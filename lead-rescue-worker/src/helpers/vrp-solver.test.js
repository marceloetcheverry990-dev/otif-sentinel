import { describe, it, expect } from 'vitest';
import {
  calcularDistanciaKm,
  clarkeWrightRoutes,
  twoOptRoute,
  routeDistanceKm,
  solveVrp,
  solveVrpAuto,
  splitUpToVehicles,
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

  it('solveVrpAuto elige el menor km entre candidatos', () => {
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
    const minCand = Math.min(...result.candidatos.map((c) => c.score ?? c.km));
    expect(result.score ?? result.kmEstimado).toBe(minCand);
  });

  it('N° camiones parte una ruta gorda que cabe en un solo vehículo', () => {
    const ordenes = [];
    for (let i = 0; i < 8; i++) {
      ordenes.push(stop(`OT-${i}`, -33.45 + (i % 2) * 0.08, -70.70 + Math.floor(i / 2) * 0.03, 1));
    }
    const one = solveVrp(ordenes, { capacity: 100, maxVehicles: 1, startMs: Date.now() });
    const two = solveVrp(ordenes, { capacity: 100, maxVehicles: 2, startMs: Date.now() });
    const three = solveVrp(ordenes, { capacity: 100, maxVehicles: 3, startMs: Date.now() });
    expect(one.routes).toHaveLength(1);
    expect(two.routes).toHaveLength(2);
    expect(three.routes).toHaveLength(3);
    expect(two.routes.flat().map((o) => o.ot_id).sort()).toEqual(ordenes.map((o) => o.ot_id).sort());
    expect(one.routes.flat()).toHaveLength(8);
  });

  it('splitUpToVehicles no inventa más rutas que paradas', () => {
    const only = [[stop('A', -33.45, -70.66), stop('B', -33.46, -70.67)]];
    const got = splitUpToVehicles(only, 9, DEFAULT_DEPOT);
    expect(got).toHaveLength(2);
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
