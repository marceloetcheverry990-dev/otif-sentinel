import { describe, expect, it } from 'vitest';
import worker from '../index.js';
import {
  OPERATOR_SESSION_COOKIE,
  signOperatorToken,
} from '../helpers/operator-auth.js';

const ENV = {
  DASHBOARD_SECRET: 'test-dashboard-secret-32-bytes!!',
  MONITORING_TENANT_ID: 'empresa_base',
};

const CTX = { waitUntil() {} };

async function operatorCookie() {
  const token = await signOperatorToken(
    { role: 'operator', tenant_id: 'empresa_base' },
    ENV,
  );
  return `${OPERATOR_SESSION_COOKIE}=${token}`;
}

describe('operator route guard', () => {
  it('rechaza una mutación sin sesión antes de ejecutar el handler', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/api/quick-route', {
        method: 'POST',
        headers: {
          Origin: 'https://worker.test',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      ENV,
      CTX,
    );

    expect(response.status).toBe(401);
  });

  it('permite cookie same-origin aunque falte Origin (navegadores reales)', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/api/quick-route', {
        method: 'POST',
        headers: {
          Cookie: await operatorCookie(),
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      ENV,
      CTX,
    );

    // Pasa el guard CSRF/auth; el handler puede responder 400 por body incompleto
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it('sigue rechazando mutaciones cross-site aunque haya cookie', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/api/quick-route', {
        method: 'POST',
        headers: {
          Cookie: await operatorCookie(),
          Origin: 'https://attacker.example',
          'Sec-Fetch-Site': 'cross-site',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      ENV,
      CTX,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('origen_invalido');
  });

  it('permite que una cookie same-origin llegue al handler protegido', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/api/quick-route', {
        method: 'POST',
        headers: {
          Cookie: await operatorCookie(),
          Origin: 'https://worker.test',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      ENV,
      CTX,
    );

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it('rechaza tenant de body diferente al tenant firmado', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/api/quick-route', {
        method: 'POST',
        headers: {
          Cookie: await operatorCookie(),
          Origin: 'https://worker.test',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tenant_id: 'otro_tenant' }),
      }),
      ENV,
      CTX,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('tenant_incorrecto');
  });

  it('GET /api/dashboard/executive con tenant_id ajeno → 403 (misma regla que GPS)', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/api/dashboard/executive?tenant_id=otro_tenant', {
        headers: { Cookie: await operatorCookie() },
      }),
      ENV,
      CTX,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('tenant_incorrecto');
  });

  // Defensa en profundidad: GETs de operador deben 401 sin cookie (no depender solo de CF Access)
  for (const path of [
    '/api/depots',
    '/api/operators',
    '/api/eta-accuracy/stats',
    '/api/control-tower-viajes',
    '/api/gps/live',
    '/control-tower',
  ]) {
    it(`rechaza ${path} sin sesión`, async () => {
      const response = await worker.fetch(
        new Request(`https://worker.test${path}?tenant_id=empresa_base`, { method: 'GET' }),
        ENV,
        CTX,
      );
      expect(response.status).toBe(401);
    });
  }
});
