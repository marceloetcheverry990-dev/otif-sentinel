import { describe, it, expect } from 'vitest';
import {
  calcularDistanciaKm,
  clarkeWrightRoutes,
  twoOptRoute,
  routeDistanceKm,
  solveVrp,
  solveVrpAuto,
  DEFAULT_DEPOT,
} from './vrp-solver.js';

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
    expect(result.solver).toBe('clarke-wright-2opt');
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
});
