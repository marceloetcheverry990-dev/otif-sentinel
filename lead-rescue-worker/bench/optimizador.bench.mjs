// Bench del optimizador: 30 escenarios por experimento, contra el motor real
// (vrp-solver) y los handlers reales (optimizarRutas, reoptimizarMidday) con
// Supabase en memoria y Mapbox simulado. Imprime una tabla por experimento.
//
//   npx vitest run -c bench/vitest.config.mjs
//
// No es parte de `npm test`: mide comportamiento, no es un test de contrato.
import { describe, it, vi, beforeAll, afterAll } from 'vitest';
import { createSupabaseMemoria } from '../src/test-utils/supabase-memoria.js';

const B = (globalThis.__bench = { tables: {}, writes: [], mapboxUrls: [] });

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    const mem = createSupabaseMemoria(globalThis.__bench.tables);
    globalThis.__bench.writes = mem.writes;
    return mem.client;
  },
}));
vi.mock('../src/db.js', () => {
  const client = { query: async () => ({ rowCount: 1, rows: [{ key: 'lock' }] }) };
  return {
    withDb: async (_env, cb) => cb(client),
    withDbTransaction: async (_env, cb) => cb(client),
  };
});
vi.mock('../src/helpers/depots.js', () => ({
  resolveDepot: async () => ({ depot_id: 'd1', nombre: 'Bodega', lat: -33.5132, lng: -70.7672 }),
  depotToSolver: (d) => ({ lat: d.lat, lng: d.lng }),
}));

const { solveVrpAuto, routeDistanceKm, routeFeasibleTw, calcularDistanciaKm } = await import('../src/helpers/vrp-solver.js');
const { PERFIL_PESOS, resolvePerfilPesos } = await import('../src/helpers/perfil-pesos.js');
const { hasHazmat, hasFood, unionTags } = await import('../src/helpers/cargo-constraints.js');
const { optimizarRutas } = await import('../src/api/optimizer.js');
const { reoptimizarMidday } = await import('../src/api/reoptimizar-midday.js');

const N = 30;
const H = 3600000;
const DEPOT = { lat: -33.5132, lng: -70.7672 };
const TENANT = 'bench';
const ENV = { SUPABASE_URL: 'https://x', SUPABASE_SERVICE_KEY: 'k', MAPBOX_TOKEN: 'pk.bench' };
const DIA = new Date('2026-09-23T14:00:00Z'); // 11:00 Chile
const NOCHE = new Date('2026-09-24T01:30:00Z'); // 22:30 Chile

function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Mapbox simulado: duración = km * 1.3 a 40 km/h (determinista)
const legSec = (a, b) => (calcularDistanciaKm(a.lat, a.lng, b.lat, b.lng) * 1.3 / 40) * 3600;
function mapboxFetch(url) {
  const u = String(url);
  B.mapboxUrls.push(u);
  if (!u.includes('api.mapbox.com/directions')) return Promise.resolve(new Response('', { status: 404 }));
  const pts = u.split('/driving')[1].split('/')[1].split('?')[0].split(';')
    .map((p) => p.split(',').map(Number)).map(([lng, lat]) => ({ lat, lng }));
  const legs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    legs.push({ duration: legSec(pts[i], pts[i + 1]), distance: calcularDistanciaKm(pts[i].lat, pts[i].lng, pts[i + 1].lat, pts[i + 1].lng) * 1300 });
  }
  const body = {
    code: 'Ok',
    routes: [{
      distance: legs.reduce((s, l) => s + l.distance, 0),
      duration: legs.reduce((s, l) => s + l.duration, 0),
      legs,
      geometry: { coordinates: pts.map((p) => [p.lng, p.lat]) },
    }],
  };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

function orden(i, r, o = {}) {
  return {
    ot_id: `OT${String(i).padStart(2, '0')}`,
    cliente: `Cliente ${i}`,
    tenant_id: TENANT,
    estado_operacional: 'PENDIENTE_RUTEO',
    trip_id: null,
    lat: -33.36 - r() * 0.2,
    lng: -70.52 - r() * 0.25,
    volumen: 1,
    peso_kg: 0,
    tipo_entrega: 'B2C',
    valor_oc_clp: Math.round(20000 + r() * (i % 4 === 0 ? 3e6 : 2e5)),
    fecha_hora_sla: new Date(DIA.getTime() + 9 * H).toISOString(),
    riesgo_score: Math.round(r() * 100),
    tags_requeridos: [],
    tags: [],
    metadata: {},
    ...o,
  };
}

