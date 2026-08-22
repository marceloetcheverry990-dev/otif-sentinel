/**
 * POST /api/route-geometry — geometría de ruta para la Torre (Mapbox, OSRM solo si falta token).
 * body: { coordinates: [[lat, lng], ...] }
 */

import { CORS_HEADERS, requireTenantId } from '../config.js';
import {
  downsampleLatLngs,
  fetchDrivingGeometry,
} from '../helpers/mapbox-directions.js';

const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function parsePoints(body) {
  const raw = body?.coordinates;
  if (!Array.isArray(raw) || raw.length < 2) return { error: 'coordinates requiere ≥2 puntos [lat,lng]' };
  if (raw.length > 100) return { error: 'Demasiados waypoints' };
  const points = [];
  for (const pair of raw) {
    const lat = Number(Array.isArray(pair) ? pair[0] : pair?.lat);
    const lng = Number(Array.isArray(pair) ? pair[1] : pair?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    points.push({ lat, lng });
  }
  if (points.length < 2) return { error: 'coordinates inválidas' };
  return { points };
}

export async function getRouteGeometry(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }

  const parsed = parsePoints(body);
  if (parsed.error) return json({ error: parsed.error }, 400);

  const got = await fetchDrivingGeometry(env, parsed.points, {
    timeoutMs: 8000,
    osrmTimeoutMs: 5000,
  });
  const route = got.route;

  if (!route?.geometry?.coordinates?.length) {
    return json({
      exito: true,
      fallback: true,
      provider: null,
      reason: got.reason || 'no_geometry',
      coordinates: parsed.points.map((p) => [p.lat, p.lng]),
    });
  }

  const latlngs = downsampleLatLngs(
    route.geometry.coordinates.map((c) => [c[1], c[0]]),
    400,
  );
  return json({
    exito: true,
    fallback: false,
    provider: got.provider,
    reason: got.reason || 'ok',
    coordinates: latlngs,
  });
}
