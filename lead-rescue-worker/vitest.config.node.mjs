// Unit tests puros (sin pool Workers / Hyperdrive).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/helpers/dte/**/*.test.js',
      'src/api/guias-despacho.test.js',
    ],
  },
});

