-- migrations/007_tenant_settings.sql
-- Multi-tenant: settings por tenant (Telegram ops, etc.)

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id              VARCHAR(64) PRIMARY KEY,
  telegram_ops_chat_id   VARCHAR(64),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
