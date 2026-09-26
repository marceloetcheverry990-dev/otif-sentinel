// handleGPSPing contra un pg falso con semántica de TX real (ver test-utils/fake-pg-tx.js).
// El ping corre dentro de BEGIN/COMMIT (withDb con tenantId): si un paso opcional
// deja la TX abortada, el COMMIT hace ROLLBACK y se pierde la posición aunque
// respondamos 200.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakePgTx, pgError } from '../test-utils/fake-pg-tx.js';

let fake;

vi.mock('../db.js', () => ({
  withDb: async (_env, cb) => cb(fake.client),
}));
vi.mock('../helpers/tower-poll-cache.js', () => ({
  invalidateTowerPoll: vi.fn(),
  getLiveFleetCacheEntry: vi.fn(() => null),
  setLiveFleetCacheEntry: vi.fn(),
}));

const { handleGPSPing } = await import('./gps.js');
const { signDriverToken } = await import('../helpers/driver-auth.js');

const TEST_ENV = { JWT_SECRET: 'test-secret-32-bytes-minimum-len!!' };
const CHOFER = { chofer_id: 'chofer-001', rut: '12345678-9', tenant_id: 'empresa_demo' };

async function ping(body) {
  const token = await signDriverToken(CHOFER, TEST_ENV);
  return handleGPSPing(new Request('https://worker.test/api/gps/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ trip_id: 'VIAJE-001', tenant_id: 'empresa_demo', ...body }),
  }), TEST_ENV);
}

const AUTORIA = /FROM flota_vehiculos[\s\S]*rut_chofer_asignado/;
const SELECT_FLOTA = /SELECT ultima_lat/;
const UPDATE_FLOTA = /^UPDATE flota_vehiculos/;
const UPDATE_TM = /^UPDATE trip_metrics/;

function flotaPrevia(overrides = {}) {
  return {
    rowCount: 1,
    rows: [{
      ultima_lat: '-33.420',
      ultima_lng: '-70.600',
      km_recorridos_reales: '10.5',
      ultima_actualizacion: new Date(Date.now() - 60000).toISOString(),
      last_significant_move_at: null,
      ...overrides,
    }],
  };
}

function baseRules(extra = []) {
  return [
    ...extra,
    [AUTORIA, { rowCount: 1, rows: [{}] }],
    [SELECT_FLOTA, flotaPrevia()],
    [UPDATE_FLOTA, { rowCount: 1 }],
    [UPDATE_TM, { rowCount: 1 }],
  ];
}

// ~1.5 km desde la posición previa, 1 min después: movimiento válido
const MOVIMIENTO = { lat: -33.430, lng: -70.610 };

beforeEach(() => {
  fake = createFakePgTx(baseRules());
});

describe('handleGPSPing — la posición se guarda aunque falle un paso opcional', () => {
  it('camino feliz: suma km, mueve el camión y la TX termina sana', async () => {
    const res = await ping(MOVIMIENTO);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.km_actuales).toBeGreaterThan(10.5);
    const upd = fake.callsMatching(UPDATE_FLOTA);
    expect(upd).toHaveLength(1);
    expect(upd[0].params[0]).toBe(-33.430);
    expect(fake.state.aborted).toBe(false);
  });

  it('gps_trail inexistente (42P01) no aborta la TX', async () => {
    fake = createFakePgTx(baseRules([
      [/FROM gps_trail/, () => { throw pgError('relation "gps_trail" does not exist', '42P01'); }],
    ]));
    const res = await ping(MOVIMIENTO);
    expect(res.status).toBe(200);
    expect(fake.callsMatching(UPDATE_FLOTA)).toHaveLength(1);
    expect(fake.state.aborted).toBe(false); // COMMIT persiste la posición
  });

  it('customer_notifications inexistente no aborta la TX', async () => {
    const etaEn5Min = new Date(Date.now() + 5 * 60000).toISOString();
    fake = createFakePgTx(baseRules([
      [/SELECT ot_id, eta/, { rowCount: 1, rows: [{ ot_id: 'OT-1', eta: etaEn5Min }] }],
      [/FROM customer_notifications/, () => { throw pgError('relation "customer_notifications" does not exist', '42P01'); }],
    ]));
    const res = await ping(MOVIMIENTO);
    expect(res.status).toBe(200);
    expect(fake.state.aborted).toBe(false);
  });

  it('falla de trip_metrics no tumba el ping: 200 y la posición queda guardada', async () => {
    fake = createFakePgTx(baseRules([
      [UPDATE_TM, () => { throw pgError('column "gps_pings_total" does not exist', '42703'); }],
    ]));
    const res = await ping(MOVIMIENTO);
    expect(res.status).toBe(200);
    expect(fake.callsMatching(UPDATE_FLOTA)).toHaveLength(1);
    expect(fake.state.aborted).toBe(false);
  });

  it('schema sin last_significant_move_at: el fallback de columna funciona dentro de la TX', async () => {
    fake = createFakePgTx(baseRules([
      [(s) => SELECT_FLOTA.test(s) && s.includes('last_significant_move_at') && !s.includes('NULL::timestamptz'),
        () => { throw pgError('column "last_significant_move_at" does not exist', '42703'); }],
      [(s) => UPDATE_FLOTA.test(s) && s.includes('last_significant_move_at'),
        () => { throw pgError('column "last_significant_move_at" does not exist', '42703'); }],
    ]));
    const res = await ping(MOVIMIENTO);
    expect(res.status).toBe(200);
    const upd = fake.callsMatching(UPDATE_FLOTA);
    // intento con la columna + fallback sin ella
    expect(upd).toHaveLength(2);
    expect(fake.state.aborted).toBe(false);
  });
});

describe('handleGPSPing — pings atrasados (reintentos de la cola offline)', () => {
  it('no retrocede el camión ni suma km si el ping es más viejo que la última posición', async () => {
    fake = createFakePgTx(baseRules([
      [SELECT_FLOTA, flotaPrevia({ ultima_actualizacion: new Date().toISOString() })],
    ]));
    const res = await ping({ ...MOVIMIENTO, timestamp: Date.now() - 5 * 60000 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.km_actuales).toBe(10.5);
    expect(fake.callsMatching(UPDATE_FLOTA)).toHaveLength(0);
    // el ping igual cuenta en métricas, con 0 km
    const tm = fake.callsMatching(UPDATE_TM);
    expect(tm).toHaveLength(1);
    expect(tm[0].params[0]).toBe(0);
  });

  it('un ping más nuevo sí mueve el camión', async () => {
    const res = await ping({ ...MOVIMIENTO, timestamp: Date.now() });
    expect(res.status).toBe(200);
    expect(fake.callsMatching(UPDATE_FLOTA)).toHaveLength(1);
  });
});
