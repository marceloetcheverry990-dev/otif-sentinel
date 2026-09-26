import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  clampWaypoints,
  downsampleLatLngs,
  fetchDrivingGeometry,
  fetchMapboxDrivingRoute,
  simplifyLatLngs,
} from './mapbox-directions.js';

describe('downsampleLatLngs', () => {
  it('no recorta por debajo del tope', () => {
    const pts = [[1, 1], [2, 2], [3, 3]];
    expect(downsampleLatLngs(pts, 10)).toEqual(pts);
  });

  it('conserva extremos', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => [i, i]);
    const out = downsampleLatLngs(pts, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual([0, 0]);
    expect(out[9]).toEqual([999, 999]);
  });
});

describe('clampWaypoints', () => {
  it('deja ≤25 puntos incluyendo extremos', () => {
    const pts = Array.from({ length: 80 }, (_, i) => ({ lat: i, lng: i }));
    const out = clampWaypoints(pts);
    expect(out.length).toBe(25);
    expect(out[0]).toEqual(pts[0]);
    expect(out[24]).toEqual(pts[79]);
  });
});

describe('fetchMapboxDrivingRoute', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no llama a Mapbox sin token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const route = await fetchMapboxDrivingRoute({}, [
      { lat: -33.4, lng: -70.6 },
      { lat: -33.5, lng: -70.7 },
    ]);
    expect(route).toBe(null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pide overview simplified y no usa OSRM público', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      expect(String(url)).toContain('api.mapbox.com/directions');
      expect(String(url)).not.toContain('project-osrm');
      expect(String(url)).toContain('overview=simplified');
      return {
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [{ geometry: { coordinates: [[-70.6, -33.4], [-70.7, -33.5]] }, distance: 1000, duration: 120, legs: [] }],
        }),
      };
    }));
    const route = await fetchMapboxDrivingRoute(
      { MAPBOX_TOKEN: 'pk.test' },
      [{ lat: -33.4, lng: -70.6 }, { lat: -33.5, lng: -70.7 }],
    );
    expect(route.distance).toBe(1000);
  });

  it('salida futura: pide depart_at y, si Mapbox lo rechaza, reintenta sin él', async () => {
    const urls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      urls.push(String(url));
      if (String(url).includes('depart_at=')) return { ok: false, status: 422, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({ code: 'Ok', routes: [{ geometry: { coordinates: [[-70.6, -33.4], [-70.7, -33.5]] }, distance: 5, duration: 1, legs: [] }] }),
      };
    }));
    const salida = Date.now() + 10 * 3600000;
    const route = await fetchMapboxDrivingRoute(
      { MAPBOX_TOKEN: 'pk.test' },
      [{ lat: -33.4, lng: -70.6 }, { lat: -33.5, lng: -70.7 }],
      { departAtMs: salida },
    );
    expect(route.distance).toBe(5);
    expect(urls[0]).toContain('depart_at=');
    expect(urls[1]).not.toContain('depart_at=');
  });

  it('salida inmediata: no manda depart_at', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 'Ok', routes: [{ geometry: { coordinates: [[-70.6, -33.4], [-70.7, -33.5]] }, legs: [] }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchMapboxDrivingRoute({ MAPBOX_TOKEN: 'pk.test' }, [{ lat: -33.4, lng: -70.6 }, { lat: -33.5, lng: -70.7 }], { departAtMs: Date.now() });
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('depart_at=');
  });
});

