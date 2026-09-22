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

  schemaReady = true;
}

/** true cuando el DDL ya corrió en este isolate. */
export function erpSchemaListo() {
  return schemaReady;
}

/** Solo tests: fuerza a re-ejecutar el DDL en la próxima llamada. */
export function __resetErpSchemaCache() {
  schemaReady = false;
}
