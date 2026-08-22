/**
 * Directions para pintar o estimar (servidor). El token no sale al navegador.
 * overview=simplified reduce geometría para Leaflet sin trabar el hilo.
 */

export const MAPBOX_MAX_WAYPOINTS = 25;
const DEFAULT_TIMEOUT_MS = 6000;

export function downsampleLatLngs(coords, maxPts = 400) {
  if (!Array.isArray(coords) || coords.length <= maxPts) return coords || [];
  if (maxPts < 2) return coords.slice(0, 1);
  const last = coords.length - 1;
  const step = last / (maxPts - 1);
  const out = [];
  for (let i = 0; i < maxPts; i++) {
    out.push(coords[Math.round(i * step)]);
  }
  return out;
}

export function clampWaypoints(points) {
  if (!Array.isArray(points) || points.length <= MAPBOX_MAX_WAYPOINTS) return points || [];
  const first = points[0];
  const last = points[points.length - 1];
  const mid = points.slice(1, -1);
  const keep = MAPBOX_MAX_WAYPOINTS - 2;
  if (mid.length <= keep) return [first, ...mid, last];
  const step = (mid.length - 1) / (keep - 1);
  const sampled = [];
  for (let i = 0; i < keep; i++) sampled.push(mid[Math.round(i * step)]);
  return [first, ...sampled, last];
}

function usablePoints(points) {
  return Array.isArray(points) ? points.filter((p) =>
    p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)),
  ) : [];
}

async function fetchJsonRoute(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) return { ok: false, status: res.status, route: null };
    const data = await res.json();
    const route = data?.routes?.[0];
    if ((data.code !== 'Ok' && data.code !== 'ok') || !route?.geometry?.coordinates?.length) {
      return { ok: false, status: res.status, route: null };
    }
    return { ok: true, status: res.status, route };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return { ok: false, status: aborted ? 408 : 0, route: null };
  } finally {
    clearTimeout(id);
  }
}

/**
 * @param {{ MAPBOX_TOKEN?: string, MAPBOX_ACCESS_TOKEN?: string }} env
 * @param {{ lat: number, lng: number }[]} points
 * @returns {Promise<object|null>} route de Mapbox (geometry, distance, duration, legs)
 */
export async function fetchMapboxDrivingRoute(env, points, opts = {}) {
  const token = env?.MAPBOX_TOKEN || env?.MAPBOX_ACCESS_TOKEN;
  if (!token) return null;
  const raw = usablePoints(points);
  if (raw.length < 2) return null;
  const clamped = clampWaypoints(raw);
  const overview = opts.overview || 'simplified';
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const coordsString = clamped.map((c) => `${c.lng},${c.lat}`).join(';');
  const profiles = ['mapbox/driving-traffic', 'mapbox/driving'];
  for (const profile of profiles) {
    const url =
      `https://api.mapbox.com/directions/v5/${profile}/${coordsString}` +
      `?geometries=geojson&overview=${encodeURIComponent(overview)}&steps=false` +
      `&access_token=${encodeURIComponent(token)}`;
    const got = await fetchJsonRoute(url, timeoutMs);
    if (got.route) return got.route;
  }
  return null;
}

/**
 * Geometría para pintar: Mapbox si hay token; si no, OSRM simplificado en el Worker
 * (nunca en el navegador, overview=simplified, ≤400 puntos).
 */
export async function fetchDrivingGeometry(env, points, opts = {}) {
  const token = env?.MAPBOX_TOKEN || env?.MAPBOX_ACCESS_TOKEN;
  const raw = usablePoints(points);
  if (raw.length < 2) return { route: null, provider: null, reason: 'too_few_points' };
  const paintOpts = { overview: 'simplified', timeoutMs: opts.timeoutMs };

  if (token) {
    const route = await fetchMapboxDrivingRoute(env, raw, paintOpts);
    if (route?.geometry?.coordinates?.length) {
      return { route, provider: 'mapbox', reason: 'ok' };
    }
  }

  const osrmTimeout = Number.isFinite(opts.osrmTimeoutMs) ? opts.osrmTimeoutMs : 5000;
  const clamped = clampWaypoints(raw);
  const coordsString = clamped.map((c) => `${c.lng},${c.lat}`).join(';');
  const osrmUrl =
    `https://router.project-osrm.org/route/v1/driving/${coordsString}` +
    `?overview=simplified&geometries=geojson&steps=false`;
  const osrm = await fetchJsonRoute(osrmUrl, osrmTimeout, {
    'User-Agent': 'OTIF-Sentinel/1.0',
  });
  if (osrm.route) {
    return {
      route: osrm.route,
      provider: 'osrm',
      reason: token ? 'mapbox_failed' : 'no_token',
    };
  }

  return {
    route: null,
    provider: null,
    reason: token ? 'mapbox_and_osrm_failed' : 'no_token',
  };
}
