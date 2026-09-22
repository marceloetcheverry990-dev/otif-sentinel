-- migrations/023_wms_lite.sql
-- OTIF Bodega (WMS-lite): catálogo, stock por bodega, movimientos, líneas de OT.
-- Flag por tenant: tenant_settings.wms_enabled (default false).

BEGIN;

ALTER TABLE public.tenant_settings
  ADD COLUMN IF NOT EXISTS wms_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.productos (
  tenant_id   VARCHAR(64)  NOT NULL,
  sku         VARCHAR(64)  NOT NULL,
  nombre      VARCHAR(256) NOT NULL,
  unidad      VARCHAR(16)  NOT NULL DEFAULT 'unidad',
  activo      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_productos_tenant_activo
  ON public.productos (tenant_id, activo);

CREATE TABLE IF NOT EXISTS public.inventario_bodega (
  tenant_id        VARCHAR(64)     NOT NULL,
  depot_id         VARCHAR(64)     NOT NULL,
  sku              VARCHAR(64)     NOT NULL,
  qty_disponible   NUMERIC(14, 3)  NOT NULL DEFAULT 0,
  qty_reservada    NUMERIC(14, 3)  NOT NULL DEFAULT 0,
  qty_minima       NUMERIC(14, 3)  NOT NULL DEFAULT 0,
  ubicacion        VARCHAR(64),
  updated_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, depot_id, sku),
  CONSTRAINT inventario_bodega_qty_chk CHECK (qty_disponible >= 0 AND qty_reservada >= 0 AND qty_minima >= 0)
);

CREATE INDEX IF NOT EXISTS idx_inventario_tenant_depot
  ON public.inventario_bodega (tenant_id, depot_id);

CREATE TABLE IF NOT EXISTS public.movimientos_inventario (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   VARCHAR(64)    NOT NULL,
  depot_id    VARCHAR(64)    NOT NULL,
  sku         VARCHAR(64)    NOT NULL,
  tipo        VARCHAR(24)    NOT NULL,
  qty         NUMERIC(14, 3) NOT NULL,
  ot_id       VARCHAR(120),
  motivo      TEXT,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT movimientos_tipo_chk CHECK (tipo IN ('entrada', 'salida', 'reserva', 'liberacion', 'ajuste'))
);

CREATE INDEX IF NOT EXISTS idx_movimientos_tenant_created
  ON public.movimientos_inventario (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.orden_lineas (
  tenant_id      VARCHAR(64)    NOT NULL,
  ot_id          VARCHAR(120)   NOT NULL,
  sku            VARCHAR(64)    NOT NULL,
  qty            NUMERIC(14, 3) NOT NULL,
  qty_pickeada   NUMERIC(14, 3) NOT NULL DEFAULT 0,
  depot_id       VARCHAR(64),
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, ot_id, sku),
  CONSTRAINT orden_lineas_qty_chk CHECK (qty > 0 AND qty_pickeada >= 0)
);

CREATE INDEX IF NOT EXISTS idx_orden_lineas_tenant_ot
  ON public.orden_lineas (tenant_id, ot_id);

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'productos',
    'inventario_bodega',
    'movimientos_inventario',
    'orden_lineas'
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
