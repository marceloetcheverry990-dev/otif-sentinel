// src/erp/schema.js
// Tablas del ERP (módulo MM). Nombres inspirados en las tablas reales de SAP:
//
//   SAP        | Aquí                          | Qué guarda
//   -----------|-------------------------------|-----------------------------------
//   MARA/MAKT  | productos (+ columnas ERP)    | Maestro de materiales (compartido con la Torre)
//   MARD       | inventario_bodega             | Stock por centro (compartido con la Torre)
//   LFA1       | erp_proveedores               | Maestro de proveedores (acreedores)
//   EKKO       | erp_pedidos_compra            | Cabecera de pedido de compra
//   EKPO       | erp_pedidos_compra_pos        | Posiciones del pedido
//   MKPF       | erp_documentos_material       | Cabecera de documento de material
//   MSEG       | erp_documentos_material_pos   | Posiciones del documento de material
//   NRIV       | erp_numeradores               | Rangos de números (4500000000, 5000000000...)
//   STKO/STPO  | erp_listas_materiales(_pos)   | Lista de materiales (receta) y sus componentes
//   AUFK/AFKO  | erp_ordenes_produccion        | Orden de producción
//   RESB       | erp_ordenes_componentes       | Componentes de la orden (reservas)
//
// La migración 025_erp_mm.sql crea lo mismo con RLS. Esto es el respaldo
// idempotente en runtime (mismo patrón que ensureWmsSchema).

import { ensureWmsSchema } from '../helpers/wms-stock.js';

let schemaReady = false;

export async function ensureErpSchema(client) {
  if (schemaReady) return;
  await ensureWmsSchema(client);

  // Campos SAP extra en el maestro de materiales (MARA).
  await client.query(`
    ALTER TABLE productos
      ADD COLUMN IF NOT EXISTS tipo_material   VARCHAR(4)     NOT NULL DEFAULT 'HAWA',
      ADD COLUMN IF NOT EXISTS grupo_articulos VARCHAR(16),
      ADD COLUMN IF NOT EXISTS peso_bruto_kg   NUMERIC(14, 3),
      ADD COLUMN IF NOT EXISTS precio_estandar NUMERIC(16, 2) NOT NULL DEFAULT 0
  `).catch((e) => console.warn('[ERP_SCHEMA] productos', e.message));

  // Los movimientos que nacen en el ERP quedan enlazados a su documento de material.
  await client.query(`
    ALTER TABLE movimientos_inventario
      ADD COLUMN IF NOT EXISTS clase_movimiento VARCHAR(3),
      ADD COLUMN IF NOT EXISTS mblnr            VARCHAR(10)
  `).catch((e) => console.warn('[ERP_SCHEMA] movimientos', e.message));

  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_numeradores (
      tenant_id  VARCHAR(64) NOT NULL,
      objeto     VARCHAR(24) NOT NULL,
      ultimo     BIGINT      NOT NULL,
      PRIMARY KEY (tenant_id, objeto)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_proveedores (
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
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_pedidos_compra (
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
      PRIMARY KEY (tenant_id, ebeln)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_pedidos_compra_pos (
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
      PRIMARY KEY (tenant_id, ebeln, ebelp)
    )
  `);

  // Indicador de borrado de posición (LOEKZ en SAP): la posición no se elimina.
  await client.query(`
    ALTER TABLE erp_pedidos_compra_pos
      ADD COLUMN IF NOT EXISTS borrado BOOLEAN NOT NULL DEFAULT FALSE
  `).catch((e) => console.warn('[ERP_SCHEMA] pedidos_pos', e.message));

  // Documentos de modificación (CDHDR/CDPOS en SAP): quién cambió qué y cuándo.
  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_cambios (
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
    )
  `);

  // Inventario físico (IKPF/ISEG en SAP): documento de conteo por centro.
  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_inventario_fisico (
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
      PRIMARY KEY (tenant_id, iblnr)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_inventario_fisico_pos (
      tenant_id         VARCHAR(64)    NOT NULL,
      iblnr             VARCHAR(10)    NOT NULL,
      zeile             INTEGER        NOT NULL,
      sku               VARCHAR(64)    NOT NULL,
      cantidad_contada  NUMERIC(14, 3),
      contado_por       VARCHAR(64),
      contado_at        TIMESTAMPTZ,
      qty_libro         NUMERIC(14, 3),
      diferencia        NUMERIC(14, 3),
      PRIMARY KEY (tenant_id, iblnr, zeile)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_documentos_material (
      tenant_id              VARCHAR(64)  NOT NULL,
      mblnr                  VARCHAR(10)  NOT NULL,
      mjahr                  INTEGER      NOT NULL,
      fecha_contabilizacion  DATE         NOT NULL DEFAULT CURRENT_DATE,
      texto_cabecera         VARCHAR(160),
      anulado_por            VARCHAR(10),
      created_by             VARCHAR(64),
      created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, mblnr)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_documentos_material_pos (
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
      PRIMARY KEY (tenant_id, mblnr, zeile)
    )
  `);

  await ensureErpPpSchema(client);

  schemaReady = true;
}

// Módulo PP (producción): recetas, órdenes y stock apartado para producción.
// Respaldo runtime de migrations/031_erp_pp.sql.
async function ensureErpPpSchema(client) {
  await client.query(`
    ALTER TABLE inventario_bodega
      ADD COLUMN IF NOT EXISTS qty_reservada_produccion NUMERIC(14, 3) NOT NULL DEFAULT 0
  `).catch((e) => console.warn('[ERP_SCHEMA] inventario_bodega', e.message));

  // Solo si hace falta: un ALTER ... TYPE bloquea la tabla aunque no cambie nada.
  await client.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'erp_cambios' AND column_name = 'clave' AND character_maximum_length < 140) THEN
        ALTER TABLE erp_cambios ALTER COLUMN clave TYPE VARCHAR(140);
      END IF;
    END $$
  `).catch((e) => console.warn('[ERP_SCHEMA] erp_cambios', e.message));

  await client.query(`
    ALTER TABLE erp_documentos_material_pos
      ADD COLUMN IF NOT EXISTS aufnr VARCHAR(12),
      ADD COLUMN IF NOT EXISTS rspos INTEGER
  `).catch((e) => console.warn('[ERP_SCHEMA] documentos_material_pos', e.message));

  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_listas_materiales (
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
      PRIMARY KEY (tenant_id, sku, centro, alternativa)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_listas_materiales_pos (
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
      PRIMARY KEY (tenant_id, sku, centro, alternativa, posicion)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_ordenes_produccion (
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
      PRIMARY KEY (tenant_id, aufnr)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS erp_ordenes_componentes (
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
      PRIMARY KEY (tenant_id, aufnr, posicion)
    )
  `);
}

/** true cuando el DDL ya corrió en este isolate. */
export function erpSchemaListo() {
  return schemaReady;
}

/** Solo tests: fuerza a re-ejecutar el DDL en la próxima llamada. */
export function __resetErpSchemaCache() {
  schemaReady = false;
}
