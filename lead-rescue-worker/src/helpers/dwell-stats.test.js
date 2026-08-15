import { describe, expect, it } from 'vitest';
import {
  computePercentiles,
  dwellMinutesBetween,
  mergeDwellSample,
  santiagoDowHour,
} from './dwell-stats.js';

describe('dwell-stats', () => {
  it('dwellMinutesBetween calcula minutos', () => {
    expect(
      dwellMinutesBetween('2026-07-22T14:00:00.000Z', '2026-07-22T14:25:00.000Z')
    ).toBe(25);
  });

  it('computePercentiles p50/p90', () => {
    const { p50, p90 } = computePercentiles([10, 20, 30, 40, 50]);
    expect(p50).toBe(30);
    expect(p90).toBe(50);
  });

  it('mergeDwellSample acumula', () => {
    const a = mergeDwellSample(null, 20);
    expect(a.samples).toBe(1);
    expect(a.dwell_avg_min).toBe(20);
    const b = mergeDwellSample(a, 40);
    expect(b.samples).toBe(2);
    expect(b.dwell_avg_min).toBe(30);
  });

  it('santiagoDowHour retorna bucket', () => {
    const b = santiagoDowHour('2026-07-22T18:00:00.000Z'); // miércoles ~14h Chile
    expect(b).toBeTruthy();
    expect(b.dow).toBeGreaterThanOrEqual(0);
    expect(b.dow).toBeLessThanOrEqual(6);
    expect(b.hour_bucket).toBeGreaterThanOrEqual(0);
    expect(b.hour_bucket).toBeLessThanOrEqual(23);
  });
});
