/**
 * VRP heurístico de calidad (Worker-friendly).
 * Clarke-Wright (savings) + 2-opt local search.
 * Hard constraints: volume, weight, time windows (VRPTW), HAZMAT/FOOD segregation,
 * flota real (cada ruta tiene que caber en un camión distinto).
 */

import {
  fitsCapacity,
  tagsConflict,
  unionTags,
  hasHazmat,
  hasFood,
  normalizeTags,
} from './cargo-constraints.js';
import {
  normalizeFleet,
  fleetGreedyOk,
  matchRoutesToFleet,
  loadOf,
} from './fleet-matching.js';

export const DEFAULT_DEPOT = { lat: -33.5132, lng: -70.7672 };

const DEFAULT_SERVICE_SEC = 5 * 60;
const LUNCH_FROM_HOUR = 13;
const LUNCH_TO_HOUR = 15;
const LUNCH_MS = 3600000;
const FULL_SEEDS_MAX_STOPS = 12;

export function calcularDistanciaKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function routeDistanceKm(stops, depot = DEFAULT_DEPOT) {
  if (!stops.length) return 0;
  let d = calcularDistanciaKm(depot.lat, depot.lng, stops[0].lat, stops[0].lng);
  for (let i = 0; i < stops.length - 1; i++) {
    d += calcularDistanciaKm(stops[i].lat, stops[i].lng, stops[i + 1].lat, stops[i + 1].lng);
  }
  d += calcularDistanciaKm(
    stops[stops.length - 1].lat,
    stops[stops.length - 1].lng,
    depot.lat,
    depot.lng
  );
  return d;
}

// Parsear la fecha en cada simulación era el 80% del CPU del solver: se cachea
// por parada (clave = el string, por si alguien cambia la ventana de la OT).
const windowCache = new WeakMap();

function parseWindow(o, field) {
  const raw = field === 'end' ? (o.ventana_fin || o.fecha_hora_sla) : o.ventana_inicio;
  let entry = windowCache.get(o);
  if (!entry) {
    entry = {};
    windowCache.set(o, entry);
  }
  const hit = entry[field];
  if (hit && hit.raw === raw) return hit.ms;
  let ms = null;
  if (raw) {
    const t = new Date(raw).getTime();
    ms = Number.isFinite(t) ? t : null;
  }
  entry[field] = { raw, ms };
  return ms;
}

/** Hard deadline: ventana_fin || fecha_hora_sla */
export function stopWindowEndMs(o) {
  return o ? parseWindow(o, 'end') : null;
}

export function stopWindowStartMs(o) {
  return o ? parseWindow(o, 'start') : null;
}

/** Offset de America/Santiago en un instante (hora local = UTC + offset). */
export function santiagoOffsetMs(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * Modelo de tiempo único para factibilidad (ventanas), costo SLA y ETAs.
 * Antes el solver suponía 5 min por parada y sin colación, mientras las ETA del
 * optimizador usaban el tiempo histórico del cliente (B2B 45 min) y la hora de
 * almuerzo: rutas "factibles" para el solver llegaban tarde en la ETA guardada.
 *
 * @param {object} o
 * @param {number} [o.startMs] hora de salida de bodega
 * @param {number} [o.velocidadKmH]
 * @param {(stop) => number} [o.serviceSecondsFn] tiempo de servicio por parada
 * @param {number} [o.roadFactor] km de calle / km en línea recta
 * @param {boolean} [o.lunchBreak] 1 h de colación la primera vez que se llega entre 13 y 15 (Chile)
 */
export function makeTiming({
  startMs = Date.now(),
  velocidadKmH = 35,
  depot = DEFAULT_DEPOT,
  serviceSecondsFn = null,
  roadFactor = 1,
  lunchBreak = false,
} = {}) {
  const origin = Number.isFinite(startMs) ? startMs : Date.now();
  return {
    startMs: origin,
    vel: Math.max(5, Number(velocidadKmH) || 35),
    depot: depot || DEFAULT_DEPOT,
    serviceMs(o) {
      const s = serviceSecondsFn ? Number(serviceSecondsFn(o)) : DEFAULT_SERVICE_SEC;
      return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_SERVICE_SEC) * 1000;
    },
    roadFactor: Number(roadFactor) > 0 ? Number(roadFactor) : 1,
    tzOffsetMs: lunchBreak ? santiagoOffsetMs(origin) : null,
  };
}

