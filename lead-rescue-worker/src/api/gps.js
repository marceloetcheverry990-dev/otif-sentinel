// src/api/gps.js
import { CONFIG, CORS_HEADERS, requireTenantId } from '../config.js';
import { withDb } from '../db.js';
import { verifyDriverToken } from '../helpers/driver-auth.js';
import { verifyOperatorToken } from '../helpers/operator-auth.js';
import { shouldSampleTrail } from '../helpers/gps-trail.js';
import { resolveGpsEventTime } from '../helpers/gps-timestamp.js';
import { maybeAutoLlegada } from '../helpers/auto-llegada.js';
import {
  getLiveFleetCacheEntry,
  setLiveFleetCacheEntry,
  invalidateTowerPoll,
} from '../helpers/tower-poll-cache.js';

const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...CORS_HEADERS });
const LR = () => CONFIG.LEAD_RESCUE || {};

function calcularDistanciaKm(lat1, lon1, lat2, lon2) {
  if (lat1 === null || lon1 === null) return 0;
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

export async function handleGPSPing(request, env, ctx) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: jsonHeaders() });
  }

  try {
    // Auth antes de validar body/tenant (A3: no filtrar tenant_id con 403 pre-auth)
    const auth = await verifyDriverToken(request, env);
    if (!auth.ok) return auth.response;

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Payload inválido' }), { status: 400, headers: jsonHeaders() });
    }
    const { trip_id, lat, lng, tenant_id: bodyTenant, timestamp, recorded_at } = body;
    const eventTime = resolveGpsEventTime(timestamp ?? recorded_at);
    const tenant_id = auth.payload.tenant_id;

    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    if (bodyTenant && bodyTenant !== tenant_id) {
      return new Response(
        JSON.stringify({ error: 'Prohibido: tenant_id del token no coincide con el payload', code: 'tenant_mismatch' }),
        { status: 403, headers: jsonHeaders() }
      );
    }

    if (!trip_id || typeof lat !== 'number' || typeof lng !== 'number') {
      return new Response(JSON.stringify({ error: 'Payload inválido' }), { status: 400, headers: jsonHeaders() });
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return new Response(JSON.stringify({ error: 'Coordenadas inválidas' }), { status: 400, headers: jsonHeaders() });
    }

    return await withDb(env, async (client) => {
      const resAsignacion = await client.query(
        `SELECT 1 FROM flota_vehiculos
         WHERE trip_id_actual = $1 AND tenant_id = $2 AND rut_chofer_asignado = $3
         LIMIT 1`,
        [trip_id, tenant_id, auth.payload.rut]
      );
      if (resAsignacion.rowCount === 0) {
        return new Response(
          JSON.stringify({ error: 'Prohibido: el viaje no está asignado a este chofer', code: 'trip_not_assigned' }),
          { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      let resFlota;
      try {
        resFlota = await client.query(
          `SELECT ultima_lat, ultima_lng,
                  COALESCE(km_recorridos_reales, 0) AS km_recorridos_reales,
                  ultima_actualizacion,
                  last_significant_move_at
           FROM flota_vehiculos 
           WHERE trip_id_actual = $1 AND tenant_id = $2 LIMIT 1`,
          [trip_id, tenant_id]
        );
      } catch (colErr) {
        if (String(colErr.message || '').includes('last_significant_move_at')) {
          resFlota = await client.query(
            `SELECT ultima_lat, ultima_lng,
                    COALESCE(km_recorridos_reales, 0) AS km_recorridos_reales,
                    ultima_actualizacion,
                    NULL::timestamptz AS last_significant_move_at
             FROM flota_vehiculos 
             WHERE trip_id_actual = $1 AND tenant_id = $2 LIMIT 1`,
            [trip_id, tenant_id]
          );
        } else {
          throw colErr;
        }
      }

      if (resFlota.rowCount === 0) {
        return new Response(JSON.stringify({ error: 'Viaje no activo o vehículo no encontrado' }), { status: 404, headers: jsonHeaders() });
      }

      const {
        ultima_lat,
        ultima_lng,
        km_recorridos_reales,
        ultima_actualizacion,
        last_significant_move_at,
      } = resFlota.rows[0];
      const kmPrevios = parseFloat(km_recorridos_reales) || 0;

      let gps_ruido = 0, gps_vel = 0, gps_salto = 0;
      let acumular = false;
      let delta = 0;

      if (ultima_lat !== null && ultima_lng !== null) {
        delta = calcularDistanciaKm(parseFloat(ultima_lat), parseFloat(ultima_lng), lat, lng);

        if (delta < 0.05) {
          gps_ruido = 1;
        } else if (ultima_actualizacion) {
          const prevMs = new Date(ultima_actualizacion).getTime();
          // A-5: también en replay offline usar |Δt| para filtrar velocidad
          const segundosDesdeUltimo = Number.isFinite(prevMs)
            ? Math.max(1, Math.abs(eventTime.ms - prevMs) / 1000)
            : 1;
          const velocidadKmH = delta / (segundosDesdeUltimo / 3600);
          if (velocidadKmH > 130) {
            gps_vel = 1;
          } else if (delta > 50) {
            gps_salto = 1;
          } else {
            acumular = true;
          }
        } else if (delta > 50) {
          gps_salto = 1;
        } else {
          acumular = true;
        }
      }

      const kmDelta = acumular ? delta : 0;
      const moveThreshold = Number(LR().MOVE_THRESHOLD_KM) || 0.05;
      const significantMove = acumular && delta >= moveThreshold;
      const seedMove = !last_significant_move_at;
      const eventIso = eventTime.iso;

      // A-4: incremento atómico — no read-modify-write en JS
      try {
        await client.query(
          `UPDATE flota_vehiculos 
           SET ultima_lat = $1, 
               ultima_lng = $2, 
               km_recorridos_reales = COALESCE(km_recorridos_reales, 0) + $3, 
               ultima_actualizacion = CASE
                 WHEN ultima_actualizacion IS NULL OR $6::timestamptz >= ultima_actualizacion
                 THEN $6::timestamptz ELSE ultima_actualizacion END,
               last_significant_move_at = CASE
                 WHEN $7::boolean AND (
                   last_significant_move_at IS NULL OR $6::timestamptz >= last_significant_move_at
                 ) THEN $6::timestamptz
                 WHEN last_significant_move_at IS NULL THEN $6::timestamptz
                 ELSE last_significant_move_at
               END
           WHERE trip_id_actual = $4 AND tenant_id = $5`,
          [lat, lng, kmDelta, trip_id, tenant_id, eventIso, significantMove || seedMove]
        );
      } catch (updErr) {
        if (!String(updErr.message || '').includes('last_significant_move_at')) throw updErr;
        await client.query(
          `UPDATE flota_vehiculos 
           SET ultima_lat = $1, ultima_lng = $2,
               km_recorridos_reales = COALESCE(km_recorridos_reales, 0) + $3,
               ultima_actualizacion = CASE
                 WHEN ultima_actualizacion IS NULL OR $6::timestamptz >= ultima_actualizacion
                 THEN $6::timestamptz ELSE ultima_actualizacion END
           WHERE trip_id_actual = $4 AND tenant_id = $5`,
          [lat, lng, kmDelta, trip_id, tenant_id, eventIso]
        );
      }

      await client.query(
        `UPDATE trip_metrics
         SET
           km_reales             = km_reales + $1,
           tiempo_real_min       = EXTRACT(EPOCH FROM (NOW() - iniciado_at))::INTEGER / 60,
           gps_pings_total       = gps_pings_total + 1,
           gps_descartados_ruido = gps_descartados_ruido + $2,
           gps_descartados_vel   = gps_descartados_vel   + $3,
           gps_descartados_salto = gps_descartados_salto + $4,
           updated_at            = NOW()
         WHERE trip_id = $5 AND tenant_id = $6`,
        [kmDelta, gps_ruido, gps_vel, gps_salto, trip_id, tenant_id]
      );

      try {
        const lastTrail = await client.query(
          `SELECT EXTRACT(EPOCH FROM recorded_at) * 1000 AS ms
           FROM gps_trail
           WHERE tenant_id = $1 AND trip_id = $2
           ORDER BY recorded_at DESC LIMIT 1`,
          [tenant_id, trip_id]
        );
        const decision = shouldSampleTrail({
          lastTrailAtMs: lastTrail.rows[0]?.ms != null ? Number(lastTrail.rows[0].ms) : null,
          nowMs: eventTime.ms,
          deltaKm: delta,
          minIntervalSec: LR().GPS_TRAIL_MIN_INTERVAL_SEC,
          moveThresholdKm: moveThreshold,
        });
        if (decision.sample) {
          await client.query(
            `INSERT INTO gps_trail (tenant_id, trip_id, lat, lng, delta_km, is_heartbeat, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
            [tenant_id, trip_id, lat, lng, Number.isFinite(delta) ? delta : null, decision.isHeartbeat, eventIso]
          );
        }
      } catch (trailErr) {
        if (trailErr?.code !== '42P01') {
          console.warn('[GPS_TRAIL_SKIP]', trailErr.message);
        }
      }

      // Auto-LLEGADA por geocerca (completa hora_llegada sin botón del chofer)
      let autoLlegada = null;
      try {
        autoLlegada = await maybeAutoLlegada(client, {
          tenant_id,
          trip_id,
          lat,
          lng,
          eventIso,
          radiusM: CONFIG.GEO_LLEGADA_RADIUS_M || 150,
        });
      } catch (geoErr) {
        console.warn('[AUTO_LLEGADA_ERR]', geoErr.message);
      }

      // ETA_15MIN: próxima parada abierta con ETA dentro de 15 min
      // Skip barato si ya hay outbox PENDING/SENT/FAILED para ese evento
      try {
        const { enqueueCustomerNotify } = await import('../helpers/customer-notify.js');
        const next = await client.query(
          `SELECT ot_id, eta
           FROM ordenes_pendientes
           WHERE tenant_id = $1 AND trip_id = $2
             AND estado_operacional NOT IN ('ENTREGADO','RECHAZADO','CANCELADO_PLANILLA','EN_SITIO')
             AND eta IS NOT NULL
           ORDER BY stop_sequence ASC NULLS LAST
           LIMIT 1`,
          [tenant_id, trip_id]
        );
        const row = next.rows[0];
        if (row?.eta) {
          const mins = (new Date(row.eta).getTime() - Date.now()) / 60000;
          if (mins >= 0 && mins <= 15) {
            const already = await client.query(
              `SELECT 1 FROM customer_notifications
               WHERE tenant_id = $1 AND ot_id = $2 AND event_type = 'ETA_15MIN'
                 AND status IN ('PENDING','SENT','FAILED')
               LIMIT 1`,
              [tenant_id, row.ot_id]
            );
            if (!already.rowCount) {
              const job = enqueueCustomerNotify(env, {
                tenantId: tenant_id,
                otId: row.ot_id,
                tripId: trip_id,
                eventType: 'ETA_15MIN',
              }).catch(() => {});
              if (ctx?.waitUntil) ctx.waitUntil(job);
            }
          }
        }
      } catch (etaNotifyErr) {
        if (etaNotifyErr?.code !== '42P01' && !String(etaNotifyErr.message || '').includes('customer_notifications')) {
          console.warn('[NOTIFY_ETA15]', etaNotifyErr.message);
        }
      }

      if (autoLlegada?.triggered) {
        invalidateTowerPoll(tenant_id);
      }

      return new Response(JSON.stringify({
        exito: true,
        km_actuales: Number((kmPrevios + kmDelta).toFixed(4)),
        event_time: eventIso,
        client_timestamp: eventTime.usedClient,
        auto_llegada: autoLlegada?.triggered
          ? { ot_id: autoLlegada.ot_id, dist_m: autoLlegada.dist_m }
          : null,
      }), { status: 200, headers: jsonHeaders() });
    }, { tenantId: tenant_id });

  } catch (err) {
    console.error('GPSPing Real Error:', err);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500, headers: jsonHeaders() });
  }
}

export async function getLiveFleet(request, env, _ctx = null, operator = null) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: jsonHeaders() });
  }

  let tenant_id = operator?.tenant_id || null;
  if (!tenant_id) {
    const auth = await verifyOperatorToken(request, env);
    if (!auth.ok) return auth.response;
    tenant_id = auth.payload.tenant_id;
  }

  const url = new URL(request.url);
  const requestedTenant = url.searchParams.get('tenant_id');

  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;
  if (requestedTenant && requestedTenant !== tenant_id) {
    return new Response(
      JSON.stringify({ error: 'Tenant no autorizado', code: 'tenant_incorrecto' }),
      { status: 403, headers: jsonHeaders() },
    );
  }

  const cacheKey = String(tenant_id);
  const cached = getLiveFleetCacheEntry(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      status: 200,
      headers: { ...jsonHeaders(), 'X-Poll-Cache': 'HIT' },
    });
  }

  try {
    return await withDb(env, async (client) => {
      const { rows } = await client.query(
        `SELECT trip_id_actual as trip_id, ultima_lat as lat, ultima_lng as lng,
                NULL::numeric as velocidad
         FROM flota_vehiculos 
         WHERE tenant_id = $1 AND trip_id_actual IS NOT NULL AND ultima_lat IS NOT NULL`,
        [tenant_id]
      );

      const body = JSON.stringify({ exito: true, flota: rows });
      setLiveFleetCacheEntry(cacheKey, body);
      return new Response(body, {
        status: 200,
        headers: { ...jsonHeaders(), 'X-Poll-Cache': 'MISS' }
      });
    }, { tenantId: tenant_id });
  } catch (err) {
    console.error('GetLiveFleet Error:', err);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500, headers: jsonHeaders() });
  }
}
