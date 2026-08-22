/**
 * Override manual del dispatcher: reordenar paradas y mover OT entre viajes.
 */
import { CORS_HEADERS, jsonResponse, requireTenantId } from '../config.js';
import { withDbTransaction } from '../db.js';
import {
  fitsCapacity,
  normalizeTags,
  tagsConflict,
  unionTags,
} from '../helpers/cargo-constraints.js';
import { ensureGuiaForLateOt } from '../helpers/dte/ensure-guia-late-ot.js';
import { invalidateTowerPoll } from '../helpers/tower-poll-cache.js';
import {
  FROZEN_STATES,
  rebuildSequences,
  splitFrozenOpen,
} from '../helpers/midday-reopt.js';
import { routeFeasibleTw } from '../helpers/vrp-solver.js';

function parseTags(raw) {
  return normalizeTags(raw);
}

async function loadTripStops(client, tenantId, tripId) {
  const attempts = [
    `SELECT ot_id, cliente, volumen, peso_kg, tags_requeridos, estado_operacional,
            stop_sequence, lat, lng, fecha_hora_sla, ventana_inicio, ventana_fin,
            trip_id, chofer_asignado_id, metadata
     FROM ordenes_pendientes
     WHERE tenant_id = $1 AND trip_id = $2
     FOR UPDATE`,
    `SELECT ot_id, cliente, volumen, tags_requeridos, estado_operacional,
            stop_sequence, fecha_hora_sla, trip_id, chofer_asignado_id, metadata
     FROM ordenes_pendientes
     WHERE tenant_id = $1 AND trip_id = $2
     FOR UPDATE`,
  ];
  let rows = null;
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const sp = `sp_load_${i}`;
    try {
      await client.query(`SAVEPOINT ${sp}`);
      const r = await client.query(attempts[i], [tenantId, tripId]);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      rows = r.rows;
      break;
    } catch (e) {
      lastErr = e;
      try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch (_) { /* ignore */ }
      if (e.code !== '42703' && !/column .* does not exist/i.test(e.message || '')) throw e;
    }
  }
  if (!rows) throw lastErr || new Error('loadTripStops failed');

  return rows.map((o) => {
    let meta = o.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    meta = meta || {};
    const latRaw = o.lat != null ? o.lat : meta.lat_destino;
    const lngRaw = o.lng != null ? o.lng : meta.lng_destino;
    return {
      ...o,
      volumen: Number(o.volumen || 1),
      peso_kg: Number(o.peso_kg || meta.peso_kg || 0),
      tags: parseTags(o.tags_requeridos || meta.tags_requeridos),
      lat: latRaw != null ? Number(latRaw) : null,
      lng: lngRaw != null ? Number(lngRaw) : null,
      ventana_inicio: o.ventana_inicio || meta.ventana_inicio || null,
      ventana_fin: o.ventana_fin || meta.ventana_fin || null,
    };
  });
}

async function loadChoferCapacity(client, tenantId, choferId) {
  if (choferId == null) {
    return { capacidad_volumen: 100, capacidad_peso: 99999, tags: [] };
  }
  const attempts = [
    `SELECT capacidad_volumen, capacidad_peso, tags
     FROM choferes
     WHERE tenant_id = $1 AND CAST(chofer_id AS VARCHAR) = CAST($2 AS VARCHAR)
     LIMIT 1`,
    `SELECT capacidad_volumen, tags
     FROM choferes
     WHERE tenant_id = $1 AND CAST(chofer_id AS VARCHAR) = CAST($2 AS VARCHAR)
     LIMIT 1`,
  ];
  let row = {};
  for (let i = 0; i < attempts.length; i++) {
    const sp = `sp_cap_${i}`;
    try {
      await client.query(`SAVEPOINT ${sp}`);
      const r = await client.query(attempts[i], [tenantId, choferId]);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      row = r.rows[0] || {};
      break;
    } catch (e) {
      try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch (_) { /* ignore */ }
      if (e.code !== '42703' && !/column .* does not exist/i.test(e.message || '')) throw e;
    }
  }
  return {
    capacidad_volumen: Number(row.capacidad_volumen) || 100,
    capacidad_peso: Number(row.capacidad_peso) || 99999,
    tags: parseTags(row.tags),
  };
}

async function persistSequences(client, tenantId, tripId, sequenced, choferId = null) {
  for (let i = 0; i < sequenced.length; i++) {
    const s = sequenced[i];
    await client.query(
      `UPDATE ordenes_pendientes
       SET stop_sequence = $1,
           trip_id = $2,
           chofer_asignado_id = COALESCE($3, chofer_asignado_id),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('routing', COALESCE(metadata->'routing','{}'::jsonb) || jsonb_build_object('stop_sequence', $1::int))
       WHERE tenant_id = $4 AND ot_id = $5`,
      [i + 1, tripId, choferId, tenantId, s.ot_id]
    );
  }
}

