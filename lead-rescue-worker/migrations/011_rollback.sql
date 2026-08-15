DROP INDEX IF EXISTS idx_perfiles_optimizacion_tenant;
ALTER TABLE perfiles_optimizacion DROP COLUMN IF EXISTS tenant_id;
