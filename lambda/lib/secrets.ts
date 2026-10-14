import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

// Las secrets de Turnstile viven en SSM Parameter Store como SecureString, una
// por sitio, nombradas con el hostname del sitio:
//   /contact-api/turnstile/mario-gutierrez.com
//   /contact-api/turnstile/portfolio.mario-gutierrez.com
export const DEFAULT_TURNSTILE_PARAM_PATH = '/contact-api/turnstile';

// Se leen una vez y se reutilizan entre invocaciones "calientes"; pasado este
// tiempo se vuelven a leer, así que cambiar una secret no requiere redeploy.
export const SECRETS_TTL_MS = 5 * 60 * 1000;

interface SecretStoreOptions {
  client?: Pick<SSMClient, 'send'>;
  path?: string;
  ttlMs?: number;
  now?: () => number;
}

export interface SecretStore {
  getSecret(hostname: string): Promise<string | undefined>;
}

export function createSecretStore(options: SecretStoreOptions = {}): SecretStore {
  const client = options.client ?? new SSMClient({});
  const path = (options.path ?? DEFAULT_TURNSTILE_PARAM_PATH).replace(/\/+$/, '');
  const ttlMs = options.ttlMs ?? SECRETS_TTL_MS;
  const now = options.now ?? Date.now;

  let cache: { value: Promise<Record<string, string>>; expiresAt: number } | undefined;

  async function load(): Promise<Record<string, string>> {
    const secrets: Record<string, string> = {};
    let nextToken: string | undefined;
    do {
      const res = await client.send(
        new GetParametersByPathCommand({ Path: path, WithDecryption: true, NextToken: nextToken })
      );
      for (const param of res.Parameters ?? []) {
        if (param.Name && param.Value) {
          secrets[param.Name.slice(path.length + 1)] = param.Value;
        }
      }
      nextToken = res.NextToken;
    } while (nextToken);
    return secrets;
  }

  return {
    async getSecret(hostname) {
      if (!cache || now() >= cache.expiresAt) {
        const value = load();
        cache = { value, expiresAt: now() + ttlMs };
        // Si SSM falla, no se guarda el error: la siguiente invocación reintenta.
        value.catch(() => {
          if (cache?.value === value) cache = undefined;
        });
      }
      const secrets = await cache.value;
      return secrets[hostname];
    },
  };
}
