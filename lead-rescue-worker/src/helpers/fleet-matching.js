/**
 * Flota mixta: emparejar rutas con camiones de distinta capacidad.
 *
 * Antes el solver armaba rutas con la capacidad PROMEDIO de la flota: con
 * camiones de 150 + 50 + 50 salían rutas de ~80 que los chicos no podían llevar
 * y esas OTs quedaban sin asignar. Ahora cada ruta tiene que poder ir en un
 * camión distinto de la flota real (emparejamiento bipartito, Kuhn).
 */

import { routeVolume, routeWeight } from './cargo-constraints.js';

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {Array<{capacity?: number, capacityWeight?: number, tags?: string[]}>} vehicles
 * @returns flota normalizada, más grande primero
 */
export function normalizeFleet(vehicles) {
  return (vehicles || [])
    .map((v, idx) => ({
      idx,
      capacity: num(v?.capacity ?? v?.capacidad_volumen, 100),
      capacityWeight: num(v?.capacityWeight ?? v?.capacidad_peso, Infinity),
      tags: Array.isArray(v?.tags) ? v.tags.map((t) => String(t).toUpperCase()) : null,
    }))
    .sort((a, b) => b.capacity - a.capacity || b.capacityWeight - a.capacityWeight);
}

/** Carga de una ruta (o de un objeto { volumen, peso }). */
export function loadOf(route) {
  if (Array.isArray(route)) return { vol: routeVolume(route), peso: routeWeight(route) };
  return { vol: Number(route?.vol) || 0, peso: Number(route?.peso) || 0 };
}

export function fitsVehicle(load, v) {
  return load.vol <= v.capacity + 1e-9 && load.peso <= v.capacityWeight + 1e-9;
}

/**
 * Condición necesaria rápida (para usar en cada fusión del solver): las k rutas
 * más cargadas tienen que caber en los k camiones más grandes, por dimensión.
 */
export function fleetGreedyOk(loads, fleet) {
  const n = Math.min(loads.length, fleet.length);
  const vols = loads.map((l) => l.vol).sort((a, b) => b - a);
  const caps = fleet.map((v) => v.capacity).sort((a, b) => b - a);
  for (let i = 0; i < n; i++) if (vols[i] > caps[i] + 1e-9) return false;
  const pesos = loads.map((l) => l.peso).sort((a, b) => b - a);
  const capsW = fleet.map((v) => v.capacityWeight).sort((a, b) => b - a);
  for (let i = 0; i < n; i++) if (pesos[i] > capsW[i] + 1e-9) return false;
  return true;
}

/**
 * Tamaño del emparejamiento máximo genérico (Kuhn) entre `nItems` y `nAgents`.
 * @param {(item: number, agent: number) => boolean} fits
 */
export function maxMatchingSize(nItems, nAgents, fits) {
  const itemOfAgent = new Array(nAgents).fill(-1);
  function tryItem(i, seen) {
    for (let a = 0; a < nAgents; a++) {
      if (seen[a] || !fits(i, a)) continue;
      seen[a] = true;
      if (itemOfAgent[a] === -1 || tryItem(itemOfAgent[a], seen)) {
        itemOfAgent[a] = i;
        return true;
      }
    }
    return false;
  }
  let size = 0;
  for (let i = 0; i < nItems; i++) if (tryItem(i, new Array(nAgents).fill(false))) size++;
  return size;
}

/**
 * Emparejamiento máximo ruta→camión.
 * @param {object[][]|{vol,peso}[]} routes
 * @param {object[]} fleet normalizada
 * @param {(routeIdx: number, vehicle: object) => boolean} [extraFits] p.ej. tags
 * @returns {{ matched: number, unmatched: number[], vehicleOf: number[] }}
 *   vehicleOf[i] = índice en `fleet` o -1
 */
export function matchRoutesToFleet(routes, fleet, extraFits = null) {
  const loads = routes.map(loadOf);
  const vehicleOf = new Array(routes.length).fill(-1);
  const routeOfVehicle = new Array(fleet.length).fill(-1);
  const can = (r, v) => fitsVehicle(loads[r], fleet[v]) && (!extraFits || extraFits(r, fleet[v]));

  function tryAssign(r, seen) {
    for (let v = 0; v < fleet.length; v++) {
      if (seen[v] || !can(r, v)) continue;
      seen[v] = true;
      if (routeOfVehicle[v] === -1 || tryAssign(routeOfVehicle[v], seen)) {
        routeOfVehicle[v] = r;
        vehicleOf[r] = v;
        return true;
      }
    }
    return false;
  }

  // Rutas más cargadas primero: menos backtracking
  const order = routes.map((_, i) => i).sort((a, b) => loads[b].vol - loads[a].vol || loads[b].peso - loads[a].peso);
  for (const r of order) tryAssign(r, new Array(fleet.length).fill(false));
  const unmatched = vehicleOf.map((v, i) => (v === -1 ? i : -1)).filter((i) => i !== -1);
  return { matched: routes.length - unmatched.length, unmatched, vehicleOf };
}
