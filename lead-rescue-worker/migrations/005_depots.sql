-- migrations/005_depots.sql
-- Multi-bodega: catálogo de depósitos por tenant.

BEGIN;

CREATE TABLE IF NOT EXISTS depots (
  depot_id    VARCHAR(64)  PRIMARY KEY,
  tenant_id   VARCHAR(64)  NOT NULL,
  nombre      VARCHAR(128) NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  is_default  BOOLEAN      NOT NULL DEFAULT FALSE,
  activo      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_depots_tenant_activo
  ON depots (tenant_id, activo);

-- Un solo default activo por tenant (parcial)
CREATE UNIQUE INDEX IF NOT EXISTS uq_depots_one_default_per_tenant
  ON depots (tenant_id)
  WHERE is_default AND activo;

COMMIT;
