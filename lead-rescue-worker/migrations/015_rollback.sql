-- migrations/015_rollback.sql
BEGIN;

ALTER TABLE bitacora_viajes DROP COLUMN IF EXISTS server_received_at;

ALTER TABLE tenant_settings
  DROP COLUMN IF EXISTS dte_rut_emisor,
  DROP COLUMN IF EXISTS dte_razon_social,
  DROP COLUMN IF EXISTS dte_ambiente,
  DROP COLUMN IF EXISTS dte_provider,
  DROP COLUMN IF EXISTS dte_api_token;

ALTER TABLE guias_despacho DROP CONSTRAINT IF EXISTS guias_despacho_estado_chk;
ALTER TABLE guias_despacho
  ADD CONSTRAINT guias_despacho_estado_chk
  CHECK (estado IN ('PENDING', 'EMITTING', 'EMITIDA', 'ERROR', 'SKIPPED'));

COMMIT;
