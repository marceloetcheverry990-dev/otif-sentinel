// Configuración separada para tests de ui.js
// ui.js es una función pura (sin fetch, sin DB, sin env de CF) — se puede correr en Node.
// El vitest.config.js principal usa @cloudflare/vitest-pool-workers que requiere
// bindings CF; este config usa el pool de Node estándar para los tests de UI.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/ui.test.js'],
    snapshotOptions: {
      // Guardar snapshots en src/__snapshots__/
    },
  },
});
