/**
 * Lead Rescue — ranking de camiones cercanos con cupo para rescatar carga.
 */

import { CONFIG } from '../config.js';
import { tagsConflict } from './cargo-constraints.js';
import { calcularDistanciaKm } from './vrp-solver.js';
import { bestInsertion, rebuildSequences, splitFrozenOpen } from './midday-reopt.js';

/**
 * @param {{
 *   stuckLat: number,
 *   stuckLng: number,
 *   candidates: Array<{
 *     trip_id: string,
 *     chofer_id?: string,
 *     patente?: string,
 *     lat: number,
 *     lng: number,
 *     capacity: number,
 *     capacityWeight?: number,
 *     volume: number,
 *     weight?: number,
 *     open?: object[],
 *     frozen?: object[],
 *     tags?: string[],
 *     nombre?: string
 *   }>,
 *   cargoVolume?: number,
 *   cargoWeight?: number,
 *   cargoTags?: string[],
 *   limit?: number,
 *   velocidadKmH?: number
 * }} opts
 */
export function rankRescueCandidates(opts) {
  const {
    stuckLat,
    stuckLng,
    candidates = [],
    cargoVolume = 0,
    cargoWeight = 0,
    cargoTags = [],
    limit = 2,
    velocidadKmH = CONFIG.VELOCIDAD_FALLBACK_KMH || 35,
  } = opts;
  const vel = Math.max(5, Number(velocidadKmH) || 35);

  if (!Number.isFinite(stuckLat) || !Number.isFinite(stuckLng)) return [];

  const ranked = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    const spare = Number(c.capacity || 0) - Number(c.volume || 0);
    if (spare + 1e-6 < Number(cargoVolume || 0)) continue;

    const capW = Number(c.capacityWeight);
    if (Number.isFinite(capW)) {
      const spareW = capW - Number(c.weight || 0);
      if (spareW + 1e-6 < Number(cargoWeight || 0)) continue;
    }

    const tags = Array.isArray(c.tags) ? c.tags : [];
    const need = Array.isArray(cargoTags) ? cargoTags : [];
    const tagSet = new Set(tags.map((t) => String(t).toUpperCase()));
    if (need.length && !need.every((t) => tagSet.has(String(t).toUpperCase()))) continue;
    // No rescatar HAZMAT hacia un viaje/chofer que ya mezcla FOOD (o viceversa)
    if (tagsConflict(need, tags)) continue;

    const delta_km = Math.round(calcularDistanciaKm(stuckLat, stuckLng, c.lat, c.lng) * 100) / 100;
    ranked.push({
      trip_id: c.trip_id,
      chofer_id: c.chofer_id || null,
      patente: c.patente || null,
      nombre: c.nombre || null,
      lat: c.lat,
      lng: c.lng,
      delta_km,
      spare_volume: Math.round(spare * 100) / 100,
      spare_weight: Number.isFinite(capW)
        ? Math.round((capW - Number(c.weight || 0)) * 100) / 100
        : null,
      capacity: Number(c.capacity || 0),
      capacity_weight: Number.isFinite(capW) ? capW : null,
      volume: Number(c.volume || 0),
      weight: Number(c.weight || 0),
      eta_min_approx: Math.max(1, Math.round((delta_km / vel) * 60)),
    });
  }

  ranked.sort((a, b) => a.delta_km - b.delta_km || b.spare_volume - a.spare_volume);
  return ranked.slice(0, Math.max(1, limit));
}

/**
 * Inserta stops transferibles en un viaje rescate (secuencias reconstruidas).
 * @returns {{ sequenced: object[], deltaKmTotal: number } | null}
 */
export function planRescueInsertion(rescueTrip, transferableStops, depot) {
  if (!rescueTrip || !transferableStops?.length) return null;

  let open = [...(rescueTrip.open || [])];
  const frozen = [...(rescueTrip.frozen || [])];
  let volume = Number(rescueTrip.volume || 0);
  let weight = Number(rescueTrip.weight || 0);
  const capacity = Number(rescueTrip.capacity || Infinity);
  const capacityWeight = Number(rescueTrip.capacityWeight ?? Infinity);
  let deltaKmTotal = 0;
  const inserted = [];

  for (const stop of transferableStops) {
    const ins = bestInsertion(open, stop, {
      seed: rescueTrip.seed,
      capacity,
      capacityWeight,
      currentVolume: volume,
      currentWeight: weight,
      existingTags: rescueTrip.tags || [],
      depot,
      velocidadKmH: rescueTrip.velocidadKmH || 35,
      startMs: rescueTrip.startMs || Date.now(),
    });
    if (!ins) continue;
    open = ins.newOpen;
    volume += Number(stop.volumen || 1);
    weight += Number(stop.peso_kg || 0);
    deltaKmTotal += ins.deltaKm;
    inserted.push(stop);
  }

  if (!inserted.length) return null;
  const sequenced = rebuildSequences(frozen, open);
  return { sequenced, deltaKmTotal: Math.round(deltaKmTotal * 100) / 100, inserted };
}

export { splitFrozenOpen, rebuildSequences };
