import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  withDb: vi.fn(async (_env, fn) => fn(globalThis.__erpClient)),
  withDbTransaction: vi.fn(async (_env, fn) => fn(globalThis.__erpClient)),
}));

import { rutChileno, cantidad, estadoPedido, ErpError, siguienteNumero, RANGOS } from './core.js';
import { TRANSACCIONES, validarRegistro, catalogoCliente } from './registry.js';
import { renderErpPage } from './ui/page.js';
import { handleErpApi } from '../api/erp.js';

/**
 * Cliente pg falso: cada handler es [regex, (params, sql) => rows]. El primero
 * que calza responde. Registra todas las consultas para poder afirmarlas.
 */
function crearCliente(handlers) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params = []) {
      consultas.push({ sql, params });
      for (const [re, fn] of handlers) {
        if (re.test(sql)) {
          const rows = fn(params, sql) || [];
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const OPERADOR = { tenant_id: 'empresa_base', username: 'marcelo', role: 'operator' };

// El DDL ya "corrió": que los tests no dependan de él.
const DDL = [/^\s*(ALTER TABLE|CREATE TABLE)/, () => []];

describe('core: validaciones', () => {
  it('valida RUT chileno con dígito verificador', () => {
    expect(rutChileno('76.086.428-5')).toBe('76086428-5');
    expect(rutChileno('11111111-1')).toBe('11111111-1');
    expect(rutChileno('')).toBeNull();
    expect(() => rutChileno('76086428-4')).toThrow(/verificador/);
    expect(() => rutChileno('abc')).toThrow(ErpError);
  });

  it('cantidad acepta coma decimal y rechaza cero o negativos', () => {
    expect(cantidad('2,5')).toBe(2.5);
    expect(() => cantidad('0')).toThrow(/mayor que cero/);
    expect(() => cantidad('-1')).toThrow(ErpError);
    expect(cantidad('0', { permitirCero: true })).toBe(0);
  });

  it('estado del pedido según lo recibido', () => {
    expect(estadoPedido([{ cantidad: 10, cantidad_recibida: 0 }])).toBe('ABIERTO');
    expect(estadoPedido([{ cantidad: 10, cantidad_recibida: 4 }])).toBe('PARCIAL');
    expect(estadoPedido([{ cantidad: 10, cantidad_recibida: 10 }, { cantidad: 1, cantidad_recibida: 1 }])).toBe('CERRADO');
  });

  it('siguienteNumero usa el rango con upsert atómico', async () => {
    const c = crearCliente([[/erp_numeradores/, (p) => [{ ultimo: p[2] }]]]);
    expect(await siguienteNumero(c, 't', RANGOS.PEDIDO)).toBe('4500000000');
    expect(c.consultas[0].sql).toMatch(/ON CONFLICT \(tenant_id, objeto\) DO UPDATE SET ultimo = erp_numeradores\.ultimo \+ 1/);
  });
});

describe('registro de transacciones', () => {
  it('no tiene errores y trae el set MM v1', () => {
    expect(validarRegistro()).toEqual([]);
    for (const code of ['MM01', 'MM02', 'MM03', 'MM60', 'XK01', 'XK02', 'XK03', 'MKVZ', 'ME21N', 'ME22N', 'ME23N', 'ME2N', 'MIGO', 'MMBE', 'MB51', 'MI01', 'MI03', 'MI04', 'MI20', 'MI07']) {
      expect(TRANSACCIONES[code], code).toBeTruthy();
    }
  });

  it('detecta códigos duplicados y pantallas mal formadas', () => {
    const errores = validarRegistro([
      { code: 'ZZ01', titulo: 'a', menu: ['x'], screen: 'function () {}' },
      { code: 'ZZ01', titulo: 'b', menu: ['x'], screen: 'no' },
    ]);
    expect(errores.join('|')).toMatch(/duplicado/);
    expect(errores.join('|')).toMatch(/screen/);
  });

  it('cada pantalla es JavaScript válido', () => {
    for (const tx of Object.values(TRANSACCIONES)) {
      expect(() => new Function(`return ${tx.screen}`)(), tx.code).not.toThrow();
    }
  });

  it('el catálogo del navegador no expone lógica de servidor', () => {
    const cat = catalogoCliente();
    expect(cat.every((t) => Object.keys(t).sort().join() === 'code,menu,titulo')).toBe(true);
  });

  it('la página /erp arma scripts que parsean y escapa al usuario', async () => {
    const html = await renderErpPage({ username: '<img src=x>', tenant_id: 'empresa_base' }).text();
    expect(html).not.toContain('<img src=x>');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(2);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });
});

describe('MIGO', () => {
  function clientePedido({ recibido = 0, disponible = 5 } = {}) {
    const pos = { ebelp: 10, sku: 'SKU-1', texto_breve: 'Caja', cantidad: '10', cantidad_recibida: String(recibido),
      unidad: 'UN', precio_neto: '1000', centro: 'empresa_base-central', pendiente: String(10 - recibido) };
    return crearCliente([
      DDL,
      [/erp_numeradores/, () => [{ ultimo: '5000000000' }]],
      [/FROM erp_pedidos_compra pc/, () => [{ ebeln: '4500000000', proveedor_id: '100000', estado: 'ABIERTO' }]],
      [/FROM erp_pedidos_compra_pos\s+WHERE/, () => [pos]],
      [/SELECT qty_disponible FROM inventario_bodega/, () => [{ qty_disponible: String(disponible) }]],
    ]);
  }

  it('101 suma stock, deja movimiento para la Torre y marca el pedido PARCIAL', async () => {
    const c = clientePedido();
    const r = await TRANSACCIONES.MIGO.post({
      client: c, tenant_id: 'empresa_base', operator: OPERADOR,
      body: { clase_movimiento: '101', pedido: '4500000000', posiciones: [{ ok: true, ebelp: '10', cantidad: '4' }] },
    });
    expect(r.documento).toBe('5000000000');
    const upd = c.consultas.find((q) => /UPDATE inventario_bodega SET qty_disponible/.test(q.sql));
    expect(upd.params[3]).toBe(9);
    const mov = c.consultas.find((q) => /INSERT INTO movimientos_inventario/.test(q.sql));
    expect(mov.params).toEqual(['empresa_base', 'empresa_base-central', 'SKU-1', 'entrada', 4, 'MIGO 101 doc 5000000000', '101', '5000000000']);
    const estado = c.consultas.find((q) => /UPDATE erp_pedidos_compra SET estado/.test(q.sql));
    expect(estado.params[2]).toBe('PARCIAL');
    const msegs = c.consultas.filter((q) => /INSERT INTO erp_documentos_material_pos/.test(q.sql));
    expect(msegs[0].params[10]).toBe(4000); // importe = 4 × 1000
  });

  it('101 con WMS activo reintenta los pedidos de venta en quiebre y lo informa', async () => {
    const base = clientePedido();
    let reservado = false;
    const c = crearCliente([
      [/FROM tenant_settings/, () => [{ wms_enabled: true }]],
      [/array_agg\(DISTINCT sku\)/, () => [{ centro: 'empresa_base-central', skus: ['SKU-1'] }]],
      [/GROUP BY q\.ot_id/, () => [{ ot_id: 'OT-QUIEBRE-1' }]],
      [/SELECT sku, qty FROM orden_lineas_quiebre/, () => [{ sku: 'SKU-1', qty: '3' }]],
      [/FROM ordenes_pendientes\s+WHERE tenant_id = \$1 AND ot_id = \$2 FOR UPDATE/, () => [{ ot_id: 'OT-QUIEBRE-1', estado_operacional: 'QUIEBRE' }]],
      [/SELECT qty_disponible, qty_reservada FROM inventario_bodega/, () => [{ qty_disponible: '9', qty_reservada: '0' }]],
      [/qty_reservada = qty_reservada \+/, () => { reservado = true; return []; }],
    ]);
    const q = c.query.bind(c);
    c.query = async (sql, params) => {
      const r = await q(sql, params);
      return r.rowCount ? r : base.query(sql, params);
    };
    const r = await TRANSACCIONES.MIGO.post({
      client: c, tenant_id: 'empresa_base', operator: OPERADOR, env: { WMS_ENABLED: 'true' },
      body: { clase_movimiento: '101', pedido: '4500000000', posiciones: [{ ok: true, ebelp: 10, cantidad: 4 }] },
    });
    expect(reservado).toBe(true);
    expect(r.liberadas).toEqual(['OT-QUIEBRE-1']);
    expect(r.mensaje).toMatch(/1 pedido\(s\) de venta liberado\(s\) de quiebre: OT-QUIEBRE-1/);
    expect(r.invalidarTorre).toBe(true);
    const agg = c.consultas.find((x) => /array_agg/.test(x.sql));
    expect(agg.params[2]).toEqual(['101', '501', '552', '701']);
  });

  it('101 con WMS apagado no toca los quiebres', async () => {
    const c = clientePedido();
    const r = await TRANSACCIONES.MIGO.post({
      client: c, tenant_id: 'empresa_base', operator: OPERADOR, env: {},
      body: { clase_movimiento: '101', pedido: '4500000000', posiciones: [{ ok: true, ebelp: 10, cantidad: 4 }] },
    });
    expect(r.liberadas).toEqual([]);
    expect(c.consultas.some((x) => /orden_lineas_quiebre|array_agg/.test(x.sql))).toBe(false);
  });

  it('101 rechaza entregar más de lo pendiente', async () => {
    const c = clientePedido({ recibido: 8 });
    await expect(TRANSACCIONES.MIGO.post({
      client: c, tenant_id: 'empresa_base', operator: OPERADOR,
      body: { clase_movimiento: '101', pedido: '4500000000', posiciones: [{ ok: true, ebelp: 10, cantidad: 3 }] },
    })).rejects.toThrow(/excede lo pendiente/);
  });

  it('101 exige al menos una posición OK', async () => {
    await expect(TRANSACCIONES.MIGO.post({
      client: clientePedido(), tenant_id: 'empresa_base', operator: OPERADOR,
      body: { clase_movimiento: '101', pedido: '4500000000', posiciones: [{ ok: false, ebelp: 10, cantidad: 3 }] },
    })).rejects.toThrow(/OK/);
  });

  it('551 no deja stock negativo', async () => {
    const c = crearCliente([
      DDL,
      [/erp_numeradores/, () => [{ ultimo: '5000000001' }]],
      [/FROM productos WHERE/, () => [{ sku: 'SKU-1', unidad: 'UN', precio_estandar: '0' }]],
      [/FROM depots/, () => [{ depot_id: 'empresa_base-central', nombre: 'Central' }]],
      [/SELECT qty_disponible FROM inventario_bodega/, () => [{ qty_disponible: '2' }]],
    ]);
    await expect(TRANSACCIONES.MIGO.post({
      client: c, tenant_id: 'empresa_base', operator: OPERADOR,
      body: { clase_movimiento: '551', posiciones: [{ material: 'SKU-1', centro: 'empresa_base-central', cantidad: 3 }] },
    })).rejects.toThrow(/Déficit de stock/);
  });

  it('no anula dos veces el mismo documento', async () => {
    const c = crearCliente([
      DDL,
      [/FROM erp_documentos_material WHERE/, () => [{ mblnr: '5000000000', anulado_por: '5000000003' }]],
      [/FROM erp_documentos_material_pos d/, () => [{ mblnr: '5000000000', zeile: 1, clase_movimiento: '101' }]],
    ]);
    await expect(TRANSACCIONES.MIGO.post({
      client: c, tenant_id: 'empresa_base', operator: OPERADOR,
      body: { operacion: 'anular', documento: '5000000000' },
    })).rejects.toThrow(/ya fue anulado/);
  });

  it('anular un 101 genera 102, resta stock y devuelve lo recibido al pedido', async () => {
    const c = crearCliente([
      DDL,
      [/erp_numeradores/, () => [{ ultimo: '5000000004' }]],
      [/FROM erp_documentos_material WHERE/, () => [{ mblnr: '5000000000', anulado_por: null }]],
      [/FROM erp_documentos_material_pos d/, () => [{
        mblnr: '5000000000', zeile: 1, clase_movimiento: '101', sku: 'SKU-1', cantidad: '4', unidad: 'UN',
        centro: 'empresa_base-central', ebeln: '4500000000', ebelp: 10, importe: '4000',
      }]],
      [/SELECT qty_disponible FROM inventario_bodega/, () => [{ qty_disponible: '9' }]],
      [/FROM erp_pedidos_compra pc/, () => [{ ebeln: '4500000000' }]],
      [/FROM erp_pedidos_compra_pos\s+WHERE/, () => [{ ebelp: 10, cantidad: '10', cantidad_recibida: '0' }]],
    ]);
    const r = await TRANSACCIONES.MIGO.post({
      client: c, tenant_id: 'empresa_base', operator: OPERADOR,
      body: { operacion: 'anular', documento: '5000000000' },
    });
    expect(r.mensaje).toMatch(/anulado con el documento de material 5000000004/);
    const upd = c.consultas.find((q) => /UPDATE inventario_bodega SET qty_disponible/.test(q.sql));
    expect(upd.params[3]).toBe(5);
    const mov = c.consultas.find((q) => /INSERT INTO movimientos_inventario/.test(q.sql));
    expect(mov.params[3]).toBe('salida');
    expect(mov.params[6]).toBe('102');
    expect(c.consultas.some((q) => /cantidad_recibida = GREATEST\(cantidad_recibida - \$4, 0\)/.test(q.sql))).toBe(true);
    expect(c.consultas.find((q) => /SET anulado_por/.test(q.sql)).params[2]).toBe('5000000004');
  });
});

describe('ME21N', () => {
  it('rechaza proveedor bloqueado', async () => {
    const c = crearCliente([[/FROM erp_proveedores/, () => [{ proveedor_id: '100000', bloqueado: true }]]]);
    await expect(ME21NPost(c, { proveedor: '100000', posiciones: [{ material: 'X', cantidad: 1, centro: 'c' }] }))
      .rejects.toThrow(/bloqueado/);
  });

  it('numera posiciones 10, 20 y usa precio estándar por defecto', async () => {
    const c = crearCliente([
      [/FROM erp_proveedores/, () => [{ proveedor_id: '100000', bloqueado: false, moneda: 'CLP' }]],
      [/FROM productos WHERE/, (p) => [{ sku: p[1], nombre: `Mat ${p[1]}`, unidad: 'UN', activo: true, precio_estandar: '500' }]],
      [/FROM depots/, () => [{ depot_id: 'c1', nombre: 'Central' }]],
      [/erp_numeradores/, () => [{ ultimo: '4500000007' }]],
    ]);
    const r = await ME21NPost(c, {
      proveedor: '100000',
      posiciones: [
        { material: 'A', cantidad: '2', centro: 'c1' },
        { material: '', cantidad: '', centro: 'c1' },
        { material: 'B', cantidad: '1', centro: 'c1', precio_neto: '900' },
      ],
    });
    expect(r.pedido).toBe('4500000007');
    const pos = c.consultas.filter((q) => /INSERT INTO erp_pedidos_compra_pos/.test(q.sql)).map((q) => q.params);
    expect(pos.map((p) => [p[2], p[3], p[7]])).toEqual([[10, 'A', 500], [20, 'B', 900]]);
  });

  it('Verificar no graba nada', async () => {
    const c = crearCliente([
      [/FROM erp_proveedores/, () => [{ proveedor_id: '100000', bloqueado: false, moneda: 'CLP' }]],
      [/FROM productos WHERE/, () => [{ sku: 'A', nombre: 'A', unidad: 'UN', activo: true, precio_estandar: '1' }]],
      [/FROM depots/, () => [{ depot_id: 'c1', nombre: 'Central' }]],
    ]);
    const r = await ME21NPost(c, { proveedor: '100000', solo_verificar: true, posiciones: [{ material: 'A', cantidad: 1, centro: 'c1' }] });
    expect(r.verificado).toBe(true);
    expect(c.consultas.some((q) => /INSERT/.test(q.sql))).toBe(false);
  });

  function ME21NPost(client, body) {
    return TRANSACCIONES.ME21N.post({ client, tenant_id: 'empresa_base', operator: OPERADOR, body });
  }
});

describe('router /api/erp', () => {
  beforeEach(() => {
    globalThis.__erpClient = crearCliente([DDL]);
  });

  function req(method, path, body) {
    return new Request(`https://x.test${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
  }

  it('404 con mensaje SAP si la transacción no existe', async () => {
    const res = await handleErpApi(req('GET', '/api/erp/tx/ZZZZ'), {}, OPERADOR);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ tipo: 'E', mensaje: 'La transacción ZZZZ no existe' });
  });

  it('convierte ErpError en { tipo, mensaje } con su status', async () => {
    const res = await handleErpApi(req('GET', '/api/erp/tx/MM03?material=NOEXISTE'), {}, OPERADOR);
    expect(res.status).toBe(404);
    expect((await res.json()).mensaje).toBe('El material NOEXISTE no existe');
  });

  it('POST exitoso responde tipo S', async () => {
    globalThis.__erpClient = crearCliente([
      DDL,
      [/erp_numeradores/, () => [{ ultimo: '100000' }]],
    ]);
    const res = await handleErpApi(req('POST', '/api/erp/tx/XK01', { nombre: 'Proveedor Uno', rut: '76086428-5' }), {}, OPERADOR);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tipo: 'S', proveedor: '100000' });
  });

  it('rechaza JSON inválido y cuerpos gigantes', async () => {
    expect((await handleErpApi(req('POST', '/api/erp/tx/XK01', '{mal'), {}, OPERADOR)).status).toBe(400);
    const grande = JSON.stringify({ nombre: 'x'.repeat(300 * 1024) });
    expect((await handleErpApi(req('POST', '/api/erp/tx/XK01', grande), {}, OPERADOR)).status).toBe(413);
  });

  it('no filtra detalles de errores de Postgres', async () => {
    globalThis.__erpClient = { query: async (sql) => { if (/^\s*(ALTER|CREATE)/.test(sql)) return { rows: [] }; throw Object.assign(new Error('relation secreta'), { code: '42P01' }); } };
    const res = await handleErpApi(req('GET', '/api/erp/tx/MM60'), {}, OPERADOR);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secreta');
  });

  it('F4 de material busca por texto', async () => {
    globalThis.__erpClient = crearCliente([DDL, [/FROM productos/, () => [{ valor: 'SKU-1', texto: 'Caja' }]]]);
    const res = await handleErpApi(req('GET', '/api/erp/f4/material?q=caj'), {}, OPERADOR);
    expect(await res.json()).toEqual({ valores: [{ valor: 'SKU-1', texto: 'Caja' }] });
    expect(globalThis.__erpClient.consultas.at(-1).params).toEqual(['empresa_base', 'caj', '%caj%']);
  });

  it('exige tenant en la sesión', async () => {
    const res = await handleErpApi(req('GET', '/api/erp/tx/MM60'), {}, { username: 'x' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('ME22N', () => {
  function clienteME22N({ recibido = 0, borrado = false, bloqueado = false } = {}) {
    const pos = { ebelp: 10, sku: 'SKU-1', texto_breve: 'Caja', cantidad: '10.000', cantidad_recibida: String(recibido),
      unidad: 'UN', precio_neto: '1000.00', centro: 'c1', fecha_entrega: null, borrado };
    return crearCliente([
      [/FROM erp_pedidos_compra pc/, () => [{ ebeln: '4500000000', proveedor_id: '100000', estado: 'ABIERTO', texto: null }]],
      [/FROM erp_pedidos_compra_pos\s+WHERE/, () => [pos]],
      [/FROM erp_proveedores/, () => [{ proveedor_id: '100000', bloqueado }]],
      [/FROM productos WHERE/, (p) => [{ sku: p[1], nombre: 'Nuevo', unidad: 'UN', activo: true, precio_estandar: '200' }]],
      [/FROM depots/, () => [{ depot_id: 'c1', nombre: 'Central' }]],
    ]);
  }
  const post = (client, body) => TRANSACCIONES.ME22N.post({ client, tenant_id: 'empresa_base', operator: OPERADOR, body: { pedido: '4500000000', ...body } });
  const cambios = (c) => c.consultas.filter((q) => /INSERT INTO erp_cambios/.test(q.sql)).map((q) => q.params.slice(3, 7));

  it('cambia cantidad y precio y deja documento de modificación', async () => {
    const c = clienteME22N();
    const r = await post(c, { posiciones: [{ ebelp: '10', cantidad: '12', precio_neto: '950', fecha_entrega: '' }] });
    expect(r.mensaje).toMatch(/modificado \(2 cambio\(s\)\)/);
    expect(cambios(c)).toEqual([[10, 'Cantidad', '10', '12'], [10, 'Precio neto', '1000', '950']]);
    expect(c.consultas.some((q) => /UPDATE erp_pedidos_compra SET estado/.test(q.sql))).toBe(true);
  });

  it('sin cambios responde advertencia y no escribe', async () => {
    const c = clienteME22N();
    const r = await post(c, { posiciones: [{ ebelp: 10, cantidad: '10', precio_neto: '1000', fecha_entrega: '' }] });
    expect(r).toMatchObject({ tipo: 'W', mensaje: 'No se han modificado datos' });
    expect(c.consultas.some((q) => /^\s*(UPDATE|INSERT)/.test(q.sql))).toBe(false);
  });

  it('no deja la cantidad bajo lo recibido ni cambia precio con entradas', async () => {
    await expect(post(clienteME22N({ recibido: 6 }), { posiciones: [{ ebelp: 10, cantidad: 5 }] })).rejects.toThrow(/menor que lo ya recibido \(6\)/);
    await expect(post(clienteME22N({ recibido: 6 }), { posiciones: [{ ebelp: 10, precio_neto: 900 }] })).rejects.toThrow(/precio ya no se puede/);
  });

  it('borrar solo sin entradas; restaurar quita el indicador', async () => {
    await expect(post(clienteME22N({ recibido: 1 }), { posiciones: [{ ebelp: 10, borrar: true }] })).rejects.toThrow(/anúlelas en MIGO/);
    const c = clienteME22N();
    await post(c, { posiciones: [{ ebelp: 10, borrar: true, cantidad: '99' }] });
    expect(cambios(c)).toEqual([[10, 'Indicador de borrado', 'no', 'sí']]); // la cantidad de una borrada se ignora
    const c2 = clienteME22N({ borrado: true });
    await post(c2, { posiciones: [{ ebelp: 10, borrar: false }] });
    expect(cambios(c2)).toEqual([[10, 'Indicador de borrado', 'sí', 'no']]);
  });

  it('añade posiciones nuevas siguiendo la numeración', async () => {
    const c = clienteME22N();
    await post(c, { nuevas: [{ material: 'SKU-9', cantidad: '3', centro: 'c1' }, { material: '' }] });
    const ins = c.consultas.find((q) => /INSERT INTO erp_pedidos_compra_pos/.test(q.sql));
    expect(ins.params.slice(2, 4)).toEqual([20, 'SKU-9']);
    expect(ins.params[7]).toBe(200);
    expect(cambios(c)).toEqual([[20, 'Posición creada', '', 'SKU-9 × 3']]);
  });

  it('no añade posiciones si el proveedor está bloqueado', async () => {
    await expect(post(clienteME22N({ bloqueado: true }), { nuevas: [{ material: 'SKU-9', cantidad: 1, centro: 'c1' }] }))
      .rejects.toThrow(/bloqueado/);
  });

  it('estadoPedido ignora posiciones borradas', () => {
    expect(estadoPedido([{ cantidad: 5, cantidad_recibida: 5 }, { cantidad: 5, cantidad_recibida: 0, borrado: true }])).toBe('CERRADO');
    expect(estadoPedido([{ cantidad: 5, cantidad_recibida: 0, borrado: true }])).toBe('CERRADO');
  });

  it('MIGO rechaza entradas a una posición borrada', async () => {
    const c = crearCliente([
      [/erp_numeradores/, () => [{ ultimo: '5000000000' }]],
      [/FROM erp_pedidos_compra pc/, () => [{ ebeln: '4500000000' }]],
      [/FROM erp_pedidos_compra_pos\s+WHERE/, () => [{ ebelp: 10, sku: 'S', cantidad: '5', cantidad_recibida: '0', borrado: true, centro: 'c1' }]],
    ]);
    await expect(TRANSACCIONES.MIGO.post({
      client: c, tenant_id: 'empresa_base', operator: OPERADOR,
      body: { clase_movimiento: '101', pedido: '4500000000', posiciones: [{ ok: true, ebelp: 10, cantidad: 1 }] },
    })).rejects.toThrow(/borrada/);
  });
});

describe('Inventario físico (MI01 / MI04 / MI07)', () => {
  const tx = (code, body, extra = {}) => ({ client: extra.client, tenant_id: 'empresa_base', operator: OPERADOR, body, params: body, ...extra });

  // posiciones: [{ zeile, sku, contado, libre, reservado }]
  function clienteInv({ estado = 'CREADO', posiciones }) {
    const porSku = Object.fromEntries(posiciones.map((p) => [p.sku, p]));
    return crearCliente([
      [/erp_numeradores/, () => [{ ultimo: '5000000009' }]],
      [/FROM erp_inventario_fisico f/, () => [{ iblnr: '100000000', centro: 'c1', estado, mblnr: null }]],
      [/FROM erp_inventario_fisico_pos x/, () => posiciones.map((p) => ({
        zeile: p.zeile, sku: p.sku, texto_breve: p.sku, unidad: 'UN', precio_estandar: '100',
        cantidad_contada: p.contado == null ? null : String(p.contado), libre: String(p.libre), reservado: String(p.reservado || 0),
      }))],
      [/SELECT qty_disponible, qty_reservada FROM inventario_bodega/, (prm) => [{ qty_disponible: String(porSku[prm[2]].libre), qty_reservada: String(porSku[prm[2]].reservado || 0) }]],
      [/SELECT qty_disponible FROM inventario_bodega/, (prm) => [{ qty_disponible: String(porSku[prm[2]].libre) }]],
    ]);
  }

  it('MI01 no deja un material en dos inventarios abiertos del mismo centro', async () => {
    const c = crearCliente([
      [/FROM depots/, () => [{ depot_id: 'c1' }]],
      [/SELECT 1 FROM inventario_bodega/, () => [{ '?column?': 1 }]],
      [/JOIN erp_inventario_fisico f/, () => [{ sku: 'A', iblnr: '100000003' }]],
    ]);
    await expect(TRANSACCIONES.MI01.post(tx('MI01', { centro: 'c1', materiales: [{ material: 'A' }] }, { client: c })))
      .rejects.toThrow(/ya está en el documento de inventario abierto 100000003/);
  });

  it('MI01 crea el documento con posiciones 1..n (sin repetir materiales)', async () => {
    const c = crearCliente([
      [/FROM depots/, () => [{ depot_id: 'c1' }]],
      [/SELECT 1 FROM inventario_bodega/, () => [{ x: 1 }]],
      [/erp_numeradores/, () => [{ ultimo: '100000000' }]],
    ]);
    const r = await TRANSACCIONES.MI01.post(tx('MI01', { centro: 'c1', materiales: [{ material: 'A' }, { material: 'B' }, { material: 'A' }] }, { client: c }));
    expect(r.documento).toBe('100000000');
    const pos = c.consultas.filter((q) => /INSERT INTO erp_inventario_fisico_pos/.test(q.sql)).map((q) => q.params.slice(2));
    expect(pos).toEqual([[1, 'A'], [2, 'B']]);
  });

  it('MI04 es a ciegas: no devuelve el stock del sistema', async () => {
    const c = clienteInv({ posiciones: [{ zeile: 1, sku: 'A', contado: null, libre: 7 }] });
    const d = await TRANSACCIONES.MI04.get(tx('MI04', { documento: '100000000' }, { client: c }));
    expect(JSON.stringify(d)).not.toMatch(/libro|libre|diferencia|reservado/);
  });

  it('MI04 acepta conteo cero, ignora vacíos y marca CONTADO al completar', async () => {
    const c = clienteInv({ posiciones: [{ zeile: 1, sku: 'A', contado: null, libre: 7 }, { zeile: 2, sku: 'B', contado: 3, libre: 3 }] });
    const r = await TRANSACCIONES.MI04.post(tx('MI04', { documento: '100000000', conteos: [{ zeile: 1, cantidad: '0' }, { zeile: 2, cantidad: '' }] }, { client: c }));
    expect(r.mensaje).toMatch(/1 posición\(es\).*conteo completo/);
    const upd = c.consultas.find((q) => /UPDATE erp_inventario_fisico_pos/.test(q.sql));
    expect(upd.params.slice(2, 4)).toEqual([1, 0]);
    expect(upd.params[5]).toBe(7); // snapshot del libro al contar
    expect(c.consultas.find((q) => /UPDATE erp_inventario_fisico SET estado/.test(q.sql)).params[2]).toBe('CONTADO');
  });

  it('MI07 exige que todo esté contado', async () => {
    const c = clienteInv({ posiciones: [{ zeile: 1, sku: 'A', contado: 5, libre: 5 }, { zeile: 2, sku: 'B', contado: null, libre: 1 }] });
    await expect(TRANSACCIONES.MI07.post(tx('MI07', { documento: '100000000' }, { client: c }))).rejects.toThrow(/Faltan recuentos en las posiciones 2/);
  });

  it('MI07 contabiliza sobrante 701 y faltante 702 contra libre + reservado', async () => {
    const c = clienteInv({ posiciones: [
      { zeile: 1, sku: 'A', contado: 12, libre: 8, reservado: 2 },  // libro 10 → +2
      { zeile: 2, sku: 'B', contado: 4, libre: 5, reservado: 0 },   // libro 5 → −1
      { zeile: 3, sku: 'C', contado: 6, libre: 6, reservado: 0 },   // sin diferencia
    ] });
    const r = await TRANSACCIONES.MI07.post(tx('MI07', { documento: '100000000' }, { client: c, env: {} }));
    expect(r.mblnr).toBe('5000000009');
    expect(r.mensaje).toMatch(/1 sobrante\(s\) \(701\), 1 faltante\(s\) \(702\), valor neto 100 CLP/);
    const movs = c.consultas.filter((q) => /INSERT INTO movimientos_inventario/.test(q.sql)).map((q) => [q.params[2], q.params[3], q.params[4], q.params[6]]);
    expect(movs).toEqual([['A', 'entrada', 2, '701'], ['B', 'salida', 1, '702']]);
    const difs = c.consultas.filter((q) => /SET qty_libro = \$4, diferencia = \$5/.test(q.sql)).map((q) => q.params.slice(3));
    expect(difs).toEqual([[10, 2], [5, -1], [6, 0]]);
  });

  it('MI07 no contabiliza un faltante que se come stock reservado por la Torre', async () => {
    const c = clienteInv({ posiciones: [{ zeile: 1, sku: 'A', contado: 1, libre: 2, reservado: 5 }] }); // libro 7 → −6, libre 2
    await expect(TRANSACCIONES.MI07.post(tx('MI07', { documento: '100000000' }, { client: c, env: {} })))
      .rejects.toThrow(/solo hay 2 libres; 5 están reservados por la Torre/);
  });

  it('MI07 sin diferencias no crea documento de material', async () => {
    const c = clienteInv({ posiciones: [{ zeile: 1, sku: 'A', contado: 3, libre: 3 }] });
    const r = await TRANSACCIONES.MI07.post(tx('MI07', { documento: '100000000' }, { client: c, env: {} }));
    expect(r.mblnr).toBeNull();
    expect(r.mensaje).toMatch(/sin diferencias/);
    expect(c.consultas.some((q) => /erp_documentos_material/.test(q.sql))).toBe(false);
  });

  it('no se puede contar ni contabilizar un documento ya contabilizado', async () => {
    const c = clienteInv({ estado: 'CONTABILIZADO', posiciones: [{ zeile: 1, sku: 'A', contado: 3, libre: 3 }] });
    await expect(TRANSACCIONES.MI04.post(tx('MI04', { documento: '100000000', conteos: [{ zeile: 1, cantidad: 1 }] }, { client: c }))).rejects.toThrow(/ya está contabilizado/);
    await expect(TRANSACCIONES.MI07.post(tx('MI07', { documento: '100000000' }, { client: c }))).rejects.toThrow(/ya está contabilizado/);
  });
});
