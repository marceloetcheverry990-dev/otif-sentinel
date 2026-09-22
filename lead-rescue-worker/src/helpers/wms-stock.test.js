import { describe, expect, it, vi } from 'vitest';
import {
  isWmsEnabled,
  tryReserveQty,
  applyAjusteQty,
  consumeReservaQty,
  WMS_ESTADOS,
  reservarOt,
  reintentarQuiebres,
} from './wms-stock.js';

function makeMockClient({ estado = 'PENDIENTE_RUTEO', qtyDisponible = 5, qtyReservada = 0 } = {}) {
  const calls = { update: [], insertLinea: [], insertMovimiento: [] };
  const query = vi.fn(async (sql, params) => {
    const s = String(sql);
    if (s.includes('FROM ordenes_pendientes') && s.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [{ ot_id: params[1], estado_operacional: estado }] };
    }
    if (s.includes('FROM inventario_bodega') && s.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [{ qty_disponible: qtyDisponible, qty_reservada: qtyReservada }] };
    }
    if (s.includes('UPDATE inventario_bodega')) {
      calls.update.push({ sku: params[2], qty: params[3] });
      return { rowCount: 1 };
    }
    if (s.includes('INSERT INTO orden_lineas')) {
      calls.insertLinea.push({ sku: params[2], qty: params[3] });
      return { rowCount: 1 };
    }
    if (s.includes('INSERT INTO movimientos_inventario')) {
      calls.insertMovimiento.push({ sku: params[2], qty: params[4] });
      return { rowCount: 1 };
    }
    if (s.includes('UPDATE ordenes_pendientes')) {
      return { rowCount: 1 };
    }
    return { rowCount: 0, rows: [] };
  });
  return { client: { query }, calls };
}

describe('wms-stock rules', () => {
  it('isWmsEnabled requires env + tenant opt-in', () => {
    expect(isWmsEnabled({})).toBe(false);
    expect(isWmsEnabled({ WMS_ENABLED: 'true' })).toBe(false);
    expect(isWmsEnabled({ WMS_ENABLED: 'true' }, { wms_enabled: false })).toBe(false);
    expect(isWmsEnabled({ WMS_ENABLED: 'true' }, { wms_enabled: true })).toBe(true);
    expect(isWmsEnabled({ WMS_ENABLED: 'false' }, { wms_enabled: true })).toBe(false);
  });

  it('reserva baja disponible y sube reservada', () => {
    const r = tryReserveQty(10, 2, 3);
    expect(r.ok).toBe(true);
    expect(r.qty_disponible).toBe(7);
    expect(r.qty_reservada).toBe(5);
  });

  it('quiebre si no alcanza', () => {
    const r = tryReserveQty(2, 0, 5);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('stock_insuficiente');
  });

  it('ajuste no deja stock negativo', () => {
    expect(applyAjusteQty(4, -5).ok).toBe(false);
    expect(applyAjusteQty(4, -2).qty_disponible).toBe(2);
  });

  it('packing consume reserva', () => {
    const r = consumeReservaQty(5, 5);
    expect(r.ok).toBe(true);
    expect(r.qty_reservada).toBe(0);
  });

  it('LISTA mapea a PENDIENTE_RUTEO', () => {
    expect(WMS_ESTADOS.LISTA).toBe('PENDIENTE_RUTEO');
  });
});

