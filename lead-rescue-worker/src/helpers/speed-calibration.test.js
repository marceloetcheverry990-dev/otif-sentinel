import { describe, it, expect, beforeEach } from 'vitest';
import {
  speedSampleFromMetric,
  speedFromBiasMin,
  applyClimaToSpeed,
  median,
  clampSpeedKmh,
  _clearSpeedCache,
  lookupEffectiveSpeedKmh,
} from './speed-calibration.js';

describe('speedSampleFromMetric', () => {
  it('tarde ⇒ velocidad menor que v0', () => {
    // 35 km en 1h planificado @ 35; +30 min tarde ⇒ 35km / 1.5h = 23.3
    const v = speedSampleFromMetric(35, 30, 35);
    expect(v).toBeLessThan(35);
    expect(v).toBeCloseTo(23.3, 0);
  });

  it('temprano ⇒ velocidad mayor que v0', () => {
    const v = speedSampleFromMetric(35, -15, 35);
    expect(v).toBeGreaterThan(35);
  });

  it('rechaza distancias fuera de rango', () => {
    expect(speedSampleFromMetric(0.1, 0, 35)).toBeNull();
    expect(speedSampleFromMetric(100, 0, 35)).toBeNull();
  });
});

describe('speedFromBiasMin / clima', () => {
  it('bias tarde baja la velocidad', () => {
    expect(speedFromBiasMin(20, { v0: 35, typicalLegMin: 20 })).toBeLessThan(35);
  });

  it('clima aplica factores relativos', () => {
    expect(applyClimaToSpeed(35, 'LLUVIA')).toBeCloseTo(25, 0);
    expect(applyClimaToSpeed(35, 'NIEBLA')).toBeCloseTo(15, 0);
    expect(applyClimaToSpeed(40, 'NORMAL')).toBe(40);
  });

  it('median y clamp', () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(clampSpeedKmh(3)).toBe(8);
    expect(clampSpeedKmh(120)).toBe(80);
  });
});

describe('lookupEffectiveSpeedKmh', () => {
  beforeEach(() => _clearSpeedCache());

  it('sin datos → config 35', async () => {
    const client = {
      query: async () => ({ rows: [] }),
    };
    const r = await lookupEffectiveSpeedKmh(client, { tenant_id: 't1' });
    expect(r.source).toBe('config');
    expect(r.velocidadKmH).toBe(35);
  });

  it('usa mediana tenant con suficientes muestras', async () => {
    const now = new Date().toISOString();
    const rows = Array.from({ length: 30 }, (_, i) => ({
      chofer_id: 'c1',
      hora_real_llegada: now,
      // ~23.3 km/h samples (late) — error de VIAJE (LLEGADA), no dwell
      distancia_restante_km: 35,
      error_minutos: 30 + (i % 3),
      error_viaje_minutos: 30 + (i % 3),
      arrival_basis: 'llegada',
    }));
    const client = {
      query: async () => ({ rows }),
    };
    const r = await lookupEffectiveSpeedKmh(client, {
      tenant_id: 't1',
      minSamplesTenant: 30,
      minSamplesHour: 100,
      minSamplesChofer: 100,
    });
    expect(r.source).toBe('tenant');
    expect(r.velocidadKmH).toBeLessThan(30);
  });
});
