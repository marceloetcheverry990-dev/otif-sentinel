-- 025_erp_mm.sql
-- ERP módulo MM (tipo SAP): proveedores, pedidos de compra, documentos de
-- material y rangos de números. Extiende productos (maestro de materiales)
-- y movimientos_inventario (enlace al documento de material).
-- Idempotente: se puede correr más de una vez. Mismo RLS que 023_wms_lite.

BEGIN;

ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS tipo_material   VARCHAR(4)     NOT NULL DEFAULT 'HAWA',
  ADD COLUMN IF NOT EXISTS grupo_articulos VARCHAR(16),
  ADD COLUMN IF NOT EXISTS peso_bruto_kg   NUMERIC(14, 3),
  ADD COLUMN IF NOT EXISTS precio_estandar NUMERIC(16, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.movimientos_inventario
  ADD COLUMN IF NOT EXISTS clase_movimiento VARCHAR(3),
  ADD COLUMN IF NOT EXISTS mblnr            VARCHAR(10);

CREATE INDEX IF NOT EXISTS idx_movimientos_inventario_mblnr
  ON public.movimientos_inventario (tenant_id, mblnr) WHERE mblnr IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.erp_numeradores (
  tenant_id  VARCHAR(64) NOT NULL,
  objeto     VARCHAR(24) NOT NULL,
  ultimo     BIGINT      NOT NULL,
  PRIMARY KEY (tenant_id, objeto)
);

CREATE TABLE IF NOT EXISTS public.erp_proveedores (
  tenant_id       VARCHAR(64)  NOT NULL,
  proveedor_id    VARCHAR(10)  NOT NULL,
  nombre          VARCHAR(120) NOT NULL,
  rut             VARCHAR(12),
  calle           VARCHAR(160),
  ciudad          VARCHAR(80),
  region          VARCHAR(80),
  pais            VARCHAR(2)   NOT NULL DEFAULT 'CL',
  telefono        VARCHAR(32),
  email           VARCHAR(120),
  contacto        VARCHAR(80),
  condicion_pago  VARCHAR(4)   NOT NULL DEFAULT 'Z030',
  moneda          VARCHAR(3)   NOT NULL DEFAULT 'CLP',
  bloqueado       BOOLEAN      NOT NULL DEFAULT FALSE,
  created_by      VARCHAR(64),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, proveedor_id)
);

CREATE TABLE IF NOT EXISTS public.erp_pedidos_compra (
  tenant_id        VARCHAR(64)  NOT NULL,
  ebeln            VARCHAR(10)  NOT NULL,
  clase_documento  VARCHAR(4)   NOT NULL DEFAULT 'NB',
  proveedor_id     VARCHAR(10)  NOT NULL,
  org_compras      VARCHAR(4)   NOT NULL DEFAULT '1000',
  grupo_compras    VARCHAR(3)   NOT NULL DEFAULT '001',
  fecha_documento  DATE         NOT NULL DEFAULT CURRENT_DATE,
  moneda           VARCHAR(3)   NOT NULL DEFAULT 'CLP',
  estado           VARCHAR(12)  NOT NULL DEFAULT 'ABIERTO',
  texto            TEXT,
  created_by       VARCHAR(64),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, ebeln),
  CONSTRAINT erp_pedidos_compra_estado_chk CHECK (estado IN ('ABIERTO', 'PARCIAL', 'CERRADO'))
);

CREATE INDEX IF NOT EXISTS idx_erp_pedidos_compra_proveedor
  ON public.erp_pedidos_compra (tenant_id, proveedor_id);

CREATE TABLE IF NOT EXISTS public.erp_pedidos_compra_pos (
  tenant_id          VARCHAR(64)    NOT NULL,
  ebeln              VARCHAR(10)    NOT NULL,
  ebelp              INTEGER        NOT NULL,
  sku                VARCHAR(64)    NOT NULL,
  texto_breve        VARCHAR(256),
  cantidad           NUMERIC(14, 3) NOT NULL,
  cantidad_recibida  NUMERIC(14, 3) NOT NULL DEFAULT 0,
  unidad             VARCHAR(16)    NOT NULL DEFAULT 'UN',
  precio_neto        NUMERIC(16, 2) NOT NULL DEFAULT 0,
  centro             VARCHAR(64)    NOT NULL,
  fecha_entrega      DATE,
  PRIMARY KEY (tenant_id, ebeln, ebelp),
  CONSTRAINT erp_pedidos_compra_pos_qty_chk CHECK (cantidad > 0 AND cantidad_recibida >= 0)
);

CREATE INDEX IF NOT EXISTS idx_erp_pedidos_compra_pos_sku
  ON public.erp_pedidos_compra_pos (tenant_id, sku, centro);

CREATE TABLE IF NOT EXISTS public.erp_documentos_material (
  tenant_id              VARCHAR(64)  NOT NULL,
  mblnr                  VARCHAR(10)  NOT NULL,
  mjahr                  INTEGER      NOT NULL,
  fecha_contabilizacion  DATE         NOT NULL DEFAULT CURRENT_DATE,
  texto_cabecera         VARCHAR(160),
  anulado_por            VARCHAR(10),
  created_by             VARCHAR(64),
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, mblnr)
);

CREATE TABLE IF NOT EXISTS public.erp_documentos_material_pos (
  tenant_id          VARCHAR(64)    NOT NULL,
  mblnr              VARCHAR(10)    NOT NULL,
  zeile              INTEGER        NOT NULL,
  clase_movimiento   VARCHAR(3)     NOT NULL,
  sku                VARCHAR(64)    NOT NULL,
  cantidad           NUMERIC(14, 3) NOT NULL,
  unidad             VARCHAR(16)    NOT NULL DEFAULT 'UN',
  centro             VARCHAR(64)    NOT NULL,
  ebeln              VARCHAR(10),
  ebelp              INTEGER,
  importe            NUMERIC(16, 2) NOT NULL DEFAULT 0,
  ref_mblnr          VARCHAR(10),
  ref_zeile          INTEGER,
  PRIMARY KEY (tenant_id, mblnr, zeile),
  CONSTRAINT erp_documentos_material_pos_qty_chk CHECK (cantidad > 0)
);

CREATE INDEX IF NOT EXISTS idx_erp_doc_material_pos_pedido
  ON public.erp_documentos_material_pos (tenant_id, ebeln) WHERE ebeln IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_erp_doc_material_pos_sku
  ON public.erp_documentos_material_pos (tenant_id, sku);

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'erp_numeradores',
    'erp_proveedores',
    'erp_pedidos_compra',
    'erp_pedidos_compra_pos',
    'erp_documentos_material',
    'erp_documentos_material_pos'
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
