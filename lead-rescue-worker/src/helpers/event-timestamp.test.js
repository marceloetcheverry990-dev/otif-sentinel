import { describe, expect, it } from 'vitest';
import { parseDeviceTimestamp, resolveEventTimestamp } from './event-timestamp.js';

describe('event-timestamp', () => {
  it('parseDeviceTimestamp acepta ms e ISO', () => {
    expect(parseDeviceTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseDeviceTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    const iso = '2026-08-08T15:00:00.000Z';
    expect(parseDeviceTimestamp(iso)).toBe(Date.parse(iso));
  });

  it('usa device si está en ventana válida', () => {
    const server = Date.parse('2026-08-08T18:00:00.000Z');
    const device = Date.parse('2026-08-08T15:40:00.000Z');
    const r = resolveEventTimestamp({ deviceRaw: device, serverNowMs: server });
    expect(r.source).toBe('device');
    expect(r.eventIso).toBe('2026-08-08T15:40:00.000Z');
    expect(r.serverReceivedIso).toBe('2026-08-08T18:00:00.000Z');
  });

  it('clampa futuro y pasado extremos', () => {
    const server = Date.parse('2026-08-08T12:00:00.000Z');
    const future = resolveEventTimestamp({
      deviceRaw: server + 10 * 60 * 1000,
      serverNowMs: server,
    });
    expect(future.source).toBe('clamped_future');
    const past = resolveEventTimestamp({
      deviceRaw: server - 20 * 60 * 60 * 1000,
      serverNowMs: server,
    });
    expect(past.source).toBe('clamped_past');
  });

  it('respeta monotonía vs último evento del viaje', () => {
    const server = Date.parse('2026-08-08T18:00:00.000Z');
    const last = '2026-08-08T16:00:00.000Z';
    const r = resolveEventTimestamp({
      deviceRaw: Date.parse('2026-08-08T15:00:00.000Z'),
      serverNowMs: server,
      lastEventIso: last,
    });
    expect(r.source).toBe('clamped_mono');
    expect(r.eventIso).toBe(last);
  });
});
