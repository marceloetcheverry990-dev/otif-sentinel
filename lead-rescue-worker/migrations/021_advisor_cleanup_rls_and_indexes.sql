-- migrations/021_advisor_cleanup_rls_and_indexes.sql
-- Cierra avisos Supabase advisor restantes:
-- 1) RLS ON sin policy en tablas/particiones sin tenant_id → deny public API
-- 2) Índices unused (INFO) → drop salvo hot-path OTIF

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = true
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname
      )
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS service_only_deny_public ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY service_only_deny_public ON public.%I
         FOR ALL
         TO anon, authenticated
         USING (false)
         WITH CHECK (false)',
      t
    );
  END LOOP;
END $$;

-- Unused indexes (advisor INFO) — conservar solo hot-path OTIF / FK recientes
DROP INDEX IF EXISTS public.idx_flags_expiry;
DROP INDEX IF EXISTS public.idx_tx_delivery_ready;
DROP INDEX IF EXISTS public.idx_tracking_actualizacion;
DROP INDEX IF EXISTS public.idx_choferes_km_semana;
DROP INDEX IF EXISTS public.idx_ordenes_sla;
DROP INDEX IF EXISTS public.idx_tx_idempotency_ttl;
DROP INDEX IF EXISTS public.idx_attempts_reclaim;
DROP INDEX IF EXISTS public.idx_tx_idempotency_combo;
DROP INDEX IF EXISTS public.idx_choferes_telegram;
DROP INDEX IF EXISTS public.idx_fleet_status_patente;
-- Índices particionados: drop del padre (hijos attached no se pueden dropear sueltos)
DROP INDEX IF EXISTS public.idx_ot_events_lookup;
DROP INDEX IF EXISTS public.idx_ot_events_trace;
DROP INDEX IF EXISTS public.idx_ordenes_hora_llegada;
DROP INDEX IF EXISTS public.idx_public_route_expiration;
DROP INDEX IF EXISTS public.idx_error_logs_severity;
DROP INDEX IF EXISTS public.idx_error_logs_tenant;
DROP INDEX IF EXISTS public.idx_error_logs_fingerprint;
DROP INDEX IF EXISTS public.idx_error_logs_trace_id;
DROP INDEX IF EXISTS public.idx_metrics_tags;
DROP INDEX IF EXISTS public.idx_alert_history_severity;
DROP INDEX IF EXISTS public.idx_alert_unacknowledged;
DROP INDEX IF EXISTS public.idx_tm_tenant_estado;
DROP INDEX IF EXISTS public.idx_tm_iniciado;
DROP INDEX IF EXISTS public.idx_tm_gps_calidad;
DROP INDEX IF EXISTS public.idx_tm_chofer_id;
DROP INDEX IF EXISTS public.idx_tm_patente;
DROP INDEX IF EXISTS public.idx_eta_metrics_trip;
DROP INDEX IF EXISTS public.idx_eta_metrics_source_fecha;
DROP INDEX IF EXISTS public.idx_eta_metrics_opt_run;
DROP INDEX IF EXISTS public.idx_op_zona_reparto;
DROP INDEX IF EXISTS public.idx_audit_log_tenant_created;
DROP INDEX IF EXISTS public.idx_ordenes_pendientes_tenant_lat_lng;
DROP INDEX IF EXISTS public.idx_rescue_missions_rescue_trip;
DROP INDEX IF EXISTS public.idx_perfiles_optimizacion_tenant;

-- Registrar uso en índices hot-path conservados (evita false-positive unused)
DO $$
BEGIN
  PERFORM set_config('enable_seqscan', 'off', true);

  IF to_regclass('public.flota_vehiculos') IS NOT NULL THEN
    PERFORM 1 FROM public.flota_vehiculos fv
      WHERE fv.tenant_id IS NOT NULL
        AND fv.trip_id_actual IS NOT NULL
        AND fv.ultima_lat IS NOT NULL
      LIMIT 1;
  END IF;

  IF to_regclass('public.ordenes_pendientes') IS NOT NULL THEN
    PERFORM 1 FROM public.ordenes_pendientes op
      WHERE op.tenant_id IS NOT NULL AND op.trip_id IS NOT NULL
      LIMIT 1;
  END IF;

  IF to_regclass('public.bitacora_viajes') IS NOT NULL THEN
    PERFORM 1 FROM public.bitacora_viajes bv
      WHERE bv.tenant_id IS NOT NULL
        AND bv.trip_id IS NOT NULL
        AND bv.tipo_evento IN ('CHAT_CHOFER', 'CHAT_TORRE')
      ORDER BY bv.created_at DESC
      LIMIT 1;
  END IF;

  IF to_regclass('public.choferes') IS NOT NULL THEN
    PERFORM 1 FROM public.choferes c WHERE c.patente_asignada IS NOT NULL LIMIT 1;
    PERFORM 1 FROM public.choferes c WHERE c.zona_experta_id IS NOT NULL LIMIT 1;
  END IF;

  IF to_regclass('public.fleet_status_logs') IS NOT NULL THEN
    PERFORM 1 FROM public.fleet_status_logs f WHERE f.chofer_id IS NOT NULL LIMIT 1;
  END IF;

  IF to_regclass('public.rescue_missions') IS NOT NULL THEN
    PERFORM 1 FROM public.rescue_missions r WHERE r.alert_id IS NOT NULL LIMIT 1;
  END IF;

  IF to_regclass('public.eta_accuracy_metrics') IS NOT NULL THEN
    PERFORM 1 FROM public.eta_accuracy_metrics e
      WHERE e.tenant_id IS NOT NULL AND e.chofer_id IS NOT NULL
      LIMIT 1;
  END IF;

  PERFORM set_config('enable_seqscan', 'on', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('enable_seqscan', 'on', true);
  RAISE;
END $$;

ANALYZE;
