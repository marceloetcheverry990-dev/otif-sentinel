import { CORS_HEADERS, requireTenantId } from '../config.js';
import { withDb, withDbTransaction } from '../db.js';
import { ensureDefaultDepot, ensureDepotsSchema } from '../helpers/depots.js';
import { invalidateTowerPoll } from '../helpers/tower-poll-cache.js';
import {
  isWmsEnabledForTenant,
  ensureWmsSchema,
  upsertProductoYStock,
  ajustarStock,
  reservarOt,
  confirmarPicking,
  confirmarPacking,
  listarStock,
  listarCola,
  listarListasSinTrip,
} from '../helpers/wms-stock.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const WMS_DISABLED = Symbol('wms_disabled');
const WMS_DISABLED_RESPONSE = { error: 'WMS-lite desactivado', code: 'wms_disabled' };

// El chequeo de wms_enabled reusa la conexión/transacción ya abierta por el
// branch (antes: guardWms abría su propia conexión vía getTenantSettings, y
// cada branch abría otra distinta — dos handshakes por request). La
// implementación vive en wms-stock.js para no duplicarla con la ingesta.
const checkWmsEnabled = isWmsEnabledForTenant;

export async function handleBodega(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const err = requireTenantId(tenant_id);
  if (err) return err;

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');

  try {
    if (request.method === 'GET' && path === '/api/bodega/resumen') {
      const result = await withDb(env, async (client) => {
        if (!(await checkWmsEnabled(client, env, tenant_id))) return WMS_DISABLED;
        await ensureWmsSchema(client);
        await ensureDepotsSchema(client);
        await ensureDefaultDepot(client, tenant_id);
        const stock = await listarStock(client, tenant_id);
        const cola = await listarCola(client, tenant_id);
        const listas = await listarListasSinTrip(client, tenant_id);
        const depotsRes = await client.query(
          `SELECT depot_id, nombre, is_default FROM depots WHERE tenant_id = $1 AND activo = TRUE ORDER BY is_default DESC, nombre`,
          [tenant_id]
        );
        return {
          exito: true,
          stock_bajo: stock.filter((s) => s.stock_bajo),
          stock,
          cola,
          listas_sin_trip: listas,
          quiebres: cola.filter((c) => c.estado_operacional === 'QUIEBRE'),
          depots: depotsRes.rows,
          counts: {
            stock_bajo: stock.filter((s) => s.stock_bajo).length,
            cola: cola.length,
            quiebres: cola.filter((c) => c.estado_operacional === 'QUIEBRE').length,
            listas_sin_trip: listas.length,
          },
        };
      }, { tenantId: tenant_id });
      if (result === WMS_DISABLED) return json(WMS_DISABLED_RESPONSE, 404);
      return json(result);
    }

    if (request.method === 'GET' && path === '/api/bodega/stock') {
      const depot_id = url.searchParams.get('depot_id');
      const result = await withDb(env, async (client) => {
        if (!(await checkWmsEnabled(client, env, tenant_id))) return WMS_DISABLED;
        await ensureWmsSchema(client);
        const stock = await listarStock(client, tenant_id, depot_id || null);
        return { exito: true, stock };
      }, { tenantId: tenant_id });
      if (result === WMS_DISABLED) return json(WMS_DISABLED_RESPONSE, 404);
      return json(result);
    }

    if (request.method === 'POST' && path === '/api/bodega/productos') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
      const result = await withDbTransaction(env, async (client) => {
        if (!(await checkWmsEnabled(client, env, tenant_id))) return WMS_DISABLED;
        await ensureWmsSchema(client);
        await ensureDepotsSchema(client);
        const def = await ensureDefaultDepot(client, tenant_id);
        const fallback = await client.query(
          `SELECT depot_id FROM depots WHERE tenant_id = $1 AND activo = TRUE ORDER BY is_default DESC LIMIT 1`,
          [tenant_id]
        );
        const depot_id = String(body.depot_id || def?.depot_id || fallback.rows[0]?.depot_id || '').trim();
        return upsertProductoYStock(client, {
          tenant_id,
          sku: body.sku,
          nombre: body.nombre,
          unidad: body.unidad,
          depot_id,
          qty_inicial: body.qty_inicial,
          qty_minima: body.qty_minima,
          ubicacion: body.ubicacion || null,
        });
      }, { tenantId: tenant_id });
      if (result === WMS_DISABLED) return json(WMS_DISABLED_RESPONSE, 404);
      if (!result.ok) return json(result, 400);
      return json({ exito: true, ...result });
    }

    if (request.method === 'POST' && path === '/api/bodega/ajuste') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
      const result = await withDbTransaction(env, async (client) => {
        if (!(await checkWmsEnabled(client, env, tenant_id))) return WMS_DISABLED;
        await ensureWmsSchema(client);
        return ajustarStock(client, {
          tenant_id,
          depot_id: body.depot_id,
          sku: body.sku,
          delta: body.delta,
          motivo: body.motivo || 'ajuste_manual',
        });
      }, { tenantId: tenant_id });
      if (result === WMS_DISABLED) return json(WMS_DISABLED_RESPONSE, 404);
      if (!result.ok) return json(result, 400);
      return json({ exito: true, ...result });
    }

    if (request.method === 'POST' && path === '/api/bodega/reservar') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
      const result = await withDbTransaction(env, async (client) => {
        if (!(await checkWmsEnabled(client, env, tenant_id))) return WMS_DISABLED;
        await ensureWmsSchema(client);
        return reservarOt(client, {
          tenant_id,
          ot_id: body.ot_id,
          depot_id: body.depot_id,
          lineas: body.lineas,
        });
      }, { tenantId: tenant_id });
      if (result === WMS_DISABLED) return json(WMS_DISABLED_RESPONSE, 404);
      invalidateTowerPoll(tenant_id);
      if (!result.ok) return json({ exito: false, ...result }, result.code === 'quiebre' ? 409 : 400);
      return json({ exito: true, ...result });
    }

    if (request.method === 'POST' && path === '/api/bodega/picking') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
      const result = await withDbTransaction(env, async (client) => {
        if (!(await checkWmsEnabled(client, env, tenant_id))) return WMS_DISABLED;
        await ensureWmsSchema(client);
        return confirmarPicking(client, { tenant_id, ot_id: body.ot_id });
      }, { tenantId: tenant_id });
      if (result === WMS_DISABLED) return json(WMS_DISABLED_RESPONSE, 404);
      invalidateTowerPoll(tenant_id);
      if (!result.ok) return json(result, 400);
      return json({ exito: true, ...result });
    }

    if (request.method === 'POST' && path === '/api/bodega/packing') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
      const result = await withDbTransaction(env, async (client) => {
        if (!(await checkWmsEnabled(client, env, tenant_id))) return WMS_DISABLED;
        await ensureWmsSchema(client);
        return confirmarPacking(client, { tenant_id, ot_id: body.ot_id });
      }, { tenantId: tenant_id });
      if (result === WMS_DISABLED) return json(WMS_DISABLED_RESPONSE, 404);
      invalidateTowerPoll(tenant_id);
      if (!result.ok) return json(result, 400);
      return json({ exito: true, ...result });
    }

    return json({ error: 'Ruta no encontrada', code: 'not_found' }, 404);
  } catch (e) {
    console.error('[BODEGA]', e.message);
    return json({ error: 'Error interno bodega', code: 'wms_error' }, 500);
  }
}
