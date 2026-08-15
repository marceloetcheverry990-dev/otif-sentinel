import { describe, it, expect } from 'vitest';
import { isInsideGeofence } from './auto-llegada.js';

describe('isInsideGeofence', () => {
  it('dentro de 150m', () => {
    // ~111m por 0.001° lat
    const r = isInsideGeofence(-33.45, -70.66, -33.4505, -70.66, 150);
    expect(r.inside).toBe(true);
    expect(r.distM).toBeLessThan(150);
  });

  it('fuera de 150m', () => {
    const r = isInsideGeofence(-33.45, -70.66, -33.46, -70.66, 150);
    expect(r.inside).toBe(false);
    expect(r.distM).toBeGreaterThan(150);
  });
});
