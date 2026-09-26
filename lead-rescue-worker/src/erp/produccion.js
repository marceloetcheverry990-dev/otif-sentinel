// src/erp/produccion.js
// Lógica del módulo PP (producción) que comparten las recetas (CS01-CS03),
// las órdenes (CO01-CO03, COOIS) y MIGO cuando se refiere a una orden.
//
// Regla central del stock: al LIBERAR una orden, sus insumos pasan de
// qty_disponible (lo que la Torre puede vender) a qty_reservada_produccion.
// Consumir (261) descuenta primero de ese apartado; el cierre técnico (TECO)
// devuelve a libre lo que sobró. Así una venta nunca se lleva un insumo que
// producción ya apartó, y el stock físico siempre es
//   qty_disponible + qty_reservada (Torre) + qty_reservada_produccion.

import { fallo, texto, cantidad, opcion } from './core.js';

export const ESTADOS_ORDEN = Object.freeze({
  CRTD: 'Abierta',
  REL: 'Liberada',
  PDLV: 'Entregada parcialmente',
  DLV: 'Entregada',
  TECO: 'Cierre técnico',
  DLFL: 'Petición de borrado',
});

/** Estados en los que la orden admite consumos y entradas (MIGO). */
export const ESTADOS_CON_MOVIMIENTOS = ['REL', 'PDLV', 'DLV'];

/** Solo se fabrican productos terminados y semielaborados. */
export const TIPOS_FABRICABLES = ['FERT', 'HALB'];

const MAX_COMPONENTES = 60;
const MAX_NIVELES = 20;

export const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

// ─── Cálculos (sin base de datos) ─────────────────────────────────────────

/**
 * Cuánto de un componente necesita una orden: la receta está escrita para
 * `cantidadBase` unidades y se agrega la merma esperada.
 *   receta 5 kg por 100 panes, merma 2 %, orden de 300 → 5 × 3 × 1,02 = 15,3 kg
 */
export function necesidadComponente({ cantidadComponente, cantidadBase, cantidadOrden, mermaPct = 0 }) {
  const n = r3(Number(cantidadComponente) * Number(cantidadOrden) / Number(cantidadBase) * (1 + Number(mermaPct) / 100));
  return n > 0 ? n : 0.001; // nunca 0: una receta con el componente siempre pide algo
}

/** Explota la receta de un nivel para una cantidad de orden. */
export function explotarLista(lista, posiciones, cantidadOrden) {
  return posiciones.map((p) => ({
    posicion: Number(p.posicion),
    sku: p.componente,
    unidad: p.unidad,
    merma_pct: Number(p.merma_pct) || 0,
    backflush: p.backflush !== false,
    cantidad_necesaria: necesidadComponente({
      cantidadComponente: p.cantidad,
      cantidadBase: lista.cantidad_base,
      cantidadOrden,
      mermaPct: p.merma_pct,
    }),
  }));
}

/** Suma lo necesario por material (un insumo puede ir en dos posiciones). */
export function necesidadPorMaterial(componentes, campo = 'pendiente') {
  const m = new Map();
  for (const c of componentes) {
    const q = campo === 'pendiente'
      ? Math.max(Number(c.cantidad_necesaria) - Number(c.cantidad_retirada || 0) - Number(c.cantidad_reservada || 0), 0)
      : Number(c[campo]);
    if (q > 0) m.set(c.sku, r3((m.get(c.sku) || 0) + q));
  }
  return m;
}

/** Al consumir q: primero se usa lo apartado para la orden, el resto sale del stock libre. */
export function repartoConsumo(q, reservada) {
  const desdeReserva = r3(Math.min(Number(q), Math.max(Number(reservada), 0)));
  return { desdeReserva, desdeLibre: r3(Number(q) - desdeReserva) };
}

/**
 * Al devolver q (262): vuelve al apartado de la orden lo que todavía necesita,
 * el resto a libre. Si la orden ya no admite movimientos todo va a libre.
 */
export function repartoDevolucion({ q, necesaria, retiradaDespues, reservada, ordenAbierta }) {
  const falta = ordenAbierta
    ? Math.max(Number(necesaria) - Number(retiradaDespues) - Number(reservada), 0)
    : 0;
  const aReserva = r3(Math.min(Number(q), falta));
  return { aReserva, aLibre: r3(Number(q) - aReserva) };
}