/**
 * Simula llegadas desde la bodega. Espera hasta ventana_inicio; infactible si se
 * llega después de ventana_fin (salvo SLA ya vencido al despacho: se entrega igual).
 */
function simulate(stops, tm) {
  let t = tm.startMs;
  let lat = tm.depot.lat;
  let lng = tm.depot.lng;
  let lunchTaken = false;
  let ok = true;
  const arrivals = [];
  for (const o of stops) {
    t += ((calcularDistanciaKm(lat, lng, o.lat, o.lng) * tm.roadFactor) / tm.vel) * 3600000;
    const startW = stopWindowStartMs(o);
    if (startW != null && t < startW) t = startW;
    arrivals.push(t);
    const endW = stopWindowEndMs(o);
    if (endW != null && endW > tm.startMs && t > endW + 1e-6) ok = false;
    t += tm.serviceMs(o);
    if (tm.tzOffsetMs != null && !lunchTaken) {
      const hour = ((Math.floor((arrivals[arrivals.length - 1] + tm.tzOffsetMs) / 3600000) % 24) + 24) % 24;
      if (hour >= LUNCH_FROM_HOUR && hour < LUNCH_TO_HOUR) {
        t += LUNCH_MS;
        lunchTaken = true;
      }
    }
    lat = o.lat;
    lng = o.lng;
  }
  return { ok, arrivals };
}

/**
 * @param {object} [extra] serviceSecondsFn / roadFactor / lunchBreak (ver makeTiming)
 * @returns {{ ok: boolean, arrivals: number[] }}
 */
export function routeFeasibleTw(stops, startMs = Date.now(), velocidadKmH = 35, depot = DEFAULT_DEPOT, extra = {}) {
  if (!stops?.length) return { ok: true, arrivals: [] };
  return simulate(stops, makeTiming({ ...extra, startMs, velocidadKmH, depot }));
}

function stopTags(s) {
  return normalizeTags(s?.tags || s?.tags_requeridos);
}

function routeSegregationOk(stops) {
  // Fuente única de verdad de qué tags son HAZMAT/FOOD: cargo-constraints.js
  const tags = unionTags(stops);
  return !(hasHazmat(tags) && hasFood(tags));
}

