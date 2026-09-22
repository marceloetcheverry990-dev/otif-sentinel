import { describe, it, expect } from 'vitest';
import { hasHazmat, hasFood, tagsConflict } from './cargo-constraints.js';

describe('cargo-constraints — tags HAZMAT/FOOD (fuente única de verdad)', () => {
  it('reconoce PELIGROSO y PELIGROSA (bien escritos) como HAZMAT, no solo el typo PELGEROSO', () => {
    expect(hasHazmat(['PELIGROSO'])).toBe(true);
    expect(hasHazmat(['PELIGROSA'])).toBe(true);
    expect(hasHazmat(['PELGEROSO'])).toBe(true); // typo histórico, se mantiene por compat
    expect(hasHazmat(['HAZMAT'])).toBe(true);
    expect(hasHazmat(['ADR'])).toBe(true);
  });

  it('reconoce las variantes de FOOD', () => {
    expect(hasFood(['FOOD'])).toBe(true);
    expect(hasFood(['ALIMENTO'])).toBe(true);
    expect(hasFood(['ALIMENTOS'])).toBe(true);
    expect(hasFood(['FRIO_ALIMENTO'])).toBe(true);
  });

  it('tagsConflict detecta HAZMAT vs FOOD cruzados entre dos conjuntos', () => {
    expect(tagsConflict(['PELIGROSO'], ['ALIMENTO'])).toBe(true);
    expect(tagsConflict(['ALIMENTO'], ['PELIGROSO'])).toBe(true);
    expect(tagsConflict(['PELIGROSO'], ['PELIGROSO'])).toBe(false);
    expect(tagsConflict([], [])).toBe(false);
  });

  it('no confunde mayúsculas/minúsculas ni strings sueltas', () => {
    expect(hasHazmat('peligroso')).toBe(true);
    expect(hasHazmat('peligroso,otro-tag')).toBe(true);
  });
});
