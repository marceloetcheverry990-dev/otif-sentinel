/**
 * OTIF Sentinel - Máquina de Estados Operativos del Chofer
 * Entorno: Cloudflare Workers (ES Modules)
 * Archivo: src/api/app-chofer-evento.js
 *
 * Máquina de estados: LLEGADA → ENTREGA → SALIDA (+ PROBLEMA en cualquier punto)
 *
 * Por qué existe este endpoint separado de /api/app-chofer-sync:
 *   - Separa telemetría pasiva (GPS cada 10s) de hitos operativos activos (acciones del chofer)
 *   - LLEGADA: congela el reloj SLA — protege al operador si el cliente hace esperar al chofer
 *   - ENTREGA: POD inmutable — no puede existir sin foto_url, elimina falsos positivos
 *   - SALIDA: dispara recálculo de ETA para la siguiente parada en segundo plano (ctx.waitUntil)
 */

import { createClient } from '@supabase/supabase-js';
import { CONFIG, CORS_HEADERS, requireTenantId } from '../config.js';
import { withDb } from '../db.js';
import { insertEtaMetric } from '../helpers/eta-metric.js';
import { upsertDwellStat } from '../helpers/dwell-stats.js';
import { getEffectiveSpeedKmh } from '../helpers/speed-calibration.js';
import { verifyDriverToken } from '../helpers/driver-auth.js';
import { isTrustedEvidenceUrl } from '../helpers/evidence-upload.js';
import { normalizeScannedCode } from '../helpers/scan-ot.js';
import { verifyPackageScan } from '../helpers/scan-token.js';
import { resolvePodRequirements } from '../helpers/pod-requirements.js';
import { enqueueCustomerNotify } from '../helpers/customer-notify.js';
import { getTenantSettings } from '../helpers/tenant-settings.js';
import { emitGuiasForTrip } from '../helpers/dte/emit-on-salida.js';
import { resolveEventTimestamp } from '../helpers/event-timestamp.js';
import {
  assertDriverCanMutateStop,
  requireMatchingTenant,
} from '../helpers/trip-ownership.js';

// ─── Helper de respuesta JSON ────────────────────────────────────────────────

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });

// ─── Motor de ruteo (funciones puras) ────────────────────────────────────────

function calcularDistanciaKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function calcularRutaMapbox(origenLat, origenLng, destinoLat, destinoLng, env) {
  try {
    const MAPBOX_TOKEN = env.MAPBOX_TOKEN;
    if (!MAPBOX_TOKEN) return null;
    const coords = `${origenLng},${origenLat};${destinoLng},${destinoLat}`;
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}?geometries=geojson&steps=false&access_token=${MAPBOX_TOKEN}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) return null;
    return { distanciaKm: data.routes[0].distance / 1000, duracionSeg: data.routes[0].duration };
  } catch {
    return null;
  }
}

// ─── Handler principal ───────────────────────────────────────────────────────

