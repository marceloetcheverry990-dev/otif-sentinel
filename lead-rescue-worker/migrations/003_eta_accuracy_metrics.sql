-- migrations/003_eta_accuracy_metrics.sql
-- Sistema de medición de precisión ETA a nivel enterprise
-- Captura el error entre ETA calculado y hora real de llegada por parada individual

BEGIN;

CREATE TABLE IF NOT EXISTS eta_accuracy_metrics (
  id                      BIGSERIAL      PRIMARY KEY,
  tenant_id               VARCHAR(64)    NOT NULL,
  trip_id                 VARCHAR(64)    NOT NULL,
  stop_id                 VARCHAR(64)    NOT NULL,
  chofer_id               VARCHAR(64),
  eta_calculado           TIMESTAMPTZ    NOT NULL,
  hora_real_llegada       TIMESTAMPTZ    NOT NULL,
  error_minutos           NUMERIC(8,1),                        -- diferencia con signo: positivo = llegó tarde
  error_absoluto_minutos  NUMERIC(8,1),                        -- ABS(error_minutos)
  eta_source              VARCHAR(32),                         -- algoritmo que generó el ETA: MAPBOX_TRAFFIC, HAVERSINE_CASCADE, etc.
  distancia_restante_km   NUMERIC(8,2),                        -- km desde posición GPS al destino al calcular ETA
  optimization_run_id     VARCHAR(64),                         -- ID del run del optimizer formal (OPT-{uuid}); null para recálculos y rutas rápidas
  stop_sequence           SMALLINT,                            -- posición de la parada en la ruta al momento de la entrega
  zona                    VARCHAR(64),                         -- comuna/zona geográfica — fase 1: siempre NULL; se poblará en fase 2
  eta_confidence          NUMERIC(3,2)   CHECK (eta_confidence IS NULL OR (eta_confidence >= 0.00 AND eta_confidence <= 1.00)),
  fecha                   DATE           NOT NULL,             -- derivada de hora_real_llegada en America/Santiago
  created_at              TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_eta_metrics_tenant_stop UNIQUE (tenant_id, stop_id)
);

-- Índice principal: consultas por tenant + rango de fechas (el más frecuente)
CREATE INDEX IF NOT EXISTS idx_eta_metrics_tenant_fecha    ON eta_accuracy_metrics (tenant_id, fecha DESC);

-- Índice para consultas por chofer específico
CREATE INDEX IF NOT EXISTS idx_eta_metrics_chofer_fecha    ON eta_accuracy_metrics (chofer_id, fecha DESC);

-- Índice para correlacionar con trip_metrics
CREATE INDEX IF NOT EXISTS idx_eta_metrics_trip            ON eta_accuracy_metrics (trip_id);

-- Índice para comparar precisión entre algoritmos ETA
CREATE INDEX IF NOT EXISTS idx_eta_metrics_source_fecha    ON eta_accuracy_metrics (eta_source, fecha DESC);

-- Índice parcial para comparar corridas del optimizer (solo filas con valor)
CREATE INDEX IF NOT EXISTS idx_eta_metrics_opt_run         ON eta_accuracy_metrics (optimization_run_id) WHERE optimization_run_id IS NOT NULL;

COMMIT;
