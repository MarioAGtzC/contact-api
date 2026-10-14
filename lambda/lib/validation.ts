export interface ContactPayload {
  name: string;
  email: string;
  message: string;
  turnstileToken: string;
  // Campos que solo manda el portfolio — opcionales para no
  // romper el payload del sitio original (mario-gutierrez.com)
  phone?: string;
  subject?: string;
}

export const LIMITS = {
  name: 100,
  email: 254,
  message: 5000,
} as const;

export type ValidationResult =
  | { ok: true; data: ContactPayload }
  | { ok: false; error: string };

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Solo acepta strings; cualquier otro tipo (número, objeto, null) cuenta como
// campo vacío en vez de tronar más adelante con un .trim() sobre algo que no
// es texto.
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function validatePayload(body: unknown): ValidationResult {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const name = asString(raw.name);
  const email = asString(raw.email);
  const message = asString(raw.message);

  if (!name.trim() || !email.trim() || !message.trim()) {
    return { ok: false, error: 'Faltan campos requeridos' };
  }
  if (!isValidEmail(email)) {
    return { ok: false, error: 'Email inválido' };
  }
  if (name.length > LIMITS.name || email.length > LIMITS.email) {
    return { ok: false, error: 'Nombre o email demasiado largo' };
  }
  if (message.length > LIMITS.message) {
    return { ok: false, error: 'Mensaje demasiado largo' };
  }

  return {
    ok: true,
    data: {
      name,
      email,
      message,
      turnstileToken: asString(raw.turnstileToken),
      phone: asOptionalString(raw.phone),
      subject: asOptionalString(raw.subject),
    },
  };
}
