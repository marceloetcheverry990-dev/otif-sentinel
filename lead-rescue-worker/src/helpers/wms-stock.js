/**
 * OTIF Bodega (WMS-lite): stock disponible + reservada, movimientos, cola.
 * Packing completo → PENDIENTE_RUTEO (el TMS no cambia).
 */

export const WMS_ESTADOS = Object.freeze({
  PENDIENTE_PICKING: 'PENDIENTE_PICKING',
  PICKING: 'PICKING',
  PACKING: 'PACKING',
  QUIEBRE: 'QUIEBRE',
  LISTA: 'PENDIENTE_RUTEO',
});

export const WMS_COLA_ESTADOS = [
  WMS_ESTADOS.PENDIENTE_PICKING,
  WMS_ESTADOS.PICKING,
  WMS_ESTADOS.PACKING,
  WMS_ESTADOS.QUIEBRE,
];

export function isWmsEnabled(env, settings = null) {
  const envOn = ['true', '1', 'yes'].includes(String(env?.WMS_ENABLED ?? 'false').toLowerCase());
  if (!envOn) return false;
  // Exige opt-in explícito por tenant (evita activar todos los tenants si settings es null).
  return settings?.wms_enabled === true;
}

/**
 * Igual que isWmsEnabled pero leyendo tenant_settings con una conexión/transacción
 * ya abierta por el caller (no abre una propia). Si la tabla no existe todavía
 * (42P01) devuelve false: sin settings no hay opt-in del tenant.
 * @param {object} client - cliente pg dentro de la conexión/tx del caller
 */
