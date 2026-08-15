-- Rollback 014_guia_despacho_res154.sql
BEGIN;

DROP TABLE IF EXISTS guias_despacho;

ALTER TABLE ordenes_pendientes
  DROP COLUMN IF EXISTS cantidad,
  DROP COLUMN IF EXISTS tipo_traslado;

ALTER TABLE depots
  DROP COLUMN IF EXISTS direccion,
  DROP COLUMN IF EXISTS comuna;

COMMIT;
