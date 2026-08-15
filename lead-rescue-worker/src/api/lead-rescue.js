/**
 * Lead Rescue API — candidatos y confirmación de misión (humano-en-el-loop).
 * confirmRescue: una sola transacción PG (ordenes + mission + alert + bitácora).
 */
import { CONFIG, CORS_HEADERS, jsonResponse, requireTenantId } from '../config.js';
import { withDb, withDbTransaction } from '../db.js';
import { resolveDepot, depotToSolver } from '../helpers/depots.js';
import {
  buildClientesMap,
  normalizeClienteKey,
  resolveDestinoCoords,
} from '../helpers/destino-coords.js';
import { tagsConflict, unionTags } from '../helpers/cargo-constraints.js';
import {
  planRescueInsertion,
  rankRescueCandidates,
  splitFrozenOpen,
} from '../helpers/lead-rescue.js';
import { ensureGuiaForLateOt } from '../helpers/dte/ensure-guia-late-ot.js';
import { getEffectiveSpeedKmh } from '../helpers/speed-calibration.js';

const LR = () => CONFIG.LEAD_RESCUE || {};

function parseTags(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j.map(String) : [];
    } catch {
      return raw ? [raw] : [];
    }
  }
  return [];
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function orderWeight(o) {
  const meta = parseMeta(o?.metadata);
  const n = Number(o?.peso_kg ?? meta.peso_kg ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** SELECT de órdenes con fallback si lat/lng no existen como columnas. */
async function loadOrdersForTrip(client, tenantId, tripId, { estados = null } = {}) {
  const withLat = estados
    ? `SELECT ot_id, cliente, volumen, peso_kg, tags_requeridos, tipo_movimiento, valor_oc_clp,
              estado_operacional, lat, lng, metadata, stop_sequence, fecha_hora_sla,
              ventana_inicio, ventana_fin, chofer_asignado_id
       FROM ordenes_pendientes
       WHERE tenant_id = $1 AND trip_id = $2
         AND estado_operacional = ANY($3::text[])`
    : `SELECT ot_id, cliente, volumen, peso_kg, tags_requeridos, tipo_movimiento, valor_oc_clp,
              estado_operacional, lat, lng, metadata, stop_sequence, fecha_hora_sla,
              ventana_inicio, ventana_fin, chofer_asignado_id
       FROM ordenes_pendientes
       WHERE tenant_id = $1 AND trip_id = $2`;
  const mid = estados
    ? `SELECT ot_id, cliente, volumen, tags_requeridos, tipo_movimiento, valor_oc_clp,
              estado_operacional, lat, lng, metadata, stop_sequence, fecha_hora_sla, chofer_asignado_id
       FROM ordenes_pendientes
       WHERE tenant_id = $1 AND trip_id = $2
         AND estado_operacional = ANY($3::text[])`
    : `SELECT ot_id, cliente, volumen, tags_requeridos, tipo_movimiento, valor_oc_clp,
              estado_operacional, lat, lng, metadata, stop_sequence, fecha_hora_sla, chofer_asignado_id
       FROM ordenes_pendientes
       WHERE tenant_id = $1 AND trip_id = $2`;
  const noLat = estados
    ? `SELECT ot_id, cliente, volumen, tags_requeridos, tipo_movimiento, valor_oc_clp,
              estado_operacional, metadata, stop_sequence, fecha_hora_sla, chofer_asignado_id
       FROM ordenes_pendientes
       WHERE tenant_id = $1 AND trip_id = $2
         AND estado_operacional = ANY($3::text[])`
    : `SELECT ot_id, cliente, volumen, tags_requeridos, tipo_movimiento, valor_oc_clp,
              estado_operacional, metadata, stop_sequence, fecha_hora_sla, chofer_asignado_id
       FROM ordenes_pendientes
       WHERE tenant_id = $1 AND trip_id = $2`;

  const params = estados ? [tenantId, tripId, estados] : [tenantId, tripId];
  const attempts = [withLat, mid, noLat];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const sp = `sp_lr_ord_${i}`;
    try {
      await client.query(`SAVEPOINT ${sp}`);
      const r = await client.query(attempts[i], params);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      return r.rows;
    } catch (e) {
      lastErr = e;
      try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch (_) { /* ignore */ }
      if (e.code !== '42703' && !/column .* does not exist/i.test(e.message || '')) throw e;
    }
  }
  throw lastErr || new Error('loadOrdersForTrip failed');
}

/**
 * GET /api/lead-rescue/candidates?trip_id=
 */
export async function getRescueCandidates(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  const url = new URL(request.url);
  const trip_id = url.searchParams.get('trip_id');
  if (!trip_id) return jsonResponse({ error: 'trip_id requerido' }, 400);

  try {
    return await withDb(env, async (client) => {
      const stuck = await client.query(
        `SELECT fv.trip_id_actual AS trip_id, fv.ultima_lat AS lat, fv.ultima_lng AS lng,
                fv.patente, fv.rut_chofer_asignado
         FROM flota_vehiculos fv
         WHERE fv.tenant_id = $1 AND fv.trip_id_actual = $2
         LIMIT 1`,
        [tenant_id, trip_id]
      );
      if (!stuck.rowCount) {
        return jsonResponse({ error: 'Viaje varado no encontrado en flota', code: 'trip_not_active' }, 404);
      }
      const s = stuck.rows[0];
      if (!Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lng))
          || (Number(s.lat) === 0 && Number(s.lng) === 0)) {
        return jsonResponse({ error: 'Sin GPS válido del camión varado', code: 'no_gps' }, 400);
      }

      const cargoRows = await loadOrdersForTrip(client, tenant_id, trip_id, {
        estados: ['CAMION_ASIGNADO', 'EN_RUTA', 'PENDIENTE', 'PENDIENTE_RUTEO'],
      });
      const cargoVolume = cargoRows.reduce((a, o) => a + Number(o.volumen || 1), 0);
      const cargoWeight = cargoRows.reduce((a, o) => a + orderWeight(o), 0);
      const cargoTags = [...new Set(cargoRows.flatMap((o) => parseTags(o.tags_requeridos)))];

      let fleet;
      try {
        await client.query('SAVEPOINT sp_lr_fleet');
        fleet = await client.query(
          `SELECT fv.trip_id_actual AS trip_id, fv.ultima_lat AS lat, fv.ultima_lng AS lng,
                  fv.patente, fv.rut_chofer_asignado,
                  ch.chofer_id, ch.nombre_completo, ch.capacidad_volumen, ch.capacidad_peso, ch.tags
           FROM flota_vehiculos fv
           LEFT JOIN choferes ch
             ON ch.tenant_id = fv.tenant_id
            AND ch.rut = fv.rut_chofer_asignado
           WHERE fv.tenant_id = $1
             AND fv.trip_id_actual IS NOT NULL
             AND fv.trip_id_actual <> $2
             AND fv.ultima_lat IS NOT NULL`,
          [tenant_id, trip_id]
        );
        await client.query('RELEASE SAVEPOINT sp_lr_fleet');
      } catch (e) {
        try { await client.query('ROLLBACK TO SAVEPOINT sp_lr_fleet'); } catch (_) { /* ignore */ }
        fleet = await client.query(
          `SELECT fv.trip_id_actual AS trip_id, fv.ultima_lat AS lat, fv.ultima_lng AS lng,
                  fv.patente, fv.rut_chofer_asignado,
                  ch.chofer_id, ch.nombre_completo, ch.capacidad_volumen, ch.tags
           FROM flota_vehiculos fv
           LEFT JOIN choferes ch
             ON ch.tenant_id = fv.tenant_id
            AND ch.rut = fv.rut_chofer_asignado
           WHERE fv.tenant_id = $1
             AND fv.trip_id_actual IS NOT NULL
             AND fv.trip_id_actual <> $2
             AND fv.ultima_lat IS NOT NULL`,
          [tenant_id, trip_id]
        );
      }

      const candidates = [];
      for (const row of fleet.rows) {
        const vols = await client.query(
          `SELECT COALESCE(SUM(volumen), 0) AS vol
           FROM ordenes_pendientes
           WHERE tenant_id = $1 AND trip_id = $2
             AND estado_operacional NOT IN ('ENTREGADO','RECHAZADO','CANCELADO_PLANILLA','RETORNO_BODEGA')`,
          [tenant_id, row.trip_id]
        );
        let weightOnBoard = 0;
        try {
          await client.query('SAVEPOINT sp_lr_w');
          const wRes = await client.query(
            `SELECT COALESCE(SUM(peso_kg), 0) AS w
             FROM ordenes_pendientes
             WHERE tenant_id = $1 AND trip_id = $2
               AND estado_operacional NOT IN ('ENTREGADO','RECHAZADO','CANCELADO_PLANILLA','RETORNO_BODEGA')`,
            [tenant_id, row.trip_id]
          );
          await client.query('RELEASE SAVEPOINT sp_lr_w');
          weightOnBoard = Number(wRes.rows[0]?.w) || 0;
        } catch (e) {
          try { await client.query('ROLLBACK TO SAVEPOINT sp_lr_w'); } catch (_) { /* ignore */ }
          const metaRows = await client.query(
            `SELECT metadata FROM ordenes_pendientes
             WHERE tenant_id = $1 AND trip_id = $2
               AND estado_operacional NOT IN ('ENTREGADO','RECHAZADO','CANCELADO_PLANILLA','RETORNO_BODEGA')`,
            [tenant_id, row.trip_id]
          );
          weightOnBoard = (metaRows.rows || []).reduce((a, r) => a + orderWeight(r), 0);
        }
        // Tags del viaje destino (órdenes abiertas) para segregación HAZMAT/FOOD
        let tripTags = parseTags(row.tags);
        try {
          await client.query('SAVEPOINT sp_lr_tags');
          const tagRes = await client.query(
            `SELECT tags_requeridos FROM ordenes_pendientes
             WHERE tenant_id = $1 AND trip_id = $2
               AND estado_operacional NOT IN ('ENTREGADO','RECHAZADO','CANCELADO_PLANILLA','RETORNO_BODEGA')`,
            [tenant_id, row.trip_id]
          );
          await client.query('RELEASE SAVEPOINT sp_lr_tags');
          tripTags = [...new Set([
            ...tripTags,
            ...tagRes.rows.flatMap((o) => parseTags(o.tags_requeridos)),
          ])];
        } catch (e) {
          try { await client.query('ROLLBACK TO SAVEPOINT sp_lr_tags'); } catch (_) { /* ignore */ }
        }
        candidates.push({
          trip_id: row.trip_id,
          chofer_id: row.chofer_id != null ? String(row.chofer_id) : null,
          patente: row.patente,
          lat: Number(row.lat),
          lng: Number(row.lng),
          capacity: Number(row.capacidad_volumen) || 100,
          capacityWeight: Number(row.capacidad_peso) || 99999,
          volume: Number(vols.rows[0]?.vol) || 0,
          weight: weightOnBoard,
          tags: tripTags,
          nombre: row.nombre_completo,
        });
      }

      let velocidadKmH = CONFIG.VELOCIDAD_FALLBACK_KMH || 35;
      try {
        const cal = await getEffectiveSpeedKmh(client, { tenant_id });
        velocidadKmH = cal.velocidadKmH;
      } catch { /* config fallback */ }

      const ranked = rankRescueCandidates({
        stuckLat: Number(s.lat),
        stuckLng: Number(s.lng),
        candidates,
        cargoVolume,
        cargoWeight,
        cargoTags,
        limit: LR().RESCUE_CANDIDATES || 2,
        velocidadKmH,
      });

      return jsonResponse({
        exito: true,
        source_trip_id: trip_id,
        stuck: { lat: Number(s.lat), lng: Number(s.lng), patente: s.patente },
        cargo: {
          ot_ids: cargoRows.map((o) => o.ot_id),
          volume: cargoVolume,
          weight: cargoWeight,
          stops: cargoRows.length,
          tags: cargoTags,
        },
        candidates: ranked,
      });
    }, { tenantId: tenant_id });
  } catch (err) {
    console.error('[LEAD_RESCUE_CANDIDATES]', err.message);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * POST /api/lead-rescue/confirm
 * Persistencia atómica: OTs + rescue_missions + fleet_alerts + bitácora.
 */
export async function confirmRescue(request, env, operator = null, ctx = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'JSON inválido' }, 400);
  }

  const source_trip_id = body.source_trip_id;
  const rescue_trip_id = body.rescue_trip_id;
  const alert_id = body.alert_id != null ? Number(body.alert_id) : null;

  if (!source_trip_id || !rescue_trip_id) {
    return jsonResponse({ error: 'source_trip_id y rescue_trip_id requeridos' }, 400);
  }
  if (source_trip_id === rescue_trip_id) {
    return jsonResponse({ error: 'El viaje rescate debe ser distinto al varado' }, 400);
  }

  try {
    const depotRow = await resolveDepot(env, tenant_id, body.depot_id || null);
    const depot = depotToSolver(depotRow);

    const prep = await withDb(env, async (client) => {
      const sourceOrders = { rows: await loadOrdersForTrip(client, tenant_id, source_trip_id) };

      const transferable = sourceOrders.rows.filter((o) =>
        ['CAMION_ASIGNADO', 'EN_RUTA', 'PENDIENTE', 'PENDIENTE_RUTEO'].includes(
          String(o.estado_operacional || '').toUpperCase()
        )
      );
      if (!transferable.length) {
        return { error: jsonResponse({ error: 'No hay paradas transferibles en el viaje varado', code: 'no_cargo' }, 400) };
      }

      const rescueOrders = { rows: await loadOrdersForTrip(client, tenant_id, rescue_trip_id) };

      const flotaRescue = await client.query(
        `SELECT ultima_lat, ultima_lng, patente, rut_chofer_asignado
         FROM flota_vehiculos
         WHERE tenant_id = $1 AND trip_id_actual = $2 LIMIT 1`,
        [tenant_id, rescue_trip_id]
      );
      const fr = flotaRescue.rows[0] || null;

      let choferRescue = null;
      if (fr?.rut_chofer_asignado) {
        try {
          await client.query('SAVEPOINT sp_lr_ch');
          const ch = await client.query(
            `SELECT chofer_id, capacidad_volumen, capacidad_peso, tags, nombre_completo
             FROM choferes WHERE tenant_id = $1 AND rut = $2 LIMIT 1`,
            [tenant_id, fr.rut_chofer_asignado]
          );
          await client.query('RELEASE SAVEPOINT sp_lr_ch');
          choferRescue = ch.rows[0] || null;
        } catch (e) {
          try { await client.query('ROLLBACK TO SAVEPOINT sp_lr_ch'); } catch (_) { /* ignore */ }
          const ch = await client.query(
            `SELECT chofer_id, capacidad_volumen, tags, nombre_completo
             FROM choferes WHERE tenant_id = $1 AND rut = $2 LIMIT 1`,
            [tenant_id, fr.rut_chofer_asignado]
          );
          choferRescue = ch.rows[0] || null;
        }
      }

      const nombres = [
        ...new Set(
          [...sourceOrders.rows, ...rescueOrders.rows].map((o) => o.cliente).filter(Boolean)
        ),
      ];
      let clientesRows = [];
      if (nombres.length) {
        const cli = await client.query(
          `SELECT * FROM clientes
           WHERE tenant_id = $1 AND nombre_cliente_raw = ANY($2::text[])`,
          [tenant_id, nombres]
        );
        clientesRows = cli.rows;
      }

      return {
        transferable,
        rescueOrders: rescueOrders.rows,
        flotaRescue: fr,
        choferRescue,
        clientesRows,
      };
    }, { tenantId: tenant_id });

    if (prep.error) return prep.error;

    const {
      transferable,
      rescueOrders,
      flotaRescue,
      choferRescue,
      clientesRows,
    } = prep;

    const clientesMap = buildClientesMap(clientesRows);
    const normalizeStop = (o) => {
      const info = clientesMap[normalizeClienteKey(o.cliente)] || null;
      const coords = resolveDestinoCoords(o, info);
      const meta = parseMeta(o.metadata);
      return {
        ...o,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        volumen: Number(o.volumen || 1),
        peso_kg: orderWeight(o),
        ventana_inicio: o.ventana_inicio || meta.ventana_inicio || null,
        ventana_fin: o.ventana_fin || meta.ventana_fin || o.fecha_hora_sla || null,
        tags: parseTags(o.tags_requeridos),
      };
    };

    const rescueNorm = rescueOrders.map(normalizeStop).filter(
      (o) => Number.isFinite(o.lat) && Number.isFinite(o.lng) && !(o.lat === 0 && o.lng === 0)
    );
    const { frozen, open } = splitFrozenOpen(rescueNorm);
    const aboard = [
      ...frozen.filter((s) => String(s.estado_operacional || '').toUpperCase() === 'EN_SITIO'),
      ...open,
    ];
    const volume = aboard.reduce((s, o) => s + Number(o.volumen || 1), 0);
    const weight = aboard.reduce((s, o) => s + Number(o.peso_kg || 0), 0);
    const toInsert = transferable.map(normalizeStop).filter(
      (o) => Number.isFinite(o.lat) && Number.isFinite(o.lng) && !(o.lat === 0 && o.lng === 0)
    );
    if (!toInsert.length) {
      return jsonResponse({ error: 'Paradas sin coordenadas — no se puede insertar', code: 'no_coords' }, 400);
    }

    // Segregación HAZMAT/FOOD entre carga varada y viaje rescate
    if (tagsConflict(unionTags(toInsert), unionTags(rescueNorm))) {
      return jsonResponse({
        error: 'Segregación HAZMAT/FOOD: el viaje rescate no puede mezclar esa carga',
        code: 'segregation',
      }, 400);
    }

    const plan = planRescueInsertion(
      {
        open,
        frozen,
        volume,
        weight,
        capacity: Number(choferRescue?.capacidad_volumen) || 100,
        capacityWeight: Number(choferRescue?.capacidad_peso) || 99999,
        tags: [
          ...parseTags(choferRescue?.tags),
          ...unionTags(rescueNorm),
        ],
        seed: {
          lat: Number(flotaRescue?.ultima_lat),
          lng: Number(flotaRescue?.ultima_lng),
        },
      },
      toInsert,
      depot
    );

    if (!plan) {
      return jsonResponse({
        error: 'El camión rescate no tiene cupo o no hay inserción viable',
        code: 'no_capacity',
      }, 409);
    }

    const choferId = choferRescue?.chofer_id != null ? String(choferRescue.chofer_id) : null;
    const insertedIds = new Set(plan.inserted.map((s) => s.ot_id));
    const otIds = plan.inserted.map((s) => s.ot_id);
    const createdBy = operator?.username || operator?.sub || 'operator';

    const mission = await withDbTransaction(env, async (client) => {
      // A-22: lockear ambos viajes y revalidar capacidad en la misma TX
      await client.query(
        `SELECT ot_id FROM ordenes_pendientes
         WHERE tenant_id = $1 AND trip_id = ANY($2::text[])
         FOR UPDATE`,
        [tenant_id, [source_trip_id, rescue_trip_id]]
      );
      const capRes = await client.query(
        `SELECT COALESCE(SUM(volumen), 0)::float AS vol
         FROM ordenes_pendientes
         WHERE tenant_id = $1 AND trip_id = $2
           AND UPPER(COALESCE(estado_operacional,'')) NOT IN
             ('ENTREGADO','RECHAZADO','CANCELADO_PLANILLA','RETORNO_BODEGA')`,
        [tenant_id, rescue_trip_id]
      );
      const currentVol = Number(capRes.rows[0]?.vol || 0);
      const insertVol = plan.inserted.reduce((s, o) => s + Number(o.volumen || 1), 0);
      const capacity = Number(choferRescue?.capacidad_volumen) || 100;
      if (currentVol + insertVol > capacity + 1e-6) {
        const err = new Error('El camión rescate ya no tiene cupo (carrera concurrente)');
        err.statusCode = 409;
        err.code = 'no_capacity_race';
        throw err;
      }
      const insertWeight = plan.inserted.reduce((s, o) => s + Number(o.peso_kg || 0), 0);
      const capacityWeight = Number(choferRescue?.capacidad_peso) || 99999;
      let currentWeight = weight;
      try {
        await client.query('SAVEPOINT sp_lr_wrace');
        const wRes = await client.query(
          `SELECT COALESCE(SUM(peso_kg), 0)::float AS w
           FROM ordenes_pendientes
           WHERE tenant_id = $1 AND trip_id = $2
             AND UPPER(COALESCE(estado_operacional,'')) NOT IN
               ('ENTREGADO','RECHAZADO','CANCELADO_PLANILLA','RETORNO_BODEGA')`,
          [tenant_id, rescue_trip_id]
        );
        await client.query('RELEASE SAVEPOINT sp_lr_wrace');
        currentWeight = Number(wRes.rows[0]?.w || 0);
      } catch (e) {
        try { await client.query('ROLLBACK TO SAVEPOINT sp_lr_wrace'); } catch (_) { /* ignore */ }
      }
      if (currentWeight + insertWeight > capacityWeight + 1e-6) {
        const err = new Error('El camión rescate ya no tiene cupo de peso (carrera concurrente)');
        err.statusCode = 409;
        err.code = 'no_capacity_weight_race';
        throw err;
      }

      for (const s of plan.sequenced) {
        if (['ENTREGADO', 'RECHAZADO', 'EN_SITIO'].includes(String(s.estado_operacional || '').toUpperCase())) {
          continue;
        }
        const wasInserted = insertedIds.has(s.ot_id);
        const metaBase = parseMeta(s.metadata);
        const metadata = {
          ...metaBase,
          routing: {
            ...(metaBase.routing || {}),
            trip_id: rescue_trip_id,
            stop_sequence: s.stop_sequence,
            rescue_insert: wasInserted,
            rescued_from_trip: wasInserted
              ? source_trip_id
              : (metaBase.routing?.rescued_from_trip || null),
          },
        };
        const nextEstado = wasInserted ? 'CAMION_ASIGNADO' : s.estado_operacional;
        await client.query(
          `UPDATE ordenes_pendientes
           SET trip_id = $1,
               chofer_asignado_id = $2,
               stop_sequence = $3,
               estado_operacional = $4,
               metadata = $5::jsonb
           WHERE ot_id = $6 AND tenant_id = $7`,
          [
            rescue_trip_id,
            choferId,
            s.stop_sequence,
            nextEstado,
            JSON.stringify(metadata),
            s.ot_id,
            tenant_id,
          ]
        );
      }

      let missionRow = null;
      try {
        const ins = await client.query(
          `INSERT INTO rescue_missions
             (tenant_id, alert_id, source_trip_id, rescue_trip_id, rescue_chofer_id, ot_ids, status, delta_km, created_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'DISPATCHED', $7, $8)
           RETURNING id, created_at`,
          [
            tenant_id,
            Number.isFinite(alert_id) ? alert_id : null,
            source_trip_id,
            rescue_trip_id,
            choferId,
            JSON.stringify(otIds),
            plan.deltaKmTotal,
            createdBy,
          ]
        );
        missionRow = ins.rows[0];

        if (Number.isFinite(alert_id)) {
          await client.query(
            `UPDATE fleet_alerts
             SET status = 'RESCUING', updated_at = NOW(),
                 payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
                   'rescue_trip_id', $2::text,
                   'mission_id', $3::bigint,
                   'ot_ids', $4::jsonb
                 )
             WHERE id = $1 AND tenant_id = $5`,
            [alert_id, rescue_trip_id, missionRow.id, JSON.stringify(otIds), tenant_id]
          );
        } else {
          await client.query(
            `UPDATE fleet_alerts
             SET status = 'RESCUING', updated_at = NOW()
             WHERE tenant_id = $1 AND trip_id = $2 AND status IN ('OPEN','ACKED')`,
            [tenant_id, source_trip_id]
          );
        }
      } catch (e) {
        if (e.code !== '42P01') throw e;
        console.warn('[RESCUE_MISSION_TABLE_MISSING]');
      }

      return missionRow;
    }, { statementTimeout: 15000, tenantId: tenant_id });

    // Bitácora fuera de la TX crítica (no debe tumbar el rescate)
    try {
      await withDb(env, async (client) => {
        for (const ot_id of otIds) {
          await client.query(
            `INSERT INTO bitacora_viajes
               (tenant_id, trip_id, stop_id, tipo_evento, mensaje, created_at)
             VALUES ($1, $2, $3, 'RESCATE', $4, NOW())`,
            [
              tenant_id,
              rescue_trip_id,
              ot_id,
              `Rescate desde ${source_trip_id} → ${rescue_trip_id}`,
            ]
          );
        }
      }, { tenantId: tenant_id });
    } catch (bitErr) {
      console.warn('[RESCUE_BITACORA]', bitErr.message);
    }

    // S9: OTs insertadas en viaje rescate que ya tuvo SALIDA → deuda de guía
    const waitUntil = ctx && typeof ctx.waitUntil === 'function'
      ? (p) => ctx.waitUntil(p)
      : undefined;
    for (const ot_id of otIds) {
      const late = ensureGuiaForLateOt(env, null, {
        tenant_id,
        trip_id: rescue_trip_id,
        ot_id,
        waitUntil,
      }).catch((e) => console.warn('[DTE_LATE_OT_RESCUE]', e.message));
      if (!waitUntil) await late;
    }

    return jsonResponse({
      exito: true,
      mensaje: `Rescate despachado: ${otIds.length} parada(s) → ${rescue_trip_id}`,
      mission_id: mission?.id || null,
      ot_ids: otIds,
      delta_km: plan.deltaKmTotal,
      rescue_trip_id,
      source_trip_id,
    });
  } catch (err) {
    console.error('[LEAD_RESCUE_CONFIRM]', err.message);
    const status = err.statusCode || 500;
    return jsonResponse(
      { error: status === 500 ? 'Internal Server Error' : err.message, code: err.code },
      status
    );
  }
}

/**
 * POST /api/fleet-alerts/:id/dismiss
 */
export async function dismissFleetAlert(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  const url = new URL(request.url);
  const alertId = Number(url.pathname.match(/\/api\/fleet-alerts\/(\d+)\/dismiss/)?.[1]);
  if (!Number.isFinite(alertId)) return jsonResponse({ error: 'alert id inválido' }, 400);

  try {
    return await withDb(env, async (client) => {
      const res = await client.query(
        `UPDATE fleet_alerts
         SET status = 'DISMISSED', updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND status IN ('OPEN','ACKED','RESCUING')
         RETURNING id`,
        [alertId, tenant_id]
      );
      if (!res.rowCount) return jsonResponse({ error: 'Alerta no encontrada', code: 'not_found' }, 404);
      return jsonResponse({ exito: true, id: alertId });
    });
  } catch (err) {
    if (err.code === '42P01') return jsonResponse({ exito: true, skipped: true });
    console.error('[FLEET_ALERT_DISMISS]', err.message);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}