export async function isWmsEnabledForTenant(client, env, tenant_id) {
  if (!['true', '1', 'yes'].includes(String(env?.WMS_ENABLED ?? 'false').toLowerCase())) {
    return false;
  }
  let settings = null;
  try {
    const r = await client.query(
      `SELECT * FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
      [tenant_id]
    );
    settings = r.rows[0] || null;
  } catch (e) {
    if (e.code !== '42P01') console.warn('[TENANT_SETTINGS]', e.message);
  }
  return isWmsEnabled(env, settings);
}

export function toQty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Reserva atómica en memoria (tests). SQL replica la misma regla. */
export function tryReserveQty(disponible, reservada, qty) {
  const d = toQty(disponible);
  const r = toQty(reservada);
  const q = toQty(qty);
  if (q <= 0) return { ok: false, code: 'qty_invalid' };
  if (d < q) return { ok: false, code: 'stock_insuficiente', disponible: d, needed: q };
  return {
    ok: true,
    qty_disponible: round3(d - q),
    qty_reservada: round3(r + q),
  };
}

export function applyAjusteQty(disponible, delta) {
  const next = round3(toQty(disponible) + toQty(delta));
  if (next < 0) return { ok: false, code: 'stock_negativo' };
  return { ok: true, qty_disponible: next };
}

export function consumeReservaQty(reservada, qty) {
  const r = toQty(reservada);
  const q = toQty(qty);
  if (q <= 0) return { ok: false, code: 'qty_invalid' };
  if (r < q) return { ok: false, code: 'reserva_insuficiente', reservada: r, needed: q };
  return { ok: true, qty_reservada: round3(r - q) };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export async function ensureWmsSchema(client) {
  await client.query(`
    ALTER TABLE tenant_settings
      ADD COLUMN IF NOT EXISTS wms_enabled BOOLEAN NOT NULL DEFAULT FALSE
  `).catch(() => {});
  await client.query(`
    CREATE TABLE IF NOT EXISTS productos (
      tenant_id   VARCHAR(64)  NOT NULL,
      sku         VARCHAR(64)  NOT NULL,
      nombre      VARCHAR(256) NOT NULL,
      unidad      VARCHAR(16)  NOT NULL DEFAULT 'unidad',
      activo      BOOLEAN      NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, sku)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS inventario_bodega (
      tenant_id        VARCHAR(64)     NOT NULL,
      depot_id         VARCHAR(64)     NOT NULL,
      sku              VARCHAR(64)     NOT NULL,
      qty_disponible   NUMERIC(14, 3)  NOT NULL DEFAULT 0,
      qty_reservada    NUMERIC(14, 3)  NOT NULL DEFAULT 0,
      qty_minima       NUMERIC(14, 3)  NOT NULL DEFAULT 0,
      ubicacion        VARCHAR(64),
      updated_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, depot_id, sku)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS movimientos_inventario (
      id          BIGSERIAL PRIMARY KEY,
      tenant_id   VARCHAR(64)    NOT NULL,
      depot_id    VARCHAR(64)    NOT NULL,
      sku         VARCHAR(64)    NOT NULL,
      tipo        VARCHAR(24)    NOT NULL,
      qty         NUMERIC(14, 3) NOT NULL,
      ot_id       VARCHAR(120),
      motivo      TEXT,
      created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS orden_lineas (
      tenant_id      VARCHAR(64)    NOT NULL,
      ot_id          VARCHAR(120)   NOT NULL,
      sku            VARCHAR(64)    NOT NULL,
      qty            NUMERIC(14, 3) NOT NULL,
      qty_pickeada   NUMERIC(14, 3) NOT NULL DEFAULT 0,
      depot_id       VARCHAR(64),
      created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, ot_id, sku)
    )
  `);
}

async function insertMovimiento(client, { tenant_id, depot_id, sku, tipo, qty, ot_id = null, motivo = null }) {
  await client.query(
    `INSERT INTO movimientos_inventario (tenant_id, depot_id, sku, tipo, qty, ot_id, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenant_id, depot_id, sku, tipo, qty, ot_id, motivo]
  );
}

export async function upsertProductoYStock(client, {
  tenant_id,
  sku,
  nombre,
  unidad = 'unidad',
  depot_id,
  qty_inicial = 0,
  qty_minima = 0,
  ubicacion = null,
}) {
  const skuN = String(sku || '').trim().slice(0, 64);
  const nombreN = String(nombre || '').trim().slice(0, 256);
  if (!skuN || !nombreN || !depot_id) {
    return { ok: false, code: 'datos_invalidos' };
  }

  await client.query(
    `INSERT INTO productos (tenant_id, sku, nombre, unidad, activo)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (tenant_id, sku) DO UPDATE SET
       nombre = EXCLUDED.nombre,
       unidad = EXCLUDED.unidad,
       activo = TRUE,
       updated_at = NOW()`,
    [tenant_id, skuN, nombreN, String(unidad || 'unidad').slice(0, 16)]
  );

  const inicial = Math.max(0, toQty(qty_inicial));
  const minima = Math.max(0, toQty(qty_minima));
  const inv = await client.query(
    `INSERT INTO inventario_bodega (tenant_id, depot_id, sku, qty_disponible, qty_reservada, qty_minima, ubicacion)
     VALUES ($1, $2, $3, $4, 0, $5, $6)
     ON CONFLICT (tenant_id, depot_id, sku) DO UPDATE SET
       qty_minima = EXCLUDED.qty_minima,
       ubicacion = COALESCE(EXCLUDED.ubicacion, inventario_bodega.ubicacion),
       updated_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [tenant_id, depot_id, skuN, inicial, minima, ubicacion]
  );

  if (inv.rows[0]?.inserted && inicial > 0) {
    await insertMovimiento(client, {
      tenant_id,
      depot_id,
      sku: skuN,
      tipo: 'entrada',
      qty: inicial,
      motivo: 'alta_producto',
    });
  }

  return { ok: true, sku: skuN };
}

export async function ajustarStock(client, { tenant_id, depot_id, sku, delta, motivo = 'ajuste' }) {
  const dlt = toQty(delta);
  if (!depot_id || !sku || dlt === 0) return { ok: false, code: 'datos_invalidos' };

  const row = await client.query(
    `SELECT qty_disponible FROM inventario_bodega
     WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3 FOR UPDATE`,
    [tenant_id, depot_id, sku]
  );
  if (!row.rowCount) return { ok: false, code: 'sku_no_encontrado' };

  const applied = applyAjusteQty(row.rows[0].qty_disponible, dlt);
  if (!applied.ok) return applied;

  await client.query(
    `UPDATE inventario_bodega
     SET qty_disponible = $4, updated_at = NOW()
     WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3`,
    [tenant_id, depot_id, sku, applied.qty_disponible]
  );
  await insertMovimiento(client, {
    tenant_id,
    depot_id,
    sku,
    tipo: dlt > 0 ? 'entrada' : 'ajuste',
    qty: dlt,
    motivo,
  });
  return { ok: true, qty_disponible: applied.qty_disponible };
}

export async function reservarOt(client, { tenant_id, ot_id, depot_id, lineas }) {
  const rawLines = Array.isArray(lineas) ? lineas : [];
  if (!ot_id || !depot_id || rawLines.length === 0) {
    return { ok: false, code: 'datos_invalidos' };
  }

  // Mergear por SKU antes de validar/reservar: si el mismo SKU aparece más
  // de una vez, cada aparición se validaba contra el mismo qty_disponible
  // (sin descontar lo que la otra ya "apartó" en memoria) y el UPDATE de
  // abajo descontaba dos veces — podía dejar qty_disponible negativo.
  const bySku = new Map();
  for (const line of rawLines) {
    const sku = String(line?.sku || '').trim();
    if (!sku) continue;
    bySku.set(sku, (bySku.get(sku) || 0) + toQty(line?.qty));
  }
  const lines = Array.from(bySku, ([sku, qty]) => ({ sku, qty }));
  if (lines.length === 0) {
    return { ok: false, code: 'datos_invalidos' };
  }

  const ot = await client.query(
    `SELECT ot_id, estado_operacional FROM ordenes_pendientes
     WHERE tenant_id = $1 AND ot_id = $2 FOR UPDATE`,
    [tenant_id, ot_id]
  );
  if (!ot.rowCount) return { ok: false, code: 'ot_no_encontrada' };

  const estado = String(ot.rows[0].estado_operacional || '');
  if (estado === WMS_ESTADOS.PENDIENTE_PICKING || estado === WMS_ESTADOS.PICKING || estado === WMS_ESTADOS.PACKING) {
    return { ok: true, already: true, estado };
  }
  const reservable = ['PENDIENTE_RUTEO', 'PENDIENTE', 'PENDIENTE_CARGA', 'ATRASO', WMS_ESTADOS.QUIEBRE];
  if (!reservable.includes(estado)) {
    return { ok: false, code: 'estado_no_reservable', estado };
  }

  for (const line of lines) {
    const sku = String(line.sku || '').trim();
    const qty = toQty(line.qty);
    const inv = await client.query(
      `SELECT qty_disponible, qty_reservada FROM inventario_bodega
       WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3 FOR UPDATE`,
      [tenant_id, depot_id, sku]
    );
    if (!inv.rowCount) {
      await client.query(
        `UPDATE ordenes_pendientes SET estado_operacional = $3
         WHERE tenant_id = $1 AND ot_id = $2`,
        [tenant_id, ot_id, WMS_ESTADOS.QUIEBRE]
      );
      return { ok: false, code: 'quiebre', sku, needed: qty, disponible: 0 };
    }
    const trial = tryReserveQty(inv.rows[0].qty_disponible, inv.rows[0].qty_reservada, qty);
    if (!trial.ok) {
      await client.query(
        `UPDATE ordenes_pendientes SET estado_operacional = $3
         WHERE tenant_id = $1 AND ot_id = $2`,
        [tenant_id, ot_id, WMS_ESTADOS.QUIEBRE]
      );
      return { ok: false, code: 'quiebre', sku, needed: qty, disponible: trial.disponible };
    }
  }

  for (const line of lines) {
    const sku = String(line.sku || '').trim();
    const qty = toQty(line.qty);
    await client.query(
      `UPDATE inventario_bodega
       SET qty_disponible = qty_disponible - $4,
           qty_reservada = qty_reservada + $4,
           updated_at = NOW()
       WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3`,
      [tenant_id, depot_id, sku, qty]
    );
    await client.query(
      `INSERT INTO orden_lineas (tenant_id, ot_id, sku, qty, qty_pickeada, depot_id)
       VALUES ($1, $2, $3, $4, 0, $5)
       ON CONFLICT (tenant_id, ot_id, sku) DO UPDATE SET qty = EXCLUDED.qty, depot_id = EXCLUDED.depot_id`,
      [tenant_id, ot_id, sku, qty, depot_id]
    );
    await insertMovimiento(client, {
      tenant_id, depot_id, sku, tipo: 'reserva', qty, ot_id, motivo: 'reserva_ot',
    });
  }

  await client.query(
    `UPDATE ordenes_pendientes SET estado_operacional = $3
     WHERE tenant_id = $1 AND ot_id = $2`,
    [tenant_id, ot_id, WMS_ESTADOS.PENDIENTE_PICKING]
  );

  return { ok: true, estado: WMS_ESTADOS.PENDIENTE_PICKING };
}

export async function confirmarPicking(client, { tenant_id, ot_id }) {
  const ot = await client.query(
    `SELECT estado_operacional FROM ordenes_pendientes
     WHERE tenant_id = $1 AND ot_id = $2 FOR UPDATE`,
    [tenant_id, ot_id]
  );
  if (!ot.rowCount) return { ok: false, code: 'ot_no_encontrada' };
  const estado = ot.rows[0].estado_operacional;
  if (![WMS_ESTADOS.PENDIENTE_PICKING, WMS_ESTADOS.PICKING].includes(estado)) {
    return { ok: false, code: 'estado_invalido', estado };
  }

  await client.query(
    `UPDATE orden_lineas SET qty_pickeada = qty
     WHERE tenant_id = $1 AND ot_id = $2`,
    [tenant_id, ot_id]
  );
  await client.query(
    `UPDATE ordenes_pendientes SET estado_operacional = $3
     WHERE tenant_id = $1 AND ot_id = $2`,
    [tenant_id, ot_id, WMS_ESTADOS.PACKING]
  );
  return { ok: true, estado: WMS_ESTADOS.PACKING };
}

export async function confirmarPacking(client, { tenant_id, ot_id }) {
  const ot = await client.query(
    `SELECT estado_operacional FROM ordenes_pendientes
     WHERE tenant_id = $1 AND ot_id = $2 FOR UPDATE`,
    [tenant_id, ot_id]
  );
  if (!ot.rowCount) return { ok: false, code: 'ot_no_encontrada' };
  if (ot.rows[0].estado_operacional !== WMS_ESTADOS.PACKING) {
    return { ok: false, code: 'estado_invalido', estado: ot.rows[0].estado_operacional };
  }

  const lines = await client.query(
    `SELECT sku, qty, depot_id FROM orden_lineas WHERE tenant_id = $1 AND ot_id = $2`,
    [tenant_id, ot_id]
  );

  for (const line of lines.rows) {
    const inv = await client.query(
      `SELECT qty_reservada FROM inventario_bodega
       WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3 FOR UPDATE`,
      [tenant_id, line.depot_id, line.sku]
    );
    if (!inv.rowCount) return { ok: false, code: 'sku_no_encontrado', sku: line.sku };
    const consumed = consumeReservaQty(inv.rows[0].qty_reservada, line.qty);
    if (!consumed.ok) return consumed;

    await client.query(
      `UPDATE inventario_bodega
       SET qty_reservada = $4, updated_at = NOW()
       WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3`,
      [tenant_id, line.depot_id, line.sku, consumed.qty_reservada]
    );
    await insertMovimiento(client, {
      tenant_id,
      depot_id: line.depot_id,
      sku: line.sku,
      tipo: 'salida',
      qty: line.qty,
      ot_id,
      motivo: 'packing_confirmado',
    });
  }

  await client.query(
    `UPDATE ordenes_pendientes SET estado_operacional = $3
     WHERE tenant_id = $1 AND ot_id = $2`,
    [tenant_id, ot_id, WMS_ESTADOS.LISTA]
  );
  return { ok: true, estado: WMS_ESTADOS.LISTA };
}

export async function listarStock(client, tenant_id, depot_id = null) {
  const params = [tenant_id];
  let extra = '';
  if (depot_id) {
    extra = ' AND i.depot_id = $2';
    params.push(depot_id);
  }
  const r = await client.query(
    `SELECT i.depot_id, i.sku, p.nombre, p.unidad, i.qty_disponible, i.qty_reservada,
            i.qty_minima, i.ubicacion,
            (i.qty_disponible < i.qty_minima) AS stock_bajo
     FROM inventario_bodega i
     LEFT JOIN productos p ON p.tenant_id = i.tenant_id AND p.sku = i.sku
     WHERE i.tenant_id = $1${extra}
     ORDER BY stock_bajo DESC, p.nombre NULLS LAST, i.sku`,
    params
  );
  return r.rows;
}

export async function listarCola(client, tenant_id) {
  const r = await client.query(
    `SELECT o.ot_id, o.cliente, o.estado_operacional, o.trip_id, o.created_at,
            COALESCE(json_agg(json_build_object(
              'sku', l.sku, 'qty', l.qty, 'qty_pickeada', l.qty_pickeada, 'depot_id', l.depot_id
            ) ORDER BY l.sku) FILTER (WHERE l.sku IS NOT NULL), '[]') AS lineas
     FROM ordenes_pendientes o
     LEFT JOIN orden_lineas l ON l.tenant_id = o.tenant_id AND l.ot_id = o.ot_id
     WHERE o.tenant_id = $1
       AND o.estado_operacional = ANY($2::text[])
     GROUP BY o.ot_id, o.cliente, o.estado_operacional, o.trip_id, o.created_at
     ORDER BY o.created_at ASC NULLS LAST
     LIMIT 200`,
    [tenant_id, WMS_COLA_ESTADOS]
  );
  return r.rows;
}

export async function listarListasSinTrip(client, tenant_id) {
  const r = await client.query(
    `SELECT ot_id, cliente, estado_operacional, created_at
     FROM ordenes_pendientes
     WHERE tenant_id = $1
       AND estado_operacional = $2
       AND (trip_id IS NULL OR trip_id = '')
     ORDER BY created_at ASC NULLS LAST
     LIMIT 100`,
    [tenant_id, WMS_ESTADOS.LISTA]
  );
  return r.rows;
}