/**
 * POST /api/trips/reorder
 * body: { trip_id, ot_ids: string[] } — nuevo orden de paradas ABIERTAS
 */
export async function reorderTripStops(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'JSON inválido' }, 400);
  }
  const trip_id = body.trip_id;
  const ot_ids = Array.isArray(body.ot_ids) ? body.ot_ids.map(String) : [];
  if (!trip_id || !ot_ids.length) {
    return jsonResponse({ error: 'trip_id y ot_ids[] requeridos' }, 400);
  }

  try {
    return await withDbTransaction(env, async (client) => {
      const stops = await loadTripStops(client, tenant_id, trip_id);
      if (!stops.length) return jsonResponse({ error: 'Viaje vacío o inexistente' }, 404);

      const { frozen, open } = splitFrozenOpen(stops);
      const openById = new Map(open.map((s) => [String(s.ot_id), s]));
      if (ot_ids.length !== open.length) {
        return jsonResponse({
          error: 'ot_ids debe listar exactamente las paradas abiertas',
          code: 'open_mismatch',
          open_count: open.length,
        }, 400);
      }
      const newOpen = [];
      for (const id of ot_ids) {
        const s = openById.get(String(id));
        if (!s) return jsonResponse({ error: `OT no abierta en viaje: ${id}` }, 400);
        newOpen.push(s);
      }

      const choferId = open[0]?.chofer_asignado_id || frozen[0]?.chofer_asignado_id;
      const cap = await loadChoferCapacity(client, tenant_id, choferId);
      const all = [...frozen, ...newOpen];
      if (tagsConflict([], unionTags(all))) {
        /* unionTags already mixed */
      }
      const hazFood = (() => {
        const t = unionTags(all);
        const haz = t.some((x) => ['HAZMAT', 'ADR', 'PELGEROSO'].includes(x));
        const food = t.some((x) => ['FOOD', 'ALIMENTO', 'ALIMENTOS', 'FRIO_ALIMENTO'].includes(x));
        return haz && food;
      })();
      if (hazFood) return jsonResponse({ error: 'Segregación HAZMAT/FOOD violada', code: 'segregation' }, 400);

      const fit = fitsCapacity(all, cap.capacidad_volumen, cap.capacidad_peso);
      if (!fit.ok) return jsonResponse({ error: 'Capacidad excedida', code: fit.reason }, 400);

      const geoOpen = newOpen.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
      if (geoOpen.length === newOpen.length) {
        const tw = routeFeasibleTw(geoOpen, Date.now(), 35);
        if (!tw.ok) return jsonResponse({ error: 'Orden viola ventanas de tiempo', code: 'tw_infeasible' }, 400);
      }

      const sequenced = rebuildSequences(frozen, newOpen);
      await persistSequences(client, tenant_id, trip_id, sequenced);
      invalidateTowerPoll(tenant_id);
      return jsonResponse({
        exito: true,
        trip_id,
        stop_sequence: sequenced.map((s) => ({ ot_id: s.ot_id, stop_sequence: s.stop_sequence ?? null })),
      });
    }, { tenantId: tenant_id, statementTimeout: 12000 });
  } catch (err) {
    console.error('[TRIP_REORDER]', err.message);
    return jsonResponse({ error: 'Internal Server Error', detalle: err.message }, 500);
  }
}

/**
 * POST /api/trips/move-stop
 * body: { ot_id, to_trip_id, insert_at?: number }
 */