/**
 * Descuento automático (backflush) al dar entrada a q unidades fabricadas:
 * cada componente marcado se consume en proporción a lo producido.
 */
export function cantidadesBackflush(componentes, q, cantidadOrden) {
  return componentes
    .filter((c) => c.backflush)
    .map((comp) => ({ comp, cantidad: r3(Number(comp.cantidad_necesaria) * Number(q) / Number(cantidadOrden)) }))
    .filter((x) => x.cantidad > 0);
}

/** Estado de sistema tras una entrada (101) o su anulación (102). */
export function estadoTrasEntrega({ estado, cantidad: plan, cantidad_entregada: entregada, entrega_final: final }) {
  if (!ESTADOS_CON_MOVIMIENTOS.includes(estado)) return estado;
  if (final || Number(entregada) >= Number(plan) - 1e-9) return 'DLV';
  return Number(entregada) > 0 ? 'PDLV' : 'REL';
}

export function exigirMovimientos(orden) {
  const { aufnr, estado } = orden;
  if (estado === 'CRTD') throw fallo(`La orden ${aufnr} no está liberada (CO02 → Liberar)`);
  if (estado === 'TECO') throw fallo(`La orden ${aufnr} tiene cierre técnico: no admite movimientos`);
  if (estado === 'DLFL') throw fallo(`La orden ${aufnr} está marcada para borrar`);
}

// ─── Recetas (listas de materiales) ───────────────────────────────────────

export async function leerLista(client, tenant_id, sku, centro, { alternativa = '01', paraActualizar = false } = {}) {
  const mat = texto(sku, { campo: 'Material', max: 64, requerido: true });
  const cen = texto(centro, { campo: 'Centro', max: 64, requerido: true });
  const cab = await client.query(
    `SELECT l.*, p.nombre, p.tipo_material, p.precio_estandar
     FROM erp_listas_materiales l
     LEFT JOIN productos p ON p.tenant_id = l.tenant_id AND p.sku = l.sku
     WHERE l.tenant_id = $1 AND l.sku = $2 AND l.centro = $3 AND l.alternativa = $4${paraActualizar ? ' FOR UPDATE OF l' : ''}`,
    [tenant_id, mat, cen, alternativa]
  );
  if (!cab.rowCount) throw fallo(`El material ${mat} no tiene lista de materiales en el centro ${cen} (créela con CS01)`, 404);
  const pos = await client.query(
    `SELECT x.posicion, x.componente, p.nombre AS texto_breve, p.tipo_material, x.cantidad, x.unidad,
            x.merma_pct, x.backflush, x.texto, COALESCE(p.precio_estandar, 0) AS precio_estandar
     FROM erp_listas_materiales_pos x
     LEFT JOIN productos p ON p.tenant_id = x.tenant_id AND p.sku = x.componente
     WHERE x.tenant_id = $1 AND x.sku = $2 AND x.centro = $3 AND x.alternativa = $4
     ORDER BY x.posicion`,
    [tenant_id, mat, cen, alternativa]
  );
  return { cabecera: cab.rows[0], posiciones: pos.rows };
}

/** Lee y valida el material a fabricar: tiene que existir, estar activo y ser FERT o HALB. */
export async function leerMaterialFabricable(client, tenant_id, sku) {
  const id = texto(sku, { campo: 'Material', max: 64, requerido: true });
  const r = await client.query(
    `SELECT sku, nombre, unidad, activo, tipo_material, precio_estandar FROM productos WHERE tenant_id = $1 AND sku = $2`,
    [tenant_id, id]
  );
  if (!r.rowCount) throw fallo(`El material ${id} no existe (créelo con MM01)`, 404);
  const m = r.rows[0];
  if (!m.activo) throw fallo(`El material ${id} está inactivo`);
  if (!TIPOS_FABRICABLES.includes(m.tipo_material)) {
    throw fallo(`El material ${id} es de tipo ${m.tipo_material}: solo se fabrican productos terminados (FERT) o semielaborados (HALB)`);
  }
  return m;
}

