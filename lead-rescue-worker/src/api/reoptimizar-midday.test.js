import { describe, it, expect, vi, beforeEach } from 'vitest';

let writes;
let lockOk;
let released;

const pendingRows = [
  {
    ot_id: 'OT-1', cliente: 'Cliente 1', volumen: 1, estado_operacional: 'PENDIENTE_RUTEO',
    lat: -33.45, lng: -70.66, fecha_hora_sla: '2099-12-31T23:00:00Z',
    metadata: {
      origen: 'RUTA_RAPIDA',
      direccion_entrega: 'Av Providencia 1200',
      lat_destino: -33.45,
      lng_destino: -70.66,
      scan_token: 'tok-1',
      routing: { previo: true },
    },
  },
];

// Builder encadenable mínimo de supabase-js: filtros devuelven this, await → { data, error }
function builder(table) {
  const state = { table, filters: [], payload: null, op: 'select' };
  const b = {
    select() { return b; },
    eq(col, val) { state.filters.push(['eq', col, val]); return b; },
    is(col, val) { state.filters.push(['is', col, val]); return b; },
    not(col, op, val) { state.filters.push(['not', col, val]); return b; },
    or() { return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { return b; },
    update(payload) { state.op = 'update'; state.payload = payload; return b; },
    upsert(payload) { state.op = 'upsert'; state.payload = payload; return b; },
    then(resolve, reject) {
      if (state.op !== 'select') {
        writes.push(state);
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      let data = [];
      if (table === 'ordenes_pendientes') {
        const active = state.filters.some(([k, c]) => k === 'not' && c === 'trip_id');
        data = active ? [] : pendingRows;
      } else if (table === 'choferes') {
        data = [{ chofer_id: 'CH-1', estado: 'DISPONIBLE', patente_asignada: 'AA11', capacidad_volumen: 100, tags: [] }];
      }
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  return b;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (t) => builder(t), rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock('../helpers/depots.js', () => ({
  resolveDepot: async () => ({ depot_id: 'd1', nombre: 'Bodega', lat: -33.5132, lng: -70.7672 }),
  depotToSolver: (d) => ({ lat: d.lat, lng: d.lng }),
}));
vi.mock('./optimizer.js', () => ({
  tryOptimizerLock: vi.fn(async () => lockOk),
  releaseOptimizerLock: vi.fn(async () => { released = true; }),
  ROAD_FACTOR: 1.2,
}));

const { reoptimizarMidday } = await import('./reoptimizar-midday.js');

const operator = { tenant_id: 'empresa_base' };
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' };

function post(body = {}) {
  return new Request('https://worker.test/api/reoptimizar-midday', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  writes = [];
  lockOk = true;
  released = false;
});

describe('reoptimizarMidday', () => {
  it('409 si ya hay una optimización en curso (mismo lock que Rutear)', async () => {
    lockOk = false;
    const res = await reoptimizarMidday(post(), env, null, operator);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('OPTIMIZATION_IN_PROGRESS');
    expect(writes).toHaveLength(0);
  });

  it('viaje nuevo: mezcla metadata (no pierde dirección/coords/scan_token), pone ETA y trip_metrics', async () => {
    const res = await reoptimizarMidday(post(), env, null, operator);
    const data = await res.json();
    expect(data.viajes_nuevos).toBe(1);
    expect(released).toBe(true);

    const upd = writes.find((w) => w.table === 'ordenes_pendientes' && w.op === 'update');
    expect(upd).toBeDefined();
    const meta = upd.payload.metadata;
    expect(meta.direccion_entrega).toBe('Av Providencia 1200');
    expect(meta.lat_destino).toBe(-33.45);
    expect(meta.scan_token).toBe('tok-1');
    expect(meta.routing.previo).toBe(true);
    expect(meta.routing.midday_new_trip).toBe(true);
    expect(meta.routing.stop_sequence).toBe(1);
    expect(upd.payload.eta).toBeTruthy();
    // no pisar una OT que ya salió del backlog
    expect(upd.filters).toContainEqual(['eq', 'estado_operacional', 'PENDIENTE_RUTEO']);

    const tm = writes.find((w) => w.table === 'trip_metrics' && w.op === 'upsert');
    expect(tm.payload.total_paradas).toBe(1);
    expect(tm.payload.km_planificados).toBeGreaterThan(0);
  });
});