function chofer(i, o = {}) {
  return {
    chofer_id: `CH${i}`,
    nombre_completo: `Chofer ${i}`,
    tenant_id: TENANT,
    estado: 'DISPONIBLE',
    patente_asignada: `PAT${i}`,
    km_acumulados_semana: i * 10,
    capacidad_volumen: 100,
    capacidad_peso: 99999,
    tags: [],
    ...o,
  };
}

const PERFILES = [
  { perfil_id: 1, nombre_perfil: 'Equilibrado (Recomendado)', modo: 'equilibrado', tenant_id: null },
  { perfil_id: 2, nombre_perfil: 'Modo Ahorro Bencina (Ruta Corta)', modo: 'ahorro', tenant_id: null },
  { perfil_id: 3, nombre_perfil: 'Modo VIP (Priorizar Montos Altos)', modo: 'vip', tenant_id: null },
  { perfil_id: 4, nombre_perfil: 'Modo Salvavidas (Evitar Multas)', modo: 'salvavidas', tenant_id: null },
];

async function correrOptimizer({ ordenes, choferes, body = {}, env = ENV }) {
  B.tables = {
    ordenes_pendientes: ordenes,
    choferes,
    clientes: [],
    perfiles_optimizacion: PERFILES,
    flota_vehiculos: [],
  };
  B.writes = [];
  B.mapboxUrls = [];
  const req = new Request('https://x/api/optimizar-rutas', {
    method: 'POST',
    body: JSON.stringify({ perfil_id: 1, flota_disponible: choferes.length, clima: 'NORMAL', ...body }),
  });
  const res = await optimizarRutas(req, env, null, { tenant_id: TENANT });
  const data = await res.json();
  const updates = B.writes.filter((w) => w.table === 'ordenes_pendientes' && w.op === 'update');
  const etaByOt = {};
  for (const w of updates) {
    const ot = ordenes.find((o) => w.match(o));
    if (ot && w.payload.eta) etaByOt[ot.ot_id] = w.payload;
  }
  return { data, writes: B.writes, etaByOt, mapboxUrls: B.mapboxUrls };
}

const resultados = [];
function reporte(nombre, filas) {
  resultados.push({ nombre, filas });
  console.log(`\n=== ${nombre} ===`);
  console.table(filas);
}

const tieneMezcla = (r) => { const t = unionTags(r); return hasHazmat(t) && hasFood(t); };
const promedio = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(DIA);
  vi.stubGlobal('fetch', vi.fn(mapboxFetch));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const { nombre, filas } of resultados) {
    process.stdout.write(`\n=== ${nombre} ===\n`);
    for (const f of filas) process.stdout.write('  ' + Object.entries(f).map(([k, v]) => `${k}: ${v}`).join(' | ') + '\n');
  }
});

