import { describe, it, expect } from 'vitest';
import {
  computeTravelErrorMinutos,
  stripDwellFromError,
  shouldApplyTravelBias,
  etaAlreadyTravelCorrected,
} from './travel-error.js';

describe('computeTravelErrorMinutos', () => {
  it('mide contra LLEGADA (sin dwell)', () => {
    const r = computeTravelErrorMinutos({
      etaIso: '2026-07-25T14:00:00.000Z',
      llegadaIso: '2026-07-25T14:20:00.000Z',
      entregaIso: '2026-07-25T15:00:00.000Z',
    });
    expect(r.basis).toBe('llegada');
    expect(r.error_viaje_minutos).toBe(20);
  });

  it('sin LLEGADA → null (no contaminar con ENTREGA)', () => {
    expect(
      computeTravelErrorMinutos({
        etaIso: '2026-07-25T14:00:00.000Z',
        entregaIso: '2026-07-25T15:00:00.000Z',
      })
    ).toBeNull();
  });
});

describe('stripDwellFromError / bias policy', () => {
  it('resta dwell del error crudo', () => {
    expect(stripDwellFromError(50, 30)).toBe(20);
  });

  it('HAVERSINE no reaplica bias; OPTIMIZER sí; null+eta no', () => {
    expect(etaAlreadyTravelCorrected('HAVERSINE_CASCADE')).toBe(true);
    expect(shouldApplyTravelBias('HAVERSINE_CASCADE')).toBe(false);
    expect(shouldApplyTravelBias('OPTIMIZER_STATIC')).toBe(true);
    expect(shouldApplyTravelBias(null)).toBe(false);
    expect(shouldApplyTravelBias(null, { provisional: true })).toBe(true);
  });
});