function numW(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Urgencia 0–20: más alto = hay que ir antes (SLA vencido o apretado). */
export function slaUrgency(o, startMs) {
  const endW = stopWindowEndMs(o) ?? new Date(o?.fecha_hora_sla || '2099-12-31').getTime();
  if (!Number.isFinite(endW)) return 0;
  const hoursLeft = (endW - startMs) / 3600000;
  if (hoursLeft <= 0) return 8 + Math.min(12, -hoursLeft);
  if (hoursLeft < 2) return 6;
  if (hoursLeft < 6) return 2.5;
  if (hoursLeft < 12) return 0.8;
  return 0.15;
}

/**
 * Costo de perfil: km + ir tarde en SLA/valor/riesgo.
 * Los pesos 0 tienen que poder apagar un término (no usar `|| 1`).
 * Las llegadas salen del mismo modelo de tiempo que la factibilidad (desde bodega).
 */
function softSlaPenalty(stops, tm, pesos = {}) {
  if (!stops.length) return 0;
  const wSla = numW(pesos.peso_sla, 1);
  const wVal = numW(pesos.peso_valor_carga, 0);
  const wRiesgo = numW(pesos.peso_riesgo_ia, 0);
  const { arrivals } = simulate(stops, tm);
  const denom = Math.max(1, stops.length - 1);
  let pen = 0;
  for (let i = 0; i < stops.length; i++) {
    const o = stops[i];
    const endW = stopWindowEndMs(o) ?? new Date(o.fecha_hora_sla || '2099-12-31').getTime();
    if (Number.isFinite(endW) && arrivals[i] > endW) {
      pen += ((arrivals[i] - endW) / 3600000) * 40 * wSla;
    }
    const pos = i / denom;
    pen += pos * slaUrgency(o, tm.startMs) * 18 * wSla;
    pen += pos * (Number(o.valor_oc_clp || 0) / 1e6) * 80 * wVal;
    pen += pos * (Number(o.riesgo_score || o.risk_score || 0) / 100) * 55 * wRiesgo;
  }
  return pen;
}

function routeCost(stops, tm, pesos) {
  return routeDistanceKm(stops, tm.depot) * numW(pesos?.peso_distancia, 1) + softSlaPenalty(stops, tm, pesos);
}

/**
 * Contexto de restricciones de ruta. `fleet` = camiones reales (más grande primero).
 * Una ruta tiene que caber en el camión más grande; el conjunto de rutas tiene que
 * poder repartirse entre camiones distintos (fleetGreedyOk / matchRoutesToFleet).
 */
function makeConstraints({ capacity = Infinity, capacityWeight = Infinity, fleet = null, maxStopsPerRoute = 24 } = {}) {
  const f = fleet && fleet.length ? fleet : null;
  const maxCap = f ? f[0].capacity : Number(capacity);
  const maxCapW = f ? Math.max(...f.map((v) => v.capacityWeight)) : Number(capacityWeight);
  const minCap = f ? Math.min(...f.map((v) => v.capacity)) : maxCap;
  const minCapW = f ? Math.min(...f.map((v) => v.capacityWeight)) : maxCapW;
  return {
    fleet: f,
    maxCap: Number.isFinite(maxCap) ? maxCap : Infinity,
    maxCapW: Number.isFinite(maxCapW) ? maxCapW : Infinity,
    minCap,
    minCapW,
    heterogeneous: Boolean(f) && (minCap < maxCap - 1e-9 || minCapW < maxCapW - 1e-9),
    maxStops: Math.max(1, Number(maxStopsPerRoute) || 24),
  };
}

function isFeasibleRoute(stops, cx, tm) {
  if (stops.length > cx.maxStops) return false;
  if (!routeSegregationOk(stops)) return false;
  if (!fitsCapacity(stops, cx.maxCap, cx.maxCapW).ok) return false;
  return simulate(stops, tm).ok;
}

/** ¿El conjunto sigue cabiendo en la flota si una ruta crece a `load`? */
function fleetStillFits(cx, otherLoads, load) {
  if (!cx.heterogeneous) return true;
  if (load.vol <= cx.minCap + 1e-9 && load.peso <= cx.minCapW + 1e-9) return true;
  return fleetGreedyOk([...otherLoads, load], cx.fleet);
}

/** Acepta opciones sueltas (compatibilidad) o timing/cx ya armados por solveVrp. */
function ctxFrom(opts = {}) {
  const tm = opts.timing || makeTiming(opts);
  const cx = opts.cx || makeConstraints(opts);
  return { tm, cx, pesos: opts.pesos || {} };
}

/**
 * 2-opt: invierte segmentos mientras baje el costo. Nunca cambia una ruta
 * factible por una infactible; si la actual es infactible, toma cualquier
 * factible (antes se quedaba con la semilla infactible si la factible costaba más).
 */
export function twoOptRoute(stops, opts = {}) {
  if (!stops || stops.length < 2) return stops ? [...stops] : [];
  const { tm, cx, pesos } = ctxFrom(opts);
  const maxIter = opts.maxIter || 80;
  let best = [...stops];
  let bestFeasible = isFeasibleRoute(best, cx, tm);
  let bestCost = routeCost(best, tm, pesos);
  let improved = true;
  let iter = 0;

  while (improved && iter < maxIter) {
    improved = false;
    iter += 1;
    for (let i = -1; i < best.length - 2; i++) {
      for (let k = i + 2; k < best.length; k++) {
        const candidate =
          i === -1
            ? best.slice(0, k + 1).reverse().concat(best.slice(k + 1))
            : best.slice(0, i + 1).concat(best.slice(i + 1, k + 1).reverse(), best.slice(k + 1));
        const feasible = isFeasibleRoute(candidate, cx, tm);
        if (bestFeasible && !feasible) continue;
        const c = routeCost(candidate, tm, pesos);
        if ((feasible && !bestFeasible) || c + 1e-9 < bestCost) {
          best = candidate;
          bestCost = c;
          bestFeasible = feasible;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * Clarke-Wright savings (versión paralela) con capacidad, ventanas, segregación
 * y flota real.
 */
export function clarkeWrightRoutes(ordenes, opts = {}) {
  const { tm, cx } = ctxFrom(opts);
  const nodes = (ordenes || []).filter(
    (o) => o && Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lng))
  );
  if (nodes.length === 0) return [];
  if (nodes.length === 1) return [[nodes[0]]];
  const depot = tm.depot;

  const routesById = new Map();
  const loadById = new Map();
  const routeOf = new Map();
  let nextId = 1;

  for (const n of nodes) {
    const rid = `r${nextId++}`;
    routesById.set(rid, [n]);
    loadById.set(rid, loadOf([n]));
    routeOf.set(n.ot_id, rid);
  }

  const savings = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const s =
        calcularDistanciaKm(depot.lat, depot.lng, a.lat, a.lng) +
        calcularDistanciaKm(depot.lat, depot.lng, b.lat, b.lng) -
        calcularDistanciaKm(a.lat, a.lng, b.lat, b.lng);
      savings.push({ i: a, j: b, s });
    }
  }
  savings.sort((x, y) => y.s - x.s);

  const isEndpoint = (route, otId) =>
    route.length > 0 && (route[0].ot_id === otId || route[route.length - 1].ot_id === otId);

  for (const { i, j } of savings) {
    const ri = routeOf.get(i.ot_id);
    const rj = routeOf.get(j.ot_id);
    if (!ri || !rj || ri === rj) continue;

    const routeI = routesById.get(ri);
    const routeJ = routesById.get(rj);
    if (!routeI || !routeJ) continue;
    if (!isEndpoint(routeI, i.ot_id) || !isEndpoint(routeJ, j.ot_id)) continue;
    if (routeI.length + routeJ.length > cx.maxStops) continue;
    if (tagsConflict(unionTags(routeI), unionTags(routeJ))) continue;

    const left = [...routeI];
    const right = [...routeJ];
    if (left[0].ot_id === i.ot_id) left.reverse();
    if (left[left.length - 1].ot_id !== i.ot_id) continue;
    if (right[right.length - 1].ot_id === j.ot_id) right.reverse();
    if (right[0].ot_id !== j.ot_id) continue;

    const merged = left.concat(right);
    if (!isFeasibleRoute(merged, cx, tm)) continue;
    const load = loadOf(merged);
    if (cx.heterogeneous) {
      const others = [];
      for (const [id, l] of loadById) if (id !== ri && id !== rj) others.push(l);
      if (!fleetStillFits(cx, others, load)) continue;
    }

    const newId = `r${nextId++}`;
    routesById.set(newId, merged);
    loadById.set(newId, load);
    for (const o of merged) routeOf.set(o.ot_id, newId);
    routesById.delete(ri);
    routesById.delete(rj);
    loadById.delete(ri);
    loadById.delete(rj);
  }

  return Array.from(routesById.values()).filter((r) => r.length > 0);
}

/**
 * Secuencia dentro de una ruta: semillas (vecino más cercano ponderado por el
 * perfil, "vence primero" y el orden recibido) + 2-opt. Gana la factible más
 * barata. El orden recibido va como semilla para que resecuenciar una ruta que
 * ya cumplía las ventanas nunca la vuelva infactible.
 */
export function sequenceRoute(stops, opts = {}) {
  if (!stops?.length) return [];
  if (stops.length === 1) return [...stops];
  const { tm, cx, pesos } = ctxFrom(opts);
  const inner = { ...opts, timing: tm, cx, pesos };

  const pending = [...stops];
  const nn = [];
  let lat = tm.depot.lat;
  let lng = tm.depot.lng;
  const wDist = numW(pesos.peso_distancia, 1);
  const wSla = numW(pesos.peso_sla, 1);
  const wVal = numW(pesos.peso_valor_carga, 0);
  const wRiesgo = numW(pesos.peso_riesgo_ia, 0);
  while (pending.length) {
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const score =
        calcularDistanciaKm(lat, lng, p.lat, p.lng) * wDist
        - slaUrgency(p, tm.startMs) * 12 * wSla
        - (Number(p.valor_oc_clp || 0) / 1e6) * 70 * wVal
        - (Number(p.riesgo_score || p.risk_score || 0) / 100) * 40 * wRiesgo;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const pick = pending.splice(bestIdx, 1)[0];
    nn.push(pick);
    lat = pick.lat;
    lng = pick.lng;
  }

  // Las otras semillas solo si la primera no cumple ventanas (ahorra CPU en el caso común)
  const seeds = [
    () => nn,
    () => [...stops].sort((a, b) => (stopWindowEndMs(a) ?? Infinity) - (stopWindowEndMs(b) ?? Infinity)),
    () => stops,
  ];
  let best = null;
  for (const seed of seeds) {
    const r = twoOptRoute(seed(), inner);
    const feasible = isFeasibleRoute(r, cx, tm);
    const cost = routeCost(r, tm, pesos);
    if (!best || (feasible && !best.feasible) || (feasible === best.feasible && cost + 1e-9 < best.cost)) {
      best = { r, feasible, cost };
    }
    // Rutas cortas: probar todas (barato, a veces "vence primero" sale más corta)
    if (best.feasible && stops.length > FULL_SEEDS_MAX_STOPS) break;
  }
  return best.r;
}

/**
 * Parte una ruta inviable (plan k-means) en tramos que sí cumplen: primero separa
 * peligrosos de alimentos, después corta por capacidad/ventanas/máx. paradas.
 */
function repairRoute(route, ctx) {
  if (isFeasibleRoute(route, ctx.cx, ctx.tm)) return [route];
  let groups = [route];
  if (!routeSegregationOk(route)) {
    const haz = route.filter((s) => hasHazmat(stopTags(s)));
    const rest = route.filter((s) => !hasHazmat(stopTags(s)));
    groups = [haz, rest].filter((g) => g.length);
  }
  const out = [];
  for (const g of groups) {
    const seq = sequenceRoute(g, ctx.opts);
    let cur = [];
    for (const s of seq) {
      const trial = cur.concat([s]);
      if (cur.length && !isFeasibleRoute(trial, ctx.cx, ctx.tm)) {
        out.push(cur);
        cur = [s];
      } else {
        cur = trial;
      }
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

/** Junta rutas (la fusión que menos km agrega y cumple todo) hasta llegar a `target`. */
function mergeDown(routes, target, ctx) {
  let out = routes.map((r) => [...r]);
  const { cx, tm } = ctx;
  while (out.length > target) {
    let best = null;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        if (a.length + b.length > cx.maxStops) continue;
        if (tagsConflict(unionTags(a), unionTags(b))) continue;
        const others = out.filter((_, k) => k !== i && k !== j).map(loadOf);
        const base = routeDistanceKm(a, tm.depot) + routeDistanceKm(b, tm.depot);
        for (const cand of [a.concat(b), b.concat(a), a.concat([...b].reverse()), [...a].reverse().concat(b)]) {
          if (!isFeasibleRoute(cand, cx, tm)) continue;
          if (!fleetStillFits(cx, others, loadOf(cand))) continue;
          const cost = routeDistanceKm(cand, tm.depot) - base;
          if (!best || cost < best.cost) best = { i, j, cand, cost };
        }
      }
    }
    if (!best) break; // no se puede juntar más sin violar algo: sobran rutas (quedan sin asignar)
    out = out.filter((_, k) => k !== best.i && k !== best.j);
    out.push(sequenceRoute(best.cand, ctx.opts));
  }
  return out;
}

/** "Usar todos": parte la ruta más larga (por secuencia) hasta llegar a `target`. */
function splitUp(routes, target, ctx) {
  let out = routes.map((r) => [...r]);
  while (out.length < target) {
    out.sort((a, b) => b.length - a.length);
    const big = out[0];
    if (!big || big.length < 2) break;
    const seq = sequenceRoute(big, ctx.opts);
    const mid = Math.ceil(seq.length / 2);
    out = [...out.slice(1), seq.slice(0, mid), seq.slice(mid)];
  }
  return out;
}

/**
 * "Usar todos" parejo: mueve paradas de la ruta más larga a la más corta
 * (la que menos km agrega y cumple todo) hasta que difieran en ≤ 1 parada.
 */
function balance(routes, ctx) {
  let out = routes.map((r) => [...r]);
  const { cx, tm } = ctx;
  const totalStops = out.reduce((s, r) => s + r.length, 0);
  for (let iter = 0; iter < totalStops * 2; iter++) {
    out.sort((a, b) => a.length - b.length);
    const small = out[0];
    const big = out[out.length - 1];
    if (!small || !big || big.length - small.length <= 1) break;
    const others = out.slice(1, -1).map(loadOf);
    let best = null;
    const bigKm = routeDistanceKm(big, tm.depot);
    const smallKm = routeDistanceKm(small, tm.depot);
    for (let si = 0; si < big.length; si++) {
      const s = big[si];
      if (tagsConflict(unionTags(small), stopTags(s))) continue;
      const bigAfter = big.filter((_, k) => k !== si);
      if (!isFeasibleRoute(bigAfter, cx, tm)) continue;
      for (let pos = 0; pos <= small.length; pos++) {
        const cand = [...small.slice(0, pos), s, ...small.slice(pos)];
        if (!isFeasibleRoute(cand, cx, tm)) continue;
        if (cx.heterogeneous && !fleetGreedyOk([...others, loadOf(cand), loadOf(bigAfter)], cx.fleet)) continue;
        const delta = routeDistanceKm(cand, tm.depot) - smallKm + routeDistanceKm(bigAfter, tm.depot) - bigKm;
        if (!best || delta < best.delta) best = { si, cand, bigAfter, delta };
      }
    }
    if (!best) break;
    out = [best.cand, ...out.slice(1, -1), best.bigAfter];
  }
  return out;
}

function evaluateRoutes(routes, allStops, ctx) {
  const { cx, tm, pesos } = ctx;
  const ids = new Set(routes.flat().map((s) => String(s.ot_id)));
  const sizes = routes.map((r) => r.length);
  const fleet = cx.fleet || [];
  const match = fleet.length ? matchRoutesToFleet(routes, fleet) : { unmatched: [] };
  const violations = {
    segregation: routes.filter((r) => !routeSegregationOk(r)).length,
    capacity: routes.filter((r) => !fitsCapacity(r, cx.maxCap, cx.maxCapW).ok).length,
    missing: allStops.filter((s) => !ids.has(String(s.ot_id))).length,
    unmatched: match.unmatched.length,
    tw: routes.filter((r) => !simulate(r, tm).ok).length,
    imbalance: sizes.length ? Math.max(...sizes) - Math.min(...sizes) : 0,
  };
  violations.hard = violations.segregation + violations.capacity + violations.missing + violations.unmatched;
  const km = routes.reduce((s, r) => s + routeDistanceKm(r, tm.depot), 0);
  const score = routes.reduce((s, r) => s + routeCost(r, tm, pesos), 0);
  return { violations, kmEstimado: Number(km.toFixed(2)), score: Number(score.toFixed(2)) };
}

/**
 * Arma el contexto común de una corrida: flota real o N camiones iguales,
 * "hasta N" vs "usar todos", modelo de tiempo.
 */
function buildContext(list, opts) {
  const maxStops = Math.max(1, Number(opts.maxStopsPerRoute) || 24);
  const requested = Math.max(1, Math.floor(Number(opts.maxVehicles) || 99));
  let fleet;
  if (Array.isArray(opts.vehicles) && opts.vehicles.length) {
    fleet = normalizeFleet(opts.vehicles).slice(0, requested);
  } else {
    const n = Math.max(1, Math.min(requested, list.length || 1));
    const cap = Math.max(1, Number(opts.capacity) || 100);
    const capW = Number.isFinite(Number(opts.capacityWeight)) ? Number(opts.capacityWeight) : Infinity;
    fleet = normalizeFleet(Array.from({ length: n }, () => ({ capacity: cap, capacityWeight: capW })));
  }
  const tm = opts.timing || makeTiming(opts);
  const cx = makeConstraints({ fleet, maxStopsPerRoute: maxStops });
  const pesos = opts.pesos || { peso_distancia: 1, peso_sla: 1, peso_valor_carga: 0 };
  const force = Boolean(opts.forceAllVehicles);
  const target = force ? Math.min(fleet.length, list.length) : fleet.length;
  const ctx = { tm, cx, pesos, force, target, maxStops };
  ctx.opts = { timing: tm, cx, pesos };
  return ctx;
}

/** Repara, junta/parte según el modo, balancea y secuencia un plan crudo. */
function finalize(rawRoutes, list, ctx, solverName) {
  let routes = [];
  for (const r of rawRoutes) if (r.length) routes.push(...repairRoute(r, ctx));
  routes = mergeDown(routes, ctx.target, ctx);
  if (ctx.force) {
    routes = splitUp(routes, ctx.target, ctx);
    routes = balance(routes, ctx);
  }
  routes = routes.filter((r) => r.length).map((r) => sequenceRoute(r, ctx.opts));
  return { routes, solver: solverName, ...evaluateRoutes(routes, list, ctx) };
}

function validStops(ordenes) {
  return (Array.isArray(ordenes) ? ordenes : []).filter(
    (o) => o && Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lng))
  );
}

/**
 * Clarke-Wright → reparación → N° de camiones → secuencia.
 * opts.forceAllVehicles: usar los N camiones repartidos parejo; si no, hasta N.
 * opts.vehicles: flota real [{capacity, capacityWeight}] (si no, N iguales).
 */
export function solveVrp(ordenes, opts = {}) {
  const list = validStops(ordenes);
  if (!list.length) {
    return { routes: [], solver: 'clarke-wright-2opt-vrptw', kmEstimado: 0, score: 0, violations: { hard: 0, tw: 0, imbalance: 0 } };
  }
  const ctx = buildContext(list, opts);
  let cwCx = ctx.cx;
  if (ctx.force && ctx.target > 1) {
    // Tope de paradas ≈ T/N: Clarke-Wright ya arma rutas del tamaño parejo
    cwCx = { ...ctx.cx, maxStops: Math.max(1, Math.min(ctx.maxStops, Math.ceil(list.length / ctx.target))) };
  }
  const raw = clarkeWrightRoutes(list, { timing: ctx.tm, cx: cwCx });
  return finalize(raw, list, ctx, 'clarke-wright-2opt-vrptw');
}

/** Deterministic PRNG for legacy multi-start */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function capacitatedKMeans(ordenes, K, capacidadMaxVolumen, rng) {
  if (ordenes.length === 0) return [];
  let centroides = [];
  for (let i = 0; i < K; i++) {
    const randomOrder = ordenes[Math.floor(rng() * ordenes.length)];
    centroides.push({ lat: randomOrder.lat, lng: randomOrder.lng });
  }
  let clusters = Array.from({ length: K }, () => []);
  for (let it = 0; it < 10; it++) {
    clusters = Array.from({ length: K }, () => []);
    const capacidades = Array(K).fill(capacidadMaxVolumen);
    const distancias = [];
    for (let i = 0; i < ordenes.length; i++) {
      for (let j = 0; j < K; j++) {
        distancias.push({
          ordenIdx: i,
          clusterIdx: j,
          dist: calcularDistanciaKm(ordenes[i].lat, ordenes[i].lng, centroides[j].lat, centroides[j].lng),
        });
      }
    }
    distancias.sort((a, b) => a.dist - b.dist);
    const asignadas = new Set();
    for (const d of distancias) {
      const orden = ordenes[d.ordenIdx];
      if (!asignadas.has(d.ordenIdx) && capacidades[d.clusterIdx] >= Number(orden.volumen || 1)) {
        clusters[d.clusterIdx].push(orden);
        capacidades[d.clusterIdx] -= Number(orden.volumen || 1);
        asignadas.add(d.ordenIdx);
      }
    }
    for (let j = 0; j < K; j++) {
      if (clusters[j].length > 0) {
        centroides[j] = {
          lat: clusters[j].reduce((a, o) => a + o.lat, 0) / clusters[j].length,
          lng: clusters[j].reduce((a, o) => a + o.lng, 0) / clusters[j].length,
        };
      }
    }
  }
  // Las que no entraron por capacidad van al cluster más cercano; la reparación
  // posterior las separa si se pasan (antes quedaban así, sobre capacidad).
  const assigned = new Set(clusters.flat().map((o) => o.ot_id));
  for (const h of ordenes.filter((o) => !assigned.has(o.ot_id))) {
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < K; j++) {
      const dist = calcularDistanciaKm(h.lat, h.lng, centroides[j].lat, centroides[j].lng);
      if (dist < bestD) {
        bestD = dist;
        best = j;
      }
    }
    clusters[best].push(h);
  }
  return clusters.filter((c) => c.length > 0);
}

