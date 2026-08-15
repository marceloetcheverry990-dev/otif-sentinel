// src/api/operator-auth-preservation.test.js
// Wave 6 — T16.1: Tests de preservación de los nueve endpoints protegidos
// Para cada endpoint verifica: token válido → éxito, sin token → 401,
// token firmado con el secreto de chofer → 401 (no autentica como operador).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OPERATOR_SESSION_COOKIE,
  signOperatorToken,
} from '../helpers/operator-auth.js';
import { signDriverToken } from '../helpers/driver-auth.js';

// ─── Envs ────────────────────────────────────────────────────────────────────
const OPERATOR_ENV = {
  DASHBOARD_SECRET: 'test-dashboard-secret-32-bytes!!',
  MONITORING_TENANT_ID: 'empresa_base',
};

const DRIVER_ENV = {
  JWT_SECRET: 'test-driver-jwt-secret-32-bytes!!',
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
const mockDbState = vi.hoisted(() => ({ lastMockClient: null, allQueryCalls: [] }));
vi.mock('../db.js', () => ({
  withDb: vi.fn(async (_env, fn) => {
    const client = {
      query: vi.fn(async (...args) => {
        mockDbState.allQueryCalls.push(args);
        return { rows: [], rowCount: 0 };
      }),
    };
    mockDbState.lastMockClient = client;
    return fn(client);
  }),
  withDbTransaction: vi.fn(async (_env, fn) => {
    const client = {
      query: vi.fn(async (...args) => {
        mockDbState.allQueryCalls.push(args);
        return { rows: [], rowCount: 0 };
      }),
    };
    mockDbState.lastMockClient = client;
    return fn(client);
  }),
}));

vi.mock('../ai.js', () => ({ evaluateOTRiskWithOpenAI: vi.fn() }));
vi.mock('../ui.js', () => ({
  renderControlTowerDashboard: vi.fn(() => '<html>mock</html>'),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function makeValidToken() {
  return signOperatorToken({ role: 'operator', tenant_id: 'empresa_base' }, OPERATOR_ENV);
}

async function makeChoferToken() {
  return signDriverToken({ chofer_id: 'c-1', rut: '12345678-9', tenant_id: 'empresa_base' }, DRIVER_ENV);
}

function makeRequest(pathname, token = null, method = 'GET', searchParams = '') {
  const url = `https://worker.test${pathname}${searchParams}`;
  const headers = {};
  if (token) headers.Cookie = `${OPERATOR_SESSION_COOKIE}=${token}`;
  return new Request(url, { method, headers });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Preservación — endpoints protegidos', () => {
  let validToken;
  let choferToken;

  beforeEach(async () => {
    validToken = await makeValidToken();
    choferToken = await makeChoferToken();
    mockDbState.allQueryCalls = [];
    mockDbState.lastMockClient = null;
    vi.clearAllMocks();
  });

  // ── T6: GET /control-tower ──────────────────────────────────────────────────
  describe('GET /control-tower — renderControlTower', () => {
    it('sin token → 401 token_ausente', async () => {
      const { renderControlTower } = await import('../api/dashboard.js');
      const res = await renderControlTower(makeRequest('/control-tower'), OPERATOR_ENV, { waitUntil: vi.fn() });
      expect(res.status).toBe(401);
      const b = await res.json(); expect(b.code).toBe('token_ausente');
    });
    it('token de chofer → 401 token_invalido', async () => {
      const { renderControlTower } = await import('../api/dashboard.js');
      const res = await renderControlTower(makeRequest('/control-tower', choferToken), OPERATOR_ENV, { waitUntil: vi.fn() });
      expect(res.status).toBe(401);
    });
    it('token válido → no devuelve 401/403', async () => {
      const { renderControlTower } = await import('../api/dashboard.js');
      const res = await renderControlTower(makeRequest('/control-tower', validToken), OPERATOR_ENV, { waitUntil: vi.fn() });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
    it('filtra SQL por tenant_id del JWT (no confía en cliente)', async () => {
      const { renderControlTower } = await import('../api/dashboard.js');
      mockDbState.allQueryCalls = [];
      const res = await renderControlTower(makeRequest('/control-tower', validToken), OPERATOR_ENV, { waitUntil: vi.fn() });
      expect(res.status).toBe(200);
      expect(mockDbState.allQueryCalls.length).toBeGreaterThan(0);
      const sqlCalls = mockDbState.allQueryCalls.map(([sql, params]) => ({ sql, params }));
      const tenantScoped = sqlCalls.filter((c) =>
        typeof c.sql === 'string' && c.sql.includes('tenant_id') && Array.isArray(c.params) && c.params[0] === 'empresa_base'
      );
      expect(tenantScoped.length).toBeGreaterThanOrEqual(2);
      expect(sqlCalls.some((c) => c.sql.includes('FROM ordenes_pendientes') && c.params?.[0] === 'empresa_base')).toBe(true);
      expect(sqlCalls.some((c) => c.sql.includes('FROM choferes') && c.params?.[0] === 'empresa_base')).toBe(true);
    });
  });

  // ── T7: GET /api/control-tower-viajes ───────────────────────────────────────
  describe('GET /api/control-tower-viajes — getControlTowerViajesAPI', () => {
    it('sin token → 401', async () => {
      const { getControlTowerViajesAPI } = await import('../api/dashboard.js');
      const res = await getControlTowerViajesAPI(makeRequest('/api/control-tower-viajes', null, 'GET', '?tenant_id=empresa_base'), OPERATOR_ENV, { waitUntil: vi.fn() });
      expect(res.status).toBe(401);
    });
    it('token de chofer → 401', async () => {
      const { getControlTowerViajesAPI } = await import('../api/dashboard.js');
      const res = await getControlTowerViajesAPI(makeRequest('/api/control-tower-viajes', choferToken, 'GET', '?tenant_id=empresa_base'), OPERATOR_ENV, { waitUntil: vi.fn() });
      expect(res.status).toBe(401);
    });
    it('token válido → no devuelve 401/403', async () => {
      const { getControlTowerViajesAPI } = await import('../api/dashboard.js');
      const res = await getControlTowerViajesAPI(makeRequest('/api/control-tower-viajes', validToken, 'GET', '?tenant_id=empresa_base'), OPERATOR_ENV, { waitUntil: vi.fn() });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
    it('tenant distinto al token → 403', async () => {
      const { getControlTowerViajesAPI } = await import('../api/dashboard.js');
      const res = await getControlTowerViajesAPI(makeRequest('/api/control-tower-viajes', validToken, 'GET', '?tenant_id=otro_tenant'), OPERATOR_ENV, { waitUntil: vi.fn() });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('tenant_incorrecto');
    });
    it('queries de viajes usan tenant_id del JWT como $1', async () => {
      const { getControlTowerViajesAPI } = await import('../api/dashboard.js');
      mockDbState.lastMockClient = null;
      const res = await getControlTowerViajesAPI(
        makeRequest('/api/control-tower-viajes', validToken, 'GET', '?tenant_id=empresa_base'),
        OPERATOR_ENV,
        { waitUntil: vi.fn() },
      );
      expect(res.status).toBe(200);
      expect(mockDbState.lastMockClient).toBeTruthy();
      const sqlCalls = mockDbState.lastMockClient.query.mock.calls;
      expect(sqlCalls.every(([, params]) => params?.[0] === 'empresa_base')).toBe(true);
      expect(sqlCalls.some(([sql]) => sql.includes('WHERE o.tenant_id = $1'))).toBe(true);
    });
  });

  // ── T8a: GET /dashboard/monitoring ─────────────────────────────────────────
  describe('GET /dashboard/monitoring — renderDashboard', () => {
    it('sin token → 401', async () => {
      const { renderDashboard } = await import('../monitoring/dashboard.js');
      const res = await renderDashboard(makeRequest('/dashboard/monitoring'), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token de chofer → 401', async () => {
      const { renderDashboard } = await import('../monitoring/dashboard.js');
      const res = await renderDashboard(makeRequest('/dashboard/monitoring', choferToken), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token válido → no devuelve 401/403', async () => {
      const { renderDashboard } = await import('../monitoring/dashboard.js');
      const res = await renderDashboard(makeRequest('/dashboard/monitoring', validToken), OPERATOR_ENV);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // ── T8b: GET /api/dashboard/data ───────────────────────────────────────────
  describe('GET /api/dashboard/data — getDashboardData', () => {
    it('sin token → 401', async () => {
      const { getDashboardData } = await import('../monitoring/dashboard.js');
      const res = await getDashboardData(makeRequest('/api/dashboard/data'), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token de chofer → 401', async () => {
      const { getDashboardData } = await import('../monitoring/dashboard.js');
      const res = await getDashboardData(makeRequest('/api/dashboard/data', choferToken), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token válido → no devuelve 401/403', async () => {
      const { getDashboardData } = await import('../monitoring/dashboard.js');
      const res = await getDashboardData(makeRequest('/api/dashboard/data', validToken), OPERATOR_ENV);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // ── T9: GET /dashboard/executive (HTML) ────────────────────────────────────
  describe('GET /dashboard/executive — renderExecutiveDashboard', () => {
    it('sin token → 401', async () => {
      const { renderExecutiveDashboard } = await import('../monitoring/dashboard-executive.js');
      const res = await renderExecutiveDashboard(makeRequest('/dashboard/executive'), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token de chofer → 401', async () => {
      const { renderExecutiveDashboard } = await import('../monitoring/dashboard-executive.js');
      const res = await renderExecutiveDashboard(makeRequest('/dashboard/executive', choferToken), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token válido → no devuelve 401/403', async () => {
      const { renderExecutiveDashboard } = await import('../monitoring/dashboard-executive.js');
      const res = await renderExecutiveDashboard(makeRequest('/dashboard/executive', validToken), OPERATOR_ENV);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // ── T10: GET /api/dashboard/executive (JSON) ────────────────────────────────
  describe('GET /api/dashboard/executive — getExecutiveDashboardData', () => {
    it('sin token → 401', async () => {
      const { getExecutiveDashboardData } = await import('../api/dashboard-executive.js');
      const res = await getExecutiveDashboardData(makeRequest('/api/dashboard/executive'), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token de chofer → 401', async () => {
      const { getExecutiveDashboardData } = await import('../api/dashboard-executive.js');
      const res = await getExecutiveDashboardData(makeRequest('/api/dashboard/executive', choferToken), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token válido → no devuelve 401/403', async () => {
      const { getExecutiveDashboardData } = await import('../api/dashboard-executive.js');
      const res = await getExecutiveDashboardData(makeRequest('/api/dashboard/executive', validToken), OPERATOR_ENV);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // ── T11: GET /dashboard/operaciones ────────────────────────────────────────
  describe('GET /dashboard/operaciones — renderDashboardOperaciones', () => {
    it('sin token → 401', async () => {
      const { renderDashboardOperaciones } = await import('../monitoring/dashboard-operaciones.js');
      const res = await renderDashboardOperaciones(makeRequest('/dashboard/operaciones'), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token de chofer → 401', async () => {
      const { renderDashboardOperaciones } = await import('../monitoring/dashboard-operaciones.js');
      const res = await renderDashboardOperaciones(makeRequest('/dashboard/operaciones', choferToken), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token válido → no devuelve 401/403', async () => {
      const { renderDashboardOperaciones } = await import('../monitoring/dashboard-operaciones.js');
      const res = await renderDashboardOperaciones(makeRequest('/dashboard/operaciones', validToken), OPERATOR_ENV);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // ── T12: GET /api/gps/live ──────────────────────────────────────────────────
  describe('GET /api/gps/live — getLiveFleet', () => {
    it('sin token → 401', async () => {
      const { getLiveFleet } = await import('../api/gps.js');
      const res = await getLiveFleet(makeRequest('/api/gps/live', null, 'GET', '?tenant_id=empresa_base'), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token de chofer → 401', async () => {
      const { getLiveFleet } = await import('../api/gps.js');
      const res = await getLiveFleet(makeRequest('/api/gps/live', choferToken, 'GET', '?tenant_id=empresa_base'), OPERATOR_ENV);
      expect(res.status).toBe(401);
    });
    it('token válido → no devuelve 401/403', async () => {
      const { getLiveFleet } = await import('../api/gps.js');
      const res = await getLiveFleet(makeRequest('/api/gps/live', validToken, 'GET', '?tenant_id=empresa_base'), OPERATOR_ENV);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
    it('tenant distinto al token → 403', async () => {
      const { getLiveFleet } = await import('../api/gps.js');
      const res = await getLiveFleet(makeRequest('/api/gps/live', validToken, 'GET', '?tenant_id=otro_tenant'), OPERATOR_ENV);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('tenant_incorrecto');
    });
  });
});
