-- 026_orden_lineas_quiebre.sql
-- Líneas de las OTs que quedaron en QUIEBRE (sin stock al reservar). Permiten
-- reintentar la reserva automáticamente cuando entra stock por el ERP
-- (MIGO 101/501/552) y mostrar la "demanda en quiebre" en MMBE.
-- Idempotente. Mismo RLS que 023_wms_lite.

BEGIN;

CREATE TABLE IF NOT EXISTS public.orden_lineas_quiebre (
  tenant_id   VARCHAR(64)    NOT NULL,
  ot_id       VARCHAR(120)   NOT NULL,
  sku         VARCHAR(64)    NOT NULL,
  qty         NUMERIC(14, 3) NOT NULL,
  depot_id    VARCHAR(64)    NOT NULL,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, ot_id, sku),
  CONSTRAINT orden_lineas_quiebre_qty_chk CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_orden_lineas_quiebre_depot_sku
  ON public.orden_lineas_quiebre (tenant_id, depot_id, sku);

ALTER TABLE public.orden_lineas_quiebre ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orden_lineas_quiebre FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_all ON public.orden_lineas_quiebre;
CREATE POLICY tenant_isolation_all ON public.orden_lineas_quiebre
  FOR ALL TO anon, authenticated
  USING ((tenant_id)::text = public.app_current_tenant())
  WITH CHECK ((tenant_id)::text = public.app_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otif_app') THEN
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_otif_app ON public.orden_lineas_quiebre';
    EXECUTE 'CREATE POLICY tenant_isolation_otif_app ON public.orden_lineas_quiebre
               FOR ALL TO otif_app
               USING ((tenant_id)::text = public.app_current_tenant())
               WITH CHECK ((tenant_id)::text = public.app_current_tenant())';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orden_lineas_quiebre TO otif_app';
  END IF;
END $$;

COMMIT;
