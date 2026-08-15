/**
 * Auto-LLEGADA por geocerca (servidor).
 * Cuando el GPS del chofer entra en radio de la parada activa → EN_SITIO + hora_llegada_chofer.
 * Completa datasets F2/F3 sin depender de que el chofer pulse el botón.
 */

import { CONFIG } from '../config.js';
import { resolveDestinoCoords } from './destino-coords.js';

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * @returns {{ triggered: boolean, ot_id?: string, dist_m?: number, reason?: string }}
 */
export async function maybeAutoLlegada(client, {
  tenant_id,
  trip_id,
  lat,
  lng,
  eventIso,
  radiusM = CONFIG.GEO_LLEGADA_RADIUS_M || 150,
}) {
  if (!tenant_id || !trip_id) return { triggered: false, reason: 'missing_ids' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { triggered: false, reason: 'bad_coords' };
  }

  // No auto-llegar si ya hay alguien EN_SITIO en el viaje
  const enSitio = await client.query(
    `SELECT 1 FROM ordenes_pendientes
     WHERE tenant_id = $1 AND trip_id = $2 AND estado_operacional = 'EN_SITIO'
     LIMIT 1`,
    [tenant_id, trip_id]
  );
  if (enSitio.rowCount > 0) return { triggered: false, reason: 'already_en_sitio' };

  // Opcional: solo si la flota ya comenzó ruta
  const flota = await client.query(
    `SELECT estado FROM flota_vehiculos
     WHERE tenant_id = $1 AND trip_id_actual = $2 LIMIT 1`,
    [tenant_id, trip_id]
  );
  const flotaEstado = String(flota.rows[0]?.estado || '').toUpperCase();
  if (flotaEstado && flotaEstado !== 'EN_RUTA' && flotaEstado !== 'EN_SITIO') {
    // Si estado es null/vacío dejamos pasar (flotas legacy)
    if (flotaEstado === 'DISPONIBLE' || flotaEstado === 'EN_BODEGA' || flotaEstado === 'IDLE') {
      return { triggered: false, reason: 'route_not_started' };
    }
  }

  const next = await client.query(
    `SELECT ot_id, cliente, lat, lng, metadata, estado_operacional, stop_sequence, hora_llegada_chofer
     FROM ordenes_pendientes
     WHERE tenant_id = $1 AND trip_id = $2
       AND estado_operacional IN ('CAMION_ASIGNADO', 'EN_RUTA')
       AND hora_llegada_chofer IS NULL
     ORDER BY stop_sequence ASC NULLS LAST
     LIMIT 1`,
    [tenant_id, trip_id]
  );
  const orden = next.rows[0];
  if (!orden) return { triggered: false, reason: 'no_open_stop' };

  let cliente = null;
  if (orden.cliente) {
    const cli = await client.query(
      `SELECT lat, lng, nombre_cliente_raw FROM clientes
       WHERE tenant_id = $1 AND LOWER(TRIM(nombre_cliente_raw)) = LOWER(TRIM($2))
       LIMIT 1`,
      [tenant_id, orden.cliente]
    );
    cliente = cli.rows[0] || null;
  }

  const dest = resolveDestinoCoords(orden, cliente);
  if (dest.lat == null || dest.lng == null) {
    return { triggered: false, reason: 'no_destino_coords' };
  }

  const distM = haversineKm(lat, lng, dest.lat, dest.lng) * 1000;
  const radius = Math.max(30, Number(radiusM) || 150);
  if (distM > radius) {
    return { triggered: false, reason: 'outside', dist_m: Math.round(distM), ot_id: orden.ot_id };
  }

  const ts = eventIso || new Date().toISOString();
  const upd = await client.query(
    `UPDATE ordenes_pendientes
     SET estado_operacional = 'EN_SITIO',
         hora_llegada_chofer = $1::timestamptz
     WHERE ot_id = $2 AND trip_id = $3 AND tenant_id = $4
       AND hora_llegada_chofer IS NULL
     RETURNING ot_id`,
    [ts, orden.ot_id, trip_id, tenant_id]
  );
  if (!upd.rowCount) {
    return { triggered: false, reason: 'race_already_set', ot_id: orden.ot_id };
  }

  try {
    await client.query(
      `INSERT INTO bitacora_viajes
         (tenant_id, trip_id, stop_id, tipo_evento, latitud, longitud, mensaje, created_at)
       VALUES ($1, $2, $3, 'LLEGADA', $4, $5, $6, $7::timestamptz)`,
      [
        tenant_id,
        trip_id,
        orden.ot_id,
        lat,
        lng,
        `auto_geofence dist_m=${Math.round(distM)} radius_m=${radius}`,
        ts,
      ]
    );
  } catch (bitErr) {
    // columnas mensaje opcionales / schema viejo
    if (bitErr.code !== '42703') {
      console.warn('[AUTO_LLEGADA_BITACORA]', bitErr.message);
    } else {
      await client.query(
        `INSERT INTO bitacora_viajes
           (tenant_id, trip_id, stop_id, tipo_evento, latitud, longitud, created_at)
         VALUES ($1, $2, $3, 'LLEGADA', $4, $5, $6::timestamptz)`,
        [tenant_id, trip_id, orden.ot_id, lat, lng, ts]
      ).catch((e) => console.warn('[AUTO_LLEGADA_BITACORA]', e.message));
    }
  }

  console.log(`[AUTO_LLEGADA] trip=${trip_id} ot=${orden.ot_id} dist_m=${Math.round(distM)}`);
  return {
    triggered: true,
    ot_id: orden.ot_id,
    dist_m: Math.round(distM),
  };
}

/** Pure helper for tests */
export function isInsideGeofence(lat, lng, destLat, destLng, radiusM) {
  const distM = haversineKm(lat, lng, destLat, destLng) * 1000;
  return { inside: distM <= radiusM, distM };
}
