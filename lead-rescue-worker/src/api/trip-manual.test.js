import { describe, it, expect, vi, beforeEach } from 'vitest';

let tripRows;
let flotaGps;
let updates;

vi.mock('../db.js', () => ({
  withDbTransaction: async (_env, cb) => {
    const client = {
      query: async (sql, params) => {
        const s = String(sql);
        if (s.includes('FROM ordenes_pendientes') && s.includes('trip_id = $2')) {
          return { rowCount: tripRows.length, rows: tripRows.filter((r) => r.trip_id === params[1]) };
        }
        if (s.includes('FROM ordenes_pendientes') && s.includes('ot_id = $2')) {
          const rows = tripRows.filter((r) => r.ot_id === params[1]);
          return { rowCount: rows.length, rows };
        }
        if (s.includes('FROM choferes')) {
          return { rowCount: 1, rows: [{ capacidad_volumen: 100, capacidad_peso: 9999, tags: [] }] };
        }
        if (s.includes('FROM flota_vehiculos')) {
          return flotaGps ? { rowCount: 1, rows: [flotaGps] } : { rowCount: 0, rows: [] };
        }
        if (s.startsWith('UPDATE ordenes_pendientes') || s.trim().startsWith('UPDATE ordenes_pendientes')) {
          updates.push(params);
          return { rowCount: 1 };
        }
        return { rowCount: 0, rows: [] };
      },
    };
    return cb(client);
  },
}));

// Bodega a ~300 km: desde ahí ninguna ventana apretada es factible.
vi.mock('../helpers/depots.js', () => ({
  resolveDepot: async () => ({ depot_id: 'd1', lat: -30.9, lng: -71.2 }),
  depotToSolver: (d) => ({ lat: d.lat, lng: d.lng }),
}));
vi.mock('../helpers/tower-poll-cache.js', () => ({ invalidateTowerPoll: vi.fn() }));
vi.mock('../helpers/dte/ensure-guia-late-ot.js', () => ({ ensureGuiaForLateOt: vi.fn(async () => {}) }));

const { reorderTripStops, moveTripStop } = await import('./trip-manual.js');

const operator = { tenant_id: 'empresa_base' };

function post(path, body) {
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function stop(ot_id, stop_sequence, estado, extra = {}) {
  return {
    ot_id, trip_id: 'TRIP-1', stop_sequence, estado_operacional: estado,
    volumen: 1, peso_kg: 0, tags_requeridos: [], chofer_asignado_id: 'CH-1',
    lat: null, lng: null, metadata: {}, ...extra,
  };
}

beforeEach(() => {
  updates = [];
  flotaGps = null;
});

describe('reorderTripStops', () => {
  it('acepta el reorden cuando el viaje tiene una parada cancelada (la Torre no la manda en ot_ids)', async () => {
    tripRows = [
      stop('A', 1, 'CAMION_ASIGNADO'),
      stop('B', 2, 'CANCELADO_PLANILLA'),
      stop('C', 3, 'CAMION_ASIGNADO'),
    ];
    const res = await reorderTripStops(post('/api/trips/reorder', { trip_id: 'TRIP-1', ot_ids: ['C', 'A'] }), {}, operator);
    expect(res.status).toBe(200);
    // La cancelada no se renumera
    expect(updates.map((p) => p[4])).toEqual(['C', 'A']);
  });

  it('rechaza mezclar PELIGROSO con ALIMENTOS', async () => {
    tripRows = [
      stop('A', 1, 'CAMION_ASIGNADO', { tags_requeridos: ['ALIMENTOS'] }),
      stop('C', 2, 'CAMION_ASIGNADO', { tags_requeridos: ['PELIGROSO'] }),
    ];
    const res = await reorderTripStops(post('/api/trips/reorder', { trip_id: 'TRIP-1', ot_ids: ['C', 'A'] }), {}, operator);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('segregation');
  });

  describe('ventanas horarias desde la posición real', () => {
    const cerca = { lat: -33.45, lng: -70.66 };
    const ventana = () => new Date(Date.now() + 20 * 60 * 1000).toISOString();

    it('viaje en curso: simula desde el GPS del camión (factible)', async () => {
      flotaGps = { ultima_lat: -33.451, ultima_lng: -70.661 };
      tripRows = [
        stop('X', 1, 'ENTREGADO', { ...cerca }),
        stop('A', 2, 'EN_RUTA', { ...cerca, ventana_fin: ventana() }),
      ];
      const res = await reorderTripStops(post('/api/trips/reorder', { trip_id: 'TRIP-1', ot_ids: ['A'] }), {}, operator);
      expect(res.status).toBe(200);
    });

    it('viaje sin salir: simula desde la bodega del tenant', async () => {
      tripRows = [stop('A', 1, 'CAMION_ASIGNADO', { ...cerca, ventana_fin: ventana() })];
      const res = await reorderTripStops(post('/api/trips/reorder', { trip_id: 'TRIP-1', ot_ids: ['A'] }), {}, operator);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('tw_infeasible');
    });
  });
});

describe('moveTripStop', () => {
  it('no deja mover una parada cancelada', async () => {
    tripRows = [
      stop('B', 1, 'CANCELADO_PLANILLA'),
      { ...stop('D', 1, 'CAMION_ASIGNADO'), trip_id: 'TRIP-2' },
    ];
    const res = await moveTripStop(post('/api/trips/move-stop', { ot_id: 'B', to_trip_id: 'TRIP-2' }), {}, operator);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('off_route');
  });
});