describe('bench optimizador (30 escenarios por experimento)', () => {
  it('E1 perfiles: cada perfil gana en su propia métrica', () => {
    const gana = { ahorro: 0, vip: 0, salvavidas: 0 };
    const km = { equilibrado: [], ahorro: [], vip: [], salvavidas: [] };
    for (let s = 1; s <= N; s++) {
      const r = rng(1000 + s);
      const ords = Array.from({ length: 12 }, (_, i) => orden(i, r, {
        fecha_hora_sla: new Date(DIA.getTime() + (i % 3 === 0 ? 1.5 : 8) * H).toISOString(),
      }));
      const topValor = [...ords].sort((a, b) => b.valor_oc_clp - a.valor_oc_clp).slice(0, 3).map((o) => o.ot_id);
      const m = {};
      for (const [k, p] of Object.entries(PERFIL_PESOS)) {
        const res = solveVrpAuto(ords, { depot: DEPOT, capacity: 100, maxVehicles: 1, startMs: DIA.getTime(), pesos: p, velocidadKmH: 35 });
        const ruta = res.routes.flat();
        let t = DIA.getTime(), lat = DEPOT.lat, lng = DEPOT.lng, tarde = 0;
        for (const st of ruta) {
          t += (calcularDistanciaKm(lat, lng, st.lat, st.lng) / 35) * H;
          if (t > new Date(st.fecha_hora_sla).getTime()) tarde++;
          t += 5 * 60000; lat = st.lat; lng = st.lng;
        }
        const posValor = promedio(topValor.map((id) => ruta.findIndex((x) => x.ot_id === id)));
        m[k] = { km: res.routes.reduce((a, rr) => a + routeDistanceKm(rr, DEPOT), 0), tarde, posValor };
        km[k].push(m[k].km);
      }
      if (m.ahorro.km <= Math.min(m.equilibrado.km, m.vip.km, m.salvavidas.km) + 1e-6) gana.ahorro++;
      if (m.vip.posValor <= Math.min(m.equilibrado.posValor, m.ahorro.posValor, m.salvavidas.posValor) + 1e-6) gana.vip++;
      if (m.salvavidas.tarde <= Math.min(m.equilibrado.tarde, m.ahorro.tarde, m.vip.tarde)) gana.salvavidas++;
    }
    reporte('E1 Perfiles (12 OTs, 1 camión)', [
      { chequeo: 'Ahorro = menos km', escenarios: `${gana.ahorro}/${N}` },
      { chequeo: 'VIP = montos altos primero', escenarios: `${gana.vip}/${N}` },
      { chequeo: 'Salvavidas = menos atrasos', escenarios: `${gana.salvavidas}/${N}` },
      { chequeo: 'km promedio', escenarios: Object.entries(km).map(([k, v]) => `${k} ${promedio(v).toFixed(0)}`).join(', ') },
    ]);
  });

  it('E2 clima: las ETA con Mapbox reflejan lluvia/niebla', async () => {
    const ratios = { NORMAL: [], LLUVIA: [], NIEBLA: [] };
    for (let s = 1; s <= N; s++) {
      for (const clima of Object.keys(ratios)) {
        const r = rng(2000 + s);
        const ords = Array.from({ length: 8 }, (_, i) => orden(i, r));
        const { etaByOt } = await correrOptimizer({ ordenes: ords, choferes: [chofer(1)], body: { clima } });
        // Primer tramo (bodega → primera parada): solo manejo, sin servicio
        const first = Object.entries(etaByOt).find(([, p]) => p.stop_sequence === 1);
        if (!first) continue;
        const ot = ords.find((o) => o.ot_id === first[0]);
        const real = (new Date(first[1].eta).getTime() - DIA.getTime()) / 1000;
        ratios[clima].push(real / legSec(DEPOT, ot));
      }
    }
    reporte('E2 Clima (ETA del primer tramo / tiempo Mapbox)', Object.entries(ratios).map(([clima, v]) => ({
      clima,
      factor_promedio: promedio(v).toFixed(2),
      esperado: clima === 'LLUVIA' ? '1.40' : clima === 'NIEBLA' ? '2.33' : '1.00',
      escenarios_ok: `${v.filter((x) => Math.abs(x - (clima === 'LLUVIA' ? 1.4 : clima === 'NIEBLA' ? 35 / 15 : 1)) < 0.02).length}/${N}`,
    })));
  });

  it('E3 N° de camiones: hasta N vs usar todos', async () => {
    let hastaUno = 0, todosTres = 0, todosParejo = 0, hastaCap = 0;
    const kmH = [], kmT = [], tam = [];
    for (let s = 1; s <= N; s++) {
      const r = rng(3000 + s);
      const ords = Array.from({ length: 12 }, (_, i) => orden(i, r));
      const base = { depot: DEPOT, capacity: 100, maxVehicles: 3, startMs: DIA.getTime(), pesos: PERFIL_PESOS.equilibrado, velocidadKmH: 35 };
      const hasta = solveVrpAuto(ords, { ...base, forceAllVehicles: false });
      const todos = solveVrpAuto(ords, { ...base, forceAllVehicles: true });
      if (hasta.routes.length === 1) hastaUno++;
      if (todos.routes.length === 3) todosTres++;
      const sz = todos.routes.map((x) => x.length);
      if (Math.max(...sz) - Math.min(...sz) <= 1) todosParejo++;
      if (s <= 3) tam.push(sz.join('/'));
      kmH.push(hasta.routes.reduce((a, rr) => a + routeDistanceKm(rr, DEPOT), 0));
      kmT.push(todos.routes.reduce((a, rr) => a + routeDistanceKm(rr, DEPOT), 0));
      // Capacidad obliga a 2 camiones de 3: "hasta N" debe usar 2
      const pesadas = ords.map((o) => ({ ...o, volumen: 15 }));
      const cap = solveVrpAuto(pesadas, { ...base, forceAllVehicles: false });
      if (cap.routes.length === 2) hastaCap++;
    }
    // Cableado de punta a punta: el checkbox llega al handler
    let e2eHasta = 0, e2eTodos = 0;
    for (let s = 1; s <= N; s++) {
      const r = rng(3500 + s);
      const ords = Array.from({ length: 12 }, (_, i) => orden(i, r));
      const ch = [chofer(1), chofer(2), chofer(3)];
      const a = await correrOptimizer({ ordenes: ords.map((o) => ({ ...o })), choferes: ch, body: { usar_todos: false } });
      const b = await correrOptimizer({ ordenes: ords.map((o) => ({ ...o })), choferes: ch, body: { usar_todos: true } });
      if (a.data.viajes_creados === 1) e2eHasta++;
      if (b.data.viajes_creados === 3) e2eTodos++;
    }
    reporte('E3 N° camiones = 3 (12 OTs que caben en 1)', [
      { chequeo: 'Hasta N: usa 1 camión', escenarios: `${hastaUno}/${N}`, km_prom: promedio(kmH).toFixed(1) },
      { chequeo: 'Hasta N: capacidad obliga a 2 → usa 2', escenarios: `${hastaCap}/${N}`, km_prom: '' },
      { chequeo: 'Usar todos: usa los 3', escenarios: `${todosTres}/${N}`, km_prom: promedio(kmT).toFixed(1) },
      { chequeo: 'Usar todos: parejo (dif ≤ 1 parada)', escenarios: `${todosParejo}/${N}`, km_prom: `ej: ${tam.join(', ')}` },
      { chequeo: 'Handler: checkbox apagado → 1 viaje', escenarios: `${e2eHasta}/${N}`, km_prom: '' },
      { chequeo: 'Handler: checkbox marcado → 3 viajes', escenarios: `${e2eTodos}/${N}`, km_prom: '' },
    ]);
  });

  it('E4 segregación peligrosos/alimentos', async () => {
    let mezcla = 0, sinAsignar = 0, escSinAsignar = 0;
    for (let s = 1; s <= N; s++) {
      const r = rng(4000 + s);
      const tagsDe = (i) => [['ALIMENTOS'], ['PELIGROSO'], []][i % 3];
      const ords = Array.from({ length: 14 }, (_, i) => orden(i, r, { tags: tagsDe(i), tags_requeridos: tagsDe(i) }));
      const res = solveVrpAuto(ords, { depot: DEPOT, capacity: 100, maxVehicles: 3, startMs: DIA.getTime(), pesos: PERFIL_PESOS.equilibrado, velocidadKmH: 35 });
      if (res.routes.some(tieneMezcla)) mezcla++;
      const ch = [1, 2, 3].map((i) => chofer(i, { tags: ['ALIMENTOS', 'PELIGROSO'] }));
      const { data } = await correrOptimizer({ ordenes: ords, choferes: ch });
      const n = (data.sin_asignar_ids || []).length;
      sinAsignar += n;
      if (n) escSinAsignar++;
    }
    reporte('E4 Segregación (14 OTs, 3 camiones)', [
      { chequeo: 'Motor: rutas que mezclan', escenarios: `${mezcla}/${N}` },
      { chequeo: 'Handler: escenarios con OTs sin asignar', escenarios: `${escSinAsignar}/${N} (${sinAsignar} OTs)` },
    ]);
  });

  it('E5 peso', async () => {
    let sobre = 0, escSin = 0, sin = 0;
    for (let s = 1; s <= N; s++) {
      const r = rng(5000 + s);
      const ords = Array.from({ length: 12 }, (_, i) => orden(i, r, { volumen: 10, peso_kg: 300 }));
      const res = solveVrpAuto(ords, { depot: DEPOT, capacity: 40, capacityWeight: 1000, maxVehicles: 4, startMs: DIA.getTime(), pesos: PERFIL_PESOS.ahorro, velocidadKmH: 35 });
      if (res.routes.some((rr) => rr.reduce((a, x) => a + x.peso_kg, 0) > 1000)) sobre++;
      const ch = [1, 2, 3, 4].map((i) => chofer(i, { capacidad_volumen: 40, capacidad_peso: 1000 }));
      const { data } = await correrOptimizer({ ordenes: ords, choferes: ch, body: { perfil_id: 2 } });
      const n = (data.sin_asignar_ids || []).length;
      sin += n; if (n) escSin++;
    }
    reporte('E5 Peso (12 OTs de 300 kg, camiones de 1000 kg)', [
      { chequeo: 'Motor: rutas sobre el peso', escenarios: `${sobre}/${N}` },
      { chequeo: 'Handler: escenarios con OTs sin asignar', escenarios: `${escSin}/${N} (${sin} OTs)` },
    ]);
  });

  it('E5b flota mixta', async () => {
    let escSin = 0, sin = 0;
    for (let s = 1; s <= N; s++) {
      const r = rng(5500 + s);
      const ords = Array.from({ length: 12 }, (_, i) => orden(i, r, { volumen: 18 }));
      const ch = [chofer(1, { capacidad_volumen: 150 }), chofer(2, { capacidad_volumen: 50 }), chofer(3, { capacidad_volumen: 50 })];
      const { data } = await correrOptimizer({ ordenes: ords, choferes: ch });
      const n = (data.sin_asignar_ids || []).length;
      sin += n; if (n) escSin++;
    }
    reporte('E5b Flota mixta (150 + 50 + 50, 12 OTs de 18 = 216)', [
      { chequeo: 'Handler: escenarios con OTs sin asignar', escenarios: `${escSin}/${N} (${sin} OTs)` },
    ]);
  });

  it('E6 tiempo de servicio B2B (45 min)', async () => {
    let tarde = 0, total = 0, escTarde = 0;
    for (let s = 1; s <= N; s++) {
      const r = rng(6000 + s);
      const ords = Array.from({ length: 9 }, (_, i) => orden(i, r, {
        tipo_entrega: 'B2B',
        fecha_hora_sla: new Date(DIA.getTime() + (3 + (i % 3) * 0.5) * H).toISOString(),
      }));
      const { etaByOt } = await correrOptimizer({ ordenes: ords, choferes: [chofer(1), chofer(2), chofer(3)] });
      let t = 0;
      for (const o of ords) {
        const p = etaByOt[o.ot_id];
        if (!p) continue;
        total++;
        if (new Date(p.eta).getTime() > new Date(o.fecha_hora_sla).getTime()) {
          tarde++; t++;
          if (process.env.BENCH_DIAG) {
            const ruta = Object.values(etaByOt).filter((x) => x.trip_id === p.trip_id).sort((a, b) => a.stop_sequence - b.stop_sequence);
            process.stdout.write(`DIAG E6 s=${s} ${o.ot_id} seq=${p.stop_sequence}/${ruta.length} eta=${p.eta} sla=${o.fecha_hora_sla} ` +
              `colacion=${ruta.map((x) => x.metadata?.routing?.pausa_colacion_aplicada ? 'S' : '-').join('')} ` +
              `etas=${ruta.map((x) => x.eta.slice(11, 16)).join(',')}\n`);
          }
        }
      }
      if (t) escTarde++;
    }
    reporte('E6 Servicio B2B (9 OTs, SLA 3–4 h, hasta 3 camiones)', [
      { chequeo: 'Paradas con ETA guardada después del SLA', escenarios: `${tarde}/${total}` },
      { chequeo: 'Escenarios con alguna parada tarde', escenarios: `${escTarde}/${N}` },
    ]);
  });

  it('E7 choferes sin patente', async () => {
    let escSin = 0, sin = 0;
    for (let s = 1; s <= N; s++) {
      const r = rng(7000 + s);
      const ords = Array.from({ length: 12 }, (_, i) => orden(i, r, { volumen: 10 }));
      // Los dos primeros de la tabla no tienen patente; hay 4 con patente
      const ch = [
        chofer(1, { patente_asignada: null, capacidad_volumen: 40 }),
        chofer(2, { patente_asignada: null, capacidad_volumen: 40 }),
        ...[3, 4, 5, 6].map((i) => chofer(i, { capacidad_volumen: 40 })),
      ];
      const { data } = await correrOptimizer({ ordenes: ords, choferes: ch, body: { flota_disponible: 3 } });
      const n = (data.sin_asignar_ids || []).length;
      sin += n; if (n) escSin++;
    }
    reporte('E7 Choferes sin patente (N=3, 12 OTs que necesitan 3 camiones)', [
      { chequeo: 'Escenarios con OTs sin asignar', escenarios: `${escSin}/${N} (${sin} OTs)` },
    ]);
  });

  it('E8 re-opt respeta el perfil', async () => {
    let distintas = 0;
    for (let s = 1; s <= N; s++) {
      const secuencias = {};
      for (const perfil_id of [2, 3]) {
        const r = rng(8000 + s);
        const ords = Array.from({ length: 8 }, (_, i) => orden(i, r));
        B.tables = { ordenes_pendientes: ords, choferes: [chofer(1)], clientes: [], perfiles_optimizacion: PERFILES, flota_vehiculos: [] };
        const req = new Request('https://x/api/reoptimizar-midday', { method: 'POST', body: JSON.stringify({ perfil_id, clima: 'NORMAL' }) });
        await reoptimizarMidday(req, ENV, null, { tenant_id: TENANT });
        const upd = B.writes.filter((w) => w.table === 'ordenes_pendientes' && w.op === 'update');
        const seq = upd.map((w) => [ords.find((o) => w.match(o))?.ot_id, w.payload.stop_sequence])
          .sort((a, b) => a[1] - b[1]).map((x) => x[0]).join('>');
        secuencias[perfil_id] = seq;
      }
      if (secuencias[2] !== secuencias[3]) distintas++;
    }
    reporte('E8 Re-opt mediodía (viaje nuevo, Ahorro vs VIP)', [
      { chequeo: 'Escenarios donde el perfil cambia la secuencia', escenarios: `${distintas}/${N}` },
    ]);
  });

  it('E9 simulación sin efectos', async () => {
    let conEscrituras = 0;
    for (let s = 1; s <= N; s++) {
      const r = rng(9000 + s);
      const ords = Array.from({ length: 6 }, (_, i) => orden(i, r));
      const { writes } = await correrOptimizer({ ordenes: ords, choferes: [chofer(1)], body: { is_simulacion: true } });
      if (writes.length) conEscrituras++;
    }
    reporte('E9 Simulación (is_simulacion: true)', [
      { chequeo: 'Escenarios que escribieron en la BD', escenarios: `${conEscrituras}/${N}` },
    ]);
  });

  it('E10 ruteo nocturno usa la hora de salida real', async () => {
    vi.setSystemTime(NOCHE);
    let conDepart = 0;
    for (let s = 1; s <= N; s++) {
      const r = rng(10000 + s);
      const ords = Array.from({ length: 6 }, (_, i) => orden(i, r, { fecha_hora_sla: new Date(NOCHE.getTime() + 20 * H).toISOString() }));
      const { mapboxUrls } = await correrOptimizer({ ordenes: ords, choferes: [chofer(1)] });
      if (mapboxUrls.some((u) => u.includes('depart_at='))) conDepart++;
    }
    vi.setSystemTime(DIA);
    reporte('E10 Ruteo a las 22:30 (salida 08:00 del día siguiente)', [
      { chequeo: 'Escenarios que piden tráfico de la hora de salida', escenarios: `${conDepart}/${N}` },
    ]);
  });

  it('E11 modo del perfil guardado en la BD', () => {
    const renombrados = [
      { nombre_perfil: 'Clientes Premium', modo: 'vip' },
      { nombre_perfil: 'Rápido y barato', modo: 'ahorro' },
      { nombre_perfil: 'Cero multas', modo: 'salvavidas' },
      { nombre_perfil: 'Estándar', modo: 'equilibrado' },
    ];
    const ok = renombrados.filter((p) => resolvePerfilPesos(p).key === p.modo).length;
    reporte('E11 Perfil renombrado con modo en la BD', [
      { chequeo: 'Perfiles que conservan su comportamiento', escenarios: `${ok}/4` },
    ]);
  });
});
