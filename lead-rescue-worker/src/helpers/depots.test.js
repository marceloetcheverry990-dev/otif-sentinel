import { describe, it, expect } from 'vitest';
import {
  FALLBACK_DEPOT,
  normalizeDepotRow,
  depotToAppConfig,
  depotToSolver,
} from './depots.js';

describe('depots helpers', () => {
  it('fallback es Maipú', () => {
    expect(FALLBACK_DEPOT.lat).toBeCloseTo(-33.5132);
    expect(FALLBACK_DEPOT.lng).toBeCloseTo(-70.7672);
  });

  it('normalizeDepotRow parsea números', () => {
    const d = normalizeDepotRow({
      depot_id: 'd1',
      nombre: 'Norte',
      lat: '-33.4',
      lng: '-70.6',
      is_default: true,
    });
    expect(d.lat).toBeCloseTo(-33.4);
    expect(d.is_default).toBe(true);
  });

  it('depotToAppConfig y solver', () => {
    const cfg = depotToAppConfig({ lat: -33.5, lng: -70.7, nombre: 'X', depot_id: 'x' });
    expect(cfg.LAT).toBe(-33.5);
    expect(cfg.NOMBRE).toBe('X');
    expect(depotToSolver(cfg).lat).toBe(-33.5); // acepta LAT/LNG de CONFIG.BODEGA
    expect(depotToSolver({ lat: -33.5, lng: -70.7 }).lat).toBe(-33.5);
  });
});
