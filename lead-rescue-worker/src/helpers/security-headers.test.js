import { describe, it, expect } from 'vitest';
import { applySecurityHeaders, SECURITY_HEADERS } from './security-headers.js';

describe('applySecurityHeaders', () => {
  it('agrega las seis cabeceras estándar si faltan', () => {
    const out = applySecurityHeaders(new Response('ok', { status: 200 }));
    expect(out.headers.get('X-Frame-Options')).toBe('DENY');
    expect(out.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(out.headers.get('Referrer-Policy')).toBe(SECURITY_HEADERS['Referrer-Policy']);
    expect(out.headers.get('Permissions-Policy')).toContain('camera=()');
    expect(out.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(out.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(out.headers.get('Content-Security-Policy')).not.toContain('project-osrm');
    expect(out.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
  });

  it('no pisa un X-Frame-Options que el handler ya puso', () => {
    const out = applySecurityHeaders(new Response('ok', {
      headers: { 'X-Frame-Options': 'SAMEORIGIN' },
    }));
    expect(out.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });
});