/**
 * k-means + greedy (multi-start con seed). Pasa por la misma reparación que
 * Clarke-Wright: antes sus planes ignoraban peso y segregación y, como salían
 * más cortos, le ganaban al plan bueno y el optimizador dejaba OTs sin chofer.
 */
export function solveVrpLegacy(ordenes, opts = {}) {
  const list = validStops(ordenes);
  const seed = opts.seed ?? 1;
  if (!list.length) {
    return { routes: [], solver: `kmeans-greedy#${seed}`, kmEstimado: 0, score: 0, violations: { hard: 0, tw: 0, imbalance: 0 } };
  }
  const ctx = buildContext(list, opts);
  const totalVol = list.reduce((acc, o) => acc + Number(o.volumen || 1), 0);
  const K = ctx.force
    ? ctx.target
    : Math.max(1, Math.min(ctx.target, Math.ceil(totalVol / Math.max(1, ctx.cx.maxCap))));
  const clusters = capacitatedKMeans(list, K, Math.max(1, ctx.cx.maxCap), mulberry32(seed));
  return finalize(clusters, list, ctx, `kmeans-greedy#${seed}`);
}

function candidateKey(c, force) {
  const v = c.violations || {};
  return [v.hard || 0, v.tw || 0, force && (v.imbalance || 0) > 1 ? 1 : 0, c.score ?? c.kmEstimado];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - 1e-9) return -1;
    if (a[i] > b[i] + 1e-9) return 1;
  }
  return 0;
}

