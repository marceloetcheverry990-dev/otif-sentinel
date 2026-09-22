-- 028_erp_inventario_fisico.sql
-- Inventario físico (IKPF/ISEG en SAP): MI01 / MI04 / MI03 / MI20 / MI07.
-- Idempotente. Mismo RLS que 023/025.

BEGIN;

CREATE TABLE IF NOT EXISTS public.erp_inventario_fisico (
  tenant_id          VARCHAR(64)  NOT NULL,
  iblnr              VARCHAR(10)  NOT NULL,
  centro             VARCHAR(64)  NOT NULL,
  fecha_planificada  DATE         NOT NULL DEFAULT CURRENT_DATE,
  estado             VARCHAR(14)  NOT NULL DEFAULT 'CREADO',
  texto              VARCHAR(160),
  mblnr              VARCHAR(10),
  created_by         VARCHAR(64),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  contabilizado_at   TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, iblnr),
  CONSTRAINT erp_inventario_fisico_estado_chk CHECK (estado IN ('CREADO', 'CONTADO', 'CONTABILIZADO'))
);

CREATE TABLE IF NOT EXISTS public.erp_inventario_fisico_pos (
  tenant_id         VARCHAR(64)    NOT NULL,
  iblnr             VARCHAR(10)    NOT NULL,
  zeile             INTEGER        NOT NULL,
  sku               VARCHAR(64)    NOT NULL,
  cantidad_contada  NUMERIC(14, 3),
  contado_por       VARCHAR(64),
  contado_at        TIMESTAMPTZ,
  qty_libro         NUMERIC(14, 3),
  diferencia        NUMERIC(14, 3),
  PRIMARY KEY (tenant_id, iblnr, zeile),
  CONSTRAINT erp_inventario_fisico_pos_qty_chk CHECK (cantidad_contada IS NULL OR cantidad_contada >= 0)
);

CREATE INDEX IF NOT EXISTS idx_erp_inventario_fisico_pos_sku
  ON public.erp_inventario_fisico_pos (tenant_id, sku);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['erp_inventario_fisico', 'erp_inventario_fisico_pos'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_all ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_all ON public.%I
         FOR ALL TO anon, authenticated
         USING ((tenant_id)::text = public.app_current_tenant())
         WITH CHECK ((tenant_id)::text = public.app_current_tenant())',
      t
    );
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otif_app') THEN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_otif_app ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation_otif_app ON public.%I
           FOR ALL TO otif_app
           USING ((tenant_id)::text = public.app_current_tenant())
           WITH CHECK ((tenant_id)::text = public.app_current_tenant())',
        t
      );
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO otif_app', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
