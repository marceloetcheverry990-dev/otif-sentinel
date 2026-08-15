-- migrations/008_rollback.sql
-- Revierte RLS de 008_rls_tenant_isolation.sql

BEGIN;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'ordenes_pendientes',
    'flota_vehiculos',
    'choferes',
    'bitacora_viajes',
    'gps_trail',
    'stop_dwell_stats',
    'fleet_alerts',
    'rescue_missions',
    'tenant_settings',
    'depots'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_all ON public.%I', t);
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.app_current_tenant();

COMMIT;
