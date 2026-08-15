-- migrations/012_product_gaps.sql
-- Gaps de producto: notificaciones cliente, firma POD, VRPTW, peso, settings

BEGIN;

-- Capacidad dual + ventanas duras + firma POD
ALTER TABLE ordenes_pendientes
  ADD COLUMN IF NOT EXISTS peso_kg NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ventana_inicio TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ventana_fin TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS firma_url TEXT;

ALTER TABLE choferes
  ADD COLUMN IF NOT EXISTS capacidad_peso NUMERIC DEFAULT 99999;

-- Settings de notificación / branding / POD por tenant
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS notify_sms_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_email_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS brand_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS pod_requirements JSONB NOT NULL DEFAULT '{"foto":true,"firma":true,"scan":true,"notas":false}'::jsonb;

-- Outbox de notificaciones al destinatario
CREATE TABLE IF NOT EXISTS customer_notifications (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL,
  ot_id         TEXT NOT NULL,
  trip_id       TEXT,
  event_type    VARCHAR(32) NOT NULL,
  channel       VARCHAR(16) NOT NULL,
  to_address    TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  provider_id   TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ,
  CONSTRAINT customer_notifications_event_chk
    CHECK (event_type IN ('DESPACHADO', 'ETA_15MIN', 'ENTREGADO')),
  CONSTRAINT customer_notifications_channel_chk
    CHECK (channel IN ('sms', 'email')),
  CONSTRAINT customer_notifications_status_chk
    CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_notifications_pending_sent
  ON customer_notifications (tenant_id, ot_id, event_type, channel)
  WHERE status IN ('PENDING', 'SENT');

CREATE INDEX IF NOT EXISTS idx_customer_notifications_pending
  ON customer_notifications (status, created_at)
  WHERE status = 'PENDING';

COMMIT;
