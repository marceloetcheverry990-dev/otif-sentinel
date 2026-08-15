import { describe, it, expect } from 'vitest';
import { scoreFromSlackMin, scoreStopSlaRisk } from './sla-risk.js';

describe('scoreFromSlackMin', () => {
  it('ok con holgura >= 30', () => {
    expect(scoreFromSlackMin(45).level).toBe('ok');
    expect(scoreFromSlackMin(45).score).toBeLessThanOrEqual(20);
  });

  it('watch con holgura 0–30', () => {
    expect(scoreFromSlackMin(15).level).toBe('watch');
    expect(scoreFromSlackMin(15).score).toBeGreaterThanOrEqual(20);
    expect(scoreFromSlackMin(15).score).toBeLessThan(50);
  });

  it('risk con atraso leve', () => {
    expect(scoreFromSlackMin(-10).level).toBe('risk');
    expect(scoreFromSlackMin(-10).score).toBeGreaterThanOrEqual(50);
  });

  it('breach con atraso fuerte', () => {
    expect(scoreFromSlackMin(-45).level).toBe('breach');
    expect(scoreFromSlackMin(-45).score).toBeGreaterThanOrEqual(80);
  });

  it('unknown sin número', () => {
    expect(scoreFromSlackMin(null).level).toBe('unknown');
  });
});

describe('scoreStopSlaRisk', () => {
  const now = Date.parse('2026-07-25T14:00:00.000Z');

  it('quiebra con dwell solo (ETA ya calibrado → sin bias viaje)', () => {
    const r = scoreStopSlaRisk({
      etaIso: '2026-07-25T14:00:00.000Z',
      fechaHoraSla: '2026-07-25T14:20:00.000Z',
      dwellP90Min: 40,
      etaBiasMin: 10,
      etaSource: 'HAVERSINE_CASCADE',
      nowMs: now,
      cliente: 'Cliente X',
      provisionalTravelMin: 0,
    });
    // finish = 14:00 + 40m dwell = 14:40 > SLA 14:20; bias NO se suma
    expect(r.travel_bias_applied).toBeFalsy();
    expect(r.level).toBe('risk');
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.reason).toMatch(/dwell p90/);
    expect(r.reason).not.toMatch(/bias viaje/);
  });

  it('bias de viaje solo si ETA no está calibrado (OPTIMIZER_STATIC)', () => {
    const r = scoreStopSlaRisk({
      etaIso: '2026-07-25T14:00:00.000Z',
      fechaHoraSla: '2026-07-25T14:50:00.000Z',
      dwellP90Min: 10,
      etaBiasMin: 30,
      etaSource: 'OPTIMIZER_STATIC',
      nowMs: now,
      provisionalTravelMin: 0,
    });
    // finish = 14:00 + 30 bias + 10 dwell = 14:40 < SLA 14:50 → ok/watch
    expect(r.travel_bias_applied).toBe(true);
  });

  it('ok cuando hay holgura amplia', () => {
    const r = scoreStopSlaRisk({
      etaIso: '2026-07-25T14:00:00.000Z',
      fechaHoraSla: '2026-07-25T16:00:00.000Z',
      dwellP90Min: 10,
      etaBiasMin: 0,
      nowMs: now,
      cliente: 'Cliente Y',
      provisionalTravelMin: 0,
    });
    expect(r.level).toBe('ok');
    expect(r.reason).toBeNull();
  });

  it('sin ETA usa travel provisional', () => {
    const r = scoreStopSlaRisk({
      etaIso: null,
      fechaHoraSla: '2026-07-25T14:10:00.000Z',
      dwellP90Min: 5,
      etaBiasMin: 0,
      nowMs: now,
      provisionalTravelMin: 25,
      cliente: 'Z',
    });
    // eta=14:25 + 5 = 14:30 > SLA 14:10
    expect(['risk', 'breach']).toContain(r.level);
  });
});
