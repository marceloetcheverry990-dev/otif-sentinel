// Unit tests puros (sin pool Workers / Hyperdrive).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/helpers/dte/**/*.test.js',
      'src/helpers/env-isolation.test.js',
      'src/api/guias-despacho.test.js',
      'src/api/dashboard-executive-kpis.test.js',
      'src/helpers/security-headers.test.js',
      'src/helpers/optimizer-flota.test.js',
      'src/helpers/dead-man-switch.test.js',
      'src/helpers/mapbox-directions.test.js',
      'src/api/route-geometry.test.js',
      'src/helpers/recalcular-ruteo.test.js',
      'src/api/recalcular-ruteo.test.js',
      'src/helpers/vrp-solver.test.js',
      'src/helpers/perfil-pesos.test.js',
      'src/helpers/geocode.test.js',
      'src/helpers/bitacora-insert.test.js',
      'src/helpers/trip-ownership.test.js',
      'src/helpers/tower-poll-cache.test.js',
    ],
  },
});

