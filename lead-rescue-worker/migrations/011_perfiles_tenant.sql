-- 011: perfiles_optimizacion scoped por tenant (M-13)

ALTER TABLE perfiles_optimizacion
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64);

-- Backfill: filas legacy sin tenant quedan visibles a todos hasta reasignar
-- (el código filtra tenant_id = $1 OR tenant_id IS NULL durante transición).

CREATE INDEX IF NOT EXISTS idx_perfiles_optimizacion_tenant
  ON perfiles_optimizacion (tenant_id);
