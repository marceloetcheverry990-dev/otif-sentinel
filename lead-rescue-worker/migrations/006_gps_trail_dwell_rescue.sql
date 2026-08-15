-- migrations/006_gps_trail_dwell_rescue.sql
-- Fase 0: historial GPS + dwell stats | Fase 1: Dead Man's Switch + Lead Rescue

BEGIN;

-- Posición con movimiento significativo (Dead Man's Switch)
ALTER TABLE flota_vehiculos
  ADD COLUMN IF NOT EXISTS last_significant_move_at TIMESTAMPTZ;

-- Trail GPS muestreado (retención ~14 días vía cron)
CREATE TABLE IF NOT EXISTS gps_trail (
  id           BIGSERIAL       PRIMARY KEY,
  tenant_id    VARCHAR(64)     NOT NULL,
  trip_id      VARCHAR(64)     NOT NULL,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  recorded_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  delta_km     NUMERIC(8,3),
  is_heartbeat BOOLEAN         NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_gps_trail_trip_time
  ON gps_trail (tenant_id, trip_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_gps_trail_retention
  ON gps_trail (recorded_at);

-- Agregado empírico de tiempo en sitio (base para riesgo SLA futuro)
CREATE TABLE IF NOT EXISTS stop_dwell_stats (
  tenant_id       VARCHAR(64)    NOT NULL,
  cliente         VARCHAR(120)   NOT NULL,
  chofer_id       VARCHAR(64)    NOT NULL DEFAULT '',
  dow             SMALLINT       NOT NULL CHECK (dow BETWEEN 0 AND 6),
  hour_bucket     SMALLINT       NOT NULL CHECK (hour_bucket BETWEEN 0 AND 23),
  samples         INT            NOT NULL DEFAULT 0,
  dwell_sum_min   NUMERIC(12,1)  NOT NULL DEFAULT 0,
  dwell_avg_min   NUMERIC(8,1),
  dwell_p50_min   NUMERIC(8,1),
  dwell_p90_min   NUMERIC(8,1),
  recent_samples  JSONB          NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, cliente, chofer_id, dow, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_stop_dwell_cliente
  ON stop_dwell_stats (tenant_id, cliente, dow, hour_bucket);

-- Alertas de flota (camión quieto / señal perdida)
CREATE TABLE IF NOT EXISTS fleet_alerts (
  id             BIGSERIAL     PRIMARY KEY,
  tenant_id      VARCHAR(64)   NOT NULL,
  trip_id        VARCHAR(64)   NOT NULL,
  alert_type     VARCHAR(32)   NOT NULL,
  severity       VARCHAR(16)   NOT NULL,
  status         VARCHAR(24)   NOT NULL DEFAULT 'OPEN',
  stuck_minutes  INT,
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  payload        JSONB         NOT NULL DEFAULT '{}'::jsonb,
  notified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fleet_alerts_open
  ON fleet_alerts (tenant_id, trip_id, alert_type)
  WHERE status IN ('OPEN', 'ACKED', 'RESCUING');

CREATE INDEX IF NOT EXISTS idx_fleet_alerts_tenant_status
  ON fleet_alerts (tenant_id, status, updated_at DESC);

-- Misiones de rescate confirmadas por despachador
CREATE TABLE IF NOT EXISTS rescue_missions (
  id               BIGSERIAL     PRIMARY KEY,
  tenant_id        VARCHAR(64)   NOT NULL,
  alert_id         BIGINT        REFERENCES fleet_alerts(id),
  source_trip_id   VARCHAR(64)   NOT NULL,
  rescue_trip_id   VARCHAR(64)   NOT NULL,
  rescue_chofer_id VARCHAR(64),
  ot_ids           JSONB         NOT NULL DEFAULT '[]'::jsonb,
  status           VARCHAR(24)   NOT NULL DEFAULT 'DISPATCHED',
  delta_km         NUMERIC(8,2),
  created_by       VARCHAR(128),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rescue_missions_rescue_trip
  ON rescue_missions (tenant_id, rescue_trip_id, status);

CREATE INDEX IF NOT EXISTS idx_rescue_missions_source
  ON rescue_missions (tenant_id, source_trip_id, created_at DESC);

COMMIT;
