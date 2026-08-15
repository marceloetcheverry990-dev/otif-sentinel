-- Rollback 010 — NO recrea uniques globales (pueden fallar si ya hay colisiones cross-tenant).
DROP INDEX IF EXISTS uq_ordenes_pendientes_tenant_ot;
DROP INDEX IF EXISTS uq_clientes_tenant_nombre;
