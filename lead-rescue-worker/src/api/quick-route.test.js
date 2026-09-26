import { describe, it, expect, vi } from 'vitest';

let queries;

vi.mock('../db.js', () => ({
  withDb: async (_env, cb) => cb({ query: async () => ({ rowCount: 0, rows: [] }) }),
  withDbTransaction: async (_env, cb) => {
    const client = {
      query: async (sql) => {
        const s = String(sql);
        queries.push(s);
        if (s.includes('FROM choferes')) {
          return {
            rowCount: 1,
            rows: [{
              chofer_id: 'CH-1', nombre_completo: 'Juan', patente_asignada: 'AA11', rut: '1-9',
              capacidad_volumen: 100, capacidad_peso: 9999, tags: [],
            }],
          };
        }
        return { rowCount: 1, rows: [] };
      },
    };
    return cb(client);
  },
}));

vi.mock('../helpers/depots.js', () => ({
  resolveDepot: async () => ({ depot_id: 'd1', nombre: 'Bodega', lat: -33.5132, lng: -70.7672 }),
  depotToSolver: (d) => ({ lat: d.lat, lng: d.lng }),
}));

vi.mock('../helpers/tower-poll-cache.js', () => ({ invalidateTowerPoll: vi.fn() }));

const {
  createQuickRoute,
  optimizarOrdenParadas,
  resolveParadaVentanaInicio,
} = await import('./quick-route.js');

function req(body) {
  return new Request('https://worker.test/api/quick-route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const operator = { tenant_id: 'empresa_base' };

describe('createQuickRoute — segregación HAZMAT/FOOD', () => {
  it('rechaza "Carga peligrosa" (PELIGROSO, valor del modal) + "Alimentos" en el mismo camión', async () => {
    queries = [];
    const res = await createQuickRoute(req({
      chofer_id: 'CH-1',
      camion_listo: true,
      paradas: [
        { cliente: 'A', direccion: 'Calle 1', lat: -33.45, lng: -70.66, tags: ['ALIMENTOS'] },
        { cliente: 'B', direccion: 'Calle 2', lat: -33.44, lng: -70.65, tags: ['PELIGROSO'] },
      ],
    }), {}, operator);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('segregation');
    expect(queries.some((q) => q.startsWith('INSERT INTO ordenes_pendientes') || q.includes('INSERT INTO ordenes_pendientes'))).toBe(false);
  });
});

describe('resolveParadaVentanaInicio', () => {
  it('convierte "HH:MM" del modal a ISO de HOY aunque la hora ya haya pasado (columna TIMESTAMPTZ)', () => {
    // 15:00 en Santiago (UTC-4 en julio)
    const now = new Date('2026-07-15T19:00:00.000Z');
    expect(resolveParadaVentanaInicio({ ventana_inicio: '09:00' }, now)).toBe('2026-07-15T13:00:00.000Z');
  });

  it('vacío o basura → null (nunca el string crudo)', () => {
    const now = new Date('2026-07-15T19:00:00.000Z');
    expect(resolveParadaVentanaInicio({ ventana_inicio: '' }, now)).toBeNull();
    expect(resolveParadaVentanaInicio({ ventana_inicio: 'mañana' }, now)).toBeNull();
  });
});

describe('optimizarOrdenParadas — orden con urgencia SLA', () => {
  const depot = { lat: -33.5132, lng: -70.7672 };
  const startMs = new Date('2026-07-15T14:00:00.000Z').getTime();
  const lejosUrgente = {
    parada: { cliente: 'Urgente' },
    coords: { lat: -33.43, lng: -70.70 }, // ~10 km
    sla: new Date(startMs + 50 * 60 * 1000).toISOString(),
    ventanaInicio: null,
    ventanaFin: new Date(startMs + 50 * 60 * 1000).toISOString(),
  };
  const cercaHolgado = {
    parada: { cliente: 'Holgado' },
    coords: { lat: -33.505, lng: -70.76 }, // ~1 km
    sla: new Date(startMs + 10 * 3600 * 1000).toISOString(),
    ventanaInicio: null,
    ventanaFin: new Date(startMs + 10 * 3600 * 1000).toISOString(),
  };

  it('va primero a la parada con SLA apretado aunque esté más lejos', () => {
    const out = optimizarOrdenParadas([cercaHolgado, lejosUrgente], depot, { startMs, velocidadKmH: 35 });
    expect(out.map((i) => i.parada.cliente)).toEqual(['Urgente', 'Holgado']);
  });

  it('las paradas sin coordenadas quedan al final', () => {
    const sinCoords = { parada: { cliente: 'SinCoords' }, coords: null, sla: null };
    const out = optimizarOrdenParadas([sinCoords, cercaHolgado, lejosUrgente], depot, { startMs });
    expect(out[out.length - 1].parada.cliente).toBe('SinCoords');
    expect(out).toHaveLength(3);
  });
});
