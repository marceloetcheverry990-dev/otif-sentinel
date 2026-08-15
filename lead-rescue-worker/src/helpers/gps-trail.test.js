import { describe, expect, it } from 'vitest';
import { shouldSampleTrail } from './gps-trail.js';

describe('shouldSampleTrail', () => {
  it('muestrea movimiento significativo', () => {
    const r = shouldSampleTrail({
      lastTrailAtMs: Date.now() - 1000,
      deltaKm: 0.08,
      minIntervalSec: 45,
      moveThresholdKm: 0.05,
    });
    expect(r.sample).toBe(true);
    expect(r.isHeartbeat).toBe(false);
  });

  it('heartbeat si pasó el intervalo sin movimiento', () => {
    const r = shouldSampleTrail({
      lastTrailAtMs: Date.now() - 60_000,
      deltaKm: 0.01,
      minIntervalSec: 45,
      moveThresholdKm: 0.05,
    });
    expect(r.sample).toBe(true);
    expect(r.isHeartbeat).toBe(true);
  });

  it('no muestrea ruido reciente', () => {
    const r = shouldSampleTrail({
      lastTrailAtMs: Date.now() - 5_000,
      deltaKm: 0.01,
      minIntervalSec: 45,
      moveThresholdKm: 0.05,
    });
    expect(r.sample).toBe(false);
  });
});
