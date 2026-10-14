import { describe, expect, it } from 'vitest';
import { isValidEmail, LIMITS, validatePayload } from '../lambda/lib/validation';

const valid = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  message: 'Hola',
  turnstileToken: 'token',
};

describe('isValidEmail', () => {
  it.each(['a@b.co', 'ada.lovelace+tag@example.com.mx'])('acepta %s', (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each(['', 'ada', 'ada@', 'ada@example', 'ada @example.com', '@example.com'])('rechaza "%s"', (email) => {
    expect(isValidEmail(email)).toBe(false);
  });
});

describe('validatePayload', () => {
  it('acepta un payload válido y conserva los campos opcionales', () => {
    const result = validatePayload({ ...valid, phone: '555', subject: 'Trabajo' });
    expect(result).toEqual({ ok: true, data: { ...valid, phone: '555', subject: 'Trabajo' } });
  });

  it.each(['name', 'email', 'message'] as const)('rechaza si falta %s', (field) => {
    expect(validatePayload({ ...valid, [field]: '   ' })).toEqual({ ok: false, error: 'Faltan campos requeridos' });
  });

  it('trata campos que no son texto como vacíos', () => {
    expect(validatePayload({ ...valid, name: 42 })).toEqual({ ok: false, error: 'Faltan campos requeridos' });
    expect(validatePayload(null)).toEqual({ ok: false, error: 'Faltan campos requeridos' });
  });

  it('rechaza un email inválido', () => {
    expect(validatePayload({ ...valid, email: 'no-es-email' })).toEqual({ ok: false, error: 'Email inválido' });
  });

  it('respeta los límites de longitud', () => {
    expect(validatePayload({ ...valid, name: 'a'.repeat(LIMITS.name) }).ok).toBe(true);
    expect(validatePayload({ ...valid, name: 'a'.repeat(LIMITS.name + 1) })).toEqual({
      ok: false,
      error: 'Nombre o email demasiado largo',
    });
    expect(validatePayload({ ...valid, email: `${'a'.repeat(LIMITS.email)}@example.com` })).toEqual({
      ok: false,
      error: 'Nombre o email demasiado largo',
    });
    expect(validatePayload({ ...valid, message: 'a'.repeat(LIMITS.message) }).ok).toBe(true);
    expect(validatePayload({ ...valid, message: 'a'.repeat(LIMITS.message + 1) })).toEqual({
      ok: false,
      error: 'Mensaje demasiado largo',
    });
  });
});
