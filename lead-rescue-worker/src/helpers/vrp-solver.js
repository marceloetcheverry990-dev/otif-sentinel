/**
 * VRP heurístico de calidad (Worker-friendly).
 * Clarke-Wright (savings) + 2-opt local search.
 * Hard constraints: volume, weight, time windows (VRPTW), HAZMAT/FOOD segregation.
 */

import {
  fitsCapacity,
  routeVolume as cargoRouteVolume,
  routeWeight as cargoRouteWeight,
  tagsConflict,
  unionTags,
} from './cargo-constraints.js';

export const DEFAULT_DEPOT = { lat: -33.5132, lng: -70.7672 };

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

function polarAngle(depot, stop) {
  return Math.atan2(
    Number(stop.lat) - Number(depot.lat),
    Number(stop.lng) - Number(depot.lng),
  );
}

/**
 * Clarke-Wright solo fusiona; si cabe todo en 1 camión, maxVehicles no partía.
 * Esto abre las rutas más largas hasta el N° pedido (tope: cantidad de paradas).
 */
export function splitUpToVehicles(routes, maxVehicles, depot = DEFAULT_DEPOT) {
  const cap = Math.max(1, Math.floor(Number(maxVehicles) || 1));
  let out = (routes || []).filter((r) => Array.isArray(r) && r.length).map((r) => [...r]);
  if (!out.length) return [];
  const total = out.reduce((s, r) => s + r.length, 0);
  const target = Math.min(cap, total);
  while (out.length < target) {
    out.sort((a, b) => b.length - a.length);
    const big = out[0];
    if (!big || big.length < 2) break;
    out.shift();
    const ordered = [...big].sort((a, b) => polarAngle(depot, a) - polarAngle(depot, b));
    const mid = Math.max(1, Math.min(ordered.length - 1, Math.ceil(ordered.length / 2)));
    out.push(ordered.slice(0, mid), ordered.slice(mid));
  }
  return out.filter((r) => r.length);
}

/** Parte si hay de más camiones, junta si hay de menos, y no pierde paradas. */
export function enforceVehicleCount(routes, maxVehicles, allStops, depot = DEFAULT_DEPOT) {
  let out = splitUpToVehicles(routes, maxVehicles, depot);
  const seen = new Set();
  for (const r of out) {
    for (const s of r) {
      if (s && s.ot_id) seen.add(String(s.ot_id));
    }
  }
  for (const s of allStops || []) {
    const id = s && s.ot_id != null ? String(s.ot_id) : '';
    if (!id || seen.has(id)) continue;
    if (!out.length) out = [[s]];
    else out[0].push(s);
    seen.add(id);
  }
  const cap = Math.max(1, Math.floor(Number(maxVehicles) || 1));
  while (out.length > cap && out.length > 1) {
    out.sort((a, b) => a.length - b.length);
    const a = out.shift();
    const b = out.shift();
    out.push([...(a || []), ...(b || [])]);
  }
  return out.filter((r) => r.length);
}

function routeVolume(stops) {
  return cargoRouteVolume(stops);
}

function routeWeight(stops) {
  return cargoRouteWeight(stops);
}

