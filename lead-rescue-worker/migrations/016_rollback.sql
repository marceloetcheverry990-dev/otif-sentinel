-- migrations/016_rollback.sql
BEGIN;

DROP INDEX IF EXISTS uq_guias_despacho_traslado;
CREATE UNIQUE INDEX IF NOT EXISTS uq_guias_despacho_tenant_ot
  ON guias_despacho (tenant_id, ot_id);

ALTER TABLE guias_despacho DROP CONSTRAINT IF EXISTS guias_despacho_estado_chk;
ALTER TABLE guias_despacho
  ADD CONSTRAINT guias_despacho_estado_chk
  CHECK (estado IN ('PENDING', 'EMITTING', 'EMITIDA', 'ERROR', 'SKIPPED', 'STUB'));

ALTER TABLE guias_despacho
  DROP COLUMN IF EXISTS ts_source,
  DROP COLUMN IF EXISTS fecha_estimada_entrega,
  DROP COLUMN IF EXISTS fecha_llegada,
  DROP COLUMN IF EXISTS origen_lat,
  DROP COLUMN IF EXISTS origen_lng;

COMMIT;
