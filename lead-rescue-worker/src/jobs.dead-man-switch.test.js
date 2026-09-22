import { describe, expect, it, vi } from 'vitest';

let capturedFleetSql = null;

vi.mock('./db.js', () => ({
  withDb: async (_env, cb) => {
    const client = {
      query: async (sql) => {
        const s = String(sql);
        if (s.includes('FROM flota_vehiculos') && s.includes('LEFT JOIN choferes')) {
          capturedFleetSql = s;
          return { rows: [] }; // sin flota activa: el resto del loop no corre
        }
        return { rows: [] };
      },
    };
    return cb(client);
  },
}));

const { auditarFlotaEnVivo } = await import('./jobs.js');

describe('auditarFlotaEnVivo (Dead Man Switch) — excluye vehículos de demo/QA', () => {
  it('la consulta de flota activa excluye patentes VIDEO-% (ruido de SIGNAL_LOST en cada corrida E2E/demo)', async () => {
    capturedFleetSql = null;
    await auditarFlotaEnVivo({});
    expect(capturedFleetSql).not.toBeNull();
    expect(capturedFleetSql).toMatch(/patente NOT LIKE 'VIDEO-%'/);
  });
});
