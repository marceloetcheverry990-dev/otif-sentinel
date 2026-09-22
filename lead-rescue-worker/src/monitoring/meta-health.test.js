import { describe, expect, it, vi, beforeEach } from 'vitest';
import { clearRateLimitData } from './rate-limiter.js';

vi.mock('../db.js', () => ({
  withDb: async (env, fn) => fn({ query: async () => ({ rows: [] }) }),
}));

const { handleMonitoringHealth } = await import('./meta-health.js');

function req(ip) {
  return new Request('https://x/health/monitoring', {
    headers: { 'CF-Connecting-IP': ip },
  });
}

describe('handleMonitoringHealth — antes sin cache ni límite (3 queries gratis por request)', () => {
  beforeEach(() => {
    clearRateLimitData();
  });

  it('responde 200 y cachea (segunda llamada devuelve la respuesta cacheada, mismo Cache-Control)', async () => {
    const res1 = await handleMonitoringHealth(req('203.0.113.10'), {});
    expect(res1.status).toBe(200);
    expect(res1.headers.get('Cache-Control')).toMatch(/max-age=10/);

    const res2 = await handleMonitoringHealth(req('203.0.113.10'), {});
    expect(res2.status).toBe(200);
    const body1 = await res1.json();
    const body2 = await res2.json();
    // Mismo timestamp = vino del cache, no volvió a correr las 3 queries.
    expect(body2.timestamp).toBe(body1.timestamp);
  });
});

describe('rate limiter de /health/monitoring en aislado (sin el cache de por medio)', () => {
  it('checkRateLimit bloquea la request 61 dentro del mismo minuto', async () => {
    const { checkRateLimit } = await import('./rate-limiter.js');
    clearRateLimitData();
    let last;
    for (let i = 0; i < 61; i++) {
      last = checkRateLimit('203.0.113.30', '/health/monitoring', 60, 60000);
    }
    expect(last.allowed).toBe(false);
  });
});
