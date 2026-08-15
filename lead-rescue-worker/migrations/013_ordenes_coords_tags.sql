-- migrations/013_ordenes_coords_tags.sql
-- Columnas lat/lng/tags_requeridos en ordenes_pendientes + backfill desde metadata.
-- Idempotente. Staging y prod comparten Hyperdrive: solo ADD IF NOT EXISTS + UPDATE NULL.

BEGIN;

ALTER TABLE ordenes_pendientes
  ADD COLUMN IF NOT EXISTS lat NUMERIC,
  ADD COLUMN IF NOT EXISTS lng NUMERIC,
  ADD COLUMN IF NOT EXISTS tags_requeridos JSONB;

-- Backfill coords desde metadata (solo donde columna está vacía)
UPDATE ordenes_pendientes
SET lat = (metadata->>'lat_destino')::numeric
WHERE lat IS NULL
  AND metadata ? 'lat_destino'
  AND (metadata->>'lat_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
  AND ABS((metadata->>'lat_destino')::numeric) <= 90
  AND (metadata->>'lat_destino')::numeric <> 0;

UPDATE ordenes_pendientes
SET lng = (metadata->>'lng_destino')::numeric
WHERE lng IS NULL
  AND metadata ? 'lng_destino'
  AND (metadata->>'lng_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
  AND ABS((metadata->>'lng_destino')::numeric) <= 180
  AND (metadata->>'lng_destino')::numeric <> 0;

-- Backfill tags desde metadata (array JSON)
UPDATE ordenes_pendientes
SET tags_requeridos = CASE
  WHEN jsonb_typeof(metadata->'tags_requeridos') = 'array' THEN metadata->'tags_requeridos'
  ELSE tags_requeridos
END
WHERE (tags_requeridos IS NULL OR tags_requeridos = '[]'::jsonb)
  AND metadata ? 'tags_requeridos'
  AND jsonb_typeof(metadata->'tags_requeridos') = 'array';

CREATE INDEX IF NOT EXISTS idx_ordenes_pendientes_tenant_lat_lng
  ON ordenes_pendientes (tenant_id)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;

COMMIT;
