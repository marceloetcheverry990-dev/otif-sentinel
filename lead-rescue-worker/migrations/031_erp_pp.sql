-- 031_erp_pp.sql
-- ERP módulo PP (producción, tipo SAP), fase 1:
--   · Listas de materiales / recetas (STKO/STPO en SAP)
--   · Órdenes de producción (AUFK/AFKO) y sus componentes reservados (RESB)
--   · Stock reservado para producción en inventario_bodega: al liberar una orden
--     sus insumos pasan de libre a este apartado, así la Torre no los vende.
--   · Referencia a la orden en los documentos de material (261/262 consumo,
--     101/102 entrada del producto fabricado).
-- Idempotente: se puede correr más de una vez. Mismo RLS que 025_erp_mm.

BEGIN;

ALTER TABLE public.inventario_bodega
  ADD COLUMN IF NOT EXISTS qty_reservada_produccion NUMERIC(14, 3) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventario_bodega_qty_prod_chk'
  ) THEN
    ALTER TABLE public.inventario_bodega
      ADD CONSTRAINT inventario_bodega_qty_prod_chk CHECK (qty_reservada_produccion >= 0);
  END IF;
END $$;

-- Los documentos de modificación de recetas usan "material / centro" como clave.
ALTER TABLE public.erp_cambios ALTER COLUMN clave TYPE VARCHAR(140);

ALTER TABLE public.erp_documentos_material_pos
  ADD COLUMN IF NOT EXISTS aufnr VARCHAR(12),
  ADD COLUMN IF NOT EXISTS rspos INTEGER;

CREATE INDEX IF NOT EXISTS idx_erp_doc_material_pos_orden
  ON public.erp_documentos_material_pos (tenant_id, aufnr) WHERE aufnr IS NOT NULL;

-- Lista de materiales: una por material fabricado, centro y alternativa.
CREATE TABLE IF NOT EXISTS public.erp_listas_materiales (
  tenant_id      VARCHAR(64)    NOT NULL,
  sku            VARCHAR(64)    NOT NULL,
  centro         VARCHAR(64)    NOT NULL,
  alternativa    VARCHAR(2)     NOT NULL DEFAULT '01',
  cantidad_base  NUMERIC(14, 3) NOT NULL,
  unidad         VARCHAR(16)    NOT NULL DEFAULT 'UN',
  texto          VARCHAR(160),
  created_by     VARCHAR(64),
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, sku, centro, alternativa),
  CONSTRAINT erp_listas_materiales_base_chk CHECK (cantidad_base > 0)
);

CREATE TABLE IF NOT EXISTS public.erp_listas_materiales_pos (
  tenant_id    VARCHAR(64)    NOT NULL,
  sku          VARCHAR(64)    NOT NULL,
  centro       VARCHAR(64)    NOT NULL,
  alternativa  VARCHAR(2)     NOT NULL DEFAULT '01',
  posicion     INTEGER        NOT NULL,
  componente   VARCHAR(64)    NOT NULL,
  cantidad     NUMERIC(14, 3) NOT NULL,
  unidad       VARCHAR(16)    NOT NULL DEFAULT 'UN',
  merma_pct    NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  backflush    BOOLEAN        NOT NULL DEFAULT TRUE,
  texto        VARCHAR(160),
  PRIMARY KEY (tenant_id, sku, centro, alternativa, posicion),
  CONSTRAINT erp_listas_materiales_pos_chk CHECK (cantidad > 0 AND merma_pct >= 0 AND merma_pct < 100)
);

CREATE INDEX IF NOT EXISTS idx_erp_listas_materiales_pos_componente
  ON public.erp_listas_materiales_pos (tenant_id, componente);

-- Orden de producción. Estados de sistema SAP:
--   CRTD abierta · REL liberada · PDLV entregada parcial · DLV entregada
--   TECO cierre técnico · DLFL petición de borrado
CREATE TABLE IF NOT EXISTS public.erp_ordenes_produccion (
  tenant_id           VARCHAR(64)    NOT NULL,
  aufnr               VARCHAR(12)    NOT NULL,
  clase_orden         VARCHAR(4)     NOT NULL DEFAULT 'PP01',
  sku                 VARCHAR(64)    NOT NULL,
  centro              VARCHAR(64)    NOT NULL,
  alternativa         VARCHAR(2)     NOT NULL DEFAULT '01',
  cantidad            NUMERIC(14, 3) NOT NULL,
  cantidad_entregada  NUMERIC(14, 3) NOT NULL DEFAULT 0,
  unidad              VARCHAR(16)    NOT NULL DEFAULT 'UN',
  fecha_inicio        DATE,
  fecha_fin           DATE,
  estado              VARCHAR(4)     NOT NULL DEFAULT 'CRTD',
  entrega_final       BOOLEAN        NOT NULL DEFAULT FALSE,
  texto               VARCHAR(160),
  created_by          VARCHAR(64),
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  liberada_at         TIMESTAMPTZ,
  cerrada_at          TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, aufnr),
  CONSTRAINT erp_ordenes_produccion_estado_chk CHECK (estado IN ('CRTD', 'REL', 'PDLV', 'DLV', 'TECO', 'DLFL')),
  CONSTRAINT erp_ordenes_produccion_qty_chk CHECK (cantidad > 0 AND cantidad_entregada >= 0)
);

CREATE INDEX IF NOT EXISTS idx_erp_ordenes_produccion_material
  ON public.erp_ordenes_produccion (tenant_id, sku, centro);
CREATE INDEX IF NOT EXISTS idx_erp_ordenes_produccion_estado
  ON public.erp_ordenes_produccion (tenant_id, estado);

-- Componentes de la orden (reservas). Se copian de la receta al crear la orden:
-- cambiar la receta después no cambia órdenes ya creadas (igual que SAP).
CREATE TABLE IF NOT EXISTS public.erp_ordenes_componentes (
  tenant_id           VARCHAR(64)    NOT NULL,
  aufnr               VARCHAR(12)    NOT NULL,
  posicion            INTEGER        NOT NULL,
  sku                 VARCHAR(64)    NOT NULL,
  centro              VARCHAR(64)    NOT NULL,
  cantidad_necesaria  NUMERIC(14, 3) NOT NULL,
  cantidad_reservada  NUMERIC(14, 3) NOT NULL DEFAULT 0,
  cantidad_retirada   NUMERIC(14, 3) NOT NULL DEFAULT 0,
  unidad              VARCHAR(16)    NOT NULL DEFAULT 'UN',
  merma_pct           NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  backflush           BOOLEAN        NOT NULL DEFAULT TRUE,
  precio_plan         NUMERIC(16, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, aufnr, posicion),
  CONSTRAINT erp_ordenes_componentes_qty_chk
    CHECK (cantidad_necesaria > 0 AND cantidad_reservada >= 0 AND cantidad_retirada >= 0)
);

CREATE INDEX IF NOT EXISTS idx_erp_ordenes_componentes_material
  ON public.erp_ordenes_componentes (tenant_id, sku, centro);

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'erp_listas_materiales',
    'erp_listas_materiales_pos',
    'erp_ordenes_produccion',
    'erp_ordenes_componentes'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
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
