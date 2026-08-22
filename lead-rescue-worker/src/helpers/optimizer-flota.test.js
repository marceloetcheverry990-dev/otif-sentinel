import { describe, it, expect } from 'vitest';
import { parseFlotaDisponible } from './optimizer-flota.js';

describe('parseFlotaDisponible', () => {
  it('vacío → sin límite (99)', () => {
    expect(parseFlotaDisponible('')).toEqual({ ok: true, value: 99 });
    expect(parseFlotaDisponible(null)).toEqual({ ok: true, value: 99 });
  });

  it('0 es válido (congelar flota)', () => {
    expect(parseFlotaDisponible(0)).toEqual({ ok: true, value: 0 });
    expect(parseFlotaDisponible('0')).toEqual({ ok: true, value: 0 });
  });

  it('rechaza negativos y no enteros', () => {
    expect(parseFlotaDisponible(-5).ok).toBe(false);
    expect(parseFlotaDisponible('-5').ok).toBe(false);
    expect(parseFlotaDisponible('3.2').ok).toBe(false);
    expect(parseFlotaDisponible('abc').ok).toBe(false);
  });

  it('acepta 1–50', () => {
    expect(parseFlotaDisponible(3)).toEqual({ ok: true, value: 3 });
    expect(parseFlotaDisponible('3')).toEqual({ ok: true, value: 3 });
    expect(parseFlotaDisponible(51).ok).toBe(false);
  });
});
