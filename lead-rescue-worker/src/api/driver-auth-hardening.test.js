import { beforeEach, describe, expect, it } from 'vitest';
import { clearRateLimitData } from '../monitoring/rate-limiter.js';
import {
  clearDriverRevocations,
  signDriverToken,
  verifyDriverToken,
} from '../helpers/driver-auth.js';
import {
  DRIVER_AUTH_LIMITS,
  LOGIN_ACCOUNT_LIMIT,
  enforceDriverAuthRateLimit,
  enforceAccountRateLimit,
} from '../helpers/driver-auth-rate-limit.js';

/** Mock mínimo de KVNamespace para tests — get/put en memoria, sin TTL real. */
function makeMockKv() {
  const store = new Map();
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}
import { logoutChofer } from './app-chofer-logout.js';
import { base64urlDecode } from '../helpers/hmac.js';

const ENV = {
  JWT_SECRET: 'test-jwt-secret-with-enough-bytes-32+',
};

describe('driver auth hardening', () => {
  beforeEach(() => {
    clearRateLimitData();
    clearDriverRevocations();
  });

  it('signDriverToken incluye jti, role e iat', async () => {
    const token = await signDriverToken(
      { chofer_id: 'c1', rut: '1-9', tenant_id: 'empresa_base' },
      ENV
    );
    const parts = token.split('.');
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
    expect(payload.jti).toBeTruthy();
    expect(payload.role).toBe('chofer');
    expect(payload.sub).toBe('c1');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
  });

  it('logout revoca el jti y verifyDriverToken falla despues', async () => {
    const token = await signDriverToken(
      { chofer_id: 'c1', rut: '1-9', tenant_id: 'empresa_base' },
      ENV
    );

    const logoutReq = new Request('https://example.com/api/choferes/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const logoutRes = await logoutChofer(logoutReq, ENV);
    expect(logoutRes.status).toBe(200);

    const verifyReq = new Request('https://example.com/api/x', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const verified = await verifyDriverToken(verifyReq, ENV);
    expect(verified.ok).toBe(false);
    expect(verified.response.status).toBe(401);
    const body = await verified.response.json();
    expect(body.code).toBe('token_revocado');
  });

  it('enforceDriverAuthRateLimit (por IP) bloquea tras superar el cupo de login', async () => {
    const req = new Request('https://example.com/api/choferes/login', {
      headers: { 'CF-Connecting-IP': '203.0.113.55' },
    });
    const { endpoint, limit, windowMs } = DRIVER_AUTH_LIMITS.login;
    const env = { DRIVER_REVOKED_JTI: makeMockKv() };

    let blocked = null;
    for (let i = 0; i < limit + 1; i++) {
      blocked = await enforceDriverAuthRateLimit(req, env, endpoint, limit, windowMs);
    }
    expect(blocked).not.toBeNull();
    expect(blocked.status).toBe(429);
  });

  it('enforceDriverAuthRateLimit no comparte cupo entre isolates distintos (dos KV separados = dos cupos)', async () => {
    // Regresión del bug real: el Map en memoria se reiniciaba por isolate.
    // Acá simulamos eso a propósito (dos "isolates" = dos mocks de KV) para
    // dejar registrado qué comportamiento NO queremos — con el KV real
    // compartido, este escenario no puede pasar.
    const req = new Request('https://example.com/api/choferes/login', {
      headers: { 'CF-Connecting-IP': '203.0.113.55' },
    });
    const { endpoint, limit, windowMs } = DRIVER_AUTH_LIMITS.login;
    const isolateA = { DRIVER_REVOKED_JTI: makeMockKv() };
    const isolateB = { DRIVER_REVOKED_JTI: makeMockKv() };

    for (let i = 0; i < limit; i++) {
      await enforceDriverAuthRateLimit(req, isolateA, endpoint, limit, windowMs);
    }
    const stillAllowedOnB = await enforceDriverAuthRateLimit(req, isolateB, endpoint, limit, windowMs);
    // Con KV separados (simulando el bug viejo) sí pasa — confirma que la
    // protección real viene de COMPARTIR el KV, no de la lógica en sí.
    expect(stillAllowedOnB).toBeNull();
  });

  it('enforceAccountRateLimit bloquea por (tenant_id, rut) sin importar la IP de origen', async () => {
    const env = { DRIVER_REVOKED_JTI: makeMockKv() };
    const { endpoint } = DRIVER_AUTH_LIMITS.login;
    const { limit, windowMs } = LOGIN_ACCOUNT_LIMIT;

    let blocked = null;
    for (let i = 0; i < limit + 1; i++) {
      // Cada intento "viene" de una IP distinta — no debería importar.
      blocked = await enforceAccountRateLimit(env, endpoint, 'empresa_base', '11111111-1', limit, windowMs);
    }
    expect(blocked).not.toBeNull();
    expect(blocked.status).toBe(429);

    // Otra cuenta en el mismo tenant no está afectada.
    const otherAccount = await enforceAccountRateLimit(env, endpoint, 'empresa_base', '22222222-2', limit, windowMs);
    expect(otherAccount).toBeNull();
  });
});
