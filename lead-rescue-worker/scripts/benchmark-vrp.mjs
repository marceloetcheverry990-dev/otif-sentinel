/**
 * Benchmark: legacy k-means+greedy vs clarke-wright+2opt
 * Run: node scripts/benchmark-vrp.mjs
 */
import {
  DEFAULT_DEPOT,
  calcularDistanciaKm,
  routeDistanceKm,
  solveVrp,
} from '../src/helpers/vrp-solver.js';

// ─── Legacy (copy of pre-E optimizer core) ───────────────────────────────────

function capacitatedKMeans(ordenes, capacidadMaxVolumen, rng) {
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
          dist: calcularDistanciaKm(
            ordenes[i].lat,
            ordenes[i].lng,
            centroides[j].lat,
            centroides[j].lng
          ),
        });
      }
    }
    distancias.sort((a, b) => a.dist - b.dist);
    const asignadas = new Set();
    for (const d of distancias) {
      const orden = ordenes[d.ordenIdx];
      const volumenOrden = Number(orden.volumen);
      if (!asignadas.has(d.ordenIdx) && capacidades[d.clusterIdx] >= volumenOrden) {
        clusters[d.clusterIdx].push(orden);
        capacidades[d.clusterIdx] -= volumenOrden;
        asignadas.add(d.ordenIdx);
      }
    }
    for (let j = 0; j < K; j++) {
      if (clusters[j].length > 0) {
        const sumLat = clusters[j].reduce((acc, o) => acc + o.lat, 0);
        const sumLng = clusters[j].reduce((acc, o) => acc + o.lng, 0);
        centroides[j] = {
          lat: sumLat / clusters[j].length,
          lng: sumLng / clusters[j].length,
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

function greedySequence(cluster, capacidadMaxVolumen, startMs, pesos, velocidadKmH) {
  const pendientes = [...cluster];
  const ordered = [];
  let lat = DEFAULT_DEPOT.lat;
  let lng = DEFAULT_DEPOT.lng;
  let tiempoEstimadoMs = startMs;
  let cargaActual = cluster
    .filter((o) => o.tipo_movimiento !== 'RETIRO')
    .reduce((acc, o) => acc + Number(o.volumen), 0);

  while (pendientes.length > 0) {
    let mejorIdx = -1;
    let mejorPuntaje = Infinity;
    for (let i = 0; i < pendientes.length; i++) {
      const parada = pendientes[i];
      const esRetiro = parada.tipo_movimiento === 'RETIRO';
      const proyeccion = esRetiro
        ? cargaActual + Number(parada.volumen)
        : cargaActual - Number(parada.volumen);
      if (proyeccion > capacidadMaxVolumen) continue;

      const distKm = calcularDistanciaKm(lat, lng, parada.lat, parada.lng);
      const slaMs = new Date(parada.fecha_hora_sla).getTime();
      const horasRestantes = (slaMs - tiempoEstimadoMs) / (1000 * 60 * 60);
      let factorUrgencia = 0;
      if (horasRestantes < 1) factorUrgencia = 500;
      else if (horasRestantes < 3) factorUrgencia = 100;
      else if (horasRestantes < 5) factorUrgencia = 20;

      const factorValor =
        pesos.peso_valor_carga > 0
          ? -(Number(parada.valor_oc_clp || 0) / 1e6) * pesos.peso_valor_carga
          : 0;
      const puntaje =
        distKm * pesos.peso_distancia - factorUrgencia * pesos.peso_sla + factorValor;
      if (puntaje < mejorPuntaje) {
        mejorPuntaje = puntaje;
        mejorIdx = i;
      }
    }
    if (mejorIdx === -1) mejorIdx = 0;
    const elegida = pendientes.splice(mejorIdx, 1)[0];
    ordered.push(elegida);
    cargaActual =
      elegida.tipo_movimiento === 'RETIRO'
        ? cargaActual + Number(elegida.volumen)
        : cargaActual - Number(elegida.volumen);
    const driveMs =
      (calcularDistanciaKm(lat, lng, elegida.lat, elegida.lng) / velocidadKmH) * 3600000;
    tiempoEstimadoMs += driveMs + 5 * 60 * 1000;
    lat = elegida.lat;
    lng = elegida.lng;
  }
  return ordered;
}

function solveLegacy(ordenes, { capacity, maxVehicles, startMs, pesos, velocidadKmH, rng }) {
  let clusters = capacitatedKMeans(ordenes, capacity, rng);
  // Merge (never drop) until fleet size — fair vs new solver
  while (clusters.length > maxVehicles && clusters.length > 1) {
    clusters.sort((a, b) => a.length - b.length);
    const a = clusters.shift();
    const b = clusters.shift();
    clusters.push([...a, ...b]);
  }
  const routes = clusters.map((c) =>
    greedySequence(c, capacity * 2, startMs, pesos, velocidadKmH) // allow sequencing despite merge overflow
  );
  const covered = new Set(routes.flat().map((o) => o.ot_id)).size;
  const km = routes.reduce((s, r) => s + routeDistanceKm(r), 0);
  return {
    routes,
    km: Number(km.toFixed(2)),
    nRoutes: routes.length,
    covered,
    n: ordenes.length,
  };
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function stop(id, lat, lng, volumen = 1, slaH = 8) {
  return {
    ot_id: id,
    lat,
    lng,
    volumen,
    cliente: id,
    fecha_hora_sla: new Date(Date.now() + slaH * 3600000).toISOString(),
    valor_oc_clp: 10000,
    tipo_movimiento: 'ENTREGA',
    tags: [],
  };
}

/** RM Santiago-ish points around depot */
function scenarioSantiago(n, seed = 1) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    // spread ~15km around Maipú/bodega corridor
    const lat = -33.40 - rng() * 0.25;
    const lng = -70.55 - rng() * 0.40;
    out.push(stop(`S${i}`, lat, lng, 5 + Math.floor(rng() * 15), 2 + rng() * 10));
  }
  return out;
}

function scenarioClusters(seed = 2) {
  // 3 geographic blobs (Peñaflor / Providencia / Maipú-ish)
  const blobs = [
    { lat: -33.61, lng: -70.89, n: 8 },
    { lat: -33.43, lng: -70.62, n: 8 },
    { lat: -33.51, lng: -70.76, n: 8 },
  ];
  const rng = mulberry32(seed);
  const out = [];
  let k = 0;
  for (const b of blobs) {
    for (let i = 0; i < b.n; i++) {
      out.push(
        stop(
          `C${k++}`,
          b.lat + (rng() - 0.5) * 0.02,
          b.lng + (rng() - 0.5) * 0.02,
          8,
          4 + rng() * 6
        )
      );
    }
  }
  return out;
}

function scenarioTightCapacity() {
  return [
    stop('A', -33.45, -70.65, 40),
    stop('B', -33.46, -70.66, 40),
    stop('C', -33.55, -70.88, 40),
    stop('D', -33.56, -70.89, 40),
    stop('E', -33.42, -70.58, 40),
    stop('F', -33.43, -70.59, 40),
  ];
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pct(newKm, oldKm) {
  return (((oldKm - newKm) / oldKm) * 100).toFixed(1);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const pesos = { peso_distancia: 1, peso_sla: 1, peso_valor_carga: 0 };
const startMs = Date.now();
const velocidadKmH = 35;

const scenarios = [
  { name: 'santiago_12', ordenes: scenarioSantiago(12, 11), capacity: 40, vehicles: 4 },
  { name: 'santiago_24', ordenes: scenarioSantiago(24, 22), capacity: 50, vehicles: 5 },
  { name: 'santiago_40', ordenes: scenarioSantiago(40, 33), capacity: 60, vehicles: 6 },
  // Misma demanda 40 pero flota suficiente (cap*trucks >= volumen)
  { name: 'santiago_40_okcap', ordenes: scenarioSantiago(40, 33), capacity: 100, vehicles: 8 },
  { name: '3_clusters_24', ordenes: scenarioClusters(7), capacity: 50, vehicles: 4 },
  { name: 'tight_capacity_6', ordenes: scenarioTightCapacity(), capacity: 80, vehicles: 3 },
];

console.log('=== VRP Benchmark: legacy (k-means+greedy) vs new (clarke-wright+2opt) ===');
console.log('Depot:', DEFAULT_DEPOT);
console.log('Legacy km = mean of 15 random k-means seeds (same as production randomness)\n');

const rows = [];

for (const sc of scenarios) {
  const legacyKms = [];
  let legacyCoveredOk = true;
  for (let seed = 1; seed <= 15; seed++) {
    const leg = solveLegacy(sc.ordenes, {
      capacity: sc.capacity,
      maxVehicles: sc.vehicles,
      startMs,
      pesos,
      velocidadKmH,
      rng: mulberry32(seed * 997 + sc.ordenes.length),
    });
    legacyKms.push(leg.km);
    if (leg.covered !== sc.ordenes.length) legacyCoveredOk = false;
  }
  const legacyMean = mean(legacyKms);
  const legacyBest = Math.min(...legacyKms);
  const legacyWorst = Math.max(...legacyKms);

  const neu = solveVrp(sc.ordenes, {
    capacity: sc.capacity,
    maxVehicles: sc.vehicles,
    startMs,
    pesos,
    velocidadKmH,
  });

  const covered =
    neu.routes.flat().length === sc.ordenes.length &&
    new Set(neu.routes.flat().map((o) => o.ot_id)).size === sc.ordenes.length;

  rows.push({
    name: sc.name,
    n: sc.ordenes.length,
    legacyMean: Number(legacyMean.toFixed(2)),
    legacyBest: Number(legacyBest.toFixed(2)),
    legacyWorst: Number(legacyWorst.toFixed(2)),
    neuKm: neu.kmEstimado,
    neuRoutes: neu.routes.length,
    vsMean: pct(neu.kmEstimado, legacyMean),
    vsBest: pct(neu.kmEstimado, legacyBest),
    covered,
  });

  console.log(`--- ${sc.name} (n=${sc.ordenes.length}, cap=${sc.capacity}, trucks=${sc.vehicles}) ---`);
  console.log(
    `  Legacy mean/best/worst km: ${legacyMean.toFixed(2)} / ${legacyBest.toFixed(2)} / ${legacyWorst.toFixed(2)}`
  );
  console.log(`  New clarke-wright+2opt km: ${neu.kmEstimado} (${neu.routes.length} rutas)`);
  console.log(
    `  Ahorro vs legacy mean: ${pct(neu.kmEstimado, legacyMean)}% | vs legacy best seed: ${pct(neu.kmEstimado, legacyBest)}%`
  );
  console.log(`  Cobertura new: ${covered ? 'OK' : 'FAIL'} | legacy seeds OK: ${legacyCoveredOk ? 'OK' : 'FAIL'}\n`);
}

const avgSaving = mean(rows.map((r) => Number(r.vsMean)));
console.log('=== RESUMEN ===');
console.log(
  rows
    .map(
      (r) =>
        `${r.name.padEnd(18)} legacyμ=${String(r.legacyMean).padStart(7)}  new=${String(r.neuKm).padStart(7)}  Δμ=${r.vsMean}%  Δbest=${r.vsBest}%`
    )
    .join('\n')
);
console.log(`\nAhorro promedio vs legacy (media de seeds): ${avgSaving.toFixed(1)}%`);
console.log(
  avgSaving > 0
    ? 'VEREDICTO: el nuevo solver gana en km promedio en estos escenarios.'
    : 'VEREDICTO: el nuevo solver NO gana en km promedio; revisar.'
);
