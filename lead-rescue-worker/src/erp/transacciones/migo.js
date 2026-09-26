// src/erp/transacciones/migo.js
// MIGO — Movimiento de mercancías. Es la ÚNICA puerta por donde el ERP cambia
// stock, y es el mismo stock (inventario_bodega) que reserva la Torre cuando
// entra un pedido de venta. Cada contabilización genera un documento de material
// (5000000000...) que se puede ver en MB51 y se puede anular.
//
// Clases de movimiento soportadas (las mismas de SAP):
//   101  Entrada de mercancías por pedido de compra      (+ stock, + recibido en el pedido)
//   101  Entrada de lo fabricado por orden de producción (+ stock, + entregado en la orden,
//        y consumo automático 261 de los insumos marcados "desc. automático")
//   261  Consumo para orden de producción                 (- stock, primero de lo apartado)
//   501  Entrada sin pedido                               (+ stock)
//   551  Salida por desguace / merma                      (- stock)
//   102 / 262 / 502 / 552  Anulación de 101 / 261 / 501 / 551 (movimiento inverso)

import {
  ErpError, fallo, texto, cantidad, fecha,
  siguienteNumero, RANGOS, validarCentro, estadoPedido, operadorDe,
} from '../core.js';
import { leerPedido } from './pedido.js';
import {
  leerOrden, exigirMovimientos, consumirComponente, devolverComponente,
  registrarEntregaOrden, cantidadesBackflush, ESTADOS_ORDEN, r3,
} from '../produccion.js';
import { isWmsEnabledForTenant, reintentarQuiebres } from '../../helpers/wms-stock.js';

export const CLASES_MOVIMIENTO = Object.freeze({
  101: { texto: 'EM entrada de mercancías (pedido u orden de producción)', signo: +1, anulacion: '102' },
  102: { texto: 'EM entrada — anulación', signo: -1 },
  261: { texto: 'Consumo para orden de producción', signo: -1, anulacion: '262' },
  262: { texto: 'Consumo para orden — anulación', signo: +1 },
  501: { texto: 'Entrada sin pedido', signo: +1, anulacion: '502' },
  502: { texto: 'Entrada sin pedido — anulación', signo: -1 },
  551: { texto: 'Salida para desguace', signo: -1, anulacion: '552' },
  552: { texto: 'Salida para desguace — anulación', signo: +1 },
  // Movimientos que nacen en la Torre (solo lectura, ver MB51):
  561: { texto: 'Entrada inicial de stock (alta en Torre)', signo: +1 },
  601: { texto: 'Salida de mercancías por entrega (despacho Torre)', signo: -1 },
  701: { texto: 'Diferencia de inventario (+) (MI07 o ajuste Torre)', signo: +1 },
  702: { texto: 'Diferencia de inventario (−) (MI07 o ajuste Torre)', signo: -1 },
});

const MENU = ['Logística', 'Gestión de materiales', 'Gestión de stocks'];
const MAX_POSICIONES = 50;

/** "Verificar" corre todo dentro de la transacción y la revierte con este error. */
class Verificado extends ErpError {
  constructor(mensaje) { super(mensaje, 200, 'S'); }
}

/**
 * Suma/resta stock de libre utilización y deja rastro en movimientos_inventario
 * (lo que ve la pestaña Bodega de la Torre). Nunca deja stock negativo.
 */
async function moverStock(client, { tenant_id, centro, sku, delta, clase, mblnr }) {
  const row = await client.query(
    `SELECT qty_disponible FROM inventario_bodega
     WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3 FOR UPDATE`,
    [tenant_id, centro, sku]
  );
  const actual = row.rowCount ? Number(row.rows[0].qty_disponible) : 0;
  const nuevo = Math.round((actual + delta) * 1000) / 1000;
  if (nuevo < 0) {
    throw fallo(`Déficit de stock libre utilización: material ${sku}, centro ${centro} (disponible ${actual}, se necesitan ${Math.abs(delta)})`);
  }
  if (row.rowCount) {
    await client.query(
      `UPDATE inventario_bodega SET qty_disponible = $4, updated_at = NOW()
       WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3`,
      [tenant_id, centro, sku, nuevo]
    );
  } else {
    await client.query(
      `INSERT INTO inventario_bodega (tenant_id, depot_id, sku, qty_disponible, qty_reservada, qty_minima)
       VALUES ($1, $2, $3, $4, 0, 0)`,
      [tenant_id, centro, sku, nuevo]
    );
  }
  await client.query(
    `INSERT INTO movimientos_inventario (tenant_id, depot_id, sku, tipo, qty, motivo, clase_movimiento, mblnr)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenant_id, centro, sku, delta > 0 ? 'entrada' : 'salida', Math.abs(delta),
      `MIGO ${clase} doc ${mblnr}`, clase, mblnr]
  );
  return nuevo;
}

async function crearCabecera(client, tenant_id, { fechaContab, textoCab, operator }) {
  const mblnr = await siguienteNumero(client, tenant_id, RANGOS.DOC_MATERIAL);
  await client.query(
    `INSERT INTO erp_documentos_material (tenant_id, mblnr, mjahr, fecha_contabilizacion, texto_cabecera, created_by)
     VALUES ($1, $2, EXTRACT(YEAR FROM COALESCE($3::date, CURRENT_DATE))::int, COALESCE($3::date, CURRENT_DATE), $4, $5)`,
    [tenant_id, mblnr, fechaContab, textoCab, operadorDe(operator)]
  );
  return mblnr;
}

async function insertarPosicion(client, tenant_id, mblnr, p) {
  await client.query(
    `INSERT INTO erp_documentos_material_pos (tenant_id, mblnr, zeile, clase_movimiento, sku, cantidad, unidad,
                                              centro, ebeln, ebelp, importe, ref_mblnr, ref_zeile, aufnr, rspos)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [tenant_id, mblnr, p.zeile, p.clase, p.sku, p.cantidad, p.unidad, p.centro,
      p.ebeln ?? null, p.ebelp ?? null, p.importe, p.ref_mblnr ?? null, p.ref_zeile ?? null,
      p.aufnr ?? null, p.rspos ?? null]
  );
}

