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
    for (const code of ['MM01', 'MM02', 'MM03', 'MM60', 'XK01', 'XK02', 'XK03', 'MKVZ', 'ME21N', 'ME23N', 'ME2N', 'MIGO', 'MMBE', 'MB51']) {
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
