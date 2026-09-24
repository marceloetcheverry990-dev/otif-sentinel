/**
 * Directions para pintar o estimar (servidor). El token no sale al navegador.
 * Para pintar se pide overview=full y se simplifica acá con Douglas-Peucker:
 * overview=simplified (y el muestreo por índice) cortaban las esquinas y la
 * línea cruzaba manzanas al hacer zoom.
 */

export const MAPBOX_MAX_WAYPOINTS = 25;
const DEFAULT_TIMEOUT_MS = 6000;

/**
 * Douglas-Peucker sobre [lat, lng]: quita puntos redundantes sin sacar la línea
 * de la calle (a diferencia de muestrear por índice). Proyección equirectangular
 * local a metros — sobra para tramos urbanos.
 * Si queda sobre maxPoints, duplica la tolerancia y reintenta.
 */
export function simplifyLatLngs(coords, { toleranceM = 3, maxPoints = 3000 } = {}) {
  if (!Array.isArray(coords) || coords.length <= 2) return coords || [];
  const lat0 = (Number(coords[0][0]) * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  const xs = coords.map((p) => Number(p[1]) * kx);
  const ys = coords.map((p) => Number(p[0]) * ky);

  const run = (tol) => {
    const keep = new Uint8Array(coords.length);
    keep[0] = 1;
    keep[coords.length - 1] = 1;
    const stack = [[0, coords.length - 1]];
    const tol2 = tol * tol;
    while (stack.length) {
      const [a, b] = stack.pop();
      const dx = xs[b] - xs[a];
      const dy = ys[b] - ys[a];
      const len2 = dx * dx + dy * dy;
      let maxD = -1;
      let idx = -1;
      for (let i = a + 1; i < b; i++) {
        let t = len2 > 0 ? ((xs[i] - xs[a]) * dx + (ys[i] - ys[a]) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = xs[a] + t * dx - xs[i];
        const py = ys[a] + t * dy - ys[i];
        const d2 = px * px + py * py;
        if (d2 > maxD) { maxD = d2; idx = i; }
      }
      if (idx !== -1 && maxD > tol2) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    return coords.filter((_, i) => keep[i]);
  };

  let tol = Math.max(0.5, Number(toleranceM) || 3);
  let out = run(tol);
  while (out.length > maxPoints && tol < 500) {
    tol *= 2;
    out = run(tol);
  }
  return out;
}

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
  // Salida futura (ruteo nocturno para las 08:00): pedir el tráfico de esa hora,
  // no el de ahora. Si Mapbox no acepta depart_at, se reintenta sin él.
  const departAt = Number(opts.departAtMs) > Date.now() + 15 * 60 * 1000
    ? new Date(Number(opts.departAtMs)).toISOString().replace(/\.\d{3}Z$/, 'Z')
    : null;
  const profiles = ['mapbox/driving-traffic', 'mapbox/driving'];
  for (const profile of profiles) {
    for (const depart of departAt ? [departAt, null] : [null]) {
      const url =
        `https://api.mapbox.com/directions/v5/${profile}/${coordsString}` +
        `?geometries=geojson&overview=${encodeURIComponent(overview)}&steps=false` +
        (depart ? `&depart_at=${encodeURIComponent(depart)}` : '') +
        `&access_token=${encodeURIComponent(token)}`;
      const got = await fetchJsonRoute(url, timeoutMs);
      if (got.route) return got.route;
    }
  }
  return null;
}

/**
 * Mapbox acepta ≤25 waypoints por request. clampWaypoints muestreaba y la línea
 * dejaba de pasar por algunas paradas: acá se parte en tramos que comparten el
 * punto de unión y se concatenan.
 */
async function fetchMapboxGeometryChunked(env, raw, opts) {
  if (raw.length <= MAPBOX_MAX_WAYPOINTS) return fetchMapboxDrivingRoute(env, raw, opts);
  const coords = [];
  for (let start = 0; start < raw.length - 1; start += MAPBOX_MAX_WAYPOINTS - 1) {
    const chunk = raw.slice(start, start + MAPBOX_MAX_WAYPOINTS);
    const route = await fetchMapboxDrivingRoute(env, chunk, opts);
    const part = route?.geometry?.coordinates;
    if (!part?.length) return null;
    coords.push(...(coords.length ? part.slice(1) : part));
  }
  return { geometry: { type: 'LineString', coordinates: coords } };
}

/**
 * Geometría para pintar: Mapbox si hay token; si no, OSRM en el Worker (nunca en
 * el navegador). overview=full: el recorte de puntos lo hace simplifyLatLngs.
 */
export async function fetchDrivingGeometry(env, points, opts = {}) {
  const token = env?.MAPBOX_TOKEN || env?.MAPBOX_ACCESS_TOKEN;
  const raw = usablePoints(points);
  if (raw.length < 2) return { route: null, provider: null, reason: 'too_few_points' };
  const paintOpts = { overview: 'full', timeoutMs: opts.timeoutMs };

  if (token) {
    const route = await fetchMapboxGeometryChunked(env, raw, paintOpts);
    if (route?.geometry?.coordinates?.length) {
      return { route, provider: 'mapbox', reason: 'ok' };
    }
  }

  // OSRM acepta hasta 100 coordenadas (tope de /api/route-geometry): sin muestreo
  const osrmTimeout = Number.isFinite(opts.osrmTimeoutMs) ? opts.osrmTimeoutMs : 5000;
  const coordsString = raw.map((c) => `${c.lng},${c.lat}`).join(';');
  const osrmUrl =
    `https://router.project-osrm.org/route/v1/driving/${coordsString}` +
    `?overview=full&geometries=geojson&steps=false`;
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
