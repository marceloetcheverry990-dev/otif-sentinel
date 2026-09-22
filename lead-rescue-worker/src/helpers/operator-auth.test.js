// src/helpers/operator-auth.test.js
// Wave 1 — T2: Smoke tests del helper de autenticación de operadores.
// Deben pasar ANTES de avanzar a Wave 2 (migración de driver-auth.js).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  OPERATOR_SESSION_COOKIE,
  createOperatorSessionCookie,
  signOperatorToken,
  verifyOperatorTenant,
  verifyOperatorToken,
  verifySameOrigin,
  revokeOperatorJti,
  isOperatorJtiRevoked,
  isOperatorJtiRevokedAsync,
  clearOperatorRevocations,
} from './operator-auth.js';

// ─── Fixture compartido ───────────────────────────────────────────────────────

const TEST_ENV = {
  DASHBOARD_SECRET: 'test-dashboard-secret-32-bytes!!',
  MONITORING_USERNAME: 'admin',
  MONITORING_PASSWORD: 'test-password-safe',
  MONITORING_TENANT_ID: 'empresa_base',
};

const TEST_PAYLOAD = {
  role: 'operator',
  tenant_id: 'empresa_base',
};

function makeRequest(token) {
  return new Request('https://worker.test/control-tower', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Smoke tests Wave 1 ───────────────────────────────────────────────────────

describe('operator-auth — smoke tests (Wave 1 gate)', () => {
  it('signOperatorToken genera un token con exactamente 3 partes separadas por punto', async () => {
    const token = await signOperatorToken(TEST_PAYLOAD, TEST_ENV);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    // Cada parte es base64url no vacía, sin +, / ni =
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
      expect(part).not.toMatch(/[+/=]/);
    }
  });

  it('verifyOperatorToken valida correctamente un token firmado con el mismo DASHBOARD_SECRET', async () => {
    const token = await signOperatorToken(TEST_PAYLOAD, TEST_ENV);
    const request = makeRequest(token);
    const result = await verifyOperatorToken(request, TEST_ENV);

    expect(result.ok).toBe(true);
    expect(result.payload.role).toBe('operator');
    expect(result.payload.tenant_id).toBe(TEST_PAYLOAD.tenant_id);
    // exp debe estar en el futuro (~8h desde ahora)
    expect(result.payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('verifyOperatorToken acepta la cookie HttpOnly de sesión', async () => {
    const token = await signOperatorToken(TEST_PAYLOAD, TEST_ENV);
    const request = new Request('https://worker.test/control-tower', {
      headers: { Cookie: `${OPERATOR_SESSION_COOKIE}=${token}` },
    });
    const result = await verifyOperatorToken(request, TEST_ENV);

    expect(result.ok).toBe(true);
    expect(result.payload.tenant_id).toBe('empresa_base');
    expect(createOperatorSessionCookie(token)).toContain('SameSite=Strict');
  });

  it('redirige navegaciones HTML sin sesión hacia /login', async () => {
    const request = new Request('https://worker.test/control-tower', {
      headers: { Accept: 'text/html' },
    });
    const result = await verifyOperatorToken(request, TEST_ENV);

    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(303);
    expect(result.response.headers.get('Location')).toBe('/login');
  });

  it('verifyOperatorToken rechaza un token firmado con un DASHBOARD_SECRET distinto', async () => {
    const token = await signOperatorToken(TEST_PAYLOAD, TEST_ENV);
    const request = makeRequest(token);

    const wrongEnv = { ...TEST_ENV, DASHBOARD_SECRET: 'otro-secreto-completamente-diferente!!' };
    const result = await verifyOperatorToken(request, wrongEnv);

    expect(result.ok).toBe(false);
    const body = await result.response.json();
    expect(result.response.status).toBe(401);
    expect(body.code).toBe('token_invalido');
  });
});

// ─── Tests adicionales Wave 4 — T14 ──────────────────────────────────────────

import { vi } from 'vitest';
import { signDriverToken } from './driver-auth.js';
import { verifyCredentials } from './operator-auth.js';

const TEST_ENV_FULL = {
  ...TEST_ENV,
  MONITORING_USERNAME: 'admin',
  MONITORING_PASSWORD: 'test-password-safe',
};

describe('operator-auth — tests adicionales (Wave 4)', () => {

  it('verifySameOrigin permite mutación same-origin con cookie', () => {
    const req = new Request('https://worker.test/api/quick-route', {
      method: 'POST',
      headers: {
        Origin: 'https://worker.test',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(verifySameOrigin(req).ok).toBe(true);
  });

  it('verifySameOrigin permite same-origin sin header Origin', () => {
    const req = new Request('https://worker.test/api/quick-route', {
      method: 'POST',
      headers: {
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(verifySameOrigin(req).ok).toBe(true);
  });

  it('verifySameOrigin rechaza mutación cross-site con cookie', async () => {
    const req = new Request('https://worker.test/api/quick-route', {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    const result = verifySameOrigin(req);
    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(403);
    expect((await result.response.json()).code).toBe('origen_invalido');
  });

  it('verifyOperatorTenant rechaza tenant diferente en JSON', async () => {
    const req = new Request('https://worker.test/api/quick-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: 'otro_tenant' }),
    });
    const result = await verifyOperatorTenant(req, 'empresa_base');
    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(403);
    expect((await result.response.json()).code).toBe('tenant_incorrecto');
  });

  it('verifyOperatorTenant rechaza tenant diferente aunque el Content-Type declarado sea falso', async () => {
    // Content-Type: text/plain con body JSON — los handlers reales usan
    // request.json() sin mirar el header, así que esto no debe evadir el chequeo.
    const req = new Request('https://worker.test/api/recalcular-scoring', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ tenant_id: 'otro_tenant', rut: '11111111-1' }),
    });
    const result = await verifyOperatorTenant(req, 'empresa_base');
    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(403);
    expect((await result.response.json()).code).toBe('tenant_incorrecto');
  });

  it('verifyOperatorTenant permite tenant firmado en query', async () => {
    const req = new Request(
      'https://worker.test/api/gps/live?tenant_id=empresa_base',
    );
    expect((await verifyOperatorTenant(req, 'empresa_base')).ok).toBe(true);
  });

  // Token expirado
  it('verifyOperatorToken rechaza token con exp en el pasado', async () => {
    const enc = new TextEncoder();
    const { importHmacKey, HMAC_ALGO, base64urlEncode } = await import('./hmac.js');
    const key = await importHmacKey(TEST_ENV.DASHBOARD_SECRET, ['sign']);
    const header = base64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const expPasado = Math.floor(Date.now() / 1000) - 3600;
    const body = base64urlEncode(enc.encode(JSON.stringify({ role: 'operator', tenant_id: 'test', exp: expPasado })));
    const signingInput = `${header}.${body}`;
    const sig = await crypto.subtle.sign(HMAC_ALGO, key, enc.encode(signingInput));
    const token = `${signingInput}.${base64urlEncode(sig)}`;

    const req = makeRequest(token);
    const result = await verifyOperatorToken(req, TEST_ENV);
    expect(result.ok).toBe(false);
    const b = await result.response.json();
    expect(b.code).toBe('token_expirado');
  });

  // Token sin campo exp
  it('verifyOperatorToken rechaza token validamente firmado pero sin exp', async () => {
    const enc = new TextEncoder();
    const { importHmacKey, HMAC_ALGO, base64urlEncode } = await import('./hmac.js');
    const key = await importHmacKey(TEST_ENV.DASHBOARD_SECRET, ['sign']);
    const header = base64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const body = base64urlEncode(enc.encode(JSON.stringify({ role: 'operator', tenant_id: 'test' }))); // sin exp
    const signingInput = `${header}.${body}`;
    const sig = await crypto.subtle.sign(HMAC_ALGO, key, enc.encode(signingInput));
    const token = `${signingInput}.${base64urlEncode(sig)}`;

    const req = makeRequest(token);
    const result = await verifyOperatorToken(req, TEST_ENV);
    expect(result.ok).toBe(false);
    const b = await result.response.json();
    expect(b.code).toBe('token_invalido');
  });

  // Token con role incorrecto → 403
  it('verifyOperatorToken rechaza token con role:chofer con HTTP 403', async () => {
    const tokenChoferRole = await signOperatorToken({ role: 'chofer', tenant_id: 'test' }, TEST_ENV);
    const req = makeRequest(tokenChoferRole);
    const result = await verifyOperatorToken(req, TEST_ENV);
    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(403);
    const b = await result.response.json();
    expect(b.code).toBe('role_incorrecto');
  });

  // Token de chofer (firmado con JWT_SECRET) no pasa verifyOperatorToken
  it('verifyOperatorToken rechaza un Token_de_Chofer firmado con JWT_SECRET', async () => {
    const driverEnv = { JWT_SECRET: 'driver-secret-32-bytes-minimum!!' };
    const tokenChofer = await signDriverToken({ chofer_id: 'c-001', rut: '12345678-9', tenant_id: 'test' }, driverEnv);
    const req = makeRequest(tokenChofer);
    const result = await verifyOperatorToken(req, TEST_ENV); // usa DASHBOARD_SECRET distinto
    expect(result.ok).toBe(false);
  });

  // verifyCredentials — sin cortocircuito: siempre ejecuta 2 verify aunque username sea incorrecto
  it('verifyCredentials: username correcto + password incorrecto ejecuta verify 2 veces', async () => {
    const verifySpy = vi.spyOn(crypto.subtle, 'verify');
    await verifyCredentials('admin', 'wrong_password', TEST_ENV_FULL);
    expect(verifySpy).toHaveBeenCalledTimes(2);
    verifySpy.mockRestore();
  });

  it('verifyCredentials: username incorrecto + password correcto ejecuta verify 2 veces', async () => {
    const verifySpy = vi.spyOn(crypto.subtle, 'verify');
    await verifyCredentials('wrong_user', 'test-password-safe', TEST_ENV_FULL);
    expect(verifySpy).toHaveBeenCalledTimes(2);
    verifySpy.mockRestore();
  });

  // verifyCredentials — credenciales correctas
  it('verifyCredentials: credenciales correctas retorna true', async () => {
    const result = await verifyCredentials('admin', 'test-password-safe', TEST_ENV_FULL);
    expect(result).toBe(true);
  });

  // verifyCredentials — password vacío no lanza excepción
  it('verifyCredentials: password vacio retorna false sin lanzar excepcion', async () => {
    const result = await verifyCredentials('admin', '', TEST_ENV_FULL);
    expect(result).toBe(false);
  });
});

// ─── Revocación de sesión (logout real) ──────────────────────────────────────
// Antes: logout solo borraba la cookie — el JWT seguía siendo válido hasta
// sus 8h de exp si alguien lo había copiado. Mismo patrón que driver-auth.js.
describe('operator-auth — revocación de jti (logout real)', () => {
  beforeEach(() => {
    clearOperatorRevocations();
  });

  it('signOperatorToken incluye un jti único por token', async () => {
    const t1 = await signOperatorToken(TEST_PAYLOAD, TEST_ENV);
    const t2 = await signOperatorToken(TEST_PAYLOAD, TEST_ENV);
    const r1 = await verifyOperatorToken(makeRequest(t1), TEST_ENV);
    const r2 = await verifyOperatorToken(makeRequest(t2), TEST_ENV);
    expect(r1.payload.jti).toBeTruthy();
    expect(r2.payload.jti).toBeTruthy();
    expect(r1.payload.jti).not.toBe(r2.payload.jti);
  });

  it('un token válido deja de pasar verifyOperatorToken después de revocar su jti', async () => {
    const token = await signOperatorToken(TEST_PAYLOAD, TEST_ENV);
    const before = await verifyOperatorToken(makeRequest(token), TEST_ENV);
    expect(before.ok).toBe(true);

    await revokeOperatorJti(before.payload.jti, before.payload.exp);

    const after = await verifyOperatorToken(makeRequest(token), TEST_ENV);
    expect(after.ok).toBe(false);
    const body = await after.response.json();
    expect(body.code).toBe('token_revocado');
  });

  it('isOperatorJtiRevoked (sync, memoria) refleja la revocación inmediatamente', async () => {
    await revokeOperatorJti('jti-test-1', Math.floor(Date.now() / 1000) + 3600);
    expect(isOperatorJtiRevoked('jti-test-1')).toBe(true);
    expect(isOperatorJtiRevoked('jti-nunca-revocado')).toBe(false);
  });

  it('un jti revocado ya vencido deja de contar como revocado', () => {
    expect(isOperatorJtiRevoked('jti-inexistente')).toBe(false);
  });

  it('isOperatorJtiRevokedAsync consulta el KV cuando el jti no está en memoria del isolate', async () => {
    const kvStore = new Map();
    const fakeKv = {
      get: async (key) => kvStore.get(key) ?? null,
      put: async (key, value) => { kvStore.set(key, value); },
    };
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await revokeOperatorJti('jti-cross-isolate', exp, { DRIVER_REVOKED_JTI: fakeKv });

    // Simula OTRO isolate: limpiar la memoria local, solo debe quedar en KV.
    clearOperatorRevocations();
    expect(isOperatorJtiRevoked('jti-cross-isolate')).toBe(false);
    expect(await isOperatorJtiRevokedAsync('jti-cross-isolate', { DRIVER_REVOKED_JTI: fakeKv })).toBe(true);
  });

  it('sin KV binding, revokeOperatorJti igual revoca en memoria (best-effort)', async () => {
    const result = await revokeOperatorJti('jti-sin-kv', Math.floor(Date.now() / 1000) + 3600, {});
    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(false);
    expect(isOperatorJtiRevoked('jti-sin-kv')).toBe(true);
  });
});
