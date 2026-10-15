export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileFailure =
  | 'missing_token'
  | 'invalid_origin'
  | 'missing_secret'
  | 'siteverify_rejected'
  | 'hostname_mismatch'
  | 'siteverify_error';

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: TurnstileFailure; errorCodes?: string[]; hostname?: string };

interface VerifyOptions {
  token: string;
  ip: string;
  requestOrigin: string;
  getSecret: (hostname: string) => Promise<string | undefined>;
  fetchFn?: typeof fetch;
}

interface SiteverifyResponse {
  success: boolean;
  hostname?: string;
  'error-codes'?: string[];
}

// Devuelve el motivo del rechazo en vez de solo true/false, para que el
// handler lo deje en el log.
export async function verifyTurnstile({
  token,
  ip,
  requestOrigin,
  getSecret,
  fetchFn = fetch,
}: VerifyOptions): Promise<TurnstileResult> {
  if (!token) return { ok: false, reason: 'missing_token' };

  let expectedHostname: string;
  try {
    expectedHostname = new URL(requestOrigin).hostname;
  } catch {
    return { ok: false, reason: 'invalid_origin' };
  }

  // Un error al leer SSM no se atrapa aquí: es un fallo del servidor (500), no
  // un captcha inválido.
  const secret = await getSecret(expectedHostname);
  if (!secret) {
    // Sin secret no hay forma de verificar el token: se rechaza el mensaje en vez
    // de dejarlo pasar sin captcha.
    return { ok: false, reason: 'missing_secret' };
  }

  try {
    const res = await fetchFn(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    const data = (await res.json()) as SiteverifyResponse;
    if (data.success !== true) {
      return { ok: false, reason: 'siteverify_rejected', errorCodes: data['error-codes'] ?? [] };
    }

    // El token debe haberse resuelto en el mismo sitio que hace la petición —
    // evita reutilizar un token obtenido en otro dominio.
    if (data.hostname !== expectedHostname) {
      return { ok: false, reason: 'hostname_mismatch', hostname: data.hostname };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'siteverify_error' };
  }
}