describe('fetchDrivingGeometry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // overview=full: la simplificación la hace simplifyLatLngs (Douglas-Peucker),
  // overview=simplified cortaba esquinas y la línea cruzaba manzanas con zoom.
  it('sin token usa OSRM con geometría completa', async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(String(url)).toContain('router.project-osrm.org');
      expect(String(url)).toContain('overview=full');
      expect(String(url)).not.toContain('api.mapbox.com');
      return {
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [{ geometry: { coordinates: [[-70.6, -33.4], [-70.61, -33.41], [-70.7, -33.5]] } }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const got = await fetchDrivingGeometry({}, [
      { lat: -33.4, lng: -70.6 },
      { lat: -33.5, lng: -70.7 },
    ]);
    expect(got.provider).toBe('osrm');
    expect(got.reason).toBe('no_token');
    expect(got.route.geometry.coordinates).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('con token no llama OSRM si Mapbox responde', async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(String(url)).toContain('api.mapbox.com');
      expect(String(url)).not.toContain('project-osrm');
      return {
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [{ geometry: { coordinates: [[-70.6, -33.4], [-70.7, -33.5]] }, distance: 9, duration: 1, legs: [] }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const got = await fetchDrivingGeometry(
      { MAPBOX_TOKEN: 'pk.test' },
      [{ lat: -33.4, lng: -70.6 }, { lat: -33.5, lng: -70.7 }],
    );
    expect(got.provider).toBe('mapbox');
    expect(got.reason).toBe('ok');
  });

  it('con >25 waypoints parte en tramos y pasa por todas las paradas (no muestrea)', async () => {
    const pts = Array.from({ length: 30 }, (_, i) => ({ lat: -33.4 - i * 0.001, lng: -70.6 }));
    const pedidos = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const coordsStr = String(url).split('/driving-traffic/')[1].split('?')[0];
      const wps = coordsStr.split(';').map((c) => c.split(',').map(Number));
      pedidos.push(wps.length);
      expect(String(url)).toContain('overview=full');
      return {
        ok: true,
        json: async () => ({ code: 'Ok', routes: [{ geometry: { coordinates: wps } }] }),
      };
    }));
    const got = await fetchDrivingGeometry({ MAPBOX_TOKEN: 'pk.test' }, pts);
    expect(pedidos).toEqual([25, 6]); // 0..24 y 24..29 comparten el punto de unión
    const lats = got.route.geometry.coordinates.map((c) => c[1]);
    expect(lats).toHaveLength(30); // sin duplicar la unión
    expect(lats).toEqual(pts.map((p) => p.lat));
  });

  it('OSRM recibe todas las paradas (sin clampWaypoints)', async () => {
    const pts = Array.from({ length: 30 }, (_, i) => ({ lat: -33.4 - i * 0.001, lng: -70.6 }));
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const coordsStr = String(url).split('/driving/')[1].split('?')[0];
      expect(coordsStr.split(';')).toHaveLength(30);
      return { ok: true, json: async () => ({ code: 'Ok', routes: [{ geometry: { coordinates: [[-70.6, -33.4], [-70.6, -33.43]] } }] }) };
    }));
    const got = await fetchDrivingGeometry({}, pts);
    expect(got.provider).toBe('osrm');
  });
});

describe('simplifyLatLngs (Douglas-Peucker)', () => {
  // Una "L": 100 puntos por una calle hacia el este y 100 hacia el norte.
  const este = Array.from({ length: 100 }, (_, i) => [-33.45, -70.66 + i * 0.0001]);
  const norte = Array.from({ length: 100 }, (_, i) => [-33.45 + (i + 1) * 0.0001, -70.66 + 99 * 0.0001]);
  const ele = [...este, ...norte];

  it('conserva la esquina (el muestreo por índice la cortaba)', () => {
    const out = simplifyLatLngs(ele);
    expect(out).toContainEqual(este[99]);
    expect(out[0]).toEqual(ele[0]);
    expect(out.at(-1)).toEqual(ele.at(-1));
  });

  it('elimina puntos colineales redundantes', () => {
    expect(simplifyLatLngs(ele).length).toBeLessThanOrEqual(5);
  });

  it('respeta maxPoints subiendo la tolerancia', () => {
    const zigzag = Array.from({ length: 5000 }, (_, i) => [-33.45 + (i % 2) * 0.0005, -70.66 + i * 0.0001]);
    expect(simplifyLatLngs(zigzag, { maxPoints: 500 }).length).toBeLessThanOrEqual(500);
  });
});
