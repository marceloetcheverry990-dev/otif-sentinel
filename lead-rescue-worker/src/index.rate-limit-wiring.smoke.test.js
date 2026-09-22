/**
 * Smoke: withHealthCheckRateLimit/withDashboardRateLimit existían en
 * monitoring/rate-limiter.js pero nunca se conectaban a ningún router —
 * /health y /dashboard/monitoring quedaban sin límite de requests. Este test
 * solo verifica el *cableado* en el texto fuente (no ejecuta rutas reales:
 * index.js necesita el pool de Workers para correr de punta a punta).
 */
import { describe, expect, it } from 'vitest';
import indexSource from './index.js?raw';

describe('index.js — rate limiters de monitoreo conectados', () => {
  it('importa withHealthCheckRateLimit y withDashboardRateLimit desde rate-limiter.js', () => {
    expect(indexSource).toMatch(/import\s*\{[^}]*withHealthCheckRateLimit[^}]*\}\s*from\s*['"]\.\/monitoring\/rate-limiter\.js['"]/);
    expect(indexSource).toMatch(/withDashboardRateLimit/);
  });

  it('la rama de /health envuelve el handler con withHealthCheckRateLimit', () => {
    const healthBranch = indexSource.match(/url\.pathname === "\/health"\)\s*\{[\s\S]{0,300}?\n\s*\}/);
    expect(healthBranch).not.toBeNull();
    expect(healthBranch[0]).toMatch(/withHealthCheckRateLimit/);
  });

  it('la rama de /dashboard/monitoring envuelve el handler con withDashboardRateLimit', () => {
    const dashboardBranch = indexSource.match(/url\.pathname === "\/dashboard\/monitoring"\)\s*\{[\s\S]{0,300}?\n\s*\}/);
    expect(dashboardBranch).not.toBeNull();
    expect(dashboardBranch[0]).toMatch(/withDashboardRateLimit/);
  });
});
