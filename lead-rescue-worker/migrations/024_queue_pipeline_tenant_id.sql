-- migrations/024_queue_pipeline_tenant_id.sql
-- Pipeline de colas (transaction_logs, outbox_events, dead_letter_events) —
-- MVP original ("Lead_Rescue_MVP"), separado del flujo activo de
-- ordenes_pendientes. Nunca tuvo tenant_id: ni las tablas, ni el webhook
-- que las alimenta (/wms-webhook). transaction_logs está vacía hoy (sin
-- tráfico real) pero se completa el fix para que el código quede correcto
-- si el pipeline se reactiva.
--
-- De paso: transaction_logs.ot_id no tenía NINGÚN unique constraint (solo
-- PK en id) — el `ON CONFLICT (ot_id)` en queues.js ya estaba roto de
-- fábrica, sin relación con el tema de tenants. Esta migración también lo
-- corrige.

BEGIN;

ALTER TABLE public.transaction_logs
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'empresa_base';

ALTER TABLE public.outbox_events
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'empresa_base';

ALTER TABLE public.dead_letter_events
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'empresa_base';

-- transaction_logs.ot_id sin unique previo -> agregamos el compuesto correcto.
ALTER TABLE public.transaction_logs
  DROP CONSTRAINT IF EXISTS uq_transaction_logs_tenant_ot;
ALTER TABLE public.transaction_logs
  ADD CONSTRAINT uq_transaction_logs_tenant_ot UNIQUE (tenant_id, ot_id);

CREATE INDEX IF NOT EXISTS idx_transaction_logs_tenant
  ON public.transaction_logs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_tenant
  ON public.outbox_events (tenant_id);
CREATE INDEX IF NOT EXISTS idx_dead_letter_events_tenant
  ON public.dead_letter_events (tenant_id);

-- RLS: mismo patrón que el resto de tablas tenant-scoped (mig. 020/023).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'transaction_logs',
    'outbox_events',
    'dead_letter_events'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_all ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_all ON public.%I
         FOR ALL TO anon, authenticated
         USING ((tenant_id)::text = public.app_current_tenant())
         WITH CHECK ((tenant_id)::text = public.app_current_tenant())',
      t
    );
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otif_app') THEN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_otif_app ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation_otif_app ON public.%I
           FOR ALL TO otif_app
           USING ((tenant_id)::text = public.app_current_tenant())
           WITH CHECK ((tenant_id)::text = public.app_current_tenant())',
        t
      );
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO otif_app', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
