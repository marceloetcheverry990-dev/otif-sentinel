-- migrations/014_guia_despacho_res154.sql
-- Guías de despacho electrónicas (Res. Ex. SII N°154 / vigencia 1-nov-2026).
-- Emisión disparada por la primera SALIDA del viaje.

BEGIN;

-- Origen del traslado: datos postales del depósito
ALTER TABLE depots
  ADD COLUMN IF NOT EXISTS direccion TEXT,
  ADD COLUMN IF NOT EXISTS comuna VARCHAR(64);

-- Campos Res. 154 a nivel OT (peso_kg y volumen ya existen desde 012)
ALTER TABLE ordenes_pendientes
  ADD COLUMN IF NOT EXISTS cantidad NUMERIC,
  ADD COLUMN IF NOT EXISTS tipo_traslado VARCHAR(32);

-- Catálogo mínimo de tipos de traslado (flexible: CHECK suave vía app)
COMMENT ON COLUMN ordenes_pendientes.tipo_traslado IS
  'Res.154: VENTA | TRASLADO_INTERNO | DEVOLUCION | OTRO';

CREATE TABLE IF NOT EXISTS guias_despacho (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       VARCHAR(64) NOT NULL,
  trip_id         TEXT NOT NULL,
  ot_id           TEXT NOT NULL,

  estado          VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  -- PENDING | EMITTING | EMITIDA | ERROR | SKIPPED

  folio           TEXT,
  track_id        TEXT,
  fecha_emision   TIMESTAMPTZ,

  tipo_traslado   VARCHAR(32),
  conductor_rut   TEXT,
  conductor_nombre TEXT,
  patente         TEXT,

  origen_direccion TEXT,
  origen_comuna    TEXT,
  destino_direccion TEXT,
  destino_comuna    TEXT,

  cantidad        NUMERIC,
  peso_kg         NUMERIC,
  volumen         NUMERIC,
  valor_clp       NUMERIC,

  proveedor       VARCHAR(32),
  payload_enviado JSONB,
  respuesta       JSONB,
  error           TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT guias_despacho_estado_chk
    CHECK (estado IN ('PENDING', 'EMITTING', 'EMITIDA', 'ERROR', 'SKIPPED', 'STUB'))
);

-- Una guía por OT (idempotencia de emisión)
CREATE UNIQUE INDEX IF NOT EXISTS uq_guias_despacho_tenant_ot
  ON guias_despacho (tenant_id, ot_id);

CREATE INDEX IF NOT EXISTS idx_guias_despacho_trip
  ON guias_despacho (tenant_id, trip_id);

CREATE INDEX IF NOT EXISTS idx_guias_despacho_estado
  ON guias_despacho (tenant_id, estado)
  WHERE estado IN ('PENDING', 'ERROR', 'EMITTING');

COMMIT;
