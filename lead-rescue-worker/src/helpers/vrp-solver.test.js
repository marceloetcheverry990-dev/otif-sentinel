import { describe, it, expect } from 'vitest';
import {
  calcularDistanciaKm,
  clarkeWrightRoutes,
  twoOptRoute,
  routeDistanceKm,
  solveVrp,
  solveVrpAuto,
  sequenceRoute,
  DEFAULT_DEPOT,
} from './vrp-solver.js';
import { PERFIL_PESOS } from './perfil-pesos.js';

function stop(id, lat, lng, volumen = 1, slaHoursFromNow = 8) {
  return {
    ot_id: id,
    lat,
    lng,
    volumen,
    cliente: id,
    fecha_hora_sla: new Date(Date.now() + slaHoursFromNow * 3600000).toISOString(),
    valor_oc_clp: 10000,
    tipo_movimiento: 'ENTREGA',
    tags: [],
  };
}

describe('vrp-solver', () => {
  it('haversine bodega-penaflor ~ razonable', () => {
    const km = calcularDistanciaKm(DEFAULT_DEPOT.lat, DEFAULT_DEPOT.lng, -33.61, -70.887);
    expect(km).toBeGreaterThan(10);
    expect(km).toBeLessThan(40);
  });

  it('clarkeWright respeta capacidad', () => {
    const ordenes = [
      stop('A', -33.45, -70.65, 40),
      stop('B', -33.46, -70.66, 40),
      stop('C', -33.47, -70.67, 40),
      stop('D', -33.48, -70.68, 40),
    ];
    const routes = clarkeWrightRoutes(ordenes, { capacity: 80, maxStopsPerRoute: 24 });
    expect(routes.length).toBeGreaterThanOrEqual(2);
    for (const r of routes) {
      const vol = r.reduce((s, o) => s + o.volumen, 0);
      expect(vol).toBeLessThanOrEqual(80);
    }
    const ids = routes.flat().map((o) => o.ot_id).sort();
    expect(ids).toEqual(['A', 'B', 'C', 'D']);
  });

  it('2-opt no empeora distancia vs orden lineal malo', () => {
    // Zigzag far points
    const bad = [
      stop('1', -33.40, -70.50),
      stop('2', -33.55, -70.90),
      stop('3', -33.41, -70.51),
      stop('4', -33.56, -70.91),
    ];
    const before = routeDistanceKm(bad);
    const after = routeDistanceKm(twoOptRoute(bad));
    expect(after).toBeLessThanOrEqual(before + 1e-6);
  });

  it('solveVrp produce rutas y km', () => {
    const ordenes = [];
    for (let i = 0; i < 12; i++) {
      ordenes.push(
        stop(
          `OT-${i}`,
          -33.4 - (i % 4) * 0.03,
          -70.6 - Math.floor(i / 4) * 0.04,
          10
        )
      );
    }
    const result = solveVrp(ordenes, {
      capacity: 40,
      maxVehicles: 5,
      startMs: Date.now(),
      pesos: { peso_distancia: 1, peso_sla: 1, peso_valor_carga: 0 },
    });
    expect(result.solver).toMatch(/clarke-wright/);
    expect(result.routes.length).toBeGreaterThan(0);
    expect(result.routes.length).toBeLessThanOrEqual(5);
    expect(result.kmEstimado).toBeGreaterThan(0);
    const all = result.routes.flat().map((o) => o.ot_id).sort();
    expect(all.length).toBe(12);
  });

  it('solveVrpAuto elige entre los que no violan restricciones el de mejor score', () => {
    const ordenes = [];
    for (let i = 0; i < 16; i++) {
      ordenes.push(
        stop(`OT-${i}`, -33.4 - (i % 4) * 0.04, -70.6 - Math.floor(i / 4) * 0.05, 10)
      );
    }
    const result = solveVrpAuto(ordenes, {
      capacity: 40,
      maxVehicles: 5,
      startMs: Date.now(),
      pesos: { peso_distancia: 1, peso_sla: 1, peso_valor_carga: 0 },
    });
    expect(result.solver.startsWith('auto:')).toBe(true);
    expect(result.candidatos.length).toBeGreaterThan(1);
    const minViol = Math.min(...result.candidatos.map((c) => c.violaciones));
    expect(result.violations.hard).toBe(minViol);
    const validos = result.candidatos.filter((c) => c.violaciones === minViol && c.ventanas === result.violations.tw);
    expect(result.score).toBe(Math.min(...validos.map((c) => c.score)));
  });

  it('sin "usar todos" usa solo los camiones que hacen falta (hasta N)', () => {
    const ordenes = [];
    for (let i = 0; i < 8; i++) {
      ordenes.push(stop(`OT-${i}`, -33.45 + (i % 2) * 0.08, -70.70 + Math.floor(i / 2) * 0.03, 1));
    }
    const three = solveVrp(ordenes, { capacity: 100, maxVehicles: 3, startMs: Date.now() });
    expect(three.routes).toHaveLength(1);
    expect(three.routes.flat()).toHaveLength(8);
    // 8 × 20 = 160 u. con camiones de 100: la capacidad obliga a 2, usa 2 (no 3)
    const pesadas = ordenes.map((o) => ({ ...o, volumen: 20 }));
    const cap = solveVrp(pesadas, { capacity: 100, maxVehicles: 3, startMs: Date.now() });
    expect(cap.routes).toHaveLength(2);
    for (const r of cap.routes) expect(r.reduce((s, o) => s + o.volumen, 0)).toBeLessThanOrEqual(100);
  });

  it('"usar todos" usa los N camiones repartidos parejo (no 6/3/3)', () => {
    const ordenes = [];
    for (let i = 0; i < 12; i++) {
      ordenes.push(stop(`OT-${i}`, -33.40 - (i % 4) * 0.03, -70.60 - Math.floor(i / 4) * 0.04, 1));
    }
    for (const n of [2, 3, 4]) {
      const res = solveVrp(ordenes, { capacity: 100, maxVehicles: n, forceAllVehicles: true, startMs: Date.now() });
      expect(res.routes).toHaveLength(n);
      const sizes = res.routes.map((r) => r.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      expect(res.routes.flat().map((o) => o.ot_id).sort()).toEqual(ordenes.map((o) => o.ot_id).sort());
    }
    // Nunca más rutas que paradas
    const dos = ordenes.slice(0, 2);
    expect(solveVrp(dos, { maxVehicles: 9, forceAllVehicles: true, startMs: Date.now() }).routes).toHaveLength(2);
  });

  it('flota mixta: cada ruta cabe en un camión distinto de la flota real', () => {
    const ordenes = [];
    for (let i = 0; i < 12; i++) ordenes.push(stop(`OT-${i}`, -33.40 - (i % 4) * 0.03, -70.60 - Math.floor(i / 4) * 0.04, 18));
    const vehicles = [{ capacity: 150 }, { capacity: 50 }, { capacity: 50 }];
    const res = solveVrpAuto(ordenes, { vehicles, maxVehicles: 3, startMs: Date.now() });
    expect(res.violations.hard).toBe(0);
    const vols = res.routes.map((r) => r.reduce((s, o) => s + o.volumen, 0)).sort((a, b) => b - a);
    const caps = [150, 50, 50];
    vols.forEach((v, i) => expect(v).toBeLessThanOrEqual(caps[i]));
    expect(res.routes.flat()).toHaveLength(12);
  });

  it('el plan k-means ya no puede ganar violando peso o segregación', () => {
    for (let s = 0; s < 5; s++) {
      const ordenes = [];
      for (let i = 0; i < 12; i++) {
        const o = stop(`OT-${i}`, -33.40 - ((i * 7 + s) % 5) * 0.03, -70.60 - ((i * 3 + s) % 4) * 0.04, 10);
        o.peso_kg = 300;
        o.tags = [['ALIMENTOS'], ['PELIGROSO'], []][i % 3];
        ordenes.push(o);
      }
      const res = solveVrpAuto(ordenes, { capacity: 40, capacityWeight: 1000, maxVehicles: 5, startMs: Date.now() });
      for (const r of res.routes) {
        expect(r.reduce((a, o) => a + o.peso_kg, 0)).toBeLessThanOrEqual(1000);
        const tags = r.flatMap((o) => o.tags);
        expect(tags.includes('PELIGROSO') && tags.includes('ALIMENTOS')).toBe(false);
      }
    }
  });

  it('resecuenciar no vuelve infactible una ruta que ya cumplía las ventanas (caso real del bench)', () => {
    // Escenario 21 del bench: 9 entregas B2B (45 min), SLA 3–4 h, 3 camiones.
    // Clarke-Wright armaba rutas factibles y el resecuenciado final devolvía un
    // orden que llegaba 3 min tarde (ninguna de sus semillas era factible).
    let t = (6021 >>> 0);
    const r = () => {
      t += 0x6d2b79f5;
      let x = Math.imul(t ^ (t >>> 15), 1 | t);
      x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const start = new Date('2026-09-23T14:00:00Z').getTime();
    const ordenes = Array.from({ length: 9 }, (_, i) => {
      const lat = -33.36 - r() * 0.2;
      const lng = -70.52 - r() * 0.25;
      const valor = Math.round(20000 + r() * (i % 4 === 0 ? 3e6 : 2e5));
      r();
      return {
        ot_id: `OT${i}`, lat, lng, volumen: 1, valor_oc_clp: valor, riesgo_score: 0, tags: [],
        fecha_hora_sla: new Date(start + (3 + (i % 3) * 0.5) * 3600000).toISOString(),
      };
    });
    const res = solveVrpAuto(ordenes, {
      vehicles: [{ capacity: 100 }, { capacity: 100 }, { capacity: 100 }],
      maxVehicles: 3,
      startMs: start,
      pesos: PERFIL_PESOS.equilibrado,
      velocidadKmH: 35,
      serviceSecondsFn: () => 45 * 60,
      roadFactor: 1.2,
      lunchBreak: true,
    });
    expect(res.violations.tw).toBe(0);
  });

  it('las ventanas usan el tiempo de servicio real (B2B 45 min), no 5 min fijos', () => {
    const start = Date.now();
    const cerca = (i) => ({ ...stop(`B${i}`, -33.50 - i * 0.004, -70.76, 1), fecha_hora_sla: new Date(start + 2.2 * 3600000).toISOString() });
    const ordenes = [0, 1, 2, 3].map(cerca);
    const cincoMin = solveVrp(ordenes, { maxVehicles: 3, startMs: start });
    const b2b = solveVrp(ordenes, { maxVehicles: 3, startMs: start, serviceSecondsFn: () => 45 * 60 });
    expect(cincoMin.routes).toHaveLength(1); // 4 × 5 min cabe en un camión
    expect(b2b.routes.length).toBeGreaterThan(1); // 4 × 45 min no llega a tiempo en uno solo
    expect(b2b.violations.tw).toBe(0);
  });

  it('nunca mezcla PELIGROSO (bien escrito) con ALIMENTO, ni siquiera forzando 1 solo vehículo', () => {
    // PELIGROSO (no el typo PELGEROSO) — la lista vieja de routeSegregationOk
    // no lo reconocía como HAZMAT, así que este caso se colaba.
    const stops = [];
    for (let i = 0; i < 6; i++) {
      const s = stop(`OT-${i}`, -33.45 + i * 0.001, -70.66 + i * 0.001, 1);
      if (i === 0) s.tags = ['PELIGROSO'];
      if (i === 1) s.tags = ['ALIMENTO'];
      stops.push(s);
    }
    const result = solveVrp(stops, { capacity: 200, maxVehicles: 1, startMs: Date.now() });
    for (const route of result.routes) {
      const tags = route.flatMap((o) => o.tags || []);
      const haz = tags.includes('PELIGROSO');
      const food = tags.includes('ALIMENTO');
      expect(haz && food).toBe(false);
    }
    // Las 6 OTs se siguen asignando todas (a alguna ruta), ninguna se pierde.
    expect(result.routes.flat().map((o) => o.ot_id).sort()).toEqual(stops.map((o) => o.ot_id).sort());
  });

  it('VIP adelanta el monto alto; Salvavidas adelanta el SLA vencido; Ahorro va a lo cerca', () => {
    const startMs = Date.now();
    const nearCheap = stop('NEAR', DEFAULT_DEPOT.lat + 0.012, DEFAULT_DEPOT.lng + 0.01, 1, 48);
    nearCheap.valor_oc_clp = 8000;
    nearCheap.riesgo_score = 5;
    const farRich = stop('RICH', DEFAULT_DEPOT.lat + 0.11, DEFAULT_DEPOT.lng + 0.09, 1, 48);
    farRich.valor_oc_clp = 9000000;
    farRich.riesgo_score = 5;
    const farLate = stop('LATE', DEFAULT_DEPOT.lat + 0.09, DEFAULT_DEPOT.lng - 0.08, 1, -20);
    farLate.valor_oc_clp = 12000;
    farLate.riesgo_score = 92;
    const stops = [nearCheap, farRich, farLate];
    const ids = (pesos) => sequenceRoute(stops, { depot: DEFAULT_DEPOT, startMs, pesos }).map((s) => s.ot_id);
    const ahorro = ids(PERFIL_PESOS.ahorro);
    const vip = ids(PERFIL_PESOS.vip);
    const salva = ids(PERFIL_PESOS.salvavidas);
    expect(ahorro[0]).toBe('NEAR');
    expect(vip[0]).toBe('RICH');
    expect(salva[0]).toBe('LATE');
    expect(new Set([ahorro.join('>'), vip.join('>'), salva.join('>')]).size).toBe(3);
  });
});