export async function handleChoferEvento(request, env, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== 'POST') return jsonRes({ error: 'Method Not Allowed' }, 405);

  try {
    // ── 0. Verificación JWT — antes de cualquier otra validación ─────────────
    const auth = await verifyDriverToken(request, env);
    if (!auth.ok) return auth.response;

    // ── 1. Tenant solo desde JWT (query/body no autorizan) ───────────────────
    const tenant_id = auth.payload.tenant_id;
    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    const urlTenant = new URL(request.url).searchParams.get('tenant_id');
    if (urlTenant) {
      const mismatch = requireMatchingTenant(auth.payload, urlTenant);
      if (mismatch) return mismatch;
    }

    const payload = await request.json();
    const { trip_id, stop_id, tipo_evento, latitud, longitud, foto_url, firma_url } = payload;
    const codigo_escaneado = payload.codigo_escaneado ?? payload.scanned_ot_id ?? null;

    if (!trip_id || !stop_id || !tipo_evento) {
      return jsonRes({ error: 'Payload incompleto. Requerido: trip_id, stop_id, tipo_evento' }, 400);
    }

    const EVENTOS_VALIDOS = ['LLEGADA', 'ENTREGA', 'SALIDA', 'PROBLEMA'];
    if (!EVENTOS_VALIDOS.includes(tipo_evento)) {
      return jsonRes({ error: `tipo_evento inválido. Permitidos: ${EVENTOS_VALIDOS.join(', ')}` }, 400);
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch },
    });

    // ── 2b. Trip asignado al chofer + stop pertenece al trip ─────────────────
    const ownership = await assertDriverCanMutateStop(supabase, auth.payload, {
      tenant_id,
      trip_id,
      stop_id,
      select: 'ot_id, trip_id, estado_operacional, metadata',
    });
    if (!ownership.ok) return ownership.response;

    const metaRawEarly = ownership.orden?.metadata;
    const metaEarly =
      typeof metaRawEarly === 'string'
        ? (() => { try { return JSON.parse(metaRawEarly); } catch { return {}; } })()
        : (metaRawEarly || {});

    let podReq = resolvePodRequirements({});
    if (tipo_evento === 'ENTREGA') {
      const tenantSettings = await getTenantSettings(env, tenant_id);
      podReq = resolvePodRequirements({
        tenantSettings,
        orderMetadata: metaEarly,
      });
      if (podReq.foto && !foto_url) {
        return jsonRes({ error: 'Operación denegada: La ENTREGA requiere foto_url (POD)', code: 'foto_required' }, 400);
      }
      if (podReq.firma && !firma_url) {
        return jsonRes({ error: 'Operación denegada: La ENTREGA requiere firma_url', code: 'firma_required' }, 400);
      }
      if (podReq.scan) {
        const codigo = normalizeScannedCode(codigo_escaneado);
        if (!codigo) {
          return jsonRes({
            error: 'Operación denegada: la ENTREGA requiere escanear el QR/código del paquete (codigo_escaneado)',
            code: 'scan_required',
          }, 400);
        }
      }
    }

    if (foto_url && !isTrustedEvidenceUrl(foto_url, env, tenant_id)) {
      return jsonRes({ error: 'foto_url no confiable: debe ser evidencia del tenant', code: 'untrusted_media_url' }, 400);
    }
    if (firma_url && !isTrustedEvidenceUrl(firma_url, env, tenant_id)) {
      return jsonRes({ error: 'firma_url no confiable: debe ser evidencia del tenant', code: 'untrusted_media_url' }, 400);
    }

    // C-11: verificar token HMAC / metadata.scan_token (no comparar dos inputs del cliente)
    if (tipo_evento === 'ENTREGA' && podReq.scan) {
      const scanCheck = await verifyPackageScan({
        scannedRaw: codigo_escaneado,
        stopId: stop_id,
        tenantId: tenant_id,
        env,
        storedToken: metaEarly.scan_token || null,
      });
      if (!scanCheck.ok) {
        return jsonRes({
          error: 'Código escaneado no coincide con la parada',
          code: scanCheck.code || 'scan_mismatch',
        }, 400);
      }
    }

    // S1: hora del device (offline) vs recepción servidor
    let lastEventIso = null;
    try {
      const { data: lastEv } = await supabase
        .from('bitacora_viajes')
        .select('created_at')
        .eq('tenant_id', tenant_id)
        .eq('trip_id', trip_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      lastEventIso = lastEv?.created_at || null;
    } catch {
      lastEventIso = null;
    }
    const resolvedTs = resolveEventTimestamp({
      deviceRaw: payload.evento_ts_device ?? payload.timestamp ?? null,
      lastEventIso,
    });
    const timestamp = resolvedTs.eventIso;
    const server_received_at = resolvedTs.serverReceivedIso;
    if (resolvedTs.source !== 'device') {
      console.warn('[EVENTO_TS]', tipo_evento, trip_id, resolvedTs.source, {
        device: resolvedTs.deviceIso,
        event: timestamp,
        server: server_received_at,
      });
    }

    // ── 3. LLEGADA ────────────────────────────────────────────────────────────
    if (tipo_evento === 'LLEGADA') {
      const { error: errLlegada } = await supabase
        .from('ordenes_pendientes')
        .update({ estado_operacional: 'EN_SITIO', hora_llegada_chofer: timestamp })
        .eq('ot_id', stop_id)
        .eq('trip_id', trip_id)
        .eq('tenant_id', tenant_id)
        .is('hora_llegada_chofer', null) // Inmutabilidad: no sobreescribir si ya llegó
        // C-6: no resucitar paradas ya cerradas (hora_llegada puede seguir NULL tras ENTREGA)
        .not('estado_operacional', 'in', '("ENTREGADO","RECHAZADO","CANCELADO_PLANILLA")');

      if (errLlegada) throw new Error(`LLEGADA DB error: ${errLlegada.message}`);

      await supabase.from('bitacora_viajes').insert([{
        tenant_id, trip_id, stop_id, tipo_evento: 'LLEGADA', latitud, longitud,
        created_at: timestamp, server_received_at,
      }]);

      return jsonRes({ exito: true, mensaje: 'Llegada registrada. Reloj SLA congelado.' });
    }

    // ── 4. ENTREGA ────────────────────────────────────────────────────────────
    if (tipo_evento === 'ENTREGA') {
      const codigoNorm = normalizeScannedCode(codigo_escaneado);
      const choferIdAuth = auth.payload.chofer_id || null;

      // A-14 + M-7: update atómico con guarda de estado + merge JSONB (no RMW)
      const entregaRes = await withDb(env, async (client) => {
        const params = [
          timestamp,
          foto_url || null,
          firma_url || null,
          JSON.stringify({
            codigo_escaneado: codigoNorm,
            escaneado_en: timestamp,
            ...(firma_url ? { firma_url } : {}),
          }),
          stop_id,
          trip_id,
          tenant_id,
        ];
        try {
          await client.query('SAVEPOINT sp_pod_firma');
          const upd = await client.query(
            `UPDATE ordenes_pendientes
             SET estado_operacional = 'ENTREGADO',
                 hora_real = $1::timestamptz,
                 evidencia_url = COALESCE($2, evidencia_url),
                 firma_url = COALESCE($3, firma_url),
                 metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
             WHERE ot_id = $5 AND trip_id = $6 AND tenant_id = $7
               AND estado_operacional NOT IN ('ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA')
             RETURNING eta, hora_llegada_chofer, hora_real, metadata, chofer_asignado_id, stop_sequence, cliente`,
            params
          );
          await client.query('RELEASE SAVEPOINT sp_pod_firma');
          return upd.rows[0] || null;
        } catch (updErr) {
          try { await client.query('ROLLBACK TO SAVEPOINT sp_pod_firma'); } catch (_) { /* ignore */ }
          // Migración 012 aún no aplicada: sin columna firma_url
          if (!/firma_url|42703|column .* does not exist/i.test(String(updErr.message || '') + updErr.code)) throw updErr;
          const upd = await client.query(
            `UPDATE ordenes_pendientes
             SET estado_operacional = 'ENTREGADO',
                 hora_real = $1::timestamptz,
                 evidencia_url = COALESCE($2, evidencia_url),
                 metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
             WHERE ot_id = $4 AND trip_id = $5 AND tenant_id = $6
               AND estado_operacional NOT IN ('ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA')
             RETURNING eta, hora_llegada_chofer, hora_real, metadata, chofer_asignado_id, stop_sequence, cliente`,
            [params[0], params[1], params[3], params[4], params[5], params[6]]
          );
          return upd.rows[0] || null;
        }
      }, { tenantId: tenant_id });

      if (!entregaRes) {
        return jsonRes({ exito: true, duplicate: true, mensaje: 'OT ya procesada anteriormente' });
      }

      await supabase.from('bitacora_viajes').insert([{
        tenant_id, trip_id, stop_id, tipo_evento: 'ENTREGA',
        evidencia_url: foto_url, latitud, longitud,
        created_at: timestamp, server_received_at,
        mensaje: `scan:${codigoNorm}`,
      }]);

      ctx.waitUntil(insertEtaMetric(supabase, {
        tenant_id,
        stop_id,
        trip_id,
        chofer_id: choferIdAuth,
        orden: entregaRes,
        hora_evento: timestamp,
      }));

      if (entregaRes?.hora_llegada_chofer) {
        ctx.waitUntil(upsertDwellStat(supabase, {
          tenant_id,
          cliente: entregaRes.cliente || null,
          chofer_id: choferIdAuth || entregaRes.chofer_asignado_id || null,
          llegadaIso: entregaRes.hora_llegada_chofer,
          finIso: entregaRes.hora_real || timestamp,
        }));
      }

      ctx.waitUntil(
        enqueueCustomerNotify(env, {
          tenantId: tenant_id,
          otId: stop_id,
          tripId: trip_id,
          eventType: 'ENTREGADO',
          hasPhoto: Boolean(foto_url),
        }).catch((e) => console.warn('[NOTIFY_ENTREGADO]', e.message))
      );

      // S7: registrar llegada real en guía (si existe) — no bloquea POD
      ctx.waitUntil(
        supabase.from('guias_despacho').update({
          fecha_llegada: timestamp,
          updated_at: new Date().toISOString(),
        })
          .eq('tenant_id', tenant_id)
          .eq('trip_id', trip_id)
          .eq('ot_id', stop_id)
          .then(({ error }) => {
            if (error && !/fecha_llegada|42703|column/i.test(error.message || '')) {
              console.warn('[DTE_FECHA_LLEGADA]', error.message);
            }
          })
          .catch((e) => console.warn('[DTE_FECHA_LLEGADA]', e.message))
      );

      return jsonRes({ exito: true, mensaje: 'Entrega confirmada con POD.' });
    }

    // ── 5. SALIDA ─────────────────────────────────────────────────────────────
    if (tipo_evento === 'SALIDA') {
      // DESPACHADO solo en la primera SALIDA del viaje (despacho real), no en cada parada
      let isFirstSalida = false;
      try {
        const prior = await withDb(env, async (client) => {
          const r = await client.query(
            `SELECT 1 FROM bitacora_viajes
             WHERE tenant_id = $1 AND trip_id = $2 AND tipo_evento = 'SALIDA'
             LIMIT 1`,
            [tenant_id, trip_id]
          );
          return r.rowCount > 0;
        }, { tenantId: tenant_id });
        isFirstSalida = !prior;
      } catch {
        isFirstSalida = false;
      }

      const { error: errSalida } = await supabase.from('bitacora_viajes').insert([{
        tenant_id, trip_id, stop_id, tipo_evento: 'SALIDA', latitud, longitud,
        created_at: timestamp, server_received_at,
      }]);
      if (errSalida) throw new Error(`SALIDA DB error: ${errSalida.message}`);

      if (isFirstSalida) {
        // Res. 154: hora de emisión = hora de inicio del traslado = SALIDA (reloj device)
        ctx.waitUntil((async () => {
          try {
            await emitGuiasForTrip(env, supabase, {
              tenant_id,
              trip_id,
              fecha_emision_iso: timestamp,
              rut_chofer: auth.payload.rut,
              ts_source: resolvedTs.source,
            });
          } catch (e) {
            console.warn('[DTE_EMIT_SALIDA]', e.message);
          }
          try {
            const { data: abiertas } = await supabase
              .from('ordenes_pendientes')
              .select('ot_id')
              .eq('trip_id', trip_id)
              .eq('tenant_id', tenant_id)
              .not('estado_operacional', 'in', '("ENTREGADO","RECHAZADO","CANCELADO_PLANILLA")');
            for (const o of abiertas || []) {
              await enqueueCustomerNotify(env, {
                tenantId: tenant_id,
                otId: o.ot_id,
                tripId: trip_id,
                eventType: 'DESPACHADO',
              });
            }
          } catch (e) {
            console.warn('[NOTIFY_DESPACHADO]', e.message);
          }
        })());
      }

      // Recálculo de ETA en segundo plano — §9 ctx.waitUntil()
      // OPTIMIZADO: Recalcular TODAS las paradas pendientes en cascada
      ctx.waitUntil((async () => {
        try {
          await withDb(env, async (pgClient) => {

          // Buscar TODAS las paradas pendientes
          const { data: paradasPendientes } = await supabase
            .from('ordenes_pendientes')
            .select('ot_id, cliente, stop_sequence, lat, lng, metadata')
            .eq('trip_id', trip_id)
            .eq('tenant_id', tenant_id)
            .not('estado_operacional', 'in', '("ENTREGADO","RECHAZADO","EN_SITIO","CANCELADO_PLANILLA")')
            .order('stop_sequence', { ascending: true});

          if (!paradasPendientes || paradasPendientes.length === 0) return;

          // Helper: merge atómico SQL
          const mergeRouting = async (otId, patch, etaIso) => {
            await pgClient.query(
              `UPDATE ordenes_pendientes
               SET eta = $1::timestamptz,
                   metadata = jsonb_set(
                     COALESCE(metadata, '{}'::jsonb),
                     '{routing}',
                     COALESCE(metadata->'routing', '{}'::jsonb) || $2::jsonb,
                     true
                   )
               WHERE ot_id = $3 AND tenant_id = $4`,
              [etaIso, JSON.stringify(patch), otId, tenant_id]
            );
          };

          // M-8: validar lat/lng del chofer (0 es válido; NaN / fuera de rango no)
          const parseGps = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          };
          let posLat = parseGps(latitud);
          let posLng = parseGps(longitud);
          const gpsOk = (la, ln) =>
            la != null && ln != null && Math.abs(la) <= 90 && Math.abs(ln) <= 180;
          if (!gpsOk(posLat, posLng)) {
            const { data: flota } = await supabase
              .from('flota_vehiculos')
              .select('ultima_lat, ultima_lng')
              .eq('trip_id_actual', trip_id)
              .eq('tenant_id', tenant_id)
              .maybeSingle();
            posLat = parseGps(flota?.ultima_lat);
            posLng = parseGps(flota?.ultima_lng);
          }

          if (!gpsOk(posLat, posLng)) {
            // Sin GPS — usar fallback de 20 min por parada
            for (let i = 0; i < paradasPendientes.length; i++) {
              const etaIso = new Date(Date.now() + (i + 1) * 20 * 60 * 1000).toISOString();
              await mergeRouting(paradasPendientes[i].ot_id, {
                eta_source: 'NO_GPS_FALLBACK',
                eta_error: 'Sin coordenadas del chofer',
                eta_recalculado_at: timestamp,
              }, etaIso);
            }
            return;
          }

          // F2 — velocidad calibrada (chofer×hora → hora → tenant → 35)
          const speedCal = await getEffectiveSpeedKmh(pgClient, {
            tenant_id,
            chofer_id: auth.payload.chofer_id || null,
            atIso: timestamp || new Date().toISOString(),
          });
          const vel = speedCal.velocidadKmH || CONFIG.VELOCIDAD_FALLBACK_KMH || 35;

          // Recalcular en cascada
          let tiempoAcumuladoSeg = 0;
          let posActualLat = posLat;
          let posActualLng = posLng;

          for (const parada of paradasPendientes) {
            // Pin exacto: orden.lat/lng → metadata → clientes
            let destinoLat = null, destinoLng = null;
            const meta = typeof parada.metadata === 'string'
              ? (() => { try { return JSON.parse(parada.metadata); } catch { return {}; } })()
              : (parada.metadata || {});
            const latOrden = Number(parada.lat ?? meta.lat_destino);
            const lngOrden = Number(parada.lng ?? meta.lng_destino);
            if (Number.isFinite(latOrden) && Number.isFinite(lngOrden)) {
              destinoLat = latOrden;
              destinoLng = lngOrden;
            } else if (parada.cliente) {
              const { data: cli } = await supabase
                .from('clientes')
                .select('lat, lng')
                .eq('tenant_id', tenant_id)
                .ilike('nombre_cliente_raw', parada.cliente)
                .maybeSingle();
              if (cli?.lat && cli?.lng) {
                destinoLat = Number(cli.lat);
                destinoLng = Number(cli.lng);
              }
            }

            if (!destinoLat || !destinoLng) {
              // Sin coordenadas — usar fallback
              tiempoAcumuladoSeg += 20 * 60; // 20 min
              const etaIso = new Date(Date.now() + tiempoAcumuladoSeg * 1000).toISOString();
              await mergeRouting(parada.ot_id, {
                eta_source: 'NO_COORDS_FALLBACK',
                eta_error: 'Sin coordenadas del destino',
                eta_recalculado_at: timestamp,
              }, etaIso);
              continue;
            }

            // Calcular distancia y tiempo
            const distanciaKm = calcularDistanciaKm(posActualLat, posActualLng, destinoLat, destinoLng);
            const duracionSeg = (distanciaKm / vel) * 3600;
            const tiempoServicioSeg = 5 * 60; // 5 min por parada

            tiempoAcumuladoSeg += duracionSeg + tiempoServicioSeg;

            const etaIso = new Date(Date.now() + tiempoAcumuladoSeg * 1000).toISOString();
            
            console.log(`[ETA_RECALC] ${parada.ot_id}: dist=${distanciaKm.toFixed(2)}km, vel=${vel}(${speedCal.source}), dur=${(duracionSeg/60).toFixed(1)}min, acum=${(tiempoAcumuladoSeg/60).toFixed(1)}min, eta=${etaIso}`);
            
            await mergeRouting(parada.ot_id, {
              eta_estimado: etaIso,
              eta_source: 'HAVERSINE_CASCADE',
              km_al_siguiente: Number(distanciaKm.toFixed(2)),
              velocidad_kmh: vel,
              velocidad_source: speedCal.source,
              eta_recalculado_at: timestamp,
            }, etaIso);

            // Actualizar posición para siguiente iteración
            posActualLat = destinoLat;
            posActualLng = destinoLng;
          }
          }, { tenantId: tenant_id });

        } catch (bgErr) {
          console.error('[SALIDA_ETA_RECALC_ERROR]', bgErr.message);
        }
      })());

      return jsonRes({ exito: true, mensaje: 'Salida registrada. ETA siguiente parada recalculando...' });
    }

    // ── 6. PROBLEMA ───────────────────────────────────────────────────────────
    if (tipo_evento === 'PROBLEMA') {
      const choferIdAuth = auth.payload.chofer_id || null;
      const problemaRes = await withDb(env, async (client) => {
        const upd = await client.query(
          `UPDATE ordenes_pendientes
           SET estado_operacional = 'RECHAZADO',
               hora_real = $1::timestamptz,
               evidencia_url = COALESCE($2, evidencia_url)
           WHERE ot_id = $3 AND trip_id = $4 AND tenant_id = $5
             AND estado_operacional NOT IN ('ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA')
           RETURNING eta, hora_llegada_chofer, hora_real, metadata, chofer_asignado_id, stop_sequence`,
          [timestamp, foto_url || null, stop_id, trip_id, tenant_id]
        );
        return upd.rows[0] || null;
      }, { tenantId: tenant_id });

      if (!problemaRes) {
        return jsonRes({ exito: true, duplicate: true, mensaje: 'OT ya procesada anteriormente' });
      }

      await supabase.from('bitacora_viajes').insert([{
        tenant_id, trip_id, stop_id, tipo_evento: 'PROBLEMA',
        mensaje: payload.razon || null, evidencia_url: foto_url || null,
        latitud, longitud, created_at: timestamp, server_received_at,
      }]);

      ctx.waitUntil(insertEtaMetric(supabase, {
        tenant_id,
        stop_id,
        trip_id,
        chofer_id: choferIdAuth,
        orden: problemaRes,
        hora_evento: timestamp,
      }));

      return jsonRes({ exito: true, mensaje: 'Problema registrado.' });
    }

  } catch (error) {
    console.error('[CHOFER_EVENTO_ERROR]', error.message);
    return jsonRes({ error: 'Internal Server Error' }, 500);
  }
}
