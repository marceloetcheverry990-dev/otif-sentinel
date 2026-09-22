import { describe, it, expect, vi } from 'vitest';

let queries;

vi.mock('../db.js', () => ({
  withDbTransaction: async (_env, cb) => {
    const client = {
      query: async (sql, params) => {
        queries.push(String(sql));
        const s = String(sql);
        if (s.includes('FROM ordenes_pendientes') && s.includes('FOR UPDATE') && !s.includes('UPDATE ordenes_pendientes')) {
          return { rowCount: 1, rows: [{ ot_id: 'OT-1', estado_operacional: 'PENDIENTE_RUTEO', chofer_asignado_id: null }] };
        }
        if (s.startsWith('UPDATE ordenes_pendientes')) {
          return { rowCount: 1 };
        }
        if (s.includes('FROM choferes')) {
          return { rowCount: 1, rows: [{ chofer_id: 'CH-1', patente_asignada: null, nombre_completo: 'Juan', estado: 'DISPONIBLE' }] };
        }
        if (s.startsWith('UPDATE choferes')) {
          return { rowCount: 1 };
        }
        if (s.includes('SELECT COUNT(*)')) {
          return { rows: [{ n: 1, match_n: 1 }] };
        }
        return { rowCount: 0, rows: [] };
      },
    };
    return cb(client);
  },
}));

vi.mock('../helpers/tower-poll-cache.js', () => ({
  invalidateTowerPoll: vi.fn(),
}));

const { handleAsignarChofer } = await import('./asignar-chofer.js');

function req(body) {
  return new Request('https://worker.test/api/asignar-chofer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('handleAsignarChofer — lock de fila para evitar la carrera de chofer huérfano OCUPADO', () => {
  it('la consulta de chequeo del trip usa FOR UPDATE (serializa asignaciones concurrentes sobre el mismo trip_id)', async () => {
    queries = [];
    const operator = { tenant_id: 'empresa_base' };
    const res = await handleAsignarChofer(req({ trip_id: 'TRIP-1', chofer_id: 'CH-1' }), {}, operator);
    expect(res.status).toBe(200);

    const tripCheckQuery = queries.find((q) => q.includes('FROM ordenes_pendientes') && !q.startsWith('UPDATE'));
    expect(tripCheckQuery).toBeDefined();
    expect(tripCheckQuery).toMatch(/FOR UPDATE/);
  });
});