const importeDe = (q, precio) => Math.round(Number(q) * Number(precio || 0) * 100) / 100;

async function leerDocumento(client, tenant_id, mblnr, { paraActualizar = false } = {}) {
  const id = texto(mblnr, { campo: 'Documento de material', max: 10, requerido: true });
  const cab = await client.query(
    `SELECT * FROM erp_documentos_material WHERE tenant_id = $1 AND mblnr = $2${paraActualizar ? ' FOR UPDATE' : ''}`,
    [tenant_id, id]
  );
  if (!cab.rowCount) throw fallo(`El documento de material ${id} no existe`, 404);
  const pos = await client.query(
    `SELECT d.*, p.nombre AS texto_breve
     FROM erp_documentos_material_pos d
     LEFT JOIN productos p ON p.tenant_id = d.tenant_id AND p.sku = d.sku
     WHERE d.tenant_id = $1 AND d.mblnr = $2 ORDER BY d.zeile`,
    [tenant_id, id]
  );
  return { cabecera: cab.rows[0], posiciones: pos.rows };
}

// ─── 101: entrada por pedido ───────────────────────────────────────────────
async function entradaPorPedido(client, tenant_id, body, cab) {
  const pedido = await leerPedido(client, tenant_id, body.pedido, { paraActualizar: true });
  const porEbelp = new Map(pedido.posiciones.map((p) => [Number(p.ebelp), p]));
  const lineas = (Array.isArray(body.posiciones) ? body.posiciones : [])
    .filter((l) => l && (l.ok === true || l.ok === 'true'));
  if (!lineas.length) throw fallo('Marque al menos una posición como OK');
  if (lineas.length > MAX_POSICIONES) throw fallo(`Máximo ${MAX_POSICIONES} posiciones`);

  const mblnr = await crearCabecera(client, tenant_id, cab);
  let zeile = 0;
  const vistos = new Set();
  for (const l of lineas) {
    const ebelp = Number(l.ebelp);
    const pos = porEbelp.get(ebelp);
    if (!pos) throw fallo(`La posición ${l.ebelp} no existe en el pedido ${pedido.cabecera.ebeln}`);
    if (vistos.has(ebelp)) throw fallo(`La posición ${ebelp} está repetida`);
    if (pos.borrado) throw fallo(`La posición ${ebelp} está borrada: no admite entradas`);
    vistos.add(ebelp);
    const q = cantidad(l.cantidad, { campo: `Cantidad pos. ${ebelp}` });
    const pendiente = Number(pos.cantidad) - Number(pos.cantidad_recibida);
    if (q > pendiente + 1e-9) {
      throw fallo(`Pos. ${ebelp}: la cantidad ${q} excede lo pendiente de entrega (${pendiente})`);
    }
    zeile += 1;
    await moverStock(client, { tenant_id, centro: pos.centro, sku: pos.sku, delta: q, clase: '101', mblnr });
    await client.query(
      `UPDATE erp_pedidos_compra_pos SET cantidad_recibida = cantidad_recibida + $4
       WHERE tenant_id = $1 AND ebeln = $2 AND ebelp = $3`,
      [tenant_id, pedido.cabecera.ebeln, ebelp, q]
    );
    pos.cantidad_recibida = Number(pos.cantidad_recibida) + q;
    await insertarPosicion(client, tenant_id, mblnr, {
      zeile, clase: '101', sku: pos.sku, cantidad: q, unidad: pos.unidad, centro: pos.centro,
      ebeln: pedido.cabecera.ebeln, ebelp, importe: Math.round(q * Number(pos.precio_neto) * 100) / 100,
    });
  }
  await actualizarEstadoPedido(client, tenant_id, pedido.cabecera.ebeln, pedido.posiciones);
  return { mblnr, posiciones: zeile };
}

async function actualizarEstadoPedido(client, tenant_id, ebeln, posiciones) {
  await client.query(
    `UPDATE erp_pedidos_compra SET estado = $3 WHERE tenant_id = $1 AND ebeln = $2`,
    [tenant_id, ebeln, estadoPedido(posiciones)]
  );
}

