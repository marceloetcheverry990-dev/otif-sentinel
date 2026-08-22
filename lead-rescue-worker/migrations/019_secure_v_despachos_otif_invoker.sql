-- migrations/019_secure_v_despachos_otif_invoker.sql
-- Advisor ERROR: view SECURITY DEFINER → security_invoker.

CREATE OR REPLACE VIEW public.v_despachos_otif
WITH (security_invoker = true) AS
 SELECT o.ot_id,
    o.trip_id,
    o.cliente,
    o.zona_reparto,
    COALESCE(ch.nombre_completo, 'Sin asignar'::character varying) AS camioneta,
    o.chofer_asignado_id AS camioneta_id,
    o.estado_operacional,
    o.peso_kg,
    o.fecha_hora_sla,
    o.hora_real,
    o.created_at,
        CASE
            WHEN o.estado_operacional = 'ENTREGADO'::text AND o.hora_real IS NOT NULL AND o.fecha_hora_sla IS NOT NULL AND o.hora_real <= o.fecha_hora_sla THEN true
            WHEN o.estado_operacional = 'ENTREGADO'::text THEN false
            ELSE NULL::boolean
        END AS a_tiempo,
    date((o.created_at AT TIME ZONE 'America/Santiago'::text)) AS fecha
   FROM ordenes_pendientes o
     LEFT JOIN choferes ch ON o.chofer_asignado_id::character varying::text = ch.chofer_id::character varying::text;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='update_trip_metrics_updated_at') THEN
    EXECUTE $f$ALTER FUNCTION public.update_trip_metrics_updated_at() SET search_path = public, pg_temp$f$;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='auditoria_automatica_leads') THEN
    EXECUTE $f$ALTER FUNCTION public.auditoria_automatica_leads() SET search_path = public, pg_temp$f$;
  END IF;
END $$;
