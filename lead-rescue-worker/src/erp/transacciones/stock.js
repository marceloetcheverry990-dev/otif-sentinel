// src/erp/transacciones/stock.js
// MMBE — Resumen de stocks (libre utilización, reservado por la Torre, en pedido de compra).
// MB51 — Lista de documentos de material: los del ERP (MIGO) y los que genera la
//        Torre (alta de producto = 561, despacho/packing = 601, ajustes = 701/702).

import { CLASES_MOVIMIENTO } from './migo.js';

const MENU = ['Logística', 'Gestión de materiales', 'Gestión de stocks', 'Entorno'];

export const MMBE = {
  code: 'MMBE',
  titulo: 'Resumen de stocks',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    const valores = [tenant_id];
    const filtros = ['i.tenant_id = $1'];
    if (params.material) {
      valores.push(`%${String(params.material).slice(0, 64)}%`);
      filtros.push(`(i.sku ILIKE $${valores.length} OR p.nombre ILIKE $${valores.length})`);
    }
    if (params.centro) {
      valores.push(String(params.centro).slice(0, 64));
      filtros.push(`i.depot_id = $${valores.length}`);
    }
    if (params.solo_bajo_minimo === 'true') filtros.push('i.qty_disponible < i.qty_minima');
    if (params.solo_quiebre === 'true') filtros.push('COALESCE(qb.demanda, 0) > 0');
    const r = await client.query(
      `SELECT i.sku, p.nombre, p.unidad, i.depot_id AS centro, d.nombre AS nombre_centro,
              i.qty_disponible AS libre_utilizacion, i.qty_reservada AS reservado,
              COALESCE(oc.en_pedido, 0) AS en_pedido,
              i.qty_disponible + i.qty_reservada AS stock_total,
              i.qty_minima AS punto_pedido, i.ubicacion,
              COALESCE(qb.demanda, 0) AS demanda_quiebre,
              (i.qty_disponible < i.qty_minima OR COALESCE(qb.demanda, 0) > 0) AS bajo_minimo,
              ROUND((i.qty_disponible + i.qty_reservada) * COALESCE(p.precio_estandar, 0), 2) AS valor
       FROM inventario_bodega i
       LEFT JOIN productos p ON p.tenant_id = i.tenant_id AND p.sku = i.sku
       LEFT JOIN depots d ON d.tenant_id = i.tenant_id AND d.depot_id = i.depot_id
       LEFT JOIN (
         SELECT centro, sku, SUM(GREATEST(cantidad - cantidad_recibida, 0)) AS en_pedido
         FROM erp_pedidos_compra_pos WHERE tenant_id = $1 AND NOT borrado GROUP BY centro, sku
       ) oc ON oc.centro = i.depot_id AND oc.sku = i.sku
       LEFT JOIN (
         SELECT q.depot_id, q.sku, SUM(q.qty) AS demanda
         FROM orden_lineas_quiebre q
         JOIN ordenes_pendientes o ON o.tenant_id = q.tenant_id AND o.ot_id = q.ot_id
         WHERE q.tenant_id = $1 AND o.estado_operacional = 'QUIEBRE'
         GROUP BY q.depot_id, q.sku
       ) qb ON qb.depot_id = i.depot_id AND qb.sku = i.sku
       WHERE ${filtros.join(' AND ')}
       ORDER BY i.sku, i.depot_id
       LIMIT 1000`,
      valores
    );
    return { stocks: r.rows };
  },
  screen: `function (ui, params) {
    ui.pantalla(ui.grupo('Criterios de selección',
      ui.campo({ id: 'material', etiqueta: 'Material', f4: 'material', valor: params.material || '' }) +
      ui.campo({ id: 'centro', etiqueta: 'Centro', f4: 'centro', valor: params.centro || '' }) +
      ui.campo({ id: 'solo_bajo_minimo', etiqueta: 'Solo bajo punto de pedido', tipo: 'check', valor: params.solo_bajo_minimo === 'true' }) +
      ui.campo({ id: 'solo_quiebre', etiqueta: 'Solo con pedidos en quiebre', tipo: 'check', valor: params.solo_quiebre === 'true' })
    ) + '<div id="resultado"></div>');
    async function ejecutar() {
      var data = await ui.get('MMBE', ui.valores());
      var bajos = data.stocks.filter(function (s) { return s.bajo_minimo; }).length;
      ui.q('#resultado').innerHTML = ui.tabla([
        { id: 'sku', etiqueta: 'Material', enlace: function (f) { ui.ir('MM03', { material: f.sku }); } },
        { id: 'nombre', etiqueta: 'Texto breve' },
        { id: 'centro', etiqueta: 'Centro' },
        { id: 'libre_utilizacion', etiqueta: 'Libre utilización', tipo: 'qty' },
        { id: 'reservado', etiqueta: 'Reservado (Torre)', tipo: 'qty' },
        { id: 'en_pedido', etiqueta: 'En pedido', tipo: 'qty' },
        { id: 'demanda_quiebre', etiqueta: 'Demanda en quiebre', tipo: 'qty' },
        { id: 'stock_total', etiqueta: 'Stock total', tipo: 'qty' },
        { id: 'unidad', etiqueta: 'UMB' },
        { id: 'punto_pedido', etiqueta: 'Punto pedido', tipo: 'qty' },
        { id: 'valor', etiqueta: 'Valor (CLP)', tipo: 'money' },
        { id: 'bajo_minimo', etiqueta: '', tipo: 'accion', texto: 'Pedir', mostrar: function (f) { return f.bajo_minimo; },
          enlace: function (f) {
            // Cubrir lo que esperan los pedidos en quiebre y reponer hasta 2× el punto de pedido.
            var falta = Math.max(Number(f.punto_pedido) * 2 + Number(f.demanda_quiebre) - Number(f.libre_utilizacion) - Number(f.en_pedido), 1);
            ui.ir('ME21N', { material: f.sku, centro: f.centro, cantidad: falta });
          } },
      ], data.stocks, { resaltar: function (f) { return f.bajo_minimo; } });
      ui.mensaje(bajos ? 'W' : 'S', data.stocks.length + ' línea(s) de stock' + (bajos ? ' — ' + bajos + ' requieren reposición (bajo punto de pedido o con pedidos en quiebre)' : ''));
    }
    ui.botones([{ texto: 'Ejecutar', tecla: 'F8', primario: true, accion: ejecutar }]);
    ejecutar();
  }`,
};

