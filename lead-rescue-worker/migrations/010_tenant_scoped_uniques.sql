-- 010: uniques compuestos por tenant (C-8 / C-10)
-- Evita que ot_id / nombre_cliente_raw globales colisionen entre tenants.

-- ordenes_pendientes: (tenant_id, ot_id)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordenes_pendientes_ot_id_key'
  ) THEN
    ALTER TABLE ordenes_pendientes DROP CONSTRAINT ordenes_pendientes_ot_id_key;
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ordenes_pendientes_tenant_ot
  ON ordenes_pendientes (tenant_id, ot_id);

-- clientes: (tenant_id, nombre_cliente_raw)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clientes_nombre_cliente_raw_key'
  ) THEN
    ALTER TABLE clientes DROP CONSTRAINT clientes_nombre_cliente_raw_key;
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

-- Si el unique era un índice con otro nombre:
DROP INDEX IF EXISTS clientes_nombre_cliente_raw_key;
DROP INDEX IF EXISTS uq_clientes_nombre_cliente_raw;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_tenant_nombre
  ON clientes (tenant_id, nombre_cliente_raw);
