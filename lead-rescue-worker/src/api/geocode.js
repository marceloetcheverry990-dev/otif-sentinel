// src/api/geocode.js
// Autocomplete + resolve de direcciones para Torre de Control (operador).

import { CORS_HEADERS } from '../config.js';
import { suggestAddresses, geocodeAddress } from '../helpers/geocode.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/**
 * GET /api/geocode/suggest?q=...
 */
export async function handleGeocodeSuggest(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 4) return json({ suggestions: [] });

  const suggestions = await suggestAddresses(q, env, { limit: 7 });
  return json({
    suggestions: suggestions.map((s) => ({
      display: s.display,
      lat: s.lat,
      lng: s.lng,
      house_number: s.houseNumber || null,
      precision: s.precision,
      provider: s.provider,
      score: s.score,
    })),
  });
}

/**
 * GET /api/geocode?q=...
 */
export async function handleGeocodeResolve(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 4) return json({ error: 'q requerido' }, 400);

  const hit = await geocodeAddress(q, env);
  if (!hit) return json({ found: false, result: null });

  return json({
    found: true,
    result: {
      display: hit.display,
      lat: hit.lat,
      lng: hit.lng,
      house_number: hit.houseNumber || null,
      precision: hit.precision,
      provider: hit.provider,
      score: hit.score,
    },
  });
}
