import { describe, expect, it, vi } from 'vitest';
import { GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { createSecretStore } from '../lambda/lib/secrets';

function fakeClient(pages: Array<{ Parameters: Array<{ Name: string; Value: string }>; NextToken?: string }>) {
  const send = vi.fn();
  for (const page of pages) send.mockResolvedValueOnce(page);
  return { send };
}

describe('createSecretStore', () => {
  it('lee todas las páginas y usa el hostname como llave', async () => {
    const client = fakeClient([
      { Parameters: [{ Name: '/contact-api/turnstile/mario-gutierrez.com', Value: 's1' }], NextToken: 'n' },
      { Parameters: [{ Name: '/contact-api/turnstile/portfolio.mario-gutierrez.com', Value: 's2' }] },
    ]);
    const store = createSecretStore({ client, path: '/contact-api/turnstile/' });

    expect(await store.getSecret('mario-gutierrez.com')).toBe('s1');
    expect(await store.getSecret('portfolio.mario-gutierrez.com')).toBe('s2');
    expect(await store.getSecret('otro.com')).toBeUndefined();

    const input = (client.send.mock.calls[0][0] as GetParametersByPathCommand).input;
    expect(input).toMatchObject({ Path: '/contact-api/turnstile', WithDecryption: true });
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('usa la caché hasta que vence el TTL', async () => {
    let time = 0;
    const client = { send: vi.fn().mockResolvedValue({ Parameters: [{ Name: '/p/a.com', Value: 'x' }] }) };
    const store = createSecretStore({ client, path: '/p', ttlMs: 1000, now: () => time });

    await store.getSecret('a.com');
    time = 999;
    await store.getSecret('a.com');
    expect(client.send).toHaveBeenCalledTimes(1);

    time = 1000;
    await store.getSecret('a.com');
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('no guarda en caché un error de SSM', async () => {
    const client = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error('SSM caído'))
        .mockResolvedValueOnce({ Parameters: [{ Name: '/p/a.com', Value: 'x' }] }),
    };
    const store = createSecretStore({ client, path: '/p' });

    await expect(store.getSecret('a.com')).rejects.toThrow('SSM caído');
    expect(await store.getSecret('a.com')).toBe('x');
  });
});