// ─── 501 / 551: sin referencia a pedido ────────────────────────────────────
async function movimientoLibre(client, tenant_id, body, cab, clase) {
  const lineas = (Array.isArray(body.posiciones) ? body.posiciones : [])
    .filter((l) => l && String(l.material ?? '').trim() !== '');
  if (!lineas.length) throw fallo('Introduzca al menos una posición');
  if (lineas.length > MAX_POSICIONES) throw fallo(`Máximo ${MAX_POSICIONES} posiciones`);

  const signo = CLASES_MOVIMIENTO[clase].signo;
  const mblnr = await crearCabecera(client, tenant_id, cab);
  let zeile = 0;
  for (const l of lineas) {
    zeile += 1;
    const sku = texto(l.material, { campo: `Material pos. ${zeile}`, max: 64, requerido: true });
    const mat = await client.query(
      `SELECT sku, unidad, precio_estandar FROM productos WHERE tenant_id = $1 AND sku = $2`,
      [tenant_id, sku]
    );
    if (!mat.rowCount) throw fallo(`Pos. ${zeile}: el material ${sku} no existe`, 404);
    const centro = await validarCentro(client, tenant_id, l.centro);
    const q = cantidad(l.cantidad, { campo: `Cantidad pos. ${zeile}` });
    await moverStock(client, { tenant_id, centro: centro.depot_id, sku, delta: signo * q, clase, mblnr });
    await insertarPosicion(client, tenant_id, mblnr, {
      zeile, clase, sku, cantidad: q, unidad: mat.rows[0].unidad || 'UN', centro: centro.depot_id,
      importe: Math.round(q * Number(mat.rows[0].precio_estandar || 0) * 100) / 100,
    });
  }
  return { mblnr, posiciones: zeile };
}

// ─── 261: consumo para orden de producción ────────────────────────────────
async function consumoParaOrden(client, tenant_id, body, cab) {
  const orden = await leerOrden(client, tenant_id, body.orden, { paraActualizar: true });
  exigirMovimientos(orden.cabecera);
  const { aufnr } = orden.cabecera;
  const porPos = new Map(orden.componentes.map((c) => [Number(c.posicion), c]));
  const lineas = (Array.isArray(body.posiciones) ? body.posiciones : [])
    .filter((l) => l && (l.ok === true || l.ok === 'true'));
  if (!lineas.length) throw fallo('Marque al menos un componente como OK');
  if (lineas.length > MAX_POSICIONES) throw fallo(`Máximo ${MAX_POSICIONES} posiciones`);

  const mblnr = await crearCabecera(client, tenant_id, cab);
  let zeile = 0;
  const vistos = new Set();
  const excedidos = [];
  for (const l of lineas) {
    const pos = Number(l.rspos);
    const comp = porPos.get(pos);
    if (!comp) throw fallo(`La orden ${aufnr} no tiene un componente en la posición ${l.rspos}`);
    if (vistos.has(pos)) throw fallo(`La posición ${pos} está repetida`);
    vistos.add(pos);
    const q = cantidad(l.cantidad, { campo: `Cantidad pos. ${pos}` });
    const pendiente = Math.max(Number(comp.cantidad_necesaria) - Number(comp.cantidad_retirada), 0);
    if (q > pendiente + 1e-9) excedidos.push(comp.sku);
    zeile += 1;
    await consumirComponente(client, { tenant_id, orden, comp, q, mblnr });
    await insertarPosicion(client, tenant_id, mblnr, {
      zeile, clase: '261', sku: comp.sku, cantidad: q, unidad: comp.unidad, centro: comp.centro,
      aufnr, rspos: pos, importe: importeDe(q, comp.precio_estandar),
    });
  }
  return {
    mblnr,
    posiciones: zeile,
    aviso: excedidos.length ? `se consumió más de lo previsto en ${excedidos.join(', ')}` : null,
  };
}

// ─── 101: entrada de lo fabricado (con descuento automático de insumos) ────
async function entradaPorOrden(client, tenant_id, body, cab) {
  const orden = await leerOrden(client, tenant_id, body.orden, { paraActualizar: true });
  exigirMovimientos(orden.cabecera);
  const c = orden.cabecera;
  const q = cantidad(body.cantidad, { campo: 'Cantidad' });
  const pendiente = r3(Number(c.cantidad) - Number(c.cantidad_entregada));
  if (q > pendiente + 1e-9) {
    throw fallo(`La cantidad ${q} excede lo pendiente de la orden ${c.aufnr} (${Math.max(pendiente, 0)} ${c.unidad})`);
  }
  const final = body.entrega_final === true || body.entrega_final === 'true';

  const mblnr = await crearCabecera(client, tenant_id, cab);
  let zeile = 1;
  await moverStock(client, { tenant_id, centro: c.centro, sku: c.sku, delta: q, clase: '101', mblnr });
  await insertarPosicion(client, tenant_id, mblnr, {
    zeile, clase: '101', sku: c.sku, cantidad: q, unidad: c.unidad, centro: c.centro,
    aufnr: c.aufnr, importe: importeDe(q, c.precio_estandar),
  });
  // Descuento automático: calculado sobre la cantidad total ANTES de marcar la entrega.
  const automaticos = cantidadesBackflush(orden.componentes, q, c.cantidad);
  for (const { comp, cantidad: qc } of automaticos) {
    zeile += 1;
    await consumirComponente(client, { tenant_id, orden, comp, q: qc, mblnr });
    await insertarPosicion(client, tenant_id, mblnr, {
      zeile, clase: '261', sku: comp.sku, cantidad: qc, unidad: comp.unidad, centro: comp.centro,
      aufnr: c.aufnr, rspos: Number(comp.posicion), importe: importeDe(qc, comp.precio_estandar),
    });
  }
  const estado = await registrarEntregaOrden(client, tenant_id, orden, { delta: q, entregaFinal: final ? true : null });
  return {
    mblnr,
    posiciones: zeile,
    aviso: `orden ${c.aufnr}: ${estado} ${ESTADOS_ORDEN[estado]}` +
      (automaticos.length ? ` · ${automaticos.length} insumo(s) descontados automáticamente` : ''),
  };
}

