import { beforeEach, describe, expect, it } from 'vitest';
import { clearRateLimitData } from '../monitoring/rate-limiter.js';
import {
  clearDriverRevocations,
  signDriverToken,
  verifyDriverToken,
} from '../helpers/driver-auth.js';
import {
  DRIVER_AUTH_LIMITS,
  enforceDriverAuthRateLimit,
} from '../helpers/driver-auth-rate-limit.js';
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

  it('enforceDriverAuthRateLimit bloquea tras superar el cupo de login', () => {
    const req = new Request('https://example.com/api/choferes/login', {
      headers: { 'CF-Connecting-IP': '203.0.113.55' },
    });
    const { endpoint, limit, windowMs } = DRIVER_AUTH_LIMITS.login;

    let blocked = null;
    for (let i = 0; i < limit + 1; i++) {
      blocked = enforceDriverAuthRateLimit(req, endpoint, limit, windowMs);
    }
    expect(blocked).not.toBeNull();
    expect(blocked.status).toBe(429);
  });
});
