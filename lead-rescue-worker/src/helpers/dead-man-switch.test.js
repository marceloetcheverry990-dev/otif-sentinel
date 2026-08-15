import { describe, expect, it } from 'vitest';
import { alertTypeForKind, evaluateDeadMan } from './dead-man-switch.js';

const now = Date.parse('2026-07-22T18:00:00.000Z');

describe('evaluateDeadMan', () => {
  it('ok si está EN_SITIO', () => {
    const r = evaluateDeadMan({
      lastSignificantMoveAt: new Date(now - 60 * 60_000).toISOString(),
      ultimaActualizacion: new Date(now - 60_000).toISOString(),
      hasEnSitio: true,
      nowMs: now,
    });
    expect(r.kind).toBe('ok');
  });

  it('stuck YELLOW a los 15 min con ping reciente', () => {
    const r = evaluateDeadMan({
      lastSignificantMoveAt: new Date(now - 16 * 60_000).toISOString(),
      ultimaActualizacion: new Date(now - 60_000).toISOString(),
      hasEnSitio: false,
      nowMs: now,
    });
    expect(r.kind).toBe('stuck');
    expect(r.severity).toBe('YELLOW');
  });

  it('stuck RED a los 40 min', () => {
    const r = evaluateDeadMan({
      lastSignificantMoveAt: new Date(now - 45 * 60_000).toISOString(),
      ultimaActualizacion: new Date(now - 60_000).toISOString(),
      hasEnSitio: false,
      nowMs: now,
    });
    expect(r.kind).toBe('stuck');
    expect(r.severity).toBe('RED');
  });

  it('signal_lost si no hay pings', () => {
    const r = evaluateDeadMan({
      lastSignificantMoveAt: new Date(now - 10 * 60_000).toISOString(),
      ultimaActualizacion: new Date(now - 20 * 60_000).toISOString(),
      hasEnSitio: false,
      nowMs: now,
    });
    expect(r.kind).toBe('signal_lost');
    expect(r.severity).toBe('YELLOW');
  });
});

describe('alertTypeForKind', () => {
  it('mapea kinds', () => {
    expect(alertTypeForKind('stuck')).toBe('STUCK_VEHICLE');
    expect(alertTypeForKind('signal_lost')).toBe('SIGNAL_LOST');
    expect(alertTypeForKind('ok')).toBe(null);
  });
});
