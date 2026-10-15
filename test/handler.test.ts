import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Las env vars se leen al cargar el módulo, así que van antes del import.
const { sesSend, ssmSend } = vi.hoisted(() => {
  process.env.ALLOWED_ORIGINS = 'https://mario-gutierrez.com,https://portfolio.mario-gutierrez.com';
  process.env.TURNSTILE_PARAM_PATH = '/contact-api/turnstile';
  process.env.SES_FROM_EMAIL = 'contact@mario-gutierrez.com';
  process.env.SES_TO_EMAIL = 'inbox@example.com';
  return { sesSend: vi.fn(), ssmSend: vi.fn() };
});

vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: class {
    send = sesSend;
  },
  SendEmailCommand: class {
    constructor(public input: Record<string, any>) {}
  },
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = ssmSend;
  },
  GetParametersByPathCommand: class {
    constructor(public input: Record<string, any>) {}
  },
}));

import { handler } from '../lambda/contact';

const RESUME = 'https://mario-gutierrez.com';
const PORTFOLIO = 'https://portfolio.mario-gutierrez.com';

function event(body: unknown, origin = RESUME): APIGatewayProxyEventV2 {
  return {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      origin,
      referer: `${origin}/contact`,
      'user-agent': 'vitest',
    },
    requestContext: { http: { sourceIp: '1.2.3.4' } },
  } as unknown as APIGatewayProxyEventV2;
}

const payload = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  message: 'Hola <b>Mario</b>',
  turnstileToken: 'token',
};

let fetchMock: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;

// Las líneas JSON que deja el handler en CloudWatch
function requestLogs() {
  return logSpy.mock.calls
    .map(([line]) => JSON.parse(String(line)))
    .filter((entry) => entry.event === 'contact');
}

function mockSiteverify(hostname: string, success = true) {
  fetchMock.mockResolvedValue({ json: async () => ({ success, hostname }) });
}

function sentEmail() {
  expect(sesSend).toHaveBeenCalledTimes(1);
  return sesSend.mock.calls[0][0].input;
}

beforeEach(() => {
  sesSend.mockReset().mockResolvedValue({ MessageId: 'msg-123' });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  ssmSend.mockReset().mockResolvedValue({
    Parameters: [
      { Name: '/contact-api/turnstile/mario-gutierrez.com', Value: 'secret-resume' },
      { Name: '/contact-api/turnstile/portfolio.mario-gutierrez.com', Value: 'secret-portfolio' },
    ],
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  mockSiteverify('mario-gutierrez.com');
});

describe('handler', () => {
  it('envía el correo y responde 200', async () => {
    const res = await handler(event(payload));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ success: true });
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe(RESUME);

    const email = sentEmail();
    expect(email.Source).toBe('contact@mario-gutierrez.com');
    expect(email.Destination.ToAddresses).toEqual(['inbox@example.com']);
    expect(email.ReplyToAddresses).toEqual(['ada@example.com']);
    expect(email.Message.Subject.Data).toBe('[resume] New message from Ada Lovelace');

    const html: string = email.Message.Body.Html.Data;
    expect(html).toContain('Hola &lt;b&gt;Mario&lt;/b&gt;');
    expect(html).not.toContain('<b>Mario</b>');
    expect(html).not.toMatch(/\{\{\w+\}\}/);
    expect(email.Message.Body.Text.Data).toContain('Mensaje:\nHola <b>Mario</b>');
    expect(email.Message.Body.Text.Data).toContain('Sitio: resume');
    expect(html).toContain('subject=Re%3A%20your%20message');

    expect(requestLogs()).toEqual([
      { event: 'contact', site: 'resume', status: 200, result: 'sent', messageId: 'msg-123' },
    ]);
  });

  it('el log no incluye datos personales', async () => {
    await handler(event(payload));
    const line = String(logSpy.mock.calls[0][0]);
    for (const value of [payload.name, payload.email, payload.message, '1.2.3.4']) {
      expect(line).not.toContain(value);
    }
  });

  it('usa la secret del sitio que hace la petición', async () => {
    mockSiteverify('portfolio.mario-gutierrez.com');
    const res = await handler(event(payload, PORTFOLIO));

    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe(PORTFOLIO);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).secret).toBe('secret-portfolio');
    expect(sentEmail().Message.Subject.Data).toBe('[portfolio] New message from Ada Lovelace');
    expect(requestLogs()[0]).toMatchObject({ site: 'portfolio', result: 'sent' });
  });

  it('muestra teléfono y asunto solo cuando vienen', async () => {
    await handler(event({ ...payload, phone: '555 123', subject: 'Una\nvacante' }));
    const withExtras = sentEmail();
    expect(withExtras.Message.Body.Text.Data).toContain('Teléfono: 555 123');
    expect(withExtras.Message.Body.Text.Data).toContain('Asunto: Una vacante');
    expect(withExtras.Message.Body.Html.Data).toContain('555 123');
    expect(withExtras.Message.Subject.Data).toBe('[resume] Una vacante — Ada Lovelace');
    expect(withExtras.Message.Body.Html.Data).toContain('subject=Re%3A%20Una%20vacante');

    sesSend.mockClear();
    await handler(event(payload));
    const withoutExtras = sentEmail();
    expect(withoutExtras.Message.Body.Text.Data).not.toContain('Teléfono');
    expect(withoutExtras.Message.Body.Text.Data).not.toContain('Asunto');
  });

  it('responde 400 con un JSON inválido', async () => {
    const res = await handler(event('{no es json'));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!)).toEqual({ error: 'JSON inválido' });
    expect(sesSend).not.toHaveBeenCalled();
    expect(requestLogs()).toEqual([
      { event: 'contact', site: 'resume', status: 400, result: 'rejected', reason: 'invalid_json' },
    ]);
  });

  it('responde 400 si la validación falla, sin verificar captcha', async () => {
    const res = await handler(event({ ...payload, email: 'mal' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!)).toEqual({ error: 'Email inválido' });
    expect(requestLogs()[0]).toMatchObject({ result: 'rejected', reason: 'invalid_email' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sesSend).not.toHaveBeenCalled();
  });

  it('responde 400 si el captcha falla y deja el motivo en el log', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ success: false, 'error-codes': ['invalid-input-secret'] }) });
    const res = await handler(event(payload));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!)).toEqual({ error: 'Verificación de captcha fallida' });
    expect(sesSend).not.toHaveBeenCalled();
    expect(requestLogs()).toEqual([
      {
        event: 'contact',
        site: 'resume',
        status: 400,
        result: 'rejected',
        reason: 'siteverify_rejected',
        errorCodes: ['invalid-input-secret'],
      },
    ]);
  });

  it('rechaza un origin fuera de la whitelist sin llamar a Cloudflare', async () => {
    const res = await handler(event(payload, 'https://evil.com'));
    expect(res.statusCode).toBe(400);
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe(RESUME);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sesSend).not.toHaveBeenCalled();
    expect(requestLogs()[0]).toMatchObject({ site: 'evil.com', reason: 'origin_not_allowed' });
  });

  it('responde 500 si SES falla', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sesSend.mockRejectedValue(new Error('SES caído'));
    const res = await handler(event(payload));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body!)).toEqual({ error: 'Error interno del servidor' });
    expect(requestLogs()).toEqual([
      { event: 'contact', site: 'resume', status: 500, result: 'error', reason: 'Error' },
    ]);
  });
});
