import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildMapTileConfig,
  handleMapTile,
  parseTilePath,
  signTileGrant,
  verifyTileGrant,
  TILE_GRANT_TTL_SEC,
} from './map-tiles.js';

const ENV = { JWT_SECRET: 'test-secret-32-bytes-minimum-len!!', MAPBOX_TOKEN: 'pk.secreto' };

function tileReq(path) {
  return new Request(`https://worker.test${path}`);
}

async function signedPath(tile, env = ENV) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = await signTileGrant(env, exp);
  return `/api/map-tiles/${tile}?exp=${exp}&sig=${sig}`;
}

afterEach(() => vi.unstubAllGlobals());

describe('buildMapTileConfig', () => {
  it('sin MAPBOX_TOKEN usa OpenStreetMap (nunca CARTO sin API key)', async () => {
    const cfg = await buildMapTileConfig({ JWT_SECRET: ENV.JWT_SECRET });
    expect(cfg.provider).toBe('osm');
    expect(cfg.url).toContain('tile.openstreetmap.org');
    expect(cfg.url).not.toContain('cartocdn');
  });

  it('con token apunta al Worker con URL firmada y sin exponer el token', async () => {
    const cfg = await buildMapTileConfig(ENV);
    expect(cfg.provider).toBe('mapbox');
    expect(cfg.url).toMatch(/^\/api\/map-tiles\/\{z\}\/\{x\}\/\{y\}\{r\}\?exp=\d+&sig=/);
    expect(JSON.stringify(cfg)).not.toContain('pk.secreto');
    expect(cfg.attribution).toContain('Mapbox');
    expect(cfg.maxZoom).toBeGreaterThanOrEqual(19);
  });
});

describe('verifyTileGrant', () => {
  it('acepta su propia firma y rechaza otra, vencida o con exp muy futuro', async () => {
    const now = Date.now();
    const exp = Math.floor(now / 1000) + 60;
    const sig = await signTileGrant(ENV, exp);
    expect(await verifyTileGrant(ENV, exp, sig, now)).toBe(true);
    expect(await verifyTileGrant(ENV, exp + 1, sig, now)).toBe(false);
    expect(await verifyTileGrant(ENV, exp, sig, now + 120_000)).toBe(false);
    const lejos = Math.floor(now / 1000) + TILE_GRANT_TTL_SEC * 10;
    expect(await verifyTileGrant(ENV, lejos, await signTileGrant(ENV, lejos), now)).toBe(false);
    expect(await verifyTileGrant(ENV, exp, 'basura', now)).toBe(false);
  });
});

describe('parseTilePath', () => {
  it('valida z/x/y dentro de rango y detecta @2x', () => {
    expect(parseTilePath('/api/map-tiles/15/9948/19620')).toEqual({ z: 15, x: 9948, y: 19620, retina: false });
    expect(parseTilePath('/api/map-tiles/15/9948/19620@2x').retina).toBe(true);
    expect(parseTilePath('/api/map-tiles/2/4/0')).toBe(null); // x fuera de 0..3
    expect(parseTilePath('/api/map-tiles/23/0/0')).toBe(null);
    expect(parseTilePath('/api/map-tiles/../../x')).toBe(null);
  });
});

describe('handleMapTile', () => {
  it('403 sin firma (no es un proxy abierto de Mapbox)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await handleMapTile(tileReq('/api/map-tiles/15/9948/19620'), ENV);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con firma válida sirve el tile de Mapbox con el token solo del lado del servidor', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(String(url)).toContain('api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/15/9948/19620@2x');
      expect(String(url)).toContain('access_token=pk.secreto');
      expect(init.cf.cacheEverything).toBe(true);
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=43200' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await handleMapTile(tileReq(await signedPath('15/9948/19620@2x')), ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('max-age=43200');
  });

  it('error de Mapbox → 502 sin filtrar el cuerpo del upstream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('token inválido', { status: 401 })));
    const res = await handleMapTile(tileReq(await signedPath('15/9948/19620')), ENV);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('');
  });
});
