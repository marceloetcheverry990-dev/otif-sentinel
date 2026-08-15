-- migrations/004_tower_operators_audit.sql
-- Operadores individuales de Torre de Control + bitácora de mutaciones.

BEGIN;

CREATE TABLE IF NOT EXISTS tower_operators (
  operator_id    VARCHAR(36)   PRIMARY KEY,
  tenant_id      VARCHAR(64)   NOT NULL,
  username       VARCHAR(64)   NOT NULL,
  display_name   VARCHAR(128),
  email          VARCHAR(255),
  password_hash  TEXT          NOT NULL,
  is_admin       BOOLEAN       NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN       NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tower_operators_tenant_username UNIQUE (tenant_id, username)
);

CREATE INDEX IF NOT EXISTS idx_tower_operators_tenant_active
  ON tower_operators (tenant_id, is_active);

CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGSERIAL     PRIMARY KEY,
  tenant_id      VARCHAR(64)   NOT NULL,
  operator_id    VARCHAR(36),
  username       VARCHAR(64),
  action         VARCHAR(64)   NOT NULL,
  outcome        VARCHAR(16)   NOT NULL DEFAULT 'success',
  resource_type  VARCHAR(64),
  resource_id    VARCHAR(128),
  meta           JSONB         NOT NULL DEFAULT '{}'::jsonb,
  ip             VARCHAR(64),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created
  ON audit_log (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_operator_created
  ON audit_log (operator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_action_created
  ON audit_log (action, created_at DESC);

COMMIT;
