// src/api/operator-login.test.js
// Wave 4 — T4.1: Tests del handler POST /api/operator/login
// Tests 13-18 del design.md sección Testing Strategy

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleOperatorLogin, handleOperatorLogout } from './operator-login.js';

// ─── Mock de rate-limiter ────────────────────────────────────────────────────
// Controlamos el resultado de checkRateLimit para aislar el handler
let rateLimitAllowed = true;
let rateLimitRetryAfter = 60;

vi.mock('../monitoring/rate-limiter.js', () => ({
  checkRateLimit: vi.fn(() => ({
    allowed: rateLimitAllowed,
    retryAfter: rateLimitRetryAfter,
    remaining: rateLimitAllowed ? 9 : 0,
  })),
}));

// ─── Mock de operator-auth ────────────────────────────────────────────────────
// Controlamos verifyCredentials para aislar el handler del comportamiento criptográfico
let credencialesValidas = true;

vi.mock('../helpers/operator-auth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    verifyCredentials: vi.fn(async () => credencialesValidas),
    signOperatorToken: vi.fn(async () => 'header.payload.signature'),
  };
});

// ─── Fixture ──────────────────────────────────────────────────────────────────

const VALID_ENV = {
  MONITORING_USERNAME: 'admin',
  MONITORING_PASSWORD: 'test-password-safe',
  DASHBOARD_SECRET: 'test-dashboard-secret-32-bytes!!',
  MONITORING_TENANT_ID: 'empresa_base',
};

function makePostRequest(body, origin = 'https://worker.test') {
  return new Request('https://worker.test/api/operator/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('handleOperatorLogin', () => {
  beforeEach(() => {
    rateLimitAllowed = true;
    credencialesValidas = true;
    vi.clearAllMocks();
  });

  // Test 13: Rate limit aplicado antes de credenciales
  it('[Test 13] rate limit activo: devuelve 429 sin llamar a verifyCredentials', async () => {
    rateLimitAllowed = false;
    rateLimitRetryAfter = 45;
    const { verifyCredentials } = await import('../helpers/operator-auth.js');

    const req = makePostRequest({ username: 'admin', password: 'secret' });
    const res = await handleOperatorLogin(req, VALID_ENV);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe('rate_limit_excedido');
    expect(body.retry_after_seconds).toBe(45);
    expect(res.headers.get('Retry-After')).toBe('45');
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  // Test 14: Campos faltantes
  it('[Test 14a] body vacio: devuelve 400', async () => {
    const req = makePostRequest({});
    const res = await handleOperatorLogin(req, VALID_ENV);
    expect(res.status).toBe(400);
  });

  it('[Test 14b] solo username: devuelve 400', async () => {
    const req = makePostRequest({ username: 'admin' });
    const res = await handleOperatorLogin(req, VALID_ENV);
    expect(res.status).toBe(400);
  });

  it('[Test 14c] solo password: devuelve 400', async () => {
    const req = makePostRequest({ password: 'secret' });
    const res = await handleOperatorLogin(req, VALID_ENV);
    expect(res.status).toBe(400);
  });

  // Test 15: Env sin MONITORING_USERNAME
  it('[Test 15] MONITORING_USERNAME no configurado: devuelve 503', async () => {
    const { verifyCredentials } = await import('../helpers/operator-auth.js');
    const envSinUsername = { ...VALID_ENV, MONITORING_USERNAME: undefined };

    const req = makePostRequest({ username: 'admin', password: 'secret' });
    const res = await handleOperatorLogin(req, envSinUsername);

    expect(res.status).toBe(503);
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  // Test 16: MONITORING_TENANT_ID no configurado
  it('[Test 16] MONITORING_TENANT_ID no configurado: devuelve 503', async () => {
    const { verifyCredentials } = await import('../helpers/operator-auth.js');
    const envSinTenant = { ...VALID_ENV, MONITORING_TENANT_ID: undefined };

    const req = makePostRequest({ username: 'admin', password: 'secret' });
    const res = await handleOperatorLogin(req, envSinTenant);

    expect(res.status).toBe(503);
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  // Test 17: Credenciales inválidas — no revela cuál campo falló
  it('[Test 17] credenciales invalidas: 401 sin revelar cuál campo fallo', async () => {
    credencialesValidas = false;

    const req = makePostRequest({ username: 'admin', password: 'wrong' });
    const res = await handleOperatorLogin(req, VALID_ENV);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('credenciales_invalidas');
    // El mensaje no debe mencionar "usuario" ni "contraseña" por separado
    expect(body.error).not.toMatch(/usuario|username/i);
    expect(body.error).not.toMatch(/contraseña|password/i);
  });

  // Test 18: Login exitoso — cookie HttpOnly y tenant_id correcto
  it('[Test 18] login exitoso: 200 con cookie segura y tenant_id correcto', async () => {
    const { signOperatorToken } = await import('../helpers/operator-auth.js');

    const req = makePostRequest({ username: 'admin', password: 'correct-password' });
    const res = await handleOperatorLogin(req, VALID_ENV);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.operator).toEqual({
      username: 'admin',
      display_name: 'admin',
      is_admin: true,
    });
    expect(body.token).toBeUndefined();
    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toContain('__Host-otif_operator_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');

    // signOperatorToken fue llamado con el tenant_id correcto
    expect(signOperatorToken).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'operator',
        tenant_id: 'empresa_base',
      }),
      VALID_ENV
    );
  });

  it('rechaza login desde un Origin diferente', async () => {
    const req = makePostRequest(
      { username: 'admin', password: 'correct-password' },
      'https://attacker.example',
    );
    const res = await handleOperatorLogin(req, VALID_ENV);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('origen_invalido');
  });

  it('logout limpia la cookie HttpOnly', async () => {
    const req = new Request('https://worker.test/api/operator/logout', {
      method: 'POST',
      headers: {
        Origin: 'https://worker.test',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    const res = await handleOperatorLogout(req, VALID_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(res.headers.get('Set-Cookie')).toContain('HttpOnly');
  });

  // Verificar también el chequeo de method (405)
  it('GET a /api/operator/login: devuelve 405', async () => {
    const req = new Request('https://worker.test/api/operator/login', { method: 'GET' });
    const res = await handleOperatorLogin(req, VALID_ENV);
    expect(res.status).toBe(405);
  });
});
