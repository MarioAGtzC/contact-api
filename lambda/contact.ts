import { join } from 'path';
import { readFileSync } from 'fs';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { getCorsHeaders, parseAllowedOrigins } from './lib/cors';
import { logRequest } from './lib/log';
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

// Quita saltos de línea y espacios extra — los asuntos de correo van en una línea.
function toOneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const requestOrigin = event.headers['origin'] ?? '';
  const corsHeaders = getCorsHeaders(requestOrigin, allowedOrigins);
  const site = getSiteLabel(requestOrigin);
  const respond = (statusCode: number, body: object): APIGatewayProxyStructuredResultV2 => ({
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body),
  });
  const reject = (reason: string, error: string, errorCodes?: string[]) => {
    logRequest({ site, status: 400, result: 'rejected', reason, errorCodes });
    return respond(400, { error });
  };

  try {
    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return reject('invalid_json', 'JSON inválido');
    }

    // --- Validación básica ---
    const validation = validatePayload(body);
    if (!validation.ok) {
      return reject(validation.code, validation.error);
    }
    const { name, email, message, turnstileToken, phone, subject: userSubject } = validation.data;

    // Datos capturados server-side — el cliente no los manda ni los puede falsear
    const ip = event.requestContext.http.sourceIp;
    const userAgent = event.headers['user-agent'] ?? 'unknown';

    // --- Verificación de captcha ---
    // Solo se verifica para los sitios de la whitelist; cualquier otro origin
    // se rechaza igual que un captcha inválido.
    if (!allowedOrigins.includes(requestOrigin)) {
      return reject('origin_not_allowed', 'Verificación de captcha fallida');
    }
    const captcha = await verifyTurnstile({
      token: turnstileToken,
      ip,
      requestOrigin,
      getSecret: secretStore.getSecret,
    });
    if (!captcha.ok) {
      return reject(captcha.reason, 'Verificación de captcha fallida', captcha.errorCodes);
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

    // Solo mostramos phone/subject en el email si el cliente los mandó —
    // el sitio viejo no los envía, así que su email no cambia de forma visible.
    const cleanPhone = phone?.trim();
    const cleanUserSubject = toOneLine(userSubject ?? '') || undefined;

    // Sin "Re:" (en un correo que no es respuesta es señal de spam) y con el
    // sitio al inicio, para distinguirlos y que el cliente de correo no los
    // agrupe todos en una sola conversación.
    const emailSubject = cleanUserSubject
      ? `[${site}] ${cleanUserSubject} — ${toOneLine(name)}`
      : `[${site}] New message from ${toOneLine(name)}`;
    // Asunto sugerido al responderle al remitente desde el botón del correo
    const replySubject = `Re: ${cleanUserSubject ?? 'your message'}`;
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
        site: escapeHtml(site),
        time,
        word_count: String(getWordCount(message)),
        subject: encodeURIComponent(replySubject), // va dentro de un mailto:?subject=...
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
Sitio: ${site}
Fecha: ${time}
Palabras: ${getWordCount(message)}
Origen: ${origin}
Dispositivo: ${userAgent}
IP: ${ip}

Mensaje:
${message}
    `.trim();

    const sent = await ses.send(
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

    logRequest({ site, status: 200, result: 'sent', messageId: sent.MessageId });
    return respond(200, { success: true });
  } catch (err) {
    console.error('Error procesando mensaje de contacto:', err);
    logRequest({
      site,
      status: 500,
      result: 'error',
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return respond(500, { error: 'Error interno del servidor' });
  }
};
