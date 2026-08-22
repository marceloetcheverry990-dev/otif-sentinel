/**
 * Recálculo de viajes ya armados: perfil, N° camiones y clima.
 * No mueve paradas congeladas (ENTREGADO / RECHAZADO / EN_SITIO).
 */

import { splitFrozenOpen } from './midday-reopt.js';
import { calcularDistanciaKm } from './vrp-solver.js';

export function classifyTripStops(stops) {
  const { frozen, open } = splitFrozenOpen(stops);
  if (!frozen.length && !open.length) return { kind: 'empty', frozen, open };
  const rolling = open.some((s) => String(s.estado_operacional || '').toUpperCase() === 'EN_RUTA');
  if (frozen.length || rolling) return { kind: 'in_progress', frozen, open };
  return { kind: 'unstarted', frozen, open };
}

/**
 * Choferes del recálculo: primero los ya asignados a viajes sin salir,
 * después DISPONIBLE, tope nCamiones. Si n < asignados, se fusionan.
 */
export function selectRecalcDrivers(assigned, disponibles, nCamiones) {
  const cap = Math.max(0, Number(nCamiones) || 0);
  const seen = new Set();
  const out = [];
  function push(d) {
    if (!d || out.length >= cap) return;
    const id = String(d.chofer_id ?? '');
    if (!id || seen.has(id)) return;
    if (!d.patente_asignada) return;
    seen.add(id);
    out.push(d);
  }
  for (const d of assigned || []) push(d);
  for (const d of disponibles || []) push(d);
  return out.slice(0, cap);
}

export function parseSelectedTripIds(raw) {
  if (raw == null || raw === '') {
    return { ok: false, error: 'Elegí al menos un viaje para recalcular.' };
  }
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const ids = [];
  const seen = new Set();
  for (const item of list) {
    const id = String(item || '').trim();
    if (!id || id.length > 80) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) return { ok: false, error: 'Elegí al menos un viaje para recalcular.' };
  if (ids.length > 50) return { ok: false, error: 'Máximo 50 viajes por recálculo.' };
  return { ok: true, ids };
}

export function estimateOpenEtas(openStops, seed, velocidadKmH) {
  const vel = Math.max(5, Number(velocidadKmH) || 35);
  let tMs = Date.now();
  let lat = Number(seed?.lat);
  let lng = Number(seed?.lng);
  const map = new Map();
  for (const s of openStops || []) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const km = calcularDistanciaKm(lat, lng, s.lat, s.lng) * 1.2;
      tMs += (km / vel) * 3600 * 1000;
    } else {
      tMs += 20 * 60 * 1000;
    }
    map.set(s.ot_id, new Date(tMs).toISOString());
    tMs += 5 * 60 * 1000;
    lat = s.lat;
    lng = s.lng;
  }
  return map;
}