// ─── Anulación (102 / 262 / 502 / 552) ─────────────────────────────────────
async function anular(client, tenant_id, body, cab) {
  const doc = await leerDocumento(client, tenant_id, body.documento, { paraActualizar: true });
  if (doc.cabecera.anulado_por) {
    throw fallo(`El documento ${doc.cabecera.mblnr} ya fue anulado con el documento ${doc.cabecera.anulado_por}`);
  }
  const noAnulable = doc.posiciones.find((p) => !CLASES_MOVIMIENTO[p.clase_movimiento]?.anulacion);
  if (noAnulable) {
    throw fallo(`La clase de movimiento ${noAnulable.clase_movimiento} no se puede anular`);
  }

  // Órdenes de producción que toca el documento: tienen que seguir abiertas.
  const ordenes = new Map();
  for (const aufnr of new Set(doc.posiciones.map((p) => p.aufnr).filter(Boolean))) {
    const orden = await leerOrden(client, tenant_id, aufnr, { paraActualizar: true });
    exigirMovimientos(orden.cabecera);
    ordenes.set(aufnr, orden);
  }

  const mblnr = await crearCabecera(client, tenant_id, {
    ...cab,
    textoCab: cab.textoCab || `Anulación de ${doc.cabecera.mblnr}`,
  });
  const pedidosTocados = new Set();
  let zeile = 0;
  for (const p of doc.posiciones) {
    zeile += 1;
    const claseOriginal = CLASES_MOVIMIENTO[p.clase_movimiento];
    const claseInv = claseOriginal.anulacion;
    const q = Number(p.cantidad);
    const orden = p.aufnr ? ordenes.get(p.aufnr) : null;
    if (orden && p.clase_movimiento === '261') {
      // 262: el insumo vuelve a lo apartado para la orden (si todavía lo necesita) o a libre.
      const comp = orden.componentes.find((x) => Number(x.posicion) === Number(p.rspos));
      if (!comp) throw fallo(`La orden ${p.aufnr} ya no tiene el componente de la posición ${p.rspos}`);
      await devolverComponente(client, { tenant_id, orden, comp, q, mblnr });
    } else {
      await moverStock(client, {
        tenant_id, centro: p.centro, sku: p.sku, delta: -claseOriginal.signo * q, clase: claseInv, mblnr,
      });
    }
    if (orden && p.clase_movimiento === '101') {
      // 102: la orden deja de tener esa entrega (y pierde la marca de entrega final).
      await registrarEntregaOrden(client, tenant_id, orden, { delta: -q, entregaFinal: false });
    }
    if (p.ebeln) {
      await client.query(
        `UPDATE erp_pedidos_compra_pos SET cantidad_recibida = GREATEST(cantidad_recibida - $4, 0)
         WHERE tenant_id = $1 AND ebeln = $2 AND ebelp = $3`,
        [tenant_id, p.ebeln, p.ebelp, q]
      );
      pedidosTocados.add(p.ebeln);
    }
    await insertarPosicion(client, tenant_id, mblnr, {
      zeile, clase: claseInv, sku: p.sku, cantidad: q, unidad: p.unidad, centro: p.centro,
      ebeln: p.ebeln, ebelp: p.ebelp, importe: Number(p.importe), ref_mblnr: p.mblnr, ref_zeile: p.zeile,
      aufnr: p.aufnr, rspos: p.rspos,
    });
  }
  await client.query(
    `UPDATE erp_documentos_material SET anulado_por = $3 WHERE tenant_id = $1 AND mblnr = $2`,
    [tenant_id, doc.cabecera.mblnr, mblnr]
  );
  for (const ebeln of pedidosTocados) {
    const pedido = await leerPedido(client, tenant_id, ebeln);
    await actualizarEstadoPedido(client, tenant_id, ebeln, pedido.posiciones);
  }
  return { mblnr, posiciones: zeile, anulado: doc.cabecera.mblnr };
}

// Clases que suben stock libre: tras contabilizarlas se reintenta reservar los
// pedidos de venta de la Torre que estaban en QUIEBRE esperando esos materiales.
// (262 también: lo devuelto que la orden ya no necesita vuelve a libre.)
const CLASES_ENTRADA = ['101', '262', '501', '552', '701'];

