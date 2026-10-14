export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface VerifyOptions {
  token: string;
  ip: string;
  requestOrigin: string;
  getSecret: (hostname: string) => Promise<string | undefined>;
  fetchFn?: typeof fetch;
}

export async function verifyTurnstile({
  token,
  ip,
  requestOrigin,
  getSecret,
  fetchFn = fetch,
}: VerifyOptions): Promise<boolean> {
  if (!token) return false;

  let expectedHostname: string;
  try {
    expectedHostname = new URL(requestOrigin).hostname;
  } catch {
    return false;
  }

  // Un error al leer SSM no se atrapa aquí: es un fallo del servidor (500), no
  // un captcha inválido.
  const secret = await getSecret(expectedHostname);
  if (!secret) {
    // Sin secret no hay forma de verificar el token: se rechaza el mensaje en vez
    // de dejarlo pasar sin captcha.
    console.error(`No hay TURNSTILE secret configurada para "${expectedHostname}" — mensaje rechazado`);
    return false;
  }

  try {
    const res = await fetchFn(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    const data = (await res.json()) as { success: boolean; hostname?: string };
    if (data.success !== true) return false;

    // El token debe haberse resuelto en el mismo sitio que hace la petición —
    // evita reutilizar un token obtenido en otro dominio.
    if (data.hostname !== expectedHostname) {
      console.warn(`Turnstile hostname "${data.hostname}" no coincide con "${expectedHostname}"`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Error verificando Turnstile:', err);
    return false;
  }
}
