// Bench del optimizador (fuera de `npm test`): npx vitest run -c bench/vitest.config.mjs
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['bench/**/*.bench.mjs'],
    testTimeout: 300000,
  },
});