/** Hard deadline: ventana_fin || fecha_hora_sla */
export function stopWindowEndMs(o) {
  const fin = o?.ventana_fin || o?.fecha_hora_sla;
  if (!fin) return null;
  const ms = new Date(fin).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function stopWindowStartMs(o) {
  if (!o?.ventana_inicio) return null;
  const ms = new Date(o.ventana_inicio).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Simula llegadas. Wait permitido hasta ventana_inicio; rechazo si llegada > ventana_fin.
 * @returns {{ ok: boolean, arrivals?: number[] }}
 */
export function routeFeasibleTw(stops, startMs = Date.now(), velocidadKmH = 35, depot = DEFAULT_DEPOT) {
  if (!stops?.length) return { ok: true, arrivals: [] };
  const vel = Math.max(5, Number(velocidadKmH) || 35);
  const origin = Number.isFinite(startMs) ? startMs : Date.now();
  let t = origin;
  let lat = depot.lat;
  let lng = depot.lng;
  const arrivals = [];
  for (let i = 0; i < stops.length; i++) {
    const o = stops[i];
    const km = calcularDistanciaKm(lat, lng, o.lat, o.lng);
    t += (km / vel) * 3600000;
    if (i > 0) t += 5 * 60 * 1000; // service at previous
    const startW = stopWindowStartMs(o);
    if (startW != null && t < startW) t = startW; // wait
    const endW = stopWindowEndMs(o);
    // SLA ya vencido al despacho: se entrega igual; el costo blando lo prioriza.
    if (endW != null && endW > origin && t > endW + 1e-6) return { ok: false, arrivals };
    arrivals.push(t);
    lat = o.lat;
    lng = o.lng;
  }
  return { ok: true, arrivals };
}

function routeSegregationOk(stops) {
  const tags = unionTags(stops);
  // union already mixed — check pairwise via hasHazmat/hasFood on union
  const haz = tags.some((t) => t === 'HAZMAT' || t === 'ADR' || t === 'PELGEROSO');
  const food = tags.some((t) => t === 'FOOD' || t === 'ALIMENTO' || t === 'ALIMENTOS' || t === 'FRIO_ALIMENTO');
  return !(haz && food);
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
 */
function softSlaPenalty(stops, startMs, pesos = {}, velocidadKmH = 35) {
  if (!stops.length) return 0;
  const wSla = numW(pesos.peso_sla, 1);
  const wVal = numW(pesos.peso_valor_carga, 0);
  const wRiesgo = numW(pesos.peso_riesgo_ia, 0);
  const vel = Math.max(5, Number(velocidadKmH) || 35);
  const origin = startMs || Date.now();
  const denom = Math.max(1, stops.length - 1);
  let pen = 0;
  let t = origin;
  let lat = stops[0]?.lat;
  let lng = stops[0]?.lng;
  for (let i = 0; i < stops.length; i++) {
    const o = stops[i];
    if (i > 0) {
      const km = calcularDistanciaKm(lat, lng, o.lat, o.lng);
      t += (km / vel) * 3600000 + 5 * 60 * 1000;
    }
    const endW = stopWindowEndMs(o) ?? new Date(o.fecha_hora_sla || '2099-12-31').getTime();
    if (Number.isFinite(endW) && t > endW) {
      pen += ((t - endW) / 3600000) * 40 * wSla;
    }
    const pos = i / denom;
    pen += pos * slaUrgency(o, origin) * 18 * wSla;
    const valorMillones = Number(o.valor_oc_clp || 0) / 1e6;
    pen += pos * valorMillones * 80 * wVal;
    const riesgo = Number(o.riesgo_score || o.risk_score || 0);
    pen += pos * (riesgo / 100) * 55 * wRiesgo;
    lat = o.lat;
    lng = o.lng;
  }
  return pen;
}

function routeCost(stops, depot, startMs, pesos, velocidadKmH = 35) {
  const wDist = numW(pesos?.peso_distancia, 1);
  return routeDistanceKm(stops, depot) * wDist + softSlaPenalty(stops, startMs, pesos, velocidadKmH);
}

function isFeasibleRoute(stops, {
  depot = DEFAULT_DEPOT,
  capacity = Infinity,
  capacityWeight = Infinity,
  startMs = Date.now(),
  velocidadKmH = 35,
} = {}) {
  if (!routeSegregationOk(stops)) return false;
  const cap = fitsCapacity(stops, capacity, capacityWeight);
  if (!cap.ok) return false;
  return routeFeasibleTw(stops, startMs, velocidadKmH, depot).ok;
}


/**
 * 2-opt: reverse segments while improving cost (solo candidatos factibles TW/capacidad).
 */
export function twoOptRoute(stops, {
  depot = DEFAULT_DEPOT,
  startMs = Date.now(),
  pesos = {},
  velocidadKmH = 35,
  maxIter = 80,
  capacity = Infinity,
  capacityWeight = Infinity,
} = {}) {
  if (!stops || stops.length < 2) return stops ? [...stops] : [];
  let best = [...stops];
  let bestCost = routeCost(best, depot, startMs, pesos, velocidadKmH);
  let improved = true;
  let iter = 0;
  const feasOpts = { depot, capacity, capacityWeight, startMs, velocidadKmH };

  while (improved && iter < maxIter) {
    improved = false;
    iter += 1;
    for (let i = -1; i < best.length - 2; i++) {
      for (let k = i + 2; k < best.length; k++) {
        const candidate =
          i === -1
            ? best.slice(0, k + 1).reverse().concat(best.slice(k + 1))
            : best.slice(0, i + 1).concat(best.slice(i + 1, k + 1).reverse(), best.slice(k + 1));
        if (!isFeasibleRoute(candidate, feasOpts)) continue;
        const c = routeCost(candidate, depot, startMs, pesos, velocidadKmH);
        if (c + 1e-9 < bestCost) {
          best = candidate;
          bestCost = c;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * Clarke-Wright savings algorithm (parallel version, capacity + TW + segregation).
 */
export function clarkeWrightRoutes(ordenes, {
  depot = DEFAULT_DEPOT,
  capacity = 100,
  capacityWeight = Infinity,
  maxStopsPerRoute = 24,
  startMs = Date.now(),
  velocidadKmH = 35,
} = {}) {
  const nodes = (ordenes || []).filter(
    (o) => o && Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lng))
  );
  if (nodes.length === 0) return [];
  if (nodes.length === 1) return [[nodes[0]]];

  const routesById = new Map();
  const routeOf = new Map();
  let nextId = 1;

  for (const n of nodes) {
    const rid = `r${nextId++}`;
    routesById.set(rid, [n]);
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

  const isEndpoint = (route, otId) => {
    if (!route.length) return false;
    return route[0].ot_id === otId || route[route.length - 1].ot_id === otId;
  };

  for (const { i, j } of savings) {
    const ri = routeOf.get(i.ot_id);
    const rj = routeOf.get(j.ot_id);
    if (!ri || !rj || ri === rj) continue;

    const routeI = routesById.get(ri);
    const routeJ = routesById.get(rj);
    if (!routeI || !routeJ) continue;
    if (!isEndpoint(routeI, i.ot_id) || !isEndpoint(routeJ, j.ot_id)) continue;

    if (routeI.length + routeJ.length > maxStopsPerRoute) continue;
    if (tagsConflict(unionTags(routeI), unionTags(routeJ))) continue;

    let left = [...routeI];
    let right = [...routeJ];
    if (left[0].ot_id === i.ot_id) left.reverse();
    if (left[left.length - 1].ot_id !== i.ot_id) continue;
    if (right[right.length - 1].ot_id === j.ot_id) right.reverse();
    if (right[0].ot_id !== j.ot_id) continue;

    const merged = left.concat(right);
    if (!isFeasibleRoute(merged, {
      depot, capacity, capacityWeight, startMs, velocidadKmH,
    })) continue;

    const newId = `r${nextId++}`;
    routesById.set(newId, merged);
    for (const o of merged) routeOf.set(o.ot_id, newId);
    routesById.delete(ri);
    routesById.delete(rj);
  }

  return Array.from(routesById.values()).filter((r) => r.length > 0);
}

/**
 * Intra-route: nearest neighbor seed then 2-opt (SLA-aware).
 */
export function sequenceRoute(stops, {
  depot = DEFAULT_DEPOT,
  startMs = Date.now(),
  pesos = {},
  velocidadKmH = 35,
  serviceSecondsFn = null,
  capacity = Infinity,
  capacityWeight = Infinity,
} = {}) {
  if (!stops?.length) return [];
  if (stops.length === 1) return [...stops];

  const pending = [...stops];
  const ordered = [];
  let lat = depot.lat;
  let lng = depot.lng;
  while (pending.length) {
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const dist = calcularDistanciaKm(lat, lng, p.lat, p.lng);
      const wDist = numW(pesos.peso_distancia, 1);
      const wSla = numW(pesos.peso_sla, 1);
      const wVal = numW(pesos.peso_valor_carga, 0);
      const wRiesgo = numW(pesos.peso_riesgo_ia, 0);
      const valorMillones = Number(p.valor_oc_clp || 0) / 1e6;
      const riesgo = Number(p.riesgo_score || p.risk_score || 0) / 100;
      const score =
        dist * wDist
        - slaUrgency(p, startMs) * 12 * wSla
        - valorMillones * 70 * wVal
        - riesgo * 40 * wRiesgo;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const pick = pending.splice(bestIdx, 1)[0];
    ordered.push(pick);
    lat = pick.lat;
    lng = pick.lng;
  }

  return twoOptRoute(ordered, {
    depot, startMs, pesos, velocidadKmH, capacity, capacityWeight,
  });
}

/**
 * Full solve: Clarke-Wright clustering → NN+2-opt sequencing per route.
 */
export function solveVrp(ordenes, {
  depot = DEFAULT_DEPOT,
  capacity = 100,
  capacityWeight = Infinity,
  maxVehicles = 99,
  maxStopsPerRoute = 24,
  startMs = Date.now(),
  pesos = { peso_distancia: 1, peso_sla: 1, peso_valor_carga: 0 },
  velocidadKmH = 35,
} = {}) {
  const list = Array.isArray(ordenes) ? ordenes : [];
  if (!list.length) {
    return { routes: [], solver: 'clarke-wright-2opt-vrptw', kmEstimado: 0 };
  }

  const cap = Math.max(1, Number(capacity) || 100);
  const capW = Number.isFinite(Number(capacityWeight)) ? Number(capacityWeight) : Infinity;
  let rawRoutes = clarkeWrightRoutes(list, {
    depot,
    capacity: cap,
    capacityWeight: capW,
    maxStopsPerRoute,
    startMs,
    velocidadKmH,
  });

  while (rawRoutes.length > maxVehicles && rawRoutes.length > 1) {
    rawRoutes.sort((a, b) => routeVolume(a) - routeVolume(b));
    const a = rawRoutes.shift();
    const b = rawRoutes.shift();
    const merged = [...a, ...b];
    const canMerge =
      routeVolume(merged) <= cap * 1.15 &&
      merged.length <= maxStopsPerRoute &&
      !tagsConflict(unionTags(a), unionTags(b)) &&
      isFeasibleRoute(merged, {
        depot, capacity: cap * 1.15, capacityWeight: capW, startMs, velocidadKmH,
      });
    if (canMerge) {
      rawRoutes.push(merged);
    } else {
      rawRoutes.unshift(b, a);
      break;
    }
  }

  if (rawRoutes.length > maxVehicles) {
    rawRoutes.sort((a, b) => b.length - a.length);
    const kept = rawRoutes.slice(0, maxVehicles);
    const leftover = rawRoutes.slice(maxVehicles).flat();
    for (const o of leftover) {
      kept.sort((a, b) => routeVolume(a) - routeVolume(b));
      const trial = [...kept[0], o];
      if (
        kept[0].length < maxStopsPerRoute &&
        isFeasibleRoute(trial, {
          depot, capacity: cap, capacityWeight: capW, startMs, velocidadKmH,
        })
      ) {
        kept[0].push(o);
      } else {
        kept.push([o]);
      }
    }
    rawRoutes = kept.slice(0, maxVehicles);
  }

  rawRoutes = enforceVehicleCount(rawRoutes, maxVehicles, list, depot);

  const routes = rawRoutes.map((r) =>
    sequenceRoute(r, {
      depot, startMs, pesos, velocidadKmH, capacity: cap, capacityWeight: capW,
    })
  );

  const kmEstimado = routes.reduce((s, r) => s + routeDistanceKm(r, depot), 0);
  const score = routes.reduce(
    (s, r) => s + routeCost(r, depot, startMs, pesos, velocidadKmH),
    0
  );

  return {
    routes,
    solver: 'clarke-wright-2opt-vrptw',
    kmEstimado: Number(kmEstimado.toFixed(2)),
    score: Number(score.toFixed(2)),
  };
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

function capacitatedKMeansLegacy(ordenes, capacidadMaxVolumen, rng) {
  if (ordenes.length === 0) return [];
  const volumenTotal = ordenes.reduce((acc, o) => acc + Number(o.volumen), 0);
  const K = Math.max(1, Math.ceil(volumenTotal / capacidadMaxVolumen));
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
      if (!asignadas.has(d.ordenIdx) && capacidades[d.clusterIdx] >= Number(orden.volumen)) {
        clusters[d.clusterIdx].push(orden);
        capacidades[d.clusterIdx] -= Number(orden.volumen);
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
 * Legacy k-means + greedy (pre-E), multi-start with seed.
 */
export function solveVrpLegacy(ordenes, opts = {}) {
  const {
    depot = DEFAULT_DEPOT,
    capacity = 100,
    maxVehicles = 99,
    maxStopsPerRoute = 24,
    startMs = Date.now(),
    pesos = { peso_distancia: 1, peso_sla: 1, peso_valor_carga: 0 },
    velocidadKmH = 35,
    seed = 1,
  } = opts;
  const list = Array.isArray(ordenes) ? ordenes : [];
  if (!list.length) return { routes: [], solver: 'kmeans-greedy', kmEstimado: 0 };

  const rng = mulberry32(seed);
  let clusters = capacitatedKMeansLegacy(list, Math.max(1, Number(capacity) || 100), rng);
  // M-11: partir clusters que excedan maxStopsPerRoute
  const capped = [];
  for (const c of clusters) {
    for (let i = 0; i < c.length; i += maxStopsPerRoute) {
      capped.push(c.slice(i, i + maxStopsPerRoute));
    }
  }
  clusters = capped;
  while (clusters.length > maxVehicles && clusters.length > 1) {
    clusters.sort((a, b) => a.length - b.length);
    const a = clusters.shift();
    const b = clusters.shift();
    const merged = [...a, ...b];
    if (merged.length <= maxStopsPerRoute) clusters.push(merged);
    else {
      clusters.push(a);
      clusters.push(b);
      break;
    }
  }
  clusters = enforceVehicleCount(clusters, maxVehicles, list, depot);
  const routes = clusters.map((c) => sequenceRoute(c, { depot, startMs, pesos, velocidadKmH }));
  const kmEstimado = routes.reduce((s, r) => s + routeDistanceKm(r, depot), 0);
  const score = routes.reduce(
    (s, r) => s + routeCost(r, depot, startMs, pesos, velocidadKmH),
    0
  );
  return {
    routes,
    solver: `kmeans-greedy#${seed}`,
    kmEstimado: Number(kmEstimado.toFixed(2)),
    score: Number(score.toFixed(2)),
  };
}

/**
 * Corre Clarke-Wright+2opt y varios seeds legacy; elige el mejor según
 * el score del perfil (distancia + SLA + valor + riesgo), no solo km.
 */
export function solveVrpAuto(ordenes, opts = {}) {
  const candidates = [solveVrp(ordenes, opts)];
  // M-11: menos seeds para acotar CPU en Workers
  for (const seed of [1, 7, 17]) {
    candidates.push(solveVrpLegacy(ordenes, { ...opts, seed }));
  }
  candidates.sort((a, b) => (a.score ?? a.kmEstimado) - (b.score ?? b.kmEstimado));
  const best = candidates[0];
  return {
    ...best,
    solver: `auto:${best.solver}`,
    candidatos: candidates.map((c) => ({
      solver: c.solver,
      km: c.kmEstimado,
      score: c.score ?? c.kmEstimado,
    })),
  };
}
