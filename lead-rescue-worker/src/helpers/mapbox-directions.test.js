import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  clampWaypoints,
  downsampleLatLngs,
  fetchDrivingGeometry,
  fetchMapboxDrivingRoute,
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
});

describe('fetchDrivingGeometry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sin token usa OSRM simplificado (no overview=full)', async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(String(url)).toContain('router.project-osrm.org');
      expect(String(url)).toContain('overview=simplified');
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
});
