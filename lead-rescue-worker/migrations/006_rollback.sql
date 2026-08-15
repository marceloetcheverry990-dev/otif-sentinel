-- migrations/006_rollback.sql
BEGIN;

DROP TABLE IF EXISTS rescue_missions;
DROP TABLE IF EXISTS fleet_alerts;
DROP TABLE IF EXISTS stop_dwell_stats;
DROP TABLE IF EXISTS gps_trail;

ALTER TABLE flota_vehiculos
  DROP COLUMN IF EXISTS last_significant_move_at;

COMMIT;
