-- migrations/013_rollback.sql
BEGIN;

DROP INDEX IF EXISTS idx_ordenes_pendientes_tenant_lat_lng;

ALTER TABLE ordenes_pendientes
  DROP COLUMN IF EXISTS lat,
  DROP COLUMN IF EXISTS lng,
  DROP COLUMN IF EXISTS tags_requeridos;

COMMIT;
