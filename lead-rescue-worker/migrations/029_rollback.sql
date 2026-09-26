-- Rollback 029: el código vuelve a deducir el modo del nombre (perfil-pesos.js lo tolera).
ALTER TABLE perfiles_optimizacion DROP CONSTRAINT IF EXISTS perfiles_optimizacion_modo_chk;
ALTER TABLE perfiles_optimizacion DROP COLUMN IF EXISTS modo;
