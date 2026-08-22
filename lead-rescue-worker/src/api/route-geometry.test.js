import { describe, expect, it, vi, afterEach } from 'vitest';
import { getRouteGeometry } from './route-geometry.js';

function req(body) {
  return new Request('https://x/api/route-geometry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('getRouteGeometry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('403 sin tenant', async () => {
    const res = await getRouteGeometry(req({ coordinates: [[1, 1], [2, 2]] }), {}, null);
    expect(res.status).toBe(403);
  });

  it('400 con pocos puntos', async () => {
    const res = await getRouteGeometry(req({ coordinates: [[-33.4, -70.6]] }), {}, { tenant_id: 't1' });
    expect(res.status).toBe(400);
  });

  it('devuelve fallback si Mapbox no responde', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const res = await getRouteGeometry(
      req({ coordinates: [[-33.4, -70.6], [-33.5, -70.7]] }),
      { MAPBOX_TOKEN: 'pk.test' },
      { tenant_id: 't1' },
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.exito).toBe(true);
    expect(body.fallback).toBe(true);
    expect(body.reason).toBe('mapbox_and_osrm_failed');
    expect(body.coordinates).toHaveLength(2);
  });

  it('convierte GeoJSON Mapbox [lng,lat] a [lat,lng]', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [{
          geometry: { coordinates: [[-70.6, -33.4], [-70.65, -33.45], [-70.7, -33.5]] },
          distance: 1,
          duration: 1,
          legs: [],
        }],
      }),
    })));
    const res = await getRouteGeometry(
      req({ coordinates: [[-33.4, -70.6], [-33.5, -70.7]] }),
      { MAPBOX_TOKEN: 'pk.test' },
      { tenant_id: 't1' },
    );
    const body = await res.json();
    expect(body.fallback).toBe(false);
    expect(body.provider).toBe('mapbox');
    expect(body.coordinates[0]).toEqual([-33.4, -70.6]);
    expect(body.coordinates.at(-1)).toEqual([-33.5, -70.7]);
  });

  it('sin token pinta con OSRM simplificado', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      expect(String(url)).toContain('project-osrm');
      expect(String(url)).toContain('overview=simplified');
      return {
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [{
            geometry: { coordinates: [[-70.6, -33.4], [-70.62, -33.42], [-70.7, -33.5]] },
          }],
        }),
      };
    }));
    const res = await getRouteGeometry(
      req({ coordinates: [[-33.4, -70.6], [-33.5, -70.7]] }),
      {},
      { tenant_id: 't1' },
    );
    const body = await res.json();
    expect(body.fallback).toBe(false);
    expect(body.provider).toBe('osrm');
    expect(body.coordinates).toHaveLength(3);
  });
});
