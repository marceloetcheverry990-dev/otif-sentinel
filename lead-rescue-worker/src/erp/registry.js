// src/erp/registry.js
// Registro central de transacciones. Para agregar una transacción nueva:
//   1. Crea (o edita) un archivo en src/erp/transacciones/ que exporte por
//      defecto un array de transacciones { code, titulo, menu, get?, post?, screen }.
//   2. Impórtalo acá y agrégalo a MODULOS.
// Eso es todo: el menú SAP Easy Access, el campo de comandos, la API y la
// auditoría se arman solos a partir de esta lista. Guía: docs/ERP-MM-GUIA.md

import material from './transacciones/material.js';
import proveedor from './transacciones/proveedor.js';
import pedido from './transacciones/pedido.js';
import migo from './transacciones/migo.js';
import stock from './transacciones/stock.js';
import inventario from './transacciones/inventario.js';

const MODULOS = [material, proveedor, pedido, migo, stock, inventario];

export const TRANSACCIONES = Object.freeze(
  Object.fromEntries(MODULOS.flat().map((tx) => [tx.code, tx]))
);

/** Valida el registro al cargar: un error acá rompe los tests, no producción. */
export function validarRegistro(lista = MODULOS.flat()) {
  const errores = [];
  const vistos = new Set();
  for (const tx of lista) {
    if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(tx.code || '')) errores.push(`código inválido: ${tx.code}`);
    if (vistos.has(tx.code)) errores.push(`código duplicado: ${tx.code}`);
    vistos.add(tx.code);
    if (!tx.titulo) errores.push(`${tx.code}: falta titulo`);
    if (!Array.isArray(tx.menu) || !tx.menu.length) errores.push(`${tx.code}: falta menu`);
    if (typeof tx.screen !== 'string' || !tx.screen.trim().startsWith('function')) {
      errores.push(`${tx.code}: screen debe ser un string "function (ui, params) {...}"`);
    }
    if (tx.get && typeof tx.get !== 'function') errores.push(`${tx.code}: get debe ser función`);
    if (tx.post && typeof tx.post !== 'function') errores.push(`${tx.code}: post debe ser función`);
  }
  return errores;
}

/** Lo que el navegador necesita saber de cada transacción (sin lógica de servidor). */
export function catalogoCliente() {
  return Object.values(TRANSACCIONES).map((tx) => ({
    code: tx.code,
    titulo: tx.titulo,
    menu: tx.menu,
  }));
}

// ─── Ayudas de búsqueda (tecla F4) ─────────────────────────────────────────
export const AYUDAS_F4 = {
  async material(client, tenant_id, q) {
    const r = await client.query(
      `SELECT sku AS valor, nombre AS texto FROM productos
       WHERE tenant_id = $1 AND activo = TRUE AND ($2 = '' OR sku ILIKE $3 OR nombre ILIKE $3)
       ORDER BY sku LIMIT 50`,
      [tenant_id, q, `%${q}%`]
    );
    return r.rows;
  },
  async proveedor(client, tenant_id, q) {
    const r = await client.query(
      `SELECT proveedor_id AS valor, nombre || COALESCE(' · ' || ciudad, '') || CASE WHEN bloqueado THEN ' (bloqueado)' ELSE '' END AS texto
       FROM erp_proveedores
       WHERE tenant_id = $1 AND ($2 = '' OR proveedor_id ILIKE $3 OR nombre ILIKE $3 OR rut ILIKE $3)
       ORDER BY proveedor_id LIMIT 50`,
      [tenant_id, q, `%${q}%`]
    );
    return r.rows;
  },
  async centro(client, tenant_id, q) {
    const r = await client.query(
      `SELECT depot_id AS valor, nombre || CASE WHEN is_default THEN ' (por defecto)' ELSE '' END AS texto
       FROM depots
       WHERE tenant_id = $1 AND activo = TRUE AND ($2 = '' OR depot_id ILIKE $3 OR nombre ILIKE $3)
       ORDER BY is_default DESC, nombre LIMIT 50`,
      [tenant_id, q, `%${q}%`]
    );
    return r.rows;
  },
  async inventario(client, tenant_id, q) {
    const r = await client.query(
      `SELECT iblnr AS valor, centro || ' · ' || estado || ' · ' || fecha_planificada::text || COALESCE(' · ' || texto, '') AS texto
       FROM erp_inventario_fisico
       WHERE tenant_id = $1 AND ($2 = '' OR iblnr ILIKE $3 OR texto ILIKE $3)
       ORDER BY (estado = 'CONTABILIZADO'), iblnr DESC LIMIT 50`,
      [tenant_id, q, `%${q}%`]
    );
    return r.rows;
  },
  async pedido(client, tenant_id, q) {
    const r = await client.query(
      `SELECT pc.ebeln AS valor, COALESCE(pr.nombre, pc.proveedor_id) || ' · ' || pc.estado || ' · ' || pc.fecha_documento::text AS texto
       FROM erp_pedidos_compra pc
       LEFT JOIN erp_proveedores pr ON pr.tenant_id = pc.tenant_id AND pr.proveedor_id = pc.proveedor_id
       WHERE pc.tenant_id = $1 AND ($2 = '' OR pc.ebeln ILIKE $3 OR pr.nombre ILIKE $3)
       ORDER BY (pc.estado = 'CERRADO'), pc.ebeln DESC LIMIT 50`,
      [tenant_id, q, `%${q}%`]
    );
    return r.rows;
  },
};
