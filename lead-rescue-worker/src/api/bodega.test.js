import { describe, expect, it, vi, beforeEach } from 'vitest';

let dbCallCount;
let tenantSettingsRow;
let queryLog;

function makeClient() {
  return {
    query: async (sql, params) => {
      const s = String(sql);
      queryLog.push(s);
      if (s.includes('FROM tenant_settings')) {
        return { rows: tenantSettingsRow ? [tenantSettingsRow] : [] };
      }
      if (s.includes('FROM depots')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

vi.mock('../db.js', () => ({
  withDb: async (_env, cb) => {
    dbCallCount += 1;
    return cb(makeClient());
  },
  withDbTransaction: async (_env, cb) => {
    dbCallCount += 1;
    return cb(makeClient());
  },
}));

vi.mock('../helpers/depots.js', () => ({
  ensureDefaultDepot: vi.fn(async () => ({ depot_id: 'depot-1' })),
  ensureDepotsSchema: vi.fn(async () => {}),
}));

vi.mock('../helpers/tower-poll-cache.js', () => ({
  invalidateTowerPoll: vi.fn(),
}));

vi.mock('../helpers/wms-stock.js', async () => {
  const actual = await vi.importActual('../helpers/wms-stock.js');
  return {
    ...actual,
    ensureWmsSchema: vi.fn(async () => {}),
    listarStock: vi.fn(async () => []),
    listarCola: vi.fn(async () => []),
    listarListasSinTrip: vi.fn(async () => []),
    upsertProductoYStock: vi.fn(async () => ({ ok: true, sku: 'SKU-1' })),
    ajustarStock: vi.fn(async () => ({ ok: true, qty_disponible: 5 })),
    reservarOt: vi.fn(async () => ({ ok: true, estado: 'PENDIENTE_PICKING' })),
    confirmarPicking: vi.fn(async () => ({ ok: true })),
    confirmarPacking: vi.fn(async () => ({ ok: true })),
  };
});

const { handleBodega } = await import('./bodega.js');

function req(method, path, body) {
  return new Request(`https://x${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ENV_WMS_ON = { WMS_ENABLED: 'true' };
const OPERATOR = { tenant_id: 'empresa_base' };

describe('handleBodega — una sola conexión/transacción por request (antes: guardWms abría la suya + el branch la suya)', () => {
  beforeEach(() => {
    dbCallCount = 0;
    queryLog = [];
    tenantSettingsRow = { tenant_id: 'empresa_base', wms_enabled: true };
  });

  it('GET /api/bodega/resumen: solo 1 llamada a withDb (antes eran 2)', async () => {
    const res = await handleBodega(req('GET', '/api/bodega/resumen'), ENV_WMS_ON, OPERATOR);
    expect(res.status).toBe(200);
    expect(dbCallCount).toBe(1);
    expect(queryLog.some((q) => q.includes('tenant_settings'))).toBe(true);
  });

  it('POST /api/bodega/ajuste: solo 1 llamada a withDbTransaction', async () => {
    const res = await handleBodega(
      req('POST', '/api/bodega/ajuste', { depot_id: 'd1', sku: 'SKU-1', delta: 1 }),
      ENV_WMS_ON,
      OPERATOR
    );
    expect(res.status).toBe(200);
    expect(dbCallCount).toBe(1);
  });

  it('WMS deshabilitado (tenant_settings.wms_enabled=false) → 404 wms_disabled, sin escribir nada', async () => {
    tenantSettingsRow = { tenant_id: 'empresa_base', wms_enabled: false };
    const res = await handleBodega(
      req('POST', '/api/bodega/ajuste', { depot_id: 'd1', sku: 'SKU-1', delta: 1 }),
      ENV_WMS_ON,
      OPERATOR
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('wms_disabled');
  });

  it('WMS deshabilitado en GET /api/bodega/resumen → 404, sigue siendo 1 sola conexión', async () => {
    tenantSettingsRow = null;
    const res = await handleBodega(req('GET', '/api/bodega/resumen'), ENV_WMS_ON, OPERATOR);
    expect(res.status).toBe(404);
    expect(dbCallCount).toBe(1);
  });

  it('POST /api/bodega/reservar deshabilitado → 404 y NO invalida el cache de poll (no hubo mutación real)', async () => {
    tenantSettingsRow = { tenant_id: 'empresa_base', wms_enabled: false };
    const { invalidateTowerPoll } = await import('../helpers/tower-poll-cache.js');
    const res = await handleBodega(
      req('POST', '/api/bodega/reservar', { ot_id: 'OT-1', depot_id: 'd1', lineas: [] }),
      ENV_WMS_ON,
      OPERATOR
    );
    expect(res.status).toBe(404);
    expect(invalidateTowerPoll).not.toHaveBeenCalled();
  });

  it('POST /api/bodega/reservar habilitado → 200 y SÍ invalida el cache de poll', async () => {
    const { invalidateTowerPoll } = await import('../helpers/tower-poll-cache.js');
    vi.mocked(invalidateTowerPoll).mockClear();
    const res = await handleBodega(
      req('POST', '/api/bodega/reservar', { ot_id: 'OT-1', depot_id: 'd1', lineas: [{ sku: 'SKU-1', qty: 1 }] }),
      ENV_WMS_ON,
      OPERATOR
    );
    expect(res.status).toBe(200);
    expect(invalidateTowerPoll).toHaveBeenCalledWith('empresa_base');
  });
});
