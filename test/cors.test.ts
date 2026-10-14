import { describe, expect, it } from 'vitest';
import { getCorsHeaders, parseAllowedOrigins } from '../lambda/lib/cors';

const allowed = ['https://mario-gutierrez.com', 'https://portfolio.mario-gutierrez.com'];

describe('parseAllowedOrigins', () => {
  it('separa por comas y quita vacíos', () => {
    expect(parseAllowedOrigins(' https://a.com, ,https://b.com ')).toEqual(['https://a.com', 'https://b.com']);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});

describe('getCorsHeaders', () => {
  it('refleja un origin permitido', () => {
    expect(getCorsHeaders(allowed[1], allowed)['Access-Control-Allow-Origin']).toBe(allowed[1]);
  });

  it('nunca refleja un origin desconocido', () => {
    expect(getCorsHeaders('https://evil.com', allowed)['Access-Control-Allow-Origin']).toBe(allowed[0]);
    expect(getCorsHeaders(undefined, allowed)['Access-Control-Allow-Origin']).toBe(allowed[0]);
  });
});
