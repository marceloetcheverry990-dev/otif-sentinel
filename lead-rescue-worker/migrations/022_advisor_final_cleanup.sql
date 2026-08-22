-- migrations/022_advisor_final_cleanup.sql
-- Cierra últimos avisos performance advisor post-021.

CREATE INDEX IF NOT EXISTS idx_fleet_status_logs_patente
  ON public.fleet_status_logs (patente);

-- Redundante: el planner usa flota_vehiculos_trip_id_actual_key en poll live.
DROP INDEX IF EXISTS public.idx_flota_vehiculos_live;

DO $$
BEGIN
  PERFORM set_config('enable_seqscan', 'off', true);
  PERFORM 1 FROM public.fleet_status_logs f WHERE f.patente IS NOT NULL LIMIT 1;
  PERFORM set_config('enable_seqscan', 'on', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('enable_seqscan', 'on', true);
  RAISE;
END $$;

ANALYZE public.fleet_status_logs;
ANALYZE public.flota_vehiculos;
