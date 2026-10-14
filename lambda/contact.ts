import { join } from 'path';
import { readFileSync } from 'fs';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { getCorsHeaders, parseAllowedOrigins } from './lib/cors';
import { createSecretStore } from './lib/secrets';
import { verifyTurnstile } from './lib/turnstile';
import { validatePayload } from './lib/validation';
import { escapeHtml, getInitials, getSiteLabel, getWordCount, renderTemplate } from './lib/template';

const ses = new SESClient({});

// El template se lee una sola vez, fuera del handler — se reutiliza entre
// invocaciones "calientes" de la Lambda en vez de leer el archivo cada vez.
const emailTemplate = readFileSync(join(__dirname, 'email-template.html'), 'utf-8');

const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const secretStore = createSecretStore({ path: process.env.TURNSTILE_PARAM_PATH });

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const requestOrigin = event.headers['origin'] ?? '';
  const corsHeaders = getCorsHeaders(requestOrigin, allowedOrigins);
  const respond = (statusCode: number, body: object): APIGatewayProxyStructuredResultV2 => ({
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body),
  });

  try {
    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return respond(400, { error: 'JSON inválido' });
    }

    // --- Validación básica ---
    const validation = validatePayload(body);
    if (!validation.ok) {
      return respond(400, { error: validation.error });
    }
    const { name, email, message, turnstileToken, phone, subject: userSubject } = validation.data;

    // Datos capturados server-side — el cliente no los manda ni los puede falsear
    const ip = event.requestContext.http.sourceIp;
    const userAgent = event.headers['user-agent'] ?? 'unknown';

    // --- Verificación de captcha ---
    // Solo se verifica para los sitios de la whitelist; cualquier otro origin
    // se rechaza igual que un captcha inválido.
    const isHuman =
      allowedOrigins.includes(requestOrigin) &&
      (await verifyTurnstile({
        token: turnstileToken,
        ip,
        requestOrigin,
        getSecret: secretStore.getSecret,
      }));
    if (!isHuman) {
      return respond(400, { error: 'Verificación de captcha fallida' });
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
      emailTemplate,
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

    return respond(200, { success: true });
  } catch (err) {
    console.error('Error procesando mensaje de contacto:', err);
    return respond(500, { error: 'Error interno del servidor' });
  }
};