/**
 * Valida las posiciones de una receta. Devuelve [{posicion, componente, cantidad,
 * unidad, merma_pct, backflush, texto}]. Las filas que ya traen número de posición
 * lo conservan (CS02); las nuevas siguen de 10 en 10 después de la mayor.
 */
export async function validarComponentes(client, tenant_id, { sku, centro, filas }) {
  const lista = (Array.isArray(filas) ? filas : [])
    .filter((f) => f && String(f.componente ?? '').trim() !== '' && !(f.borrar === true || f.borrar === 'true'));
  if (!lista.length) throw fallo('Introduzca al menos un componente');
  if (lista.length > MAX_COMPONENTES) throw fallo(`Máximo ${MAX_COMPONENTES} componentes por lista de materiales`);

  const usadas = new Set(lista.map((f) => Number(f.posicion)).filter((n) => Number.isInteger(n) && n > 0));
  let siguiente = Math.max(0, ...usadas) + 10;
  const out = [];
  for (const f of lista) {
    let posicion = Number(f.posicion);
    if (!Number.isInteger(posicion) || posicion <= 0) {
      posicion = siguiente;
      siguiente += 10;
    }
    const etiqueta = `pos. ${String(posicion).padStart(4, '0')}`;
    const comp = texto(f.componente, { campo: `Componente ${etiqueta}`, max: 64, requerido: true });
    if (comp === sku) throw fallo(`${etiqueta}: el material ${sku} no puede ser componente de sí mismo`);
    const mat = await client.query(
      `SELECT sku, unidad, activo FROM productos WHERE tenant_id = $1 AND sku = $2`,
      [tenant_id, comp]
    );
    if (!mat.rowCount) throw fallo(`${etiqueta}: el material ${comp} no existe (créelo con MM01)`, 404);
    if (!mat.rows[0].activo) throw fallo(`${etiqueta}: el material ${comp} está inactivo`);
    const merma = f.merma_pct === '' || f.merma_pct == null ? 0 : cantidad(f.merma_pct, { campo: `Merma % ${etiqueta}`, permitirCero: true });
    if (merma >= 100) throw fallo(`${etiqueta}: la merma debe ser menor que 100 %`);
    out.push({
      posicion,
      componente: comp,
      cantidad: cantidad(f.cantidad, { campo: `Cantidad ${etiqueta}` }),
      unidad: mat.rows[0].unidad || 'UN',
      merma_pct: Math.round(merma * 100) / 100,
      backflush: !(f.backflush === false || f.backflush === 'false'),
      texto: texto(f.texto, { campo: `Texto ${etiqueta}`, max: 160 }),
    });
  }
  const repetida = out.find((p, i) => out.findIndex((q) => q.posicion === p.posicion) !== i);
  if (repetida) throw fallo(`La posición ${repetida.posicion} está repetida`);
  out.sort((a, b) => a.posicion - b.posicion);
  await detectarCiclo(client, tenant_id, { sku, centro, componentes: out.map((p) => p.componente) });
  return out;
}

/**
 * Una receta no puede contenerse a sí misma en ningún nivel (A lleva B, B lleva A).
 * Recorre las recetas de los componentes semielaborados en el mismo centro.
 */
async function detectarCiclo(client, tenant_id, { sku, centro, componentes }) {
  let nivel = Array.from(new Set(componentes));
  const vistos = new Set(nivel);
  for (let n = 0; n < MAX_NIVELES && nivel.length; n++) {
    const r = await client.query(
      `SELECT DISTINCT componente FROM erp_listas_materiales_pos
       WHERE tenant_id = $1 AND centro = $2 AND sku = ANY($3::text[])`,
      [tenant_id, centro, nivel]
    );
    const siguientes = [];
    for (const { componente } of r.rows) {
      if (componente === sku) {
        throw fallo(`Recursividad: ${sku} terminaría siendo componente de sí mismo a través de otra lista de materiales`);
      }
      if (!vistos.has(componente)) {
        vistos.add(componente);
        siguientes.push(componente);
      }
    }
    nivel = siguientes;
  }
}

// ─── Órdenes ──────────────────────────────────────────────────────────────

