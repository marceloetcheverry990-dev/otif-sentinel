-- migrations/008_rls_tenant_isolation.sql
-- D3: Row Level Security por tenant_id en tablas core.
--
-- Comportamiento:
-- - anon / authenticated: solo filas del tenant en app.current_tenant
--   o claim JWT request.jwt.claims.tenant_id (PostgREST/Supabase).
-- - Roles con BYPASSRLS (p.ej. service_role / postgres en Supabase):
--   siguen viendo todo — el Worker actual no se rompe.
-- - FORCE RLS: ni el dueño de la tabla saltea políticas (salvo BYPASSRLS).
--
-- Defensa en profundidad: no reemplaza WHERE tenant_id = $1 en el Worker.

BEGIN;

CREATE OR REPLACE FUNCTION public.app_current_tenant()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.current_tenant', true), ''),
    NULLIF(
      (NULLIF(current_setting('request.jwt.claims', true), ''))::json->>'tenant_id',
      ''
    )
  );
$$;

COMMENT ON FUNCTION public.app_current_tenant() IS
  'Tenant activo para políticas RLS (set_config app.current_tenant o JWT claim).';

-- Helper: aplica RLS + política ALL fail-closed por tenant
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
      RAISE NOTICE 'RLS skip: tabla %.% no existe', 'public', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_all ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_all ON public.%I
         FOR ALL
         TO anon, authenticated
         USING (tenant_id = public.app_current_tenant())
         WITH CHECK (tenant_id = public.app_current_tenant())',
      t
    );
  END LOOP;
END $$;

COMMIT;
