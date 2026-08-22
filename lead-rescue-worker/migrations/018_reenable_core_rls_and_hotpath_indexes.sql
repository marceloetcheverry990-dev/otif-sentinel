-- migrations/018_reenable_core_rls_and_hotpath_indexes.sql
-- Advisor ERROR: políticas tenant_isolation_* existían con RLS OFF en tablas core.
-- Re-habilita RLS + FORCE, restaura fail-closed anon/authenticated, índices hot-path.

CREATE OR REPLACE FUNCTION public.app_current_tenant()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.current_tenant', true), ''),
    NULLIF(
      (NULLIF(current_setting('request.jwt.claims', true), ''))::json->>'tenant_id',
      ''
    )
  );
$$;

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

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_all ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_all ON public.%I
         FOR ALL
         TO anon, authenticated
         USING ((tenant_id)::text = public.app_current_tenant())
         WITH CHECK ((tenant_id)::text = public.app_current_tenant())',
      t
    );

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otif_app') THEN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_otif_app ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation_otif_app ON public.%I
           FOR ALL
           TO otif_app
           USING ((tenant_id)::text = public.app_current_tenant())
           WITH CHECK ((tenant_id)::text = public.app_current_tenant())',
        t
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.guias_despacho') IS NOT NULL THEN
    ALTER TABLE public.guias_despacho ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.guias_despacho FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_all ON public.guias_despacho;
    CREATE POLICY tenant_isolation_all ON public.guias_despacho
      FOR ALL TO anon, authenticated
      USING ((tenant_id)::text = public.app_current_tenant())
      WITH CHECK ((tenant_id)::text = public.app_current_tenant());
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otif_app') THEN
      DROP POLICY IF EXISTS tenant_isolation_otif_app ON public.guias_despacho;
      CREATE POLICY tenant_isolation_otif_app ON public.guias_despacho
        FOR ALL TO otif_app
        USING ((tenant_id)::text = public.app_current_tenant())
        WITH CHECK ((tenant_id)::text = public.app_current_tenant());
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_choferes_patente_asignada
  ON public.choferes (patente_asignada);

CREATE INDEX IF NOT EXISTS idx_choferes_zona_experta_id
  ON public.choferes (zona_experta_id);

CREATE INDEX IF NOT EXISTS idx_fleet_status_logs_chofer_id
  ON public.fleet_status_logs (chofer_id);

CREATE INDEX IF NOT EXISTS idx_rescue_missions_alert_id
  ON public.rescue_missions (alert_id);

CREATE INDEX IF NOT EXISTS idx_ordenes_pendientes_tenant_trip
  ON public.ordenes_pendientes (tenant_id, trip_id)
  WHERE trip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_flota_vehiculos_live
  ON public.flota_vehiculos (tenant_id)
  WHERE trip_id_actual IS NOT NULL AND ultima_lat IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bitacora_chat_trip
  ON public.bitacora_viajes (tenant_id, trip_id, created_at DESC)
  WHERE tipo_evento IN ('CHAT_CHOFER', 'CHAT_TORRE');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable'
  ) THEN
    REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM anon, authenticated;
  END IF;
END $$;

ANALYZE public.ordenes_pendientes;
ANALYZE public.flota_vehiculos;
ANALYZE public.bitacora_viajes;
ANALYZE public.choferes;
ANALYZE public.guias_despacho;