/**
 * Corre Clarke-Wright+2opt y varios seeds k-means; elige primero el que NO viola
 * restricciones duras (segregación, capacidad, flota, paradas perdidas), después
 * el de menos ventanas incumplidas, después (si "usar todos") el parejo, y recién
 * ahí el de mejor score del perfil.
 */
export function solveVrpAuto(ordenes, opts = {}) {
  const list = validStops(ordenes);
  const shared = list.length ? { ...opts, timing: opts.timing || makeTiming(opts) } : opts;
  const candidates = [solveVrp(list, shared)];
  // M-11: pocos seeds para acotar CPU en Workers
  for (const seed of [1, 7, 17]) {
    candidates.push(solveVrpLegacy(list, { ...shared, seed }));
  }
  const force = Boolean(opts.forceAllVehicles);
  candidates.sort((a, b) => compareKeys(candidateKey(a, force), candidateKey(b, force)));
  const best = candidates[0];
  return {
    ...best,
    solver: `auto:${best.solver}`,
    candidatos: candidates.map((c) => ({
      solver: c.solver,
      km: c.kmEstimado,
      score: c.score ?? c.kmEstimado,
      violaciones: c.violations?.hard ?? 0,
      ventanas: c.violations?.tw ?? 0,
    })),
  };
}
