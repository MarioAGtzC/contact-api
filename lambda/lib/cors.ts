// ALLOWED_ORIGINS llega como string separado por comas (las env vars solo
// aceptan strings).
export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

// Refleja el origin del request si está en la whitelist; si no, cae al
// primero de la lista en vez de exponer un origin no autorizado.
export function getCorsHeaders(requestOrigin: string | undefined, allowedOrigins: string[]) {
  const origin =
    (requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0]) || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  };
}
