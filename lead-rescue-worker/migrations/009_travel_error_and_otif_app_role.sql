-- migrations/009_travel_error_and_otif_app_role.sql
-- 1) error_viaje_minutos: error de tránsito SIN dwell (F2/F3)
-- 2) Rol otif_app SIN BYPASSRLS — Hyperdrive debe usar un login que herede este rol.
--
-- SEGURIDAD: este archivo NO crea roles LOGIN ni pone passwords.
-- Ops (fuera del repo), después de aplicar:
--   CREATE ROLE otif_app_login LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '...secreto...';
--   GRANT otif_app TO otif_app_login;
--   → apuntar Hyperdrive a otif_app_login
--
-- Mientras Hyperdrive use postgres/service_role, RLS sigue siendo cosmético.
-- SUPABASE_SERVICE_KEY (REST) también bypasea RLS.

BEGIN;

-- Dependencia de 008: si 008 no se aplicó, creamos la función acá (idempotente).
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

ALTER TABLE eta_accuracy_metrics
  ADD COLUMN IF NOT EXISTS error_viaje_minutos NUMERIC(8,1);

ALTER TABLE eta_accuracy_metrics
  ADD COLUMN IF NOT EXISTS arrival_basis VARCHAR(16);

COMMENT ON COLUMN eta_accuracy_metrics.error_viaje_minutos IS
  'Error ETA vs hora_llegada_chofer (viaje). No incluye dwell en andén.';
COMMENT ON COLUMN eta_accuracy_metrics.arrival_basis IS
  'llegada = medido contra LLEGADA; null/unknown = legado no confiable para F2';

-- Rol de aplicación: SOLO NOLOGIN (sin password en migración)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otif_app') THEN
    CREATE ROLE otif_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE otif_app NOBYPASSRLS;
    -- Si alguien creó login por error en versión anterior, no tocamos password aquí
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO otif_app;
GRANT EXECUTE ON FUNCTION public.app_current_tenant() TO otif_app;

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
    'depots',
    'eta_accuracy_metrics',
    'clientes'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO otif_app', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_otif_app ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_otif_app ON public.%I
         FOR ALL
         TO otif_app
         USING (tenant_id = public.app_current_tenant())
         WITH CHECK (tenant_id = public.app_current_tenant())',
      t
    );
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO otif_app;

COMMIT;
