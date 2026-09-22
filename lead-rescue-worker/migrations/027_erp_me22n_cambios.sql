-- 027_erp_me22n_cambios.sql
-- ME22N (modificar pedido): indicador de borrado de posición (LOEKZ en SAP) y
-- documentos de modificación (CDHDR/CDPOS en SAP) para auditar quién cambió qué.
-- Idempotente. Mismo RLS que 023/025.

BEGIN;

ALTER TABLE public.erp_pedidos_compra_pos
  ADD COLUMN IF NOT EXISTS borrado BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.erp_cambios (
  id             BIGSERIAL    PRIMARY KEY,
  tenant_id      VARCHAR(64)  NOT NULL,
  objeto         VARCHAR(24)  NOT NULL,
  clave          VARCHAR(20)  NOT NULL,
  posicion       INTEGER,
  campo          VARCHAR(40)  NOT NULL,
  valor_antes    TEXT,
  valor_despues  TEXT,
  usuario        VARCHAR(64),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_erp_cambios_objeto
  ON public.erp_cambios (tenant_id, objeto, clave, created_at DESC);

ALTER TABLE public.erp_cambios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_cambios FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_all ON public.erp_cambios;
CREATE POLICY tenant_isolation_all ON public.erp_cambios
  FOR ALL TO anon, authenticated
  USING ((tenant_id)::text = public.app_current_tenant())
  WITH CHECK ((tenant_id)::text = public.app_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otif_app') THEN
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_otif_app ON public.erp_cambios';
    EXECUTE 'CREATE POLICY tenant_isolation_otif_app ON public.erp_cambios
               FOR ALL TO otif_app
               USING ((tenant_id)::text = public.app_current_tenant())
               WITH CHECK ((tenant_id)::text = public.app_current_tenant())';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.erp_cambios TO otif_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.erp_cambios_id_seq TO otif_app';
  END IF;
END $$;

COMMIT;