// Traduce un movimiento nacido en la Torre (sin documento ERP) a su clase SAP.
export const CLASE_DESDE_TORRE_SQL = `CASE
  WHEN m.tipo = 'entrada' AND m.motivo = 'alta_producto' THEN '561'
  WHEN m.tipo = 'entrada' THEN '701'
  WHEN m.tipo = 'salida' THEN '601'
  WHEN m.tipo = 'ajuste' THEN '702'
  ELSE NULL END`;

export const MB51 = {
  code: 'MB51',
  titulo: 'Lista de documentos de material',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    const valores = [tenant_id];
    const filtros = [];
    const add = (sql, v) => { valores.push(v); filtros.push(sql.replaceAll('?', `$${valores.length}`)); };
    if (params.material) add('x.sku = ?', String(params.material).slice(0, 64));
    if (params.centro) add('x.centro = ?', String(params.centro).slice(0, 64));
    if (params.clase_movimiento) add('x.clase_movimiento = ?', String(params.clase_movimiento).slice(0, 3));
    if (params.documento) add('x.documento = ?', String(params.documento).slice(0, 20));
    if (params.desde) add('x.fecha >= ?::date', String(params.desde).slice(0, 10));
    if (params.hasta) add('x.fecha <= ?::date', String(params.hasta).slice(0, 10));
    // Documentos ERP (MSEG) + movimientos de la Torre sin documento (las reservas
    // no son documentos de material en SAP, por eso se excluyen).
    const r = await client.query(
      `SELECT x.* FROM (
         SELECT d.mblnr AS documento, d.zeile AS linea, d.clase_movimiento, d.sku, d.centro,
                d.cantidad, d.unidad, d.importe, d.ebeln AS referencia,
                m.fecha_contabilizacion AS fecha, m.created_at, m.created_by AS usuario, 'ERP' AS origen
         FROM erp_documentos_material_pos d
         JOIN erp_documentos_material m ON m.tenant_id = d.tenant_id AND m.mblnr = d.mblnr
         WHERE d.tenant_id = $1
         UNION ALL
         SELECT 'T' || m.id::text AS documento, 1 AS linea, ${CLASE_DESDE_TORRE_SQL} AS clase_movimiento,
                m.sku, m.depot_id AS centro, ABS(m.qty) AS cantidad, COALESCE(p.unidad, 'UN') AS unidad,
                ROUND(ABS(m.qty) * COALESCE(p.precio_estandar, 0), 2) AS importe, m.ot_id AS referencia,
                m.created_at::date AS fecha, m.created_at, 'Torre' AS usuario, 'TORRE' AS origen
         FROM movimientos_inventario m
         LEFT JOIN productos p ON p.tenant_id = m.tenant_id AND p.sku = m.sku
         WHERE m.tenant_id = $1 AND m.mblnr IS NULL AND m.tipo <> 'reserva'
       ) x
       ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
       ORDER BY x.created_at DESC, x.documento DESC, x.linea
       LIMIT 500`,
      valores
    );
    const clases = Object.fromEntries(Object.entries(CLASES_MOVIMIENTO).map(([k, v]) => [k, v.texto]));
    return {
      documentos: r.rows.map((row) => ({
        ...row,
        texto_clase: clases[row.clase_movimiento] || '',
        signo: CLASES_MOVIMIENTO[row.clase_movimiento]?.signo ?? 0,
      })),
    };
  },
  screen: `function (ui, params) {
    ui.pantalla(ui.grupo('Criterios de selección',
      ui.campo({ id: 'material', etiqueta: 'Material', f4: 'material', valor: params.material || '' }) +
      ui.campo({ id: 'centro', etiqueta: 'Centro', f4: 'centro', valor: params.centro || '' }) +
      ui.campo({ id: 'clase_movimiento', etiqueta: 'Clase de movimiento', valor: params.clase_movimiento || '', ancho: 5 }) +
      ui.campo({ id: 'documento', etiqueta: 'Documento material', valor: params.documento || '' }) +
      ui.campo({ id: 'desde', etiqueta: 'Fecha contab. desde', tipo: 'date', valor: params.desde || '' }) +
      ui.campo({ id: 'hasta', etiqueta: 'hasta', tipo: 'date', valor: params.hasta || '' })
    ) + '<div id="resultado"></div>');
    async function ejecutar() {
      var data = await ui.get('MB51', ui.valores());
      data.documentos.forEach(function (d) { d.cantidad_signo = d.signo < 0 ? -Number(d.cantidad) : Number(d.cantidad); });
      ui.q('#resultado').innerHTML = ui.tabla([
        { id: 'documento', etiqueta: 'Doc. material', enlace: function (f) { if (f.origen === 'ERP') ui.ir('MIGO', { documento: f.documento }); } },
        { id: 'linea', etiqueta: 'Pos.', tipo: 'num' },
        { id: 'clase_movimiento', etiqueta: 'CMv' },
        { id: 'texto_clase', etiqueta: 'Texto clase mov.' },
        { id: 'sku', etiqueta: 'Material' },
        { id: 'centro', etiqueta: 'Centro' },
        { id: 'cantidad_signo', etiqueta: 'Cantidad', tipo: 'qty' },
        { id: 'unidad', etiqueta: 'UM' },
        { id: 'importe', etiqueta: 'Importe', tipo: 'money' },
        { id: 'referencia', etiqueta: 'Referencia' },
        { id: 'fecha', etiqueta: 'Fe. contab.', tipo: 'date' },
        { id: 'usuario', etiqueta: 'Usuario' },
      ], data.documentos);
      ui.mensaje('S', data.documentos.length + ' posición(es) de documento de material');
    }
    ui.botones([{ texto: 'Ejecutar', tecla: 'F8', primario: true, accion: ejecutar }]);
    ejecutar();
  }`,
};

export default [MMBE, MB51];