export async function moveTripStop(request, env, operator = null, ctx = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'JSON inválido' }, 400);
  }
  const ot_id = body.ot_id != null ? String(body.ot_id) : null;
  const to_trip_id = body.to_trip_id != null ? String(body.to_trip_id) : null;
  const insert_at = body.insert_at != null ? Number(body.insert_at) : null;
  if (!ot_id || !to_trip_id) {
    return jsonResponse({ error: 'ot_id y to_trip_id requeridos' }, 400);
  }

  try {
    const response = await withDbTransaction(env, async (client) => {
      const loadOtAttempts = [
        `SELECT ot_id, trip_id, estado_operacional, volumen, peso_kg, tags_requeridos,
                lat, lng, fecha_hora_sla, ventana_inicio, ventana_fin, cliente, stop_sequence,
                chofer_asignado_id, metadata
         FROM ordenes_pendientes
         WHERE tenant_id = $1 AND ot_id = $2
         FOR UPDATE`,
        `SELECT ot_id, trip_id, estado_operacional, volumen, tags_requeridos,
                fecha_hora_sla, cliente, stop_sequence, chofer_asignado_id, metadata
         FROM ordenes_pendientes
         WHERE tenant_id = $1 AND ot_id = $2
         FOR UPDATE`,
      ];
      let moving = null;
      let lastOtErr = null;
      for (let i = 0; i < loadOtAttempts.length; i++) {
        const sp = `sp_move_ot_${i}`;
        try {
          await client.query(`SAVEPOINT ${sp}`);
          const srcRes = await client.query(loadOtAttempts[i], [tenant_id, ot_id]);
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          if (!srcRes.rowCount) return jsonResponse({ error: 'OT no encontrada' }, 404);
          moving = srcRes.rows[0];
          break;
        } catch (e) {
          lastOtErr = e;
          try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch (_) { /* ignore */ }
          if (e.code !== '42703' && !/column .* does not exist/i.test(e.message || '')) throw e;
        }
      }
      if (!moving) throw lastOtErr || new Error('OT load failed');

      const from_trip_id = moving.trip_id;
      if (!from_trip_id) return jsonResponse({ error: 'OT sin viaje origen' }, 400);
      if (from_trip_id === to_trip_id) {
        return jsonResponse({ error: 'La OT ya está en ese viaje' }, 400);
      }
      const st = String(moving.estado_operacional || '').toUpperCase();
      if (FROZEN_STATES.has(st) || st === 'ENTREGADO') {
        return jsonResponse({ error: 'No se puede mover una parada congelada/entregada', code: 'frozen' }, 400);
      }

      const sourceStops = await loadTripStops(client, tenant_id, from_trip_id);
      const destStops = await loadTripStops(client, tenant_id, to_trip_id);
      if (!destStops.length) return jsonResponse({ error: 'Viaje destino vacío o inexistente' }, 404);

      let meta = moving.metadata;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
      }
      meta = meta || {};
      const latRaw = moving.lat != null ? moving.lat : meta.lat_destino;
      const lngRaw = moving.lng != null ? moving.lng : meta.lng_destino;
      const movingNorm = {
        ...moving,
        volumen: Number(moving.volumen || 1),
        peso_kg: Number(moving.peso_kg || meta.peso_kg || 0),
        tags: parseTags(moving.tags_requeridos),
        lat: latRaw != null ? Number(latRaw) : null,
        lng: lngRaw != null ? Number(lngRaw) : null,
        ventana_inicio: moving.ventana_inicio || meta.ventana_inicio || null,
        ventana_fin: moving.ventana_fin || meta.ventana_fin || null,
      };

      const srcSplit = splitFrozenOpen(sourceStops.filter((s) => s.ot_id !== ot_id));
      const dstSplit = splitFrozenOpen(destStops);

      const destChofer = destStops[0]?.chofer_asignado_id;
      const cap = await loadChoferCapacity(client, tenant_id, destChofer);
      // Segregación antes que tags de chofer: mensaje más específico al mezclar HAZMAT/FOOD
      if (tagsConflict(unionTags([...dstSplit.frozen, ...dstSplit.open]), movingNorm.tags)) {
        return jsonResponse({ error: 'Segregación HAZMAT/FOOD', code: 'segregation' }, 400);
      }
      const need = movingNorm.tags;
      if (need.length && !need.every((t) => cap.tags.includes(t))) {
        return jsonResponse({ error: 'Chofer destino sin tags requeridos', code: 'tags' }, 400);
      }
      const destAll = [...dstSplit.frozen, ...dstSplit.open, movingNorm];
      const fit = fitsCapacity(destAll, cap.capacidad_volumen, cap.capacidad_peso);
      if (!fit.ok) return jsonResponse({ error: 'Capacidad destino excedida', code: fit.reason }, 400);

      let newOpen = [...dstSplit.open];
      let idx = Number.isFinite(insert_at) ? Math.max(0, Math.min(insert_at, newOpen.length)) : newOpen.length;
      newOpen.splice(idx, 0, movingNorm);

      const geoOpen = newOpen.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
      if (geoOpen.length === newOpen.length) {
        const tw = routeFeasibleTw(geoOpen, Date.now(), 35);
        if (!tw.ok) return jsonResponse({ error: 'Inserción viola ventanas de tiempo', code: 'tw_infeasible' }, 400);
      }

      const destSeq = rebuildSequences(dstSplit.frozen, newOpen);
      const srcSeq = rebuildSequences(srcSplit.frozen, srcSplit.open);

      await persistSequences(client, tenant_id, to_trip_id, destSeq, destChofer);
      await persistSequences(client, tenant_id, from_trip_id, srcSeq);

      invalidateTowerPoll(tenant_id);

      return jsonResponse({
        exito: true,
        ot_id,
        from_trip_id,
        to_trip_id,
        insert_at: idx,
      });
    }, { tenantId: tenant_id, statementTimeout: 15000 });

    // S9: OT movida a viaje ya despachado → deuda de guía
    if (response?.status === 200) {
      await ensureGuiaForLateOt(env, null, {
        tenant_id,
        trip_id: to_trip_id,
        ot_id,
        waitUntil: ctx && typeof ctx.waitUntil === 'function'
          ? (p) => ctx.waitUntil(p)
          : undefined,
      }).catch((e) => console.warn('[DTE_LATE_OT_MOVE]', e.message));
    }
    return response;
  } catch (err) {
    console.error('[TRIP_MOVE_STOP]', err.message);
    return jsonResponse({ error: 'Internal Server Error', detalle: err.message }, 500);
  }
}
