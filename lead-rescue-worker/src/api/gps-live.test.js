import { describe, expect, it, vi } from 'vitest';

let queryImpl;
vi.mock('../db.js', () => ({
  withDb: async (_env, cb) => cb({ query: (...args) => queryImpl(...args) }),
}));
vi.mock('../helpers/tower-poll-cache.js', () => ({
  getLiveFleetCacheEntry: () => null,
  setLiveFleetCacheEntry: () => {},
  invalidateTowerPoll: () => {},
}));
vi.mock('../helpers/operator-auth.js', () => ({
  verifyOperatorToken: async () => ({ ok: true, payload: { tenant_id: 'empresa_base' } }),
}));

const { getLiveFleet } = await import('./gps.js');

function req() {
  return new Request('https://x/api/gps/live?tenant_id=empresa_base', { method: 'GET' });
}

describe('getLiveFleet — velocidad calculada desde gps_trail (antes NULL::numeric hardcodeado)', () => {
  it('calcula km/h reales desde delta_km y el gap de tiempo entre los últimos 2 puntos', async () => {
    queryImpl = async (sql) => {
      const s = String(sql);
      if (s.includes('FROM flota_vehiculos')) {
        return { rows: [{ trip_id: 'TRIP-1', lat: -33.4, lng: -70.6 }] };
      }
      if (s.includes('FROM gps_trail')) {
        // 6 km recorridos en 600s = 1/6 h → 36 km/h
        return { rows: [{ trip_id: 'TRIP-1', delta_km: 6, gap_seconds: 600 }] };
      }
      return { rows: [] };
    };
    const res = await getLiveFleet(req(), { tenant_id: 'empresa_base' }, null, { tenant_id: 'empresa_base' });
    const body = await res.json();
    expect(body.exito).toBe(true);
    expect(body.flota[0].velocidad).toBe(36);
  });

  it('sin suficientes puntos en gps_trail (gap_seconds null) → velocidad null, no revienta', async () => {
    queryImpl = async (sql) => {
      const s = String(sql);
      if (s.includes('FROM flota_vehiculos')) {
        return { rows: [{ trip_id: 'TRIP-2', lat: -33.4, lng: -70.6 }] };
      }
      if (s.includes('FROM gps_trail')) {
        return { rows: [{ trip_id: 'TRIP-2', delta_km: 3, gap_seconds: null }] };
      }
      return { rows: [] };
    };
    const res = await getLiveFleet(req(), {}, null, { tenant_id: 'empresa_base' });
    const body = await res.json();
    expect(body.flota[0].velocidad).toBeNull();
  });

  it('gps_trail no existe (42P01) → degrada a velocidad null, endpoint sigue respondiendo', async () => {
    queryImpl = async (sql) => {
      const s = String(sql);
      if (s.includes('FROM flota_vehiculos')) {
        return { rows: [{ trip_id: 'TRIP-3', lat: -33.4, lng: -70.6 }] };
      }
      if (s.includes('FROM gps_trail')) {
        const e = new Error('relation "gps_trail" does not exist');
        e.code = '42P01';
        throw e;
      }
      return { rows: [] };
    };
    const res = await getLiveFleet(req(), {}, null, { tenant_id: 'empresa_base' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flota[0].velocidad).toBeNull();
  });
});
