import { describe, expect, it } from 'vitest';
import { resolveGpsEventTime } from './gps-timestamp.js';

const now = Date.parse('2026-07-25T12:00:00.000Z');

describe('resolveGpsEventTime', () => {
  it('acepta ms del cliente dentro de rango', () => {
    const client = now - 10 * 60_000;
    const r = resolveGpsEventTime(client, now);
    expect(r.usedClient).toBe(true);
    expect(r.ms).toBe(client);
  });

  it('acepta segundos epoch', () => {
    const sec = Math.floor((now - 60_000) / 1000);
    const r = resolveGpsEventTime(sec, now);
    expect(r.usedClient).toBe(true);
    expect(r.ms).toBe(sec * 1000);
  });

  it('rechaza futuro lejano', () => {
    const r = resolveGpsEventTime(now + 10 * 60_000, now);
    expect(r.usedClient).toBe(false);
    expect(r.reason).toBe('future');
    expect(r.ms).toBe(now);
  });

  it('rechaza demasiado viejo', () => {
    const r = resolveGpsEventTime(now - 72 * 60 * 60_000, now);
    expect(r.usedClient).toBe(false);
    expect(r.reason).toBe('too_old');
  });

  it('fallback si falta', () => {
    const r = resolveGpsEventTime(null, now);
    expect(r.usedClient).toBe(false);
    expect(r.reason).toBe('missing');
  });
});
