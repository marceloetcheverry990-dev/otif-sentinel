import { describe, it, expect } from 'vitest';
import { normalizeSantiagoDate, parseTimeOfDay, resolveSlaFromTimeOfDay, santiagoWallToUtcIso } from './santiago-time.js';

describe('santiago-time (A-3)', () => {
  it('no trata la hora chilena como UTC (corrige el bug Date.UTC)', () => {
    const iso = normalizeSantiagoDate('25/07/2026 18:00');
    // El bug viejo producía 18:00Z; la hora de pared en Santiago debe seguir siendo 18:00
    expect(iso).not.toBe('2026-07-25T18:00:00.000Z');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(iso));
    const get = (t) => parts.find((p) => p.type === t)?.value;
    expect(get('hour')).toBe('18');
    expect(get('minute')).toBe('00');
  });

  it('santiagoWallToUtcIso alinea wall-clock con America/Santiago', () => {
    const iso = santiagoWallToUtcIso(2026, 6, 25, 18, 0);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(iso));
    const get = (t) => parts.find((p) => p.type === t)?.value;
    expect(get('year')).toBe('2026');
    expect(get('month')).toBe('07');
    expect(get('day')).toBe('25');
    expect(get('hour')).toBe('18');
    expect(get('minute')).toBe('00');
  });

  it('resolveSlaFromTimeOfDay usa hoy en Santiago y pasa al día siguiente si ya pasó', () => {
    const refLate = new Date('2026-08-19T23:00:00.000Z');
    const isoLate = resolveSlaFromTimeOfDay('18:00', refLate);
    expect(new Date(isoLate).getTime()).toBeGreaterThan(refLate.getTime());
    const partsLate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(isoLate));
    const getLate = (t) => partsLate.find((p) => p.type === t)?.value;
    expect(getLate('hour')).toBe('18');
    expect(getLate('minute')).toBe('00');

    const refEarly = new Date('2026-08-19T12:00:00.000Z');
    const isoEarly = resolveSlaFromTimeOfDay('18:00', refEarly);
    const partsEarly = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(isoEarly));
    const getEarly = (t) => partsEarly.find((p) => p.type === t)?.value;
    expect(getEarly('hour')).toBe('18');
    expect(getEarly('minute')).toBe('00');
    expect(getEarly('day')).toBe('19');
  });

  it('parseTimeOfDay rechaza horas inválidas', () => {
    expect(parseTimeOfDay('25:00')).toBeNull();
    expect(parseTimeOfDay('abc')).toBeNull();
    expect(parseTimeOfDay('14:30')?.hours).toBe(14);
  });

  it('rechaza fechas basura', () => {
    expect(normalizeSantiagoDate('')).toBeNull();
    expect(normalizeSantiagoDate(null)).toBeNull();
    expect(normalizeSantiagoDate('no-es-fecha')).toBeNull();
  });
});
