-- scripts/cleanup-qa-staging.sql
-- Limpieza acotada de basura QA en tenant empresa_base (DB compartida staging/prod).
-- Revisar conteos del bloque SELECT antes de descomentar los DELETE/UPDATE.
-- Fecha de referencia QA: 2026-07-28.

BEGIN;

-- ── Conteos (correr primero) ──────────────────────────────────────────────
SELECT 'spot_qa' AS kind, COUNT(*)::int AS n
FROM ordenes_pendientes
WHERE tenant_id = 'empresa_base'
  AND ot_id LIKE 'SPOT-20260728-%'
UNION ALL
SELECT 'trip_ghost', COUNT(*)::int
FROM (
  SELECT DISTINCT trip_id FROM ordenes_pendientes
  WHERE tenant_id = 'empresa_base'
    AND trip_id ~ '^TRIP-[A-H]$'
) t
UNION ALL
SELECT 'chofer_ocupado_huerfano', COUNT(*)::int
FROM choferes c
WHERE c.tenant_id = 'empresa_base'
  AND UPPER(COALESCE(c.estado, '')) = 'OCUPADO'
  AND NOT EXISTS (
    SELECT 1 FROM flota_vehiculos fv
    WHERE fv.tenant_id = c.tenant_id
      AND fv.rut_chofer_asignado = c.rut
      AND fv.trip_id_actual IS NOT NULL
  );

-- ── Aplicar (descomentar tras revisar) ──────────────────────────────────
/*
-- Cancelar OTs SPOT de la sesión QA (no borrar histórico de bitácora)
UPDATE ordenes_pendientes
SET estado_operacional = 'CANCELADO_PLANILLA',
    trip_id = NULL,
    stop_sequence = NULL,
    chofer_asignado_id = NULL,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'qa_cleanup', true,
      'qa_cleanup_at', NOW()::text
    )
WHERE tenant_id = 'empresa_base'
  AND ot_id LIKE 'SPOT-20260728-%'
  AND COALESCE(estado_operacional, '') <> 'CANCELADO_PLANILLA';

-- Liberar flota atada a viajes fantasma TRIP-A..H
UPDATE flota_vehiculos
SET trip_id_actual = NULL,
    ultima_actualizacion = NOW()
WHERE tenant_id = 'empresa_base'
  AND trip_id_actual ~ '^TRIP-[A-H]$';

-- Despegar OTs de viajes fantasma TRIP-A..H
UPDATE ordenes_pendientes
SET estado_operacional = CASE
      WHEN COALESCE(estado_operacional, '') IN ('ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA')
        THEN estado_operacional
      ELSE 'CANCELADO_PLANILLA'
    END,
    trip_id = NULL,
    stop_sequence = NULL,
    chofer_asignado_id = NULL,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'qa_cleanup', true,
      'qa_cleanup_ghost_trip', true,
      'qa_cleanup_at', NOW()::text
    )
WHERE tenant_id = 'empresa_base'
  AND trip_id ~ '^TRIP-[A-H]$';

-- Choferes OCUPADO sin viaje vivo en flota → DISPONIBLE
UPDATE choferes c
SET estado = 'DISPONIBLE'
WHERE c.tenant_id = 'empresa_base'
  AND UPPER(COALESCE(c.estado, '')) = 'OCUPADO'
  AND NOT EXISTS (
    SELECT 1 FROM flota_vehiculos fv
    WHERE fv.tenant_id = c.tenant_id
      AND fv.rut_chofer_asignado = c.rut
      AND fv.trip_id_actual IS NOT NULL
  );
*/

COMMIT;
