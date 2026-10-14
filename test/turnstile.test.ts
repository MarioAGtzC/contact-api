import { describe, expect, it, vi } from 'vitest';
import { SITEVERIFY_URL, verifyTurnstile } from '../lambda/lib/turnstile';

const origin = 'https://mario-gutierrez.com';

function siteverify(response: object) {
  return vi.fn().mockResolvedValue({ json: async () => response } as Response);
}

function verify(overrides: Partial<Parameters<typeof verifyTurnstile>[0]> = {}) {
  return verifyTurnstile({
    token: 'token',
    ip: '1.2.3.4',
    requestOrigin: origin,
    getSecret: async (host) => (host === 'mario-gutierrez.com' ? 'secret' : undefined),
    fetchFn: siteverify({ success: true, hostname: 'mario-gutierrez.com' }),
    ...overrides,
  });
}

describe('verifyTurnstile', () => {
  it('acepta un token válido resuelto en el mismo sitio', async () => {
    const fetchFn = siteverify({ success: true, hostname: 'mario-gutierrez.com' });
    expect(await verify({ fetchFn })).toBe(true);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(SITEVERIFY_URL);
    expect(JSON.parse(init.body)).toEqual({ secret: 'secret', response: 'token', remoteip: '1.2.3.4' });
  });

  it('rechaza sin token, sin llamar a Cloudflare', async () => {
    const fetchFn = siteverify({ success: true });
    expect(await verify({ token: '', fetchFn })).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rechaza un sitio sin secret configurada', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = siteverify({ success: true });
    expect(await verify({ requestOrigin: 'https://otro.com', fetchFn })).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rechaza un origin que no es URL', async () => {
    expect(await verify({ requestOrigin: '' })).toBe(false);
  });

  it('rechaza cuando Cloudflare dice que no', async () => {
    expect(await verify({ fetchFn: siteverify({ success: false }) })).toBe(false);
  });

  it('rechaza un token resuelto en otro dominio', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await verify({ fetchFn: siteverify({ success: true, hostname: 'otro.com' }) })).toBe(false);
  });

  it('rechaza si la llamada a Cloudflare falla', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await verify({ fetchFn: vi.fn().mockRejectedValue(new Error('red')) })).toBe(false);
  });

  it('deja pasar el error si no se pudo leer la secret', async () => {
    const getSecret = vi.fn().mockRejectedValue(new Error('SSM caído'));
    await expect(verify({ getSecret })).rejects.toThrow('SSM caído');
  });
});
