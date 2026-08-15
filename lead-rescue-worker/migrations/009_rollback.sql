-- migrations/009_rollback.sql
BEGIN;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'ordenes_pendientes','flota_vehiculos','choferes','bitacora_viajes',
    'gps_trail','stop_dwell_stats','fleet_alerts','rescue_missions',
    'tenant_settings','depots','eta_accuracy_metrics','clientes'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_otif_app ON public.%I', t);
  END LOOP;
END $$;

ALTER TABLE eta_accuracy_metrics DROP COLUMN IF EXISTS error_viaje_minutos;
ALTER TABLE eta_accuracy_metrics DROP COLUMN IF EXISTS arrival_basis;

-- No dropear otif_app automáticamente (puede estar grantado a logins ops).
-- DROP ROLE IF EXISTS otif_app;

COMMIT;
