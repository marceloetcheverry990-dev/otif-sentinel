-- migrations/016_res154_phase2.sql
-- R3 ts_source/REVIEW · S7 fechas llegada · S8 unique por traslado/vehículo

BEGIN;

ALTER TABLE guias_despacho
  ADD COLUMN IF NOT EXISTS ts_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS fecha_estimada_entrega TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fecha_llegada TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS origen_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS origen_lng DOUBLE PRECISION;

ALTER TABLE guias_despacho DROP CONSTRAINT IF EXISTS guias_despacho_estado_chk;
ALTER TABLE guias_despacho
  ADD CONSTRAINT guias_despacho_estado_chk
  CHECK (estado IN (
    'PENDING', 'EMITTING', 'EMITIDA', 'ERROR', 'SKIPPED', 'STUB', 'REVIEW'
  ));

-- S8: una guía por OT + viaje + vehículo (transbordo)
DROP INDEX IF EXISTS uq_guias_despacho_tenant_ot;
CREATE UNIQUE INDEX IF NOT EXISTS uq_guias_despacho_traslado
  ON guias_despacho (tenant_id, ot_id, trip_id, (COALESCE(patente, '')));

COMMIT;
