/**
 * Mapa base de la Torre y del portal público.
 *
 * CARTO (basemaps.cartocdn.com) ahora exige API key: sin ella sirve tiles
 * borrosas con la marca "API KEY REQUIRED" — por eso las calles no se veían
 * al hacer zoom. Con MAPBOX_TOKEN servimos tiles de Mapbox a través del Worker
 * (el token no sale al navegador, igual que en /api/route-geometry). Sin token
 * (dev/staging) caemos a OpenStreetMap directo.
 *
 * Las URLs de tiles van firmadas (HMAC con vencimiento) para que el endpoint
 * no sea un proxy abierto de Mapbox: la página las recibe al renderizar.
 */

import { CORS_HEADERS } from '../config.js';
import { importHmacKey, base64urlEncode, base64urlDecode } from '../helpers/hmac.js';

export const TILE_GRANT_TTL_SEC = 24 * 3600;
const DEFAULT_MAPBOX_STYLE = 'mapbox/streets-v12';
const MAX_ZOOM = 20;

const OSM_TILES = Object.freeze({
  provider: 'osm',
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  maxZoom: 19,
  maxNativeZoom: 19,
});

const MAPBOX_ATTRIBUTION =
  '&copy; <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">Mapbox</a> ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> ' +
  '<a href="https://www.mapbox.com/map-feedback/" target="_blank" rel="noopener"><strong>Mejorar este mapa</strong></a>';

function mapboxToken(env) {
  return env?.MAPBOX_TOKEN || env?.MAPBOX_ACCESS_TOKEN || '';
}

function mapboxStyle(env) {
  const s = String(env?.MAP_TILE_STYLE || '').trim();
  return /^[\w-]+\/[\w.-]+$/.test(s) ? s : DEFAULT_MAPBOX_STYLE;
}

function grantMessage(exp) {
  // Separación de dominio: la firma de tiles no sirve como nada más.
  return new TextEncoder().encode(`map-tiles:v1:${exp}`);
}

export async function signTileGrant(env, exp) {
  const key = await importHmacKey(env.JWT_SECRET, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, grantMessage(exp));
  return base64urlEncode(sig);
}

export async function verifyTileGrant(env, exp, sig, nowMs = Date.now()) {
  const expNum = Number(exp);
  const nowSec = Math.floor(nowMs / 1000);
  if (!Number.isInteger(expNum) || !sig) return false;
  if (expNum < nowSec) return false;
  if (expNum > nowSec + TILE_GRANT_TTL_SEC + 60) return false;
  try {
    const key = await importHmacKey(env.JWT_SECRET, ['verify']);
    return await crypto.subtle.verify('HMAC', key, base64urlDecode(String(sig)), grantMessage(expNum));
  } catch {
    return false;
  }
}

/**
 * Config de capa base para Leaflet (va embebida en la página).
 * @returns {{ provider, url, attribution, maxZoom, maxNativeZoom }}
 */
export async function buildMapTileConfig(env, nowMs = Date.now()) {
  if (!mapboxToken(env)) return { ...OSM_TILES };
  try {
    const exp = Math.floor(nowMs / 1000) + TILE_GRANT_TTL_SEC;
    const sig = await signTileGrant(env, exp);
    return {
      provider: 'mapbox',
      url: `/api/map-tiles/{z}/{x}/{y}{r}?exp=${exp}&sig=${sig}`,
      attribution: MAPBOX_ATTRIBUTION,
      maxZoom: MAX_ZOOM,
      maxNativeZoom: MAX_ZOOM,
    };
  } catch (e) {
    // Sin JWT_SECRET válido no podemos firmar: mejor OSM que un mapa roto
    console.warn('[MAP_TILES] sin firma, uso OSM:', e.message);
    return { ...OSM_TILES };
  }
}

const TILE_PATH = /^\/api\/map-tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(@2x)?$/;

export function parseTilePath(pathname) {
  const m = TILE_PATH.exec(pathname);
  if (!m) return null;
  const z = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (z > 22) return null;
  const n = 2 ** z;
  if (x >= n || y >= n) return null;
  return { z, x, y, retina: Boolean(m[4]) };
}

/**
 * GET /api/map-tiles/:z/:x/:y[@2x]?exp=&sig=
 */
export async function handleMapTile(request, env) {
  const url = new URL(request.url);
  const tile = parseTilePath(url.pathname);
  if (!tile) return new Response('Tile inválido', { status: 400, headers: CORS_HEADERS });

  const ok = await verifyTileGrant(env, url.searchParams.get('exp'), url.searchParams.get('sig'));
  if (!ok) return new Response('Firma de mapa vencida o inválida', { status: 403, headers: CORS_HEADERS });

  const token = mapboxToken(env);
  if (!token) return new Response('Mapa base no configurado', { status: 404, headers: CORS_HEADERS });

  const upstream =
    `https://api.mapbox.com/styles/v1/${mapboxStyle(env)}/tiles/256/` +
    `${tile.z}/${tile.x}/${tile.y}${tile.retina ? '@2x' : ''}` +
    `?access_token=${encodeURIComponent(token)}`;

  let res;
  try {
    // cacheEverything: Cloudflare cachea en el edge respetando el Cache-Control de Mapbox
    res = await fetch(upstream, { cf: { cacheEverything: true } });
  } catch (e) {
    console.warn('[MAP_TILES] upstream', e.message);
    return new Response(null, { status: 502, headers: CORS_HEADERS });
  }
  if (!res.ok) {
    return new Response(null, { status: res.status === 404 ? 404 : 502, headers: CORS_HEADERS });
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': res.headers.get('Content-Type') || 'image/png',
      'Cache-Control': res.headers.get('Cache-Control') || 'public, max-age=3600',
    },
  });
}

/**
 * GET /api/map-tiles/config — URL firmada nueva cuando la del render venció
 * (la Torre queda abierta días). Requiere sesión de operador (lo chequea el router).
 */
export async function getMapTileConfig(request, env) {
  const cfg = await buildMapTileConfig(env);
  return new Response(JSON.stringify(cfg), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
