-- migrations/012_rollback.sql
BEGIN;

DROP INDEX IF EXISTS idx_customer_notifications_pending;
DROP INDEX IF EXISTS uq_customer_notifications_pending_sent;
DROP TABLE IF EXISTS customer_notifications;

ALTER TABLE tenant_settings
  DROP COLUMN IF EXISTS notify_sms_enabled,
  DROP COLUMN IF EXISTS notify_email_enabled,
  DROP COLUMN IF EXISTS brand_name,
  DROP COLUMN IF EXISTS pod_requirements;

ALTER TABLE choferes
  DROP COLUMN IF EXISTS capacidad_peso;

ALTER TABLE ordenes_pendientes
  DROP COLUMN IF EXISTS peso_kg,
  DROP COLUMN IF EXISTS ventana_inicio,
  DROP COLUMN IF EXISTS ventana_fin,
  DROP COLUMN IF EXISTS firma_url;

COMMIT;
