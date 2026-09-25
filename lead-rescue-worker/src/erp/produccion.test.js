// Módulo PP (producción): cálculos puros + ciclo completo contra un Postgres real
// en memoria (PGlite), sin tocar ninguna base compartida.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import {
  necesidadComponente, explotarLista, necesidadPorMaterial, repartoConsumo, repartoDevolucion,
  cantidadesBackflush, estadoTrasEntrega, exigirMovimientos,
} from './produccion.js';
import { ensureErpSchema, __resetErpSchemaCache } from './schema.js';
import { TRANSACCIONES, validarRegistro } from './registry.js';

describe('producción: cálculos', () => {
  it('necesidad = receta × cantidad / base × (1 + merma)', () => {
    expect(necesidadComponente({ cantidadComponente: 5, cantidadBase: 100, cantidadOrden: 300, mermaPct: 2 })).toBe(15.3);
    expect(necesidadComponente({ cantidadComponente: 1, cantidadBase: 1, cantidadOrden: 7 })).toBe(7);
    // Nunca 0: una receta con el componente siempre pide algo.
    expect(necesidadComponente({ cantidadComponente: 1, cantidadBase: 1000000, cantidadOrden: 1 })).toBe(0.001);
  });

  it('explota la receta y suma por material aunque el insumo esté en dos posiciones', () => {
    const comps = explotarLista({ cantidad_base: 10 }, [
      { posicion: 10, componente: 'A', cantidad: 2, unidad: 'KG', merma_pct: 0, backflush: true },
      { posicion: 20, componente: 'B', cantidad: 1, unidad: 'UN', merma_pct: 10, backflush: false },
      { posicion: 30, componente: 'A', cantidad: 1, unidad: 'KG', merma_pct: 0, backflush: true },
    ], 20);
    expect(comps.map((c) => [c.posicion, c.sku, c.cantidad_necesaria, c.backflush])).toEqual([
      [10, 'A', 4, true], [20, 'B', 2.2, false], [30, 'A', 2, true],
    ]);
    expect([...necesidadPorMaterial(comps, 'cantidad_necesaria')]).toEqual([['A', 6], ['B', 2.2]]);
  });

  it('consumo: primero lo apartado para la orden, el resto de libre', () => {
    expect(repartoConsumo(5, 8)).toEqual({ desdeReserva: 5, desdeLibre: 0 });
    expect(repartoConsumo(5, 3)).toEqual({ desdeReserva: 3, desdeLibre: 2 });
    expect(repartoConsumo(5, 0)).toEqual({ desdeReserva: 0, desdeLibre: 5 });
  });

  it('devolución: vuelve al apartado solo lo que la orden todavía necesita', () => {
    // necesita 10, quedan consumidos 4 después de devolver, apartado 5 → falta apartar 1
    expect(repartoDevolucion({ q: 3, necesaria: 10, retiradaDespues: 4, reservada: 5, ordenAbierta: true })).toEqual({ aReserva: 1, aLibre: 2 });
    expect(repartoDevolucion({ q: 3, necesaria: 10, retiradaDespues: 4, reservada: 0, ordenAbierta: true })).toEqual({ aReserva: 3, aLibre: 0 });
    expect(repartoDevolucion({ q: 3, necesaria: 10, retiradaDespues: 4, reservada: 0, ordenAbierta: false })).toEqual({ aReserva: 0, aLibre: 3 });
  });

  it('descuento automático proporcional a lo fabricado, solo en insumos marcados', () => {
    const comps = [
      { posicion: 10, sku: 'A', cantidad_necesaria: 5.1, backflush: true },
      { posicion: 20, sku: 'B', cantidad_necesaria: 100, backflush: false },
    ];
    expect(cantidadesBackflush(comps, 60, 100).map((x) => [x.comp.sku, x.cantidad])).toEqual([['A', 3.06]]);
  });

  it('estado tras la entrega: PDLV parcial, DLV completa o con entrega final', () => {
    const base = { estado: 'REL', cantidad: 100, entrega_final: false };
    expect(estadoTrasEntrega({ ...base, cantidad_entregada: 0 })).toBe('REL');
    expect(estadoTrasEntrega({ ...base, cantidad_entregada: 60 })).toBe('PDLV');
    expect(estadoTrasEntrega({ ...base, cantidad_entregada: 100 })).toBe('DLV');
    expect(estadoTrasEntrega({ ...base, cantidad_entregada: 60, entrega_final: true })).toBe('DLV');
    expect(estadoTrasEntrega({ ...base, estado: 'TECO', cantidad_entregada: 60 })).toBe('TECO');
  });

  it('solo las órdenes liberadas admiten movimientos', () => {
    expect(() => exigirMovimientos({ aufnr: '1', estado: 'CRTD' })).toThrow(/no está liberada/);
    expect(() => exigirMovimientos({ aufnr: '1', estado: 'TECO' })).toThrow(/cierre técnico/);
    expect(() => exigirMovimientos({ aufnr: '1', estado: 'DLFL' })).toThrow(/marcada para borrar/);
    expect(() => exigirMovimientos({ aufnr: '1', estado: 'PDLV' })).not.toThrow();
  });

  it('las transacciones PP quedan registradas y sus pantallas son válidas', () => {
    expect(validarRegistro()).toEqual([]);
    for (const code of ['CS01', 'CS02', 'CS03', 'CO01', 'CO02', 'CO03', 'COOIS']) {
      expect(TRANSACCIONES[code], code).toBeTruthy();
      expect(() => new Function(`return (${TRANSACCIONES[code].screen})`)(), code).not.toThrow();
    }
  });
});

