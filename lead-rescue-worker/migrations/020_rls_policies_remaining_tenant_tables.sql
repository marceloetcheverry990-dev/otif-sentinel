-- migrations/020_rls_policies_remaining_tenant_tables.sql
-- Tablas con RLS ON pero sin policy (advisor INFO) — fail-closed anon/authenticated.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'alert_history',
    'audit_log',
    'customer_notifications',
    'dead_letter_events',
    'delivery_attempts',
    'error_logs',
    'fleet_status_logs',
    'health_check_results',
    'ordenes_import_error',
    'outbox_events',
    'perfiles_optimizacion',
    'public_route_links',
    'sla_clientes',
    'system_flags',
    'tower_operators',
    'tracking_gps',
    'transaction_logs',
    'trip_metrics',
    'zonas_operativas',
    'eta_accuracy_metrics',
    'clientes'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'tenant_id'
    ) THEN
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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO otif_app', t);
    END IF;
  END LOOP;
END $$;