describe('reservarOt — SKU repetido en la misma reserva no debe descontar dos veces', () => {
  it('mergea qty por SKU: dos líneas del mismo SKU que juntas exceden el stock dan quiebre (antes cada una pasaba sola)', async () => {
    const { client, calls } = makeMockClient({ qtyDisponible: 5 });
    const r = await reservarOt(client, {
      tenant_id: 't1',
      ot_id: 'OT-1',
      depot_id: 'D1',
      lineas: [
        { sku: 'SKU-A', qty: 3 },
        { sku: 'SKU-A', qty: 3 }, // suma 6 > 5 disponible
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('quiebre');
    // No debe haber llegado a descontar stock — falló en la validación.
    expect(calls.update).toHaveLength(0);
  });

  it('mergea qty por SKU: dos líneas del mismo SKU que juntas caben se reservan como UNA sola línea sumada', async () => {
    const { client, calls } = makeMockClient({ qtyDisponible: 5 });
    const r = await reservarOt(client, {
      tenant_id: 't1',
      ot_id: 'OT-1',
      depot_id: 'D1',
      lineas: [
        { sku: 'SKU-A', qty: 2 },
        { sku: 'SKU-A', qty: 2 }, // suma 4 <= 5 disponible
      ],
    });
    expect(r.ok).toBe(true);
    // Un solo UPDATE de inventario por SKU, con la qty ya sumada — no dos
    // descuentos de 2 (que hubiera dejado el stock en 1 en vez de en 3... o
    // peor, negativo si la suma real hubiera superado qty_disponible).
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toEqual({ sku: 'SKU-A', qty: 4 });
    expect(calls.insertLinea).toHaveLength(1);
    expect(calls.insertLinea[0]).toEqual({ sku: 'SKU-A', qty: 4 });
  });
});

describe('quiebre guarda sus líneas para reintentar cuando llega stock', () => {
  it('reservarOt en quiebre persiste las líneas (mergeadas) en orden_lineas_quiebre', async () => {
    const { client } = makeMockClient({ qtyDisponible: 1 });
    const r = await reservarOt(client, {
      tenant_id: 't1', ot_id: 'OT-9', depot_id: 'D1',
      lineas: [{ sku: 'SKU-A', qty: 2 }, { sku: 'SKU-A', qty: 1 }],
    });
    expect(r.code).toBe('quiebre');
    const sqls = client.query.mock.calls.map(([s, p]) => [String(s), p]);
    expect(sqls.some(([s]) => s.includes('DELETE FROM orden_lineas_quiebre'))).toBe(true);
    const ins = sqls.filter(([s]) => s.includes('INSERT INTO orden_lineas_quiebre'));
    expect(ins.map(([, p]) => p)).toEqual([['t1', 'OT-9', 'SKU-A', 3, 'D1']]);
  });

  it('reserva exitosa limpia las líneas de quiebre de esa OT', async () => {
    const { client } = makeMockClient({ estado: 'QUIEBRE', qtyDisponible: 10 });
    const r = await reservarOt(client, { tenant_id: 't1', ot_id: 'OT-9', depot_id: 'D1', lineas: [{ sku: 'SKU-A', qty: 3 }] });
    expect(r.ok).toBe(true);
    const del = client.query.mock.calls.find(([s]) => String(s).includes('DELETE FROM orden_lineas_quiebre'));
    expect(del[1]).toEqual(['t1', 'OT-9']);
  });

  it('reintentarQuiebres libera en orden FIFO y aísla cada OT con SAVEPOINT', async () => {
    const stock = { 'SKU-A': 4 };
    const lineasPorOt = { 'OT-1': [{ sku: 'SKU-A', qty: 3 }], 'OT-2': [{ sku: 'SKU-A', qty: 3 }] };
    const query = vi.fn(async (sql, p) => {
      const s = String(sql);
      if (s.includes('GROUP BY q.ot_id')) return { rowCount: 2, rows: [{ ot_id: 'OT-1' }, { ot_id: 'OT-2' }] };
      if (s.includes('SELECT sku, qty FROM orden_lineas_quiebre')) return { rowCount: 1, rows: lineasPorOt[p[1]] };
      if (s.includes('FROM ordenes_pendientes') && s.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ ot_id: p[1], estado_operacional: 'QUIEBRE' }] };
      if (s.includes('FROM inventario_bodega') && s.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ qty_disponible: stock[p[2]], qty_reservada: 0 }] };
      if (s.includes('UPDATE inventario_bodega')) { stock[p[2]] -= p[3]; return { rowCount: 1 }; }
      return { rowCount: 0, rows: [] };
    });
    const r = await reintentarQuiebres({ query }, { tenant_id: 't1', depot_id: 'D1', skus: ['SKU-A', 'SKU-A', ''] });
    expect(r).toEqual({ liberadas: ['OT-1'], siguen: 1 });
    expect(stock['SKU-A']).toBe(1);
    const sp = query.mock.calls.map(([s]) => String(s)).filter((s) => s.includes('SAVEPOINT wms_reintento'));
    expect(sp).toEqual(['SAVEPOINT wms_reintento', 'RELEASE SAVEPOINT wms_reintento', 'SAVEPOINT wms_reintento', 'RELEASE SAVEPOINT wms_reintento']);
    const cand = query.mock.calls.find(([s]) => String(s).includes('GROUP BY q.ot_id'));
    expect(cand[1][2]).toEqual(['SKU-A']);
  });

  it('reintentarQuiebres sin SKUs no consulta nada', async () => {
    const query = vi.fn();
    expect(await reintentarQuiebres({ query }, { tenant_id: 't1', depot_id: 'D1', skus: [] })).toEqual({ liberadas: [], siguen: 0 });
    expect(query).not.toHaveBeenCalled();
  });
});