// ─── Ciclo completo contra Postgres (PGlite) ─────────────────────────────────

const T = 'empresa_base';
const OP = { tenant_id: T, username: 'marcelo', role: 'operator' };
const C = 'CENTRAL';

describe('producción: ciclo completo en base de datos', () => {
  let db;
  let client;

  const tx = async (code, body) => {
    await client.query('BEGIN');
    try {
      const r = await TRANSACCIONES[code].post({ client, tenant_id: T, body, operator: OP, env: {} });
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  };
  const get = (code, params) => TRANSACCIONES[code].get({ client, tenant_id: T, params, operator: OP, env: {} });
  const stock = async (sku) => {
    const r = await client.query(
      `SELECT qty_disponible, qty_reservada_produccion FROM inventario_bodega WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3`,
      [T, C, sku]
    );
    return r.rowCount ? { libre: Number(r.rows[0].qty_disponible), prod: Number(r.rows[0].qty_reservada_produccion) } : { libre: 0, prod: 0 };
  };
  const orden = async (aufnr) => (await get('CO03', { orden: aufnr }));
  const comp = (o, sku) => {
    const c = o.componentes.find((x) => x.sku === sku);
    return { necesaria: Number(c.cantidad_necesaria), apartado: Number(c.cantidad_reservada), consumido: Number(c.cantidad_retirada) };
  };

  beforeAll(async () => {
    db = new PGlite();
    client = {
      async query(sql, params = []) {
        const r = await db.query(sql, params);
        return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
      },
    };
    await client.query(`CREATE TABLE depots (tenant_id VARCHAR(64), depot_id VARCHAR(64), nombre VARCHAR(120),
                          activo BOOLEAN DEFAULT TRUE, is_default BOOLEAN DEFAULT FALSE)`);
    await client.query(`CREATE TABLE ordenes_pendientes (tenant_id VARCHAR(64), ot_id VARCHAR(120),
                          estado_operacional VARCHAR(40), created_at TIMESTAMPTZ DEFAULT NOW())`);
    __resetErpSchemaCache();
    await ensureErpSchema(client);
    await client.query(`INSERT INTO depots VALUES ($1, $2, 'Bodega Central', TRUE, TRUE)`, [T, C]);
    const mats = [
      ['HARINA', 'Harina', 'KG', 'ROH', 1000],
      ['AGUA', 'Agua', 'L', 'ROH', 5],
      ['BOLSA', 'Bolsa', 'UN', 'VERP', 20],
      ['PAN', 'Pan envasado', 'UN', 'FERT', 300],
      ['MASA', 'Masa madre', 'KG', 'HALB', 800],
    ];
    for (const [sku, nombre, unidad, tipo, precio] of mats) {
      await client.query(
        `INSERT INTO productos (tenant_id, sku, nombre, unidad, tipo_material, precio_estandar) VALUES ($1, $2, $3, $4, $5, $6)`,
        [T, sku, nombre, unidad, tipo, precio]
      );
    }
    for (const [sku, q] of [['HARINA', 10], ['AGUA', 20], ['BOLSA', 300]]) {
      await client.query(`INSERT INTO inventario_bodega (tenant_id, depot_id, sku, qty_disponible) VALUES ($1, $2, $3, $4)`, [T, C, sku, q]);
    }
  });

  it('CS01 solo acepta productos fabricados y no deja que un material sea componente de sí mismo', async () => {
    await expect(tx('CS01', { material: 'HARINA', centro: C, cantidad_base: 1, posiciones: [{ componente: 'AGUA', cantidad: 1 }] }))
      .rejects.toThrow(/solo se fabrican/);
    await expect(tx('CS01', { material: 'PAN', centro: C, cantidad_base: 1, posiciones: [{ componente: 'PAN', cantidad: 1 }] }))
      .rejects.toThrow(/no puede ser componente de sí mismo/);
  });

  it('CS01 crea la receta con posiciones 10, 20, 30 y CS03 la costea', async () => {
    const r = await tx('CS01', {
      material: 'PAN', centro: C, cantidad_base: '100',
      posiciones: [
        { componente: 'HARINA', cantidad: '5', merma_pct: '2' },
        { componente: 'AGUA', cantidad: '3' },
        { componente: 'BOLSA', cantidad: '100', backflush: false },
      ],
    });
    expect(r.mensaje).toMatch(/3 componente/);
    const d = await get('CS03', { material: 'PAN', centro: C });
    expect(d.posiciones.map((p) => [p.posicion, p.componente, p.backflush])).toEqual([
      [10, 'HARINA', true], [20, 'AGUA', true], [30, 'BOLSA', false],
    ]);
    // 5 × 1,02 × 1000 + 3 × 5 + 100 × 20 = 7115 por 100 panes
    expect(d.costo_total).toBe(7115);
    expect(d.costo_unitario).toBe(71.15);
    await expect(tx('CS01', { material: 'PAN', centro: C, cantidad_base: 1, posiciones: [{ componente: 'AGUA', cantidad: 1 }] }))
      .rejects.toThrow(/Ya existe una lista de materiales/);
  });

  it('CS02 detecta recursividad entre recetas y registra los cambios', async () => {
    await tx('CS01', { material: 'MASA', centro: C, cantidad_base: 1, posiciones: [{ componente: 'PAN', cantidad: 1 }] });
    const lista = await get('CS02', { material: 'PAN', centro: C });
    const filas = lista.posiciones.map((p) => ({ posicion: p.posicion, componente: p.componente, cantidad: Number(p.cantidad), merma_pct: Number(p.merma_pct), backflush: p.backflush }));
    await expect(tx('CS02', { material: 'PAN', centro: C, cantidad_base: 100, posiciones: [...filas, { componente: 'MASA', cantidad: 1 }] }))
      .rejects.toThrow(/Recursividad/);
    const sinCambios = await tx('CS02', { material: 'PAN', centro: C, cantidad_base: 100, posiciones: filas });
    expect(sinCambios.tipo).toBe('W');
    filas[1].cantidad = 3; // igual que antes: sin cambio
    const r = await tx('CS02', { material: 'PAN', centro: C, cantidad_base: 100, texto: 'Receta base', posiciones: filas });
    expect(r.mensaje).toMatch(/1 cambio/);
    const d = await get('CS03', { material: 'PAN', centro: C });
    expect(d.cambios.map((c) => c.campo)).toEqual(['Texto']);
  });

  it('CO01 "Verificar" avisa los insumos que faltan sin grabar', async () => {
    const r = await tx('CO01', { material: 'PAN', centro: C, cantidad: '300', solo_verificar: true });
    expect(r.tipo).toBe('W');
    expect(r.mensaje).toMatch(/HARINA/);
    const harina = r.componentes.find((c) => c.sku === 'HARINA');
    expect([harina.cantidad_necesaria, harina.libre, harina.falta]).toEqual([15.3, 10, 5.3]);
    expect((await get('COOIS', { estado: '' })).ordenes).toHaveLength(0);
  });

  it('CO01 crea la orden abierta (CRTD) sin tocar el stock, y MIGO no la acepta sin liberar', async () => {
    const r = await tx('CO01', { material: 'PAN', centro: C, cantidad: '100' });
    expect(r.orden).toBe('1000000');
    const o = await orden('1000000');
    expect(o.cabecera.estado).toBe('CRTD');
    expect(comp(o, 'HARINA').necesaria).toBe(5.1);
    expect(comp(o, 'BOLSA').necesaria).toBe(100);
    expect(await stock('HARINA')).toEqual({ libre: 10, prod: 0 });
    await expect(tx('MIGO', { clase_movimiento: '261', orden: '1000000', posiciones: [{ ok: true, rspos: 30, cantidad: 1 }] }))
      .rejects.toThrow(/no está liberada/);
  });

  it('CO02 Liberar aparta los insumos: la Torre ya no los ve como libres', async () => {
    const r = await tx('CO02', { orden: '1000000', accion: 'liberar' });
    expect(r.mensaje).toMatch(/liberada/);
    expect(await stock('HARINA')).toEqual({ libre: 4.9, prod: 5.1 });
    expect(await stock('BOLSA')).toEqual({ libre: 200, prod: 100 });
    expect(await stock('AGUA')).toEqual({ libre: 17, prod: 3 });
    expect((await orden('1000000')).cabecera.estado).toBe('REL');
  });

  it('liberar sin stock suficiente no crea nada y dice qué falta', async () => {
    await expect(tx('CO01', { material: 'PAN', centro: C, cantidad: '100', liberar: true }))
      .rejects.toThrow(/faltan insumos — HARINA \(necesita 5.1, libre 4.9, faltan 0.2\)/);
    expect((await get('COOIS', { estado: '' })).ordenes).toHaveLength(1);
    expect(await stock('HARINA')).toEqual({ libre: 4.9, prod: 5.1 });
  });

  it('MIGO 261 consume la bolsa desde lo apartado', async () => {
    const r = await tx('MIGO', { clase_movimiento: '261', orden: '1000000', posiciones: [{ ok: true, rspos: '30', cantidad: '100' }] });
    expect(r.documento).toMatch(/^5000000/);
    expect(await stock('BOLSA')).toEqual({ libre: 200, prod: 0 });
    expect(comp(await orden('1000000'), 'BOLSA')).toEqual({ necesaria: 100, apartado: 0, consumido: 100 });
  });

  it('MIGO 101 por orden da entrada al pan y descuenta solos la harina y el agua', async () => {
    const r = await tx('MIGO', { clase_movimiento: '101', orden: '1000000', cantidad: '60' });
    expect(r.mensaje).toMatch(/PDLV Entregada parcialmente · 2 insumo\(s\) descontados automáticamente/);
    expect(await stock('PAN')).toEqual({ libre: 60, prod: 0 });
    expect(await stock('HARINA')).toEqual({ libre: 4.9, prod: 2.04 }); // 5,1 × 60/100 = 3,06 desde lo apartado
    expect(await stock('AGUA')).toEqual({ libre: 17, prod: 1.2 });
    const doc = (await get('MIGO', { documento: r.documento })).documento;
    expect(doc.posiciones.map((p) => [p.clase_movimiento, p.sku, Number(p.cantidad)])).toEqual([
      ['101', 'PAN', 60], ['261', 'HARINA', 3.06], ['261', 'AGUA', 1.8],
    ]);
    globalThis.__docEntrada = r.documento;
  });

  it('anular la entrada devuelve el pan y vuelve a apartar los insumos para la orden', async () => {
    const r = await tx('MIGO', { operacion: 'anular', documento: globalThis.__docEntrada });
    expect(r.mensaje).toMatch(/anulado/);
    expect(await stock('PAN')).toEqual({ libre: 0, prod: 0 });
    expect(await stock('HARINA')).toEqual({ libre: 4.9, prod: 5.1 });
    expect(await stock('AGUA')).toEqual({ libre: 17, prod: 3 });
    const o = await orden('1000000');
    expect([o.cabecera.estado, Number(o.cabecera.cantidad_entregada)]).toEqual(['REL', 0]);
    const anulacion = (await get('MIGO', { documento: r.documento })).documento;
    expect(anulacion.posiciones.map((p) => p.clase_movimiento)).toEqual(['102', '262', '262']);
  });

  it('entrada completa: DLV, sin nada apartado, y no admite más de lo pendiente', async () => {
    await tx('MIGO', { clase_movimiento: '101', orden: '1000000', cantidad: '100' });
    const o = await orden('1000000');
    expect(o.cabecera.estado).toBe('DLV');
    expect(await stock('HARINA')).toEqual({ libre: 4.9, prod: 0 });
    expect(await stock('PAN')).toEqual({ libre: 100, prod: 0 });
    await expect(tx('MIGO', { clase_movimiento: '101', orden: '1000000', cantidad: '1' })).rejects.toThrow(/excede lo pendiente/);
    // Costos netos: lo consumido (con la anulación descontada) es exactamente el plan.
    expect(o.costos).toMatchObject({ plan_insumos: 7115, consumido_real: 7115, desviacion: 0, entregado_valorado: 30000 });
  });

  it('consumir de más se permite con aviso y sale de libre', async () => {
    const r = await tx('MIGO', { clase_movimiento: '261', orden: '1000000', posiciones: [{ ok: true, rspos: 10, cantidad: '0,5' }] });
    expect(r.mensaje).toMatch(/se consumió más de lo previsto en HARINA/);
    expect(await stock('HARINA')).toEqual({ libre: 4.4, prod: 0 });
    // … y anularlo lo devuelve a libre (la orden ya no necesita más harina).
    await tx('MIGO', { operacion: 'anular', documento: r.documento });
    expect(await stock('HARINA')).toEqual({ libre: 4.9, prod: 0 });
  });

  it('CO02 cierre técnico: TECO y ya no admite movimientos ni anulaciones', async () => {
    const r = await tx('CO02', { orden: '1000000', accion: 'teco' });
    expect(r.mensaje).toMatch(/cierre técnico/);
    await expect(tx('MIGO', { clase_movimiento: '261', orden: '1000000', posiciones: [{ ok: true, rspos: 10, cantidad: 1 }] }))
      .rejects.toThrow(/cierre técnico/);
    const docs = (await orden('1000000')).documentos;
    // El primer documento es el consumo de bolsas (261): anulable, pero la orden ya está cerrada.
    await expect(tx('MIGO', { operacion: 'anular', documento: docs[0].mblnr })).rejects.toThrow(/cierre técnico/);
  });

  it('TECO de una orden sin usar devuelve todo lo apartado a libre', async () => {
    const r = await tx('CO01', { material: 'PAN', centro: C, cantidad: '50', liberar: true });
    expect(await stock('HARINA')).toEqual({ libre: 2.35, prod: 2.55 });
    await tx('CO02', { orden: r.orden, accion: 'teco' });
    expect(await stock('HARINA')).toEqual({ libre: 4.9, prod: 0 });
    expect(await stock('AGUA')).toEqual({ libre: 17, prod: 0 });
  });

  it('CO02 cambiar la cantidad de una orden liberada vuelve a apartar; si no alcanza, no cambia nada', async () => {
    const { orden: aufnr } = await tx('CO01', { material: 'PAN', centro: C, cantidad: '40', liberar: true });
    expect(await stock('HARINA')).toEqual({ libre: 2.86, prod: 2.04 });
    await tx('CO02', { orden: aufnr, accion: 'modificar', cantidad: '80' });
    expect(await stock('HARINA')).toEqual({ libre: 0.82, prod: 4.08 });
    await expect(tx('CO02', { orden: aufnr, accion: 'modificar', cantidad: '200' })).rejects.toThrow(/faltan insumos/);
    expect(await stock('HARINA')).toEqual({ libre: 0.82, prod: 4.08 });
    const o = await orden(aufnr);
    expect(Number(o.cabecera.cantidad)).toBe(80);
    expect(o.cambios.map((c) => c.campo)).toContain('Cantidad total');
    globalThis.__ordenAbierta = aufnr;
  });

  it('MMBE y MB51 muestran lo apartado para producción y lo que está en fabricación', async () => {
    const harina = (await get('MMBE', { material: 'HARINA' })).stocks[0];
    expect(Number(harina.reservado_produccion)).toBe(4.08);
    expect(Number(harina.stock_total)).toBe(4.9);
    const pan = (await get('MMBE', { material: 'PAN' })).stocks[0];
    expect(Number(pan.en_fabricacion)).toBe(80);
    const movs = (await get('MB51', { orden: '1000000' })).documentos;
    expect(new Set(movs.map((m) => m.clase_movimiento))).toEqual(new Set(['101', '102', '261', '262']));
    expect(movs.every((m) => m.referencia === '1000000')).toBe(true);
  });

  it('el inventario físico cuenta lo apartado para producción como stock en bodega', async () => {
    const { documento } = await tx('MI01', { centro: C, materiales: [{ material: 'HARINA' }] });
    await tx('MI04', { documento, conteos: [{ zeile: 1, cantidad: '4,9' }] });
    const r = await tx('MI07', { documento });
    expect(r.mensaje).toMatch(/sin diferencias/);
    // Un faltante que se comería lo apartado para la orden no se contabiliza.
    const otro = await tx('MI01', { centro: C, materiales: [{ material: 'HARINA' }] });
    await tx('MI04', { documento: otro.documento, conteos: [{ zeile: 1, cantidad: '1' }] });
    await expect(tx('MI07', { documento: otro.documento })).rejects.toThrow(/órdenes de producción liberadas/);
  });

  it('solo se borra una orden abierta sin liberar', async () => {
    await expect(tx('CO02', { orden: globalThis.__ordenAbierta, accion: 'borrar' })).rejects.toThrow(/Solo se puede borrar una orden abierta/);
    const { orden: aufnr } = await tx('CO01', { material: 'PAN', centro: C, cantidad: '10' });
    await tx('CO02', { orden: aufnr, accion: 'borrar' });
    expect((await orden(aufnr)).cabecera.estado).toBe('DLFL');
    const abiertas = (await get('COOIS', { estado: 'ABIERTAS' })).ordenes.map((o) => o.aufnr);
    expect(abiertas).toEqual([globalThis.__ordenAbierta]);
  });
});
