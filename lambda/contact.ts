import { join } from 'path';
import { readFileSync } from 'fs';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const ses = new SESClient({});

// El template se lee una sola vez, fuera del handler — se reutiliza entre
// invocaciones "calientes" de la Lambda en vez de leer el archivo cada vez.
const emailTemplate = readFileSync(join(__dirname, 'email-template.html'), 'utf-8');

interface ContactPayload {
  name: string;
  email: string;
  message: string;
  turnstileToken: string;
  // Campos nuevos que solo manda greenie-studios.com — opcionales para no
  // romper el payload del sitio original (mario-gutierrez.com)
  phone?: string;
  subject?: string;
}

function getWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((n) => n[0])
    .join('')
    .toUpperCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Escapa HTML del usuario antes de insertarlo en el template — sin esto,
// alguien podría meter <script> o markup propio en "name" o "message" y
// romper el layout del correo (o intentar un ataque tipo XSS/HTML injection).
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Etiqueta corta del sitio que envió el formulario, para la barra del email.
const SITE_LABELS: Record<string, string> = {
  'mario-gutierrez.com': 'resume',
  'portfolio.mario-gutierrez.com': 'portfolio',
  'greenie-studios.com': 'portfolio',
};

function getSiteLabel(requestOrigin: string): string {
  try {
    const host = new URL(requestOrigin).hostname.replace(/^www\./, '');
    return SITE_LABELS[host] ?? host;
  } catch {
    return 'unknown';
  }
}

// Bloques opcionales del template: <!--IF:key-->...<!--ENDIF:key-->.
// Si `present` no incluye la key, se borra el bloque completo; si la incluye,
// solo se quitan los marcadores y el contenido queda.
function stripConditionalBlocks(html: string, present: Set<string>): string {
  return html.replace(
    /<!--IF:(\w+)-->([\s\S]*?)<!--ENDIF:\1-->/g,
    (_match, key: string, inner: string) => (present.has(key) ? inner : '')
  );
}

function renderTemplate(vars: Record<string, string>, present: Set<string>): string {
  let html = stripConditionalBlocks(emailTemplate, present);
  for (const [key, value] of Object.entries(vars)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
}

// Cada sitio (origin) puede tener su propio site/secret de Turnstile —
// mapeo origin -> secret key, ej: {"https://a.com":"xxx","https://b.com":"yyy"}
const turnstileSecrets: Record<string, string> = (() => {
  try {
    return JSON.parse(process.env.TURNSTILE_SECRETS || '{}');
  } catch {
    return {};
  }
})();

async function verifyTurnstile(token: string, ip: string, requestOrigin: string): Promise<boolean> {
  if (!token) return false;

  const secret = turnstileSecrets[requestOrigin];
  if (!secret) {
    // Si no configuraste la secret key para este origin, no bloquees en seco — pero avisa en logs.
    // Quita ese origin del fallback (o agrega su secret) una vez que tengas Turnstile configurado.
    console.warn(`No hay TURNSTILE secret configurada para el origin "${requestOrigin}" — saltando verificación de captcha`);
    return true;
  }

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    const data = (await res.json()) as { success: boolean };
    return data.success === true;
  } catch (err) {
    console.error('Error verificando Turnstile:', err);
    return false;
  }
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Refleja el origin del request si está en la whitelist; si no, cae al
// primero de la lista en vez de exponer un origin no autorizado.
function getCorsHeaders(requestOrigin?: string) {
  const origin =
    (requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0]) || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const requestOrigin = event.headers['origin'] ?? '';
  const corsHeaders = getCorsHeaders(requestOrigin);
  try {
    const body: ContactPayload = JSON.parse(event.body ?? '{}');
    const { name, email, message, turnstileToken, phone, subject: userSubject } = body;

    // Datos capturados server-side — el cliente no los manda ni los puede falsear
    const ip = event.requestContext.http.sourceIp;
    const userAgent = event.headers['user-agent'] ?? 'unknown';

    // --- Validación básica ---
    if (!name?.trim() || !email?.trim() || !message?.trim()) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Faltan campos requeridos' }),
      };
    }
    if (!isValidEmail(email)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Email inválido' }),
      };
    }
    if (message.length > 5000) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Mensaje demasiado largo' }),
      };
    }

    // --- Verificación de captcha ---
    const isHuman = await verifyTurnstile(turnstileToken, ip, requestOrigin);
    if (!isHuman) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Verificación de captcha fallida' }),
      };
    }

    // --- Metadata calculada server-side ---
    const time = new Date().toLocaleString('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    // El "origin" se toma del header Referer/Origin que manda el navegador,
    // no de un valor que el cliente declare en el body — así no se puede
    // falsear fácilmente.
    const origin = event.headers['referer'] || event.headers['origin'] || 'unknown';

    const emailSubject = `Re: Message from ${name} via website`;

    // Solo mostramos phone/subject en el email si el cliente los mandó —
    // el sitio viejo no los envía, así que su email no cambia de forma visible.
    const cleanPhone = phone?.trim();
    const cleanUserSubject = userSubject?.trim().replace(/[\r\n]+/g, ' ');
    const presentBlocks = new Set<string>();
    if (cleanPhone) presentBlocks.add('phone');
    if (cleanUserSubject) presentBlocks.add('user_subject');

    const htmlBody = renderTemplate(
      {
        name: escapeHtml(name),
        email: escapeHtml(email),
        phone: escapeHtml(cleanPhone ?? ''),
        user_subject: escapeHtml(cleanUserSubject ?? ''),
        message: escapeHtml(message),
        initials: escapeHtml(getInitials(name)),
        site: escapeHtml(getSiteLabel(requestOrigin)),
        time,
        word_count: String(getWordCount(message)),
        subject: encodeURIComponent(emailSubject), // va dentro de un mailto:?subject=...
        origin: escapeHtml(origin),
        device_info: escapeHtml(userAgent),
        ip: escapeHtml(ip),
      },
      presentBlocks
    );

    // Fallback de texto plano — buena práctica de deliverability, y lo ven
    // los clientes de correo que no renderizan HTML.
    const textBody = `
Nombre: ${name}
Email: ${email}${cleanPhone ? `\nTeléfono: ${cleanPhone}` : ''}${cleanUserSubject ? `\nAsunto: ${cleanUserSubject}` : ''}
Fecha: ${time}
Palabras: ${getWordCount(message)}
Origen: ${origin}
Dispositivo: ${userAgent}
IP: ${ip}

Mensaje:
${message}
    `.trim();

    await ses.send(
      new SendEmailCommand({
        Source: process.env.SES_FROM_EMAIL,
        Destination: { ToAddresses: [process.env.SES_TO_EMAIL!] },
        Message: {
          Subject: { Data: emailSubject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: htmlBody, Charset: 'UTF-8' },
            Text: { Data: textBody, Charset: 'UTF-8' },
          },
        },
        ReplyToAddresses: [email],
      })
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    console.error('Error procesando mensaje de contacto:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Error interno del servidor' }),
    };
  }
};