export async function leerOrden(client, tenant_id, aufnr, { paraActualizar = false } = {}) {
  const id = texto(aufnr, { campo: 'Orden', max: 12, requerido: true });
  const cab = await client.query(
    // Fechas como texto AAAA-MM-DD: un DATE convertido a Date de JS puede correrse un día según la zona horaria.
    `SELECT o.aufnr, o.clase_orden, o.sku, o.centro, o.alternativa, o.cantidad, o.cantidad_entregada, o.unidad,
            o.fecha_inicio::text AS fecha_inicio, o.fecha_fin::text AS fecha_fin, o.estado, o.entrega_final,
            o.texto, o.created_by, o.created_at, o.liberada_at, o.cerrada_at,
            p.nombre, p.precio_estandar, d.nombre AS nombre_centro
     FROM erp_ordenes_produccion o
     LEFT JOIN productos p ON p.tenant_id = o.tenant_id AND p.sku = o.sku
     LEFT JOIN depots d ON d.tenant_id = o.tenant_id AND d.depot_id = o.centro
     WHERE o.tenant_id = $1 AND o.aufnr = $2${paraActualizar ? ' FOR UPDATE OF o' : ''}`,
    [tenant_id, id]
  );
  if (!cab.rowCount) throw fallo(`La orden ${id} no existe`, 404);
  const comp = await client.query(
    `SELECT c.posicion, c.sku, p.nombre AS texto_breve, c.centro, c.cantidad_necesaria, c.cantidad_reservada,
            c.cantidad_retirada, c.unidad, c.merma_pct, c.backflush, c.precio_plan,
            COALESCE(p.precio_estandar, 0) AS precio_estandar,
            GREATEST(c.cantidad_necesaria - c.cantidad_retirada, 0) AS pendiente,
            COALESCE(i.qty_disponible, 0) AS libre
     FROM erp_ordenes_componentes c
     LEFT JOIN productos p ON p.tenant_id = c.tenant_id AND p.sku = c.sku
     LEFT JOIN inventario_bodega i ON i.tenant_id = c.tenant_id AND i.depot_id = c.centro AND i.sku = c.sku
     WHERE c.tenant_id = $1 AND c.aufnr = $2
     ORDER BY c.posicion${paraActualizar ? ' FOR UPDATE OF c' : ''}`,
    [tenant_id, id]
  );
  const cabecera = cab.rows[0];
  cabecera.texto_estado = ESTADOS_ORDEN[cabecera.estado] || cabecera.estado;
  return { cabecera, componentes: comp.rows };
}

/**
 * Mueve stock entre "libre" y "apartado para producción" (o fuera de la bodega)
 * y deja rastro en movimientos_inventario. Nunca deja ninguno de los dos negativo.
 *   deltaLibre    cambio en qty_disponible
 *   deltaReserva  cambio en qty_reservada_produccion
 * Si la suma es 0 es un traspaso (liberar / TECO): se anota como 'reserva',
 * que MB51 no lista porque no es un movimiento físico.
 */
