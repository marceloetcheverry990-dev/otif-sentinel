/**
 * Restricciones de carga: peso/volumen dual + segregación HAZMAT vs FOOD.
 */

const HAZMAT_TAGS = new Set(['HAZMAT', 'ADR', 'PELGEROSO', 'PELIGROSO', 'PELIGROSA']);
const FOOD_TAGS = new Set(['FOOD', 'ALIMENTO', 'ALIMENTOS', 'FRIO_ALIMENTO']);

export function normalizeTags(raw) {
  if (Array.isArray(raw)) return raw.map((t) => String(t).toUpperCase());
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((t) => String(t).toUpperCase());
    } catch {
      return raw
        .split(',')
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);
    }
  }
  return [];
}

export function hasHazmat(tags) {
  return normalizeTags(tags).some((t) => HAZMAT_TAGS.has(t));
}

export function hasFood(tags) {
  return normalizeTags(tags).some((t) => FOOD_TAGS.has(t));
}

/** True si mezclar estos conjuntos de tags viola segregación v1. */
export function tagsConflict(tagsA, tagsB) {
  const a = normalizeTags(tagsA);
  const b = normalizeTags(tagsB);
  const aHaz = a.some((t) => HAZMAT_TAGS.has(t));
  const aFood = a.some((t) => FOOD_TAGS.has(t));
  const bHaz = b.some((t) => HAZMAT_TAGS.has(t));
  const bFood = b.some((t) => FOOD_TAGS.has(t));
  return (aHaz && bFood) || (aFood && bHaz);
}

export function routeVolume(stops) {
  return (stops || []).reduce((acc, o) => acc + Number(o.volumen || 1), 0);
}

export function routeWeight(stops) {
  return (stops || []).reduce((acc, o) => acc + Number(o.peso_kg || 0), 0);
}

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
export function fitsCapacity(stopsOrVol, capacityVolume, capacityWeight = Infinity, extraStop = null) {
  const stops = Array.isArray(stopsOrVol) ? stopsOrVol : null;
  const vol = stops
    ? routeVolume(stops) + (extraStop ? Number(extraStop.volumen || 1) : 0)
    : Number(stopsOrVol || 0) + (extraStop ? Number(extraStop.volumen || 1) : 0);
  const weight = stops
    ? routeWeight(stops) + (extraStop ? Number(extraStop.peso_kg || 0) : 0)
    : Number(extraStop?.peso_kg || 0);

  const capV = Number(capacityVolume);
  const capW = Number(capacityWeight);
  if (Number.isFinite(capV) && vol > capV + 1e-9) {
    return { ok: false, reason: 'volume_exceeded' };
  }
  if (Number.isFinite(capW) && weight > capW + 1e-9) {
    return { ok: false, reason: 'weight_exceeded' };
  }
  return { ok: true };
}

export function unionTags(stops) {
  const set = new Set();
  for (const s of stops || []) {
    for (const t of normalizeTags(s.tags || s.tags_requeridos)) set.add(t);
  }
  return [...set];
}