async function liberarQuiebres(client, env, tenant_id, mblnr) {
  if (!(await isWmsEnabledForTenant(client, env, tenant_id))) return [];
  const r = await client.query(
    `SELECT centro, array_agg(DISTINCT sku) AS skus
     FROM erp_documentos_material_pos
     WHERE tenant_id = $1 AND mblnr = $2 AND clase_movimiento = ANY($3::text[])
     GROUP BY centro`,
    [tenant_id, mblnr, CLASES_ENTRADA]
  );
  const liberadas = [];
  for (const { centro, skus } of r.rows) {
    const res = await reintentarQuiebres(client, { tenant_id, depot_id: centro, skus });
    liberadas.push(...res.liberadas);
  }
  return liberadas;
}

export const MIGO = {
  code: 'MIGO',
  titulo: 'Movimiento de mercancías',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    if (params.documento) return { documento: await leerDocumento(client, tenant_id, params.documento) };
    if (params.pedido) return { pedido: await leerPedido(client, tenant_id, params.pedido) };
    if (params.orden) return { orden: await leerOrden(client, tenant_id, params.orden) };
    throw fallo('Indique un pedido, una orden o un documento de material');
  },
  async post({ client, tenant_id, body, operator, env }) {
    const cab = {
      fechaContab: fecha(body.fecha_contabilizacion, { campo: 'Fecha de contabilización' }),
      textoCab: texto(body.texto_cabecera, { campo: 'Texto cabecera', max: 160 }),
      operator,
    };
    let r;
    if (body.operacion === 'anular') {
      r = await anular(client, tenant_id, body, cab);
    } else {
      const clase = String(body.clase_movimiento || '');
      if (clase === '101' && body.orden) r = await entradaPorOrden(client, tenant_id, body, cab);
      else if (clase === '101') r = await entradaPorPedido(client, tenant_id, body, cab);
      else if (clase === '261') r = await consumoParaOrden(client, tenant_id, body, cab);
      else if (clase === '501' || clase === '551') r = await movimientoLibre(client, tenant_id, body, cab, clase);
      else throw fallo(`Clase de movimiento ${clase || '(vacía)'} no soportada en MIGO`);
    }
    const liberadas = await liberarQuiebres(client, env, tenant_id, r.mblnr);
    const extra = (r.aviso ? ` · ${r.aviso}` : '') + (liberadas.length
      ? ` · ${liberadas.length} pedido(s) de venta liberado(s) de quiebre: ${liberadas.slice(0, 5).join(', ')}${liberadas.length > 5 ? '…' : ''}`
      : '');
    if (body.solo_verificar) {
      throw new Verificado(`Verificación correcta: ${r.posiciones} posición(es) se pueden contabilizar${extra.replace('liberado(s)', 'se liberarían')}`);
    }
    const mensaje = r.anulado
      ? `Documento ${r.anulado} anulado con el documento de material ${r.mblnr}${extra}`
      : `Documento de material ${r.mblnr} contabilizado${extra}`;
    return { mensaje, documento: r.mblnr, liberadas, invalidarTorre: true };
  },
  screen: `function (ui, params) {
    var operacionInicial = params.documento ? 'A04' : (params.operacion || 'A01');
    var estado = {
      operacion: operacionInicial,
      referencia: params.documento ? 'R02' : (params.referencia || (operacionInicial === 'A07' ? 'R10' : 'R01')),
      datos: null,
    };

    function cabecera() {
      var opOpciones = [['A01', 'A01 Entrada de mercancías'], ['A07', 'A07 Salida de mercancías'], ['A03', 'A03 Anulación'], ['A04', 'A04 Visualizar']];
      var refOpciones = estado.operacion === 'A01'
        ? [['R01', 'R01 Pedido'], ['R08', 'R08 Orden'], ['R10', 'R10 Otros']]
        : estado.operacion === 'A07' ? [['R08', 'R08 Orden'], ['R10', 'R10 Otros']] : [['R02', 'R02 Documento material']];
      var html = '<div class="erp-migo-barra">' +
        ui.campo({ id: 'operacion', etiqueta: 'Operación', tipo: 'select', opciones: opOpciones, valor: estado.operacion }) +
        ui.campo({ id: 'referencia', etiqueta: 'Referencia', tipo: 'select', opciones: refOpciones, valor: estado.referencia });
      if (estado.operacion === 'A01' && estado.referencia === 'R01') {
        html += ui.campo({ id: 'pedido', etiqueta: 'Pedido', f4: 'pedido', valor: estado.datos && estado.datos.pedido ? estado.datos.pedido.cabecera.ebeln : (params.pedido || '') });
      } else if (estado.referencia === 'R08') {
        html += ui.campo({ id: 'orden', etiqueta: 'Orden', f4: 'orden', valor: estado.datos && estado.datos.orden ? estado.datos.orden.cabecera.aufnr : (params.orden || '') });
      } else if (estado.operacion === 'A03' || estado.operacion === 'A04') {
        html += ui.campo({ id: 'documento', etiqueta: 'Doc. material', valor: estado.datos && estado.datos.documento ? estado.datos.documento.cabecera.mblnr : (params.documento || '') });
      }
      html += ui.campo({ id: 'clase_movimiento', etiqueta: 'Clase movimiento', valor: claseActual(), soloLectura: true, ancho: 5 });
      return html + '</div>';
    }

    function claseActual() {
      if (estado.operacion === 'A01') return estado.referencia === 'R10' ? '501' : '101';
      if (estado.operacion === 'A07') return estado.referencia === 'R08' ? '261' : '551';
      return '';
    }

    function datosCabecera() {
      if (estado.operacion === 'A04') return '';
      return ui.grupo('Datos de cabecera',
        ui.campo({ id: 'fecha_contabilizacion', etiqueta: 'Fecha contabilización', tipo: 'date', valor: ui.hoy() }) +
        ui.campo({ id: 'texto_cabecera', etiqueta: 'Texto cabecera', valor: '', ancho: 40 }) +
        (estado.operacion === 'A01' && estado.referencia === 'R01' ? ui.campo({ id: 'guia', etiqueta: 'Nota de entrega', valor: '', ayuda: 'N° guía del proveedor (opcional)' }) : '')
      );
    }

    function posicionesPedido(p) {
      return ui.grupo('Resumen de posiciones — pedido ' + p.cabecera.ebeln + ' (' + (p.cabecera.nombre_proveedor || p.cabecera.proveedor_id) + ')',
        '<table class="erp-tabla erp-tabla-editable"><thead><tr><th>OK</th><th>Pos.</th><th>Material</th><th>Texto breve</th><th>Por entregar</th><th>Cantidad EM</th><th>UM</th><th>Centro</th></tr></thead><tbody>' +
        p.posiciones.map(function (pos, i) {
          var pendiente = Number(pos.pendiente);
          return '<tr' + (pendiente <= 0 ? ' class="erp-fila-inactiva"' : '') + '>' +
            '<td>' + ui.celda({ fila: i, col: 'ok', tipo: 'check', valor: false, soloLectura: pendiente <= 0 }) +
              '<input type="hidden" data-fila="' + i + '" data-col="ebelp" value="' + pos.ebelp + '"></td>' +
            '<td class="erp-num">' + pos.ebelp + '</td>' +
            '<td>' + ui.esc(pos.sku) + '</td><td>' + ui.esc(pos.texto_breve || '') + '</td>' +
            '<td class="erp-num">' + ui.num(pendiente) + '</td>' +
            '<td>' + ui.celda({ fila: i, col: 'cantidad', tipo: 'number', valor: pendiente > 0 ? pendiente : '', ancho: 8, soloLectura: pendiente <= 0 }) + '</td>' +
            '<td>' + ui.esc(pos.unidad) + '</td><td>' + ui.esc(pos.centro) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="erp-ayuda">Marque <b>OK</b> en las posiciones que llegaron y ajuste la cantidad si llegó menos.</p>');
    }

    // A01 + R08: entrada de lo fabricado. Muestra cuánto falta y qué insumos se descontarán solos.
    function posicionesOrdenEntrada(o) {
      var c = o.cabecera;
      var pendiente = Math.max(Number(c.cantidad) - Number(c.cantidad_entregada), 0);
      var auto = o.componentes.filter(function (x) { return x.backflush; });
      return ui.grupo('Orden ' + c.aufnr + ' — ' + c.sku + ' ' + (c.nombre || '') + ' (' + c.estado + ')',
        ui.campo({ id: 'plan', etiqueta: 'Cantidad total', valor: ui.num(c.cantidad) + ' ' + c.unidad, soloLectura: true }) +
        ui.campo({ id: 'ya', etiqueta: 'Ya entregado', valor: ui.num(c.cantidad_entregada), soloLectura: true }) +
        ui.campo({ id: 'cantidad_em', etiqueta: 'Cantidad fabricada', tipo: 'number', obligatorio: true, valor: pendiente > 0 ? ui.num(pendiente) : '', ancho: 10 }) +
        ui.campo({ id: 'entrega_final', etiqueta: 'Entrega final (no se fabricará más)', tipo: 'check', valor: false }) +
        (auto.length
          ? '<p class="erp-ayuda">Al contabilizar se descuentan solos estos insumos (clase 261):</p>' +
            '<table class="erp-tabla"><thead><tr><th>Pos.</th><th>Insumo</th><th>Texto breve</th><th class="erp-num">Se descuenta</th><th>UM</th></tr></thead><tbody>' +
            auto.map(function (x) {
              return '<tr><td class="erp-num">' + x.posicion + '</td><td>' + ui.esc(x.sku) + '</td><td>' + ui.esc(x.texto_breve || '') + '</td>' +
                '<td class="erp-num" data-auto="' + x.posicion + '"></td><td>' + ui.esc(x.unidad) + '</td></tr>';
            }).join('') + '</tbody></table>'
          : '<p class="erp-ayuda">Ningún insumo de esta orden se descuenta solo: entréguelos con A07 Salida + R08 Orden (clase 261).</p>'));
    }
    function recalcularAuto() {
      var o = estado.datos && estado.datos.orden;
      if (!o || estado.operacion !== 'A01') return;
      var q = ui.numeroCL((ui.valores().cantidad_em) || '0');
      o.componentes.forEach(function (x) {
        var celda = ui.q('[data-auto="' + x.posicion + '"]');
        if (celda) celda.textContent = isFinite(q) ? ui.num(Math.round(Number(x.cantidad_necesaria) * q / Number(o.cabecera.cantidad) * 1000) / 1000) : '';
      });
    }

    // A07 + R08: consumo de insumos para la orden (bodega los entrega).
    function posicionesOrdenConsumo(o) {
      var c = o.cabecera;
      return ui.grupo('Componentes de la orden ' + c.aufnr + ' — ' + c.sku + ' ' + (c.nombre || '') + ' (' + c.estado + ')',
        '<table class="erp-tabla erp-tabla-editable"><thead><tr><th>OK</th><th>Pos.</th><th>Insumo</th><th>Texto breve</th><th>Necesario</th><th>Consumido</th><th>Por consumir</th><th>Cantidad</th><th>UM</th><th>Desc. automático</th></tr></thead><tbody>' +
        o.componentes.map(function (x, i) {
          var pend = Math.max(Number(x.pendiente), 0);
          return '<tr' + (pend <= 0 ? ' class="erp-fila-inactiva"' : '') + '>' +
            '<td>' + ui.celda({ fila: i, col: 'ok', tipo: 'check', valor: false }) +
              '<input type="hidden" data-fila="' + i + '" data-col="rspos" value="' + x.posicion + '"></td>' +
            '<td class="erp-num">' + x.posicion + '</td>' +
            '<td>' + ui.esc(x.sku) + '</td><td>' + ui.esc(x.texto_breve || '') + '</td>' +
            '<td class="erp-num">' + ui.num(x.cantidad_necesaria) + '</td>' +
            '<td class="erp-num">' + ui.num(x.cantidad_retirada) + '</td>' +
            '<td class="erp-num">' + ui.num(pend) + '</td>' +
            '<td>' + ui.celda({ fila: i, col: 'cantidad', tipo: 'number', valor: pend > 0 ? ui.num(pend) : '', ancho: 8 }) + '</td>' +
            '<td>' + ui.esc(x.unidad) + '</td><td>' + (x.backflush ? '✔' : '') + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="erp-ayuda">Marque <b>OK</b> en lo que bodega entrega a producción. Los insumos con <b>desc. automático</b> se descuentan solos al dar entrada a lo fabricado: no los entregue dos veces.</p>');
    }

    function posicionesLibres() {
      var filas = '';
      for (var i = 0; i < 5; i++) {
        filas += '<tr><td class="erp-num">' + (i + 1) + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'material', f4: 'material', valor: i === 0 ? (params.material || '') : '', ancho: 14 }) + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'cantidad', tipo: 'number', ancho: 8 }) + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'centro', f4: 'centro', valor: ui.centroPorDefecto(), ancho: 16 }) + '</td></tr>';
      }
      return ui.grupo('Posiciones — clase ' + claseActual(),
        '<table class="erp-tabla erp-tabla-editable"><thead><tr><th>Línea</th><th>Material</th><th>Cantidad</th><th>Centro</th></tr></thead><tbody>' + filas + '</tbody></table>');
    }

    function posicionesDocumento(d) {
      var c = d.cabecera;
      return ui.grupo('Documento de material ' + c.mblnr + ' / ' + c.mjahr + (c.anulado_por ? ' — ANULADO por ' + c.anulado_por : ''),
        ui.campo({ id: 'fc', etiqueta: 'Fecha contabilización', valor: ui.fecha(c.fecha_contabilizacion), soloLectura: true }) +
        ui.campo({ id: 'tc', etiqueta: 'Texto cabecera', valor: c.texto_cabecera || '', soloLectura: true, ancho: 40 }) +
        ui.campo({ id: 'us', etiqueta: 'Usuario', valor: c.created_by || '', soloLectura: true }) +
        ui.tabla([
          { id: 'zeile', etiqueta: 'Línea', tipo: 'num' },
          { id: 'clase_movimiento', etiqueta: 'CMv' },
          { id: 'sku', etiqueta: 'Material', enlace: function (f) { ui.ir('MMBE', { material: f.sku }); } },
          { id: 'texto_breve', etiqueta: 'Texto breve' },
          { id: 'cantidad', etiqueta: 'Cantidad', tipo: 'qty' },
          { id: 'unidad', etiqueta: 'UM' },
          { id: 'centro', etiqueta: 'Centro' },
          { id: 'ebeln', etiqueta: 'Pedido', enlace: function (f) { if (f.ebeln) ui.ir('ME23N', { pedido: f.ebeln }); } },
          { id: 'ebelp', etiqueta: 'Pos.' },
          { id: 'aufnr', etiqueta: 'Orden', enlace: function (f) { if (f.aufnr) ui.ir('CO03', { orden: f.aufnr }); } },
          { id: 'importe', etiqueta: 'Importe', tipo: 'money' },
          { id: 'ref_mblnr', etiqueta: 'Doc. referencia' },
        ], d.posiciones));
    }

    function render() {
      var libre = estado.referencia === 'R10' && (estado.operacion === 'A07' || estado.operacion === 'A01');
      var cuerpo = '';
      if (estado.datos && estado.datos.pedido) cuerpo = posicionesPedido(estado.datos.pedido);
      else if (estado.datos && estado.datos.orden) cuerpo = estado.operacion === 'A01' ? posicionesOrdenEntrada(estado.datos.orden) : posicionesOrdenConsumo(estado.datos.orden);
      else if (estado.datos && estado.datos.documento) cuerpo = posicionesDocumento(estado.datos.documento);
      else if (libre) cuerpo = posicionesLibres();
      else cuerpo = '<p class="erp-ayuda">Ingrese la referencia y presione Enter (Ejecutar).</p>';

      ui.pantalla(cabecera() + (estado.datos || libre ? datosCabecera() : '') + cuerpo);
      ui.q('[data-campo="operacion"]').addEventListener('change', function (e) { estado.operacion = e.target.value; estado.referencia = e.target.value === 'A01' ? 'R01' : (e.target.value === 'A07' ? 'R10' : 'R02'); estado.datos = null; params = {}; render(); });
      ui.q('[data-campo="referencia"]').addEventListener('change', function (e) { estado.referencia = e.target.value; estado.datos = null; params = {}; render(); });
      var campoCantidad = ui.q('[data-campo="cantidad_em"]');
      if (campoCantidad) { campoCantidad.addEventListener('input', recalcularAuto); recalcularAuto(); }

      var b = [];
      var ordenAbierta = estado.datos && estado.datos.orden && ['REL', 'PDLV', 'DLV'].indexOf(estado.datos.orden.cabecera.estado) >= 0;
      var puedeContabilizar = (estado.datos && estado.datos.pedido) || ordenAbierta || libre ||
        (estado.operacion === 'A03' && estado.datos && estado.datos.documento && !estado.datos.documento.cabecera.anulado_por);
      if (!estado.datos && (estado.referencia === 'R01' || estado.referencia === 'R08' || estado.operacion === 'A03' || estado.operacion === 'A04')) {
        b.push({ texto: 'Ejecutar', tecla: 'Enter', primario: true, accion: cargar });
      }
      if (puedeContabilizar) {
        b.push({ texto: estado.operacion === 'A03' ? 'Contabilizar anulación' : 'Contabilizar', tecla: 'Ctrl+S', primario: true, accion: function () { contabilizar(false); } });
        b.push({ texto: 'Verificar', accion: function () { contabilizar(true); } });
      }
      if (estado.datos) b.push({ texto: 'Otra referencia', tecla: 'F3', accion: function () { estado.datos = null; params = {}; render(); } });
      ui.botones(b);
    }

    async function cargar() {
      var v = ui.valores();
      if (estado.referencia === 'R01' && estado.operacion === 'A01') {
        if (!v.pedido) return ui.mensaje('E', 'Introduzca un pedido');
        estado.datos = await ui.get('MIGO', { pedido: v.pedido });
        if (estado.datos.pedido.cabecera.estado === 'CERRADO') ui.mensaje('W', 'El pedido ' + v.pedido + ' ya está completamente entregado');
      } else if (estado.referencia === 'R08') {
        if (!v.orden) return ui.mensaje('E', 'Introduzca una orden');
        estado.datos = await ui.get('MIGO', { orden: v.orden });
        var co = estado.datos.orden.cabecera;
        if (['REL', 'PDLV', 'DLV'].indexOf(co.estado) < 0) ui.mensaje('W', 'La orden ' + co.aufnr + ' está en ' + co.estado + ' ' + co.texto_estado + ': no admite movimientos');
      } else {
        if (!v.documento) return ui.mensaje('E', 'Introduzca un documento de material');
        estado.datos = await ui.get('MIGO', { documento: v.documento });
        if (estado.datos.documento.cabecera.anulado_por) ui.mensaje('W', 'Documento ya anulado por ' + estado.datos.documento.cabecera.anulado_por);
      }
      render();
    }

    async function contabilizar(soloVerificar) {
      var v = ui.valores();
      var body = {
        fecha_contabilizacion: v.fecha_contabilizacion,
        texto_cabecera: [v.texto_cabecera, v.guia ? 'Guía ' + v.guia : ''].filter(Boolean).join(' / '),
        solo_verificar: soloVerificar,
      };
      if (estado.operacion === 'A03') {
        body.operacion = 'anular';
        body.documento = estado.datos.documento.cabecera.mblnr;
      } else if (estado.datos && estado.datos.orden) {
        body.clase_movimiento = claseActual();
        body.orden = estado.datos.orden.cabecera.aufnr;
        if (estado.operacion === 'A01') {
          body.cantidad = v.cantidad_em;
          body.entrega_final = v.entrega_final;
        } else {
          body.posiciones = ui.filas();
        }
      } else {
        body.clase_movimiento = claseActual();
        body.posiciones = ui.filas();
        if (body.clase_movimiento === '101') body.pedido = estado.datos.pedido.cabecera.ebeln;
      }
      var r = await ui.post('MIGO', body);
      if (soloVerificar) return ui.mensaje('S', r.mensaje);
      ui.ir('MIGO', { documento: r.documento }, { mensaje: ['S', r.mensaje] });
    }

    render();
    if (params.pedido || params.documento || params.orden) cargar();
  }`,
};

// Reutilizadas por otras transacciones que mueven stock (ej. MI07 inventario físico).
export { Verificado, moverStock, crearCabecera, insertarPosicion, liberarQuiebres };

export default [MIGO];
