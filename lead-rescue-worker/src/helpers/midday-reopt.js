/**
 * Inserción mid-day: costo de meter un stop en una ruta existente
 * sin tocar el prefijo congelado (ENTREGADO / EN_SITIO / RECHAZADO).
 */

import { calcularDistanciaKm, DEFAULT_DEPOT, routeFeasibleTw } from './vrp-solver.js';
import { tagsConflict } from './cargo-constraints.js';

export const FROZEN_STATES = new Set(['ENTREGADO', 'RECHAZADO', 'EN_SITIO']);
export const OPEN_STATES = new Set(['CAMION_ASIGNADO', 'EN_RUTA', 'PENDIENTE', 'PENDIENTE_RUTEO']);

/**
 * Separa paradas congeladas (ya hechas / en sitio) del resto.
 * @returns {{ frozen: object[], open: object[] }}
 */
export function splitFrozenOpen(stops) {
  const sorted = [...(stops || [])].sort(
    (a, b) => (Number(a.stop_sequence) || 0) - (Number(b.stop_sequence) || 0)
  );
  const frozen = [];
  const open = [];
  for (const s of sorted) {
    const st = String(s.estado_operacional || '').toUpperCase();
    if (FROZEN_STATES.has(st)) frozen.push(s);
    else open.push(s);
  }
  return { frozen, open };
}

/**
 * Costo delta (km) de insertar `candidate` en la posición `insertAt`
 * de la secuencia open (0 = justo después del frozen / seed).
 *
 * seed = posición actual del camión (GPS) o última frozen o bodega.
 */
export function insertionDeltaKm(openStops, candidate, insertAt, seed, depot = DEFAULT_DEPOT) {
  const seedLat = seed?.lat ?? depot.lat;
  const seedLng = seed?.lng ?? depot.lng;
  const before = openStops.slice(0, insertAt);
  const after = openStops.slice(insertAt);

  const prev = before.length
    ? before[before.length - 1]
    : { lat: seedLat, lng: seedLng };
  const next = after.length ? after[0] : null;

  const addIn =
    calcularDistanciaKm(prev.lat, prev.lng, candidate.lat, candidate.lng) +
    (next
      ? calcularDistanciaKm(candidate.lat, candidate.lng, next.lat, next.lng)
      : calcularDistanciaKm(candidate.lat, candidate.lng, depot.lat, depot.lng));

  const removeOld = next
    ? calcularDistanciaKm(prev.lat, prev.lng, next.lat, next.lng)
    : calcularDistanciaKm(prev.lat, prev.lng, depot.lat, depot.lng);

  return addIn - removeOld;
}

/**
 * Mejor posición de inserción en un viaje.
 * @returns {{ insertAt: number, deltaKm: number, newOpen: object[] } | null}
 */
export function bestInsertion(openStops, candidate, {
  seed = null,
  depot = DEFAULT_DEPOT,
  capacity = Infinity,
  capacityWeight = Infinity,
  currentVolume = 0,
  currentWeight = 0,
  startMs = Date.now(),
  velocidadKmH = 35,
  existingTags = [],
} = {}) {
  if (!candidate || !Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng)) {
    return null;
  }
  const vol = Number(candidate.volumen || 1);
  const weight = Number(candidate.peso_kg || 0);
  if (currentVolume + vol > capacity + 1e-6) return null;
  if (Number.isFinite(capacityWeight) && currentWeight + weight > capacityWeight + 1e-6) return null;
  if (tagsConflict(existingTags, candidate.tags || candidate.tags_requeridos)) return null;

  let best = null;
  const slots = (openStops?.length || 0) + 1;
  for (let i = 0; i < slots; i++) {
    const delta = insertionDeltaKm(openStops || [], candidate, i, seed, depot);
    const newOpen = [...(openStops || [])];
    newOpen.splice(i, 0, candidate);
    if (!routeFeasibleTw(newOpen, startMs, velocidadKmH, depot).ok) continue;
    if (!best || delta < best.deltaKm) {
      best = { insertAt: i, deltaKm: delta, newOpen };
    }
  }
  return best;
}

/**
 * Elige el mejor viaje activo para insertar un pendiente.
 * @param {Array<{ trip_id, open, frozen, capacity, volume, seed, tags }>} trips
 */
export function pickBestTripForInsert(trips, candidate, { depot = DEFAULT_DEPOT } = {}) {
  let best = null;
  for (const trip of trips || []) {
    const candTags = Array.isArray(candidate.tags) ? candidate.tags : [];
    const tripTags = Array.isArray(trip.tags) ? trip.tags : [];
    // Pedido con tags (ej. HAZMAT) solo a choferes que los tengan
    if (candTags.length) {
      const ok = candTags.every((t) => tripTags.includes(t));
      if (!ok) continue;
    }
    const tripDepot = trip.depot || depot;
    const ins = bestInsertion(trip.open, candidate, {
      seed: trip.seed,
      capacity: trip.capacity,
      capacityWeight: trip.capacityWeight ?? Infinity,
      currentVolume: trip.volume,
      currentWeight: trip.weight ?? 0,
      existingTags: tripTags,
      depot: tripDepot,
      startMs: trip.startMs || Date.now(),
      velocidadKmH: trip.velocidadKmH || 35,
    });
    if (!ins) continue;
    if (!best || ins.deltaKm < best.deltaKm) {
      best = { ...ins, trip_id: trip.trip_id, chofer_id: trip.chofer_id, patente: trip.patente };
    }
  }
  return best;
}

/**
 * Reconstruye stop_sequence: frozen primero (conserva orden), luego open.
 */
export function rebuildSequences(frozen, open) {
  // A-16: no renumerar frozen (no se persisten) — open empieza tras el max seq congelado
  const out = [];
  let maxFrozen = 0;
  for (const s of frozen || []) {
    const seq = Number(s.stop_sequence) || 0;
    if (seq > maxFrozen) maxFrozen = seq;
    out.push({ ...s });
  }
  if (maxFrozen === 0 && (frozen || []).length > 0) {
    maxFrozen = frozen.length;
  }
  let next = maxFrozen + 1;
  for (const s of open || []) {
    out.push({ ...s, stop_sequence: next++ });
  }
  return out;
}