export async function moverStockProduccion(client, { tenant_id, centro, sku, deltaLibre = 0, deltaReserva = 0, clase = null, mblnr = null, aufnr }) {
  const dl = r3(deltaLibre);
  const dr = r3(deltaReserva);
  if (dl === 0 && dr === 0) return;
  const row = await client.query(
    `SELECT qty_disponible, qty_reservada_produccion FROM inventario_bodega
     WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3 FOR UPDATE`,
    [tenant_id, centro, sku]
  );
  const libre = row.rowCount ? Number(row.rows[0].qty_disponible) : 0;
  const reservado = row.rowCount ? Number(row.rows[0].qty_reservada_produccion) : 0;
  const nuevoLibre = r3(libre + dl);
  const nuevoReservado = r3(reservado + dr);
  if (nuevoLibre < 0) {
    throw fallo(`Déficit de stock libre utilización: material ${sku}, centro ${centro} (disponible ${libre}, se necesitan ${Math.abs(dl)})`);
  }
  if (nuevoReservado < 0) {
    throw fallo(`Déficit de stock reservado para producción: material ${sku}, centro ${centro} (reservado ${reservado}, se necesitan ${Math.abs(dr)})`);
  }
  if (row.rowCount) {
    await client.query(
      `UPDATE inventario_bodega SET qty_disponible = $4, qty_reservada_produccion = $5, updated_at = NOW()
       WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3`,
      [tenant_id, centro, sku, nuevoLibre, nuevoReservado]
    );
  } else {
    await client.query(
      `INSERT INTO inventario_bodega (tenant_id, depot_id, sku, qty_disponible, qty_reservada, qty_minima, qty_reservada_produccion)
       VALUES ($1, $2, $3, $4, 0, 0, $5)`,
      [tenant_id, centro, sku, nuevoLibre, nuevoReservado]
    );
  }
  const fisico = r3(dl + dr);
  const tipo = fisico > 0 ? 'entrada' : fisico < 0 ? 'salida' : 'reserva';
  const motivo = clase
    ? `MIGO ${clase} doc ${mblnr} orden ${aufnr}`
    : `${dr > 0 ? 'Reserva' : 'Fin de reserva'} orden de producción ${aufnr}`;
  await client.query(
    `INSERT INTO movimientos_inventario (tenant_id, depot_id, sku, tipo, qty, motivo, clase_movimiento, mblnr)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenant_id, centro, sku, tipo, Math.abs(fisico || dr), motivo, clase, mblnr]
  );
}

/**
 * Libera la orden: aparta lo que le falta a cada componente. Si algún insumo no
 * alcanza, no aparta nada y dice exactamente qué falta.
 */
export async function reservarOrden(client, tenant_id, orden) {
  const { aufnr } = orden.cabecera;
  const porCentro = new Map();
  for (const c of orden.componentes) {
    const clave = c.centro;
    if (!porCentro.has(clave)) porCentro.set(clave, []);
    porCentro.get(clave).push(c);
  }
  const faltantes = [];
  for (const [centro, comps] of porCentro) {
    for (const [sku, q] of necesidadPorMaterial(comps)) {
      const inv = await client.query(
        `SELECT qty_disponible FROM inventario_bodega WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3 FOR UPDATE`,
        [tenant_id, centro, sku]
      );
      const libre = inv.rowCount ? Number(inv.rows[0].qty_disponible) : 0;
      if (libre + 1e-9 < q) faltantes.push({ sku, centro, necesita: q, libre, falta: r3(q - libre) });
    }
  }
  if (faltantes.length) {
    const detalle = faltantes.slice(0, 5)
      .map((f) => `${f.sku} (necesita ${f.necesita}, libre ${f.libre}, faltan ${f.falta})`).join('; ');
    const err = fallo(`No se puede liberar la orden ${aufnr}: faltan insumos — ${detalle}${faltantes.length > 5 ? '…' : ''}`);
    err.faltantes = faltantes;
    throw err;
  }
  for (const c of orden.componentes) {
    const q = r3(Math.max(Number(c.cantidad_necesaria) - Number(c.cantidad_retirada) - Number(c.cantidad_reservada), 0));
    if (q <= 0) continue;
    await moverStockProduccion(client, { tenant_id, centro: c.centro, sku: c.sku, deltaLibre: -q, deltaReserva: q, aufnr });
    await client.query(
      `UPDATE erp_ordenes_componentes SET cantidad_reservada = cantidad_reservada + $4
       WHERE tenant_id = $1 AND aufnr = $2 AND posicion = $3`,
      [tenant_id, aufnr, c.posicion, q]
    );
    c.cantidad_reservada = r3(Number(c.cantidad_reservada) + q);
  }
}

/** Devuelve a libre todo lo apartado (TECO). Devuelve {centro: [skus]} liberados. */
export async function devolverReservas(client, tenant_id, orden) {
  const { aufnr } = orden.cabecera;
  const liberados = new Map();
  for (const c of orden.componentes) {
    const q = r3(c.cantidad_reservada);
    if (q <= 0) continue;
    await moverStockProduccion(client, { tenant_id, centro: c.centro, sku: c.sku, deltaLibre: q, deltaReserva: -q, aufnr });
    await client.query(
      `UPDATE erp_ordenes_componentes SET cantidad_reservada = 0
       WHERE tenant_id = $1 AND aufnr = $2 AND posicion = $3`,
      [tenant_id, aufnr, c.posicion]
    );
    c.cantidad_reservada = 0;
    if (!liberados.has(c.centro)) liberados.set(c.centro, new Set());
    liberados.get(c.centro).add(c.sku);
  }
  return liberados;
}

/** Consumo 261 de un componente: primero de lo apartado, después de libre. */
export async function consumirComponente(client, { tenant_id, orden, comp, q, mblnr }) {
  const { desdeReserva, desdeLibre } = repartoConsumo(q, comp.cantidad_reservada);
  await moverStockProduccion(client, {
    tenant_id, centro: comp.centro, sku: comp.sku,
    deltaLibre: -desdeLibre, deltaReserva: -desdeReserva, clase: '261', mblnr, aufnr: orden.cabecera.aufnr,
  });
  await client.query(
    `UPDATE erp_ordenes_componentes
     SET cantidad_reservada = cantidad_reservada - $4, cantidad_retirada = cantidad_retirada + $5
     WHERE tenant_id = $1 AND aufnr = $2 AND posicion = $3`,
    [tenant_id, orden.cabecera.aufnr, comp.posicion, desdeReserva, q]
  );
  comp.cantidad_reservada = r3(Number(comp.cantidad_reservada) - desdeReserva);
  comp.cantidad_retirada = r3(Number(comp.cantidad_retirada) + q);
  return { desdeReserva, desdeLibre };
}

/** Devolución 262 (anulación de un consumo). */
export async function devolverComponente(client, { tenant_id, orden, comp, q, mblnr }) {
  const retiradaDespues = r3(Number(comp.cantidad_retirada) - q);
  if (retiradaDespues < -1e-9) {
    throw fallo(`Orden ${orden.cabecera.aufnr}, pos. ${comp.posicion}: no se puede devolver más de lo retirado (${comp.cantidad_retirada})`);
  }
  const { aReserva, aLibre } = repartoDevolucion({
    q,
    necesaria: comp.cantidad_necesaria,
    retiradaDespues,
    reservada: comp.cantidad_reservada,
    ordenAbierta: ESTADOS_CON_MOVIMIENTOS.includes(orden.cabecera.estado),
  });
  await moverStockProduccion(client, {
    tenant_id, centro: comp.centro, sku: comp.sku,
    deltaLibre: aLibre, deltaReserva: aReserva, clase: '262', mblnr, aufnr: orden.cabecera.aufnr,
  });
  await client.query(
    `UPDATE erp_ordenes_componentes
     SET cantidad_reservada = cantidad_reservada + $4, cantidad_retirada = GREATEST(cantidad_retirada - $5, 0)
     WHERE tenant_id = $1 AND aufnr = $2 AND posicion = $3`,
    [tenant_id, orden.cabecera.aufnr, comp.posicion, aReserva, q]
  );
  comp.cantidad_reservada = r3(Number(comp.cantidad_reservada) + aReserva);
  comp.cantidad_retirada = Math.max(retiradaDespues, 0);
  return { aReserva, aLibre };
}

/** Actualiza cantidad entregada y estado tras una entrada (101) o su anulación (102). */
export async function registrarEntregaOrden(client, tenant_id, orden, { delta, entregaFinal = null }) {
  const c = orden.cabecera;
  const entregada = r3(Number(c.cantidad_entregada) + delta);
  if (entregada < -1e-9) throw fallo(`La orden ${c.aufnr} quedaría con entrega negativa`);
  const final = entregaFinal == null ? c.entrega_final : entregaFinal;
  const estado = estadoTrasEntrega({ estado: c.estado, cantidad: c.cantidad, cantidad_entregada: entregada, entrega_final: final });
  await client.query(
    `UPDATE erp_ordenes_produccion SET cantidad_entregada = $3, entrega_final = $4, estado = $5
     WHERE tenant_id = $1 AND aufnr = $2`,
    [tenant_id, c.aufnr, Math.max(entregada, 0), !!final, estado]
  );
  Object.assign(c, { cantidad_entregada: Math.max(entregada, 0), entrega_final: !!final, estado });
  return estado;
}

export function leerEstadoFiltro(v) {
  return opcion(v, ['', 'ABIERTAS', ...Object.keys(ESTADOS_ORDEN)], { campo: 'Estado', porDefecto: '' });
}
