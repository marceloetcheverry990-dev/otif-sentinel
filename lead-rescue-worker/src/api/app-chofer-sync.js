// src/api/app-chofer-sync.js
import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { insertEtaMetric } from '../helpers/eta-metric.js';
import { verifyDriverToken } from '../helpers/driver-auth.js';
import { uploadEvidenceImage } from '../helpers/evidence-upload.js';
import {
  assertDriverOwnsTrip,
  requireMatchingTenant,
} from '../helpers/trip-ownership.js';

export async function syncChoferEvent(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  try {
    // Verificación JWT al inicio, antes de cualquier lógica de negocio
    const auth = await verifyDriverToken(request, env);
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const { tenant_id, rut, stopId, status, payload } = body;

    // Regla §3: Validación obligatoria de tenant_id
    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    const tenantMismatch = requireMatchingTenant(auth.payload, tenant_id);
    if (tenantMismatch) return tenantMismatch;

    // Verificación de autoría: el rut del token debe coincidir con el rut del body
    if (auth.payload.rut !== rut) {
      return new Response(
        JSON.stringify({ error: 'Prohibido: el token no corresponde al rut del body', code: 'rut_mismatch' }),
        { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Validación estricta de campos operativos
    if (!rut || !stopId || !status) {
      return new Response(
        JSON.stringify({ error: 'Bad Request: Faltan datos críticos (rut, stopId, status)' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Whitelist: el cliente no puede escribir estados operacionales arbitrarios
    const STATUS_MAP = {
      COMPLETADA: 'ENTREGADO',
      PROBLEMA: 'RECHAZADO',
      LLEGADA: 'EN_SITIO',
    };
    if (!(status in STATUS_MAP)) {
      return new Response(
        JSON.stringify({
          error: 'Bad Request: status inválido',
          code: 'invalid_status',
          allowed: Object.keys(STATUS_MAP),
        }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
    const estadoOperacional = STATUS_MAP[status];

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch: fetch }
    });

    // 1. Buscar primero el trip_id de la orden
    const { data: ordenInfo, error: errTrip } = await supabase
      .from('ordenes_pendientes')
      .select('trip_id, estado_operacional')
      .eq('ot_id', stopId)
      .eq('tenant_id', tenant_id)
      .single();
      
      if (errTrip || !ordenInfo?.trip_id) {
        throw new Error(`No se encontró trip_id para OT ${stopId}`);
      }

      // Ownership: el viaje de la OT debe estar asignado al chofer del token
      const tripErr = await assertDriverOwnsTrip(supabase, {
        trip_id: ordenInfo.trip_id,
        tenant_id,
        rut: auth.payload.rut,
      });
      if (tripErr) return tripErr;

      if (['ENTREGADO', 'RECHAZADO'].includes(ordenInfo?.estado_operacional)) {
        return new Response(
          JSON.stringify({ success: true, duplicate: true, message: 'Parada ya cerrada' }),
          { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }


      // ========================================
      // SUBIR FOTO A SUPABASE STORAGE
      // ========================================

      let publicPhotoUrl = null;

      if (payload?.photo) {
        const uploaded = await uploadEvidenceImage(supabase, {
          tenant_id,
          photo: payload.photo,
          prefix: `ot_${stopId}`,
        });
        if (!uploaded.ok) {
          console.error('[PHOTO ERROR]', uploaded.error);
          // A-6: no cerrar entrega/problema sin POD si la foto falló
          if (status === 'COMPLETADA' || status === 'PROBLEMA') {
            return new Response(
              JSON.stringify({
                error: 'No se pudo subir la evidencia fotográfica',
                code: 'photo_upload_failed',
                detalle: uploaded.error,
              }),
              { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
          }
        } else {
          publicPhotoUrl = uploaded.url;
          console.log('[PHOTO UPLOAD OK]', { url: publicPhotoUrl, fileName: uploaded.fileName });
        }
      }


      // M-20: orden primero (con guarda), bitácora después — evita dupes si falla el update
      const horaEvento = new Date().toISOString();
      const clientEventId = payload?.client_event_id || payload?.event_id || null;

      if (clientEventId) {
        const { data: already } = await supabase
          .from('bitacora_viajes')
          .select('id')
          .eq('tenant_id', tenant_id)
          .eq('stop_id', stopId)
          .eq('tipo_evento', status)
          .eq('mensaje', `idem:${clientEventId}`)
          .maybeSingle();
        if (already) {
          return new Response(
            JSON.stringify({ success: true, duplicate: true, message: 'Evento ya procesado' }),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
      }

      const ordenPatch = { estado_operacional: estadoOperacional };
      if (publicPhotoUrl) ordenPatch.evidencia_url = publicPhotoUrl;
      if (status === 'COMPLETADA' || status === 'PROBLEMA') {
        ordenPatch.hora_real = horaEvento;
      }

      const { data: ordenActualizada, error: errOrden } = await supabase
        .from('ordenes_pendientes')
        .update(ordenPatch)
        .eq('ot_id', stopId)
        .eq('trip_id', ordenInfo.trip_id)
        .eq('tenant_id', tenant_id)
        .not('estado_operacional', 'in', '("ENTREGADO","RECHAZADO")')
        .select('trip_id, hora_real, estado_operacional')
        .maybeSingle();

      if (errOrden) {
        throw new Error(`Fallo actualizando orden: ${errOrden.message}`);
      }
      if (!ordenActualizada) {
        return new Response(
          JSON.stringify({ success: true, duplicate: true, message: 'Parada ya cerrada' }),
          { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const { error: insertError } = await supabase
        .from('bitacora_viajes')
        .insert([{
          tenant_id,
          trip_id: ordenInfo.trip_id,
          rut_chofer: rut,
          stop_id: stopId,
          tipo_evento: status,
          mensaje: clientEventId ? `idem:${clientEventId}` : (payload?.reason || null),
          foto_url: publicPhotoUrl
        }]);

      if (insertError) {
        console.error('[BITACORA_AFTER_ORDER]', insertError.message);
        // Orden ya persistida — no 500 para no re-subir foto en loop infinito
      }

      // Capturar métricas ETA en background para estados terminales (COMPLETADA y PROBLEMA)
      if ((status === 'COMPLETADA' || status === 'PROBLEMA') && ctx) {
        const { data: ordenParaMetrica } = await supabase
          .from('ordenes_pendientes')
          .select('eta, hora_llegada_chofer, hora_real, metadata, chofer_asignado_id, stop_sequence')
          .eq('ot_id', stopId)
          .eq('tenant_id', tenant_id)
          .single();

        ctx.waitUntil(insertEtaMetric(supabase, {
          tenant_id,
          stop_id: stopId,
          trip_id: ordenInfo.trip_id,
          chofer_id: null,
          orden: ordenParaMetrica,
          hora_evento: horaEvento,
        }));
      }

      // 3. NUEVO: Lógica de Ciclo de Vida (Liberar camión si el viaje terminó)
      if (ordenActualizada?.trip_id) {
        const tripId = ordenActualizada.trip_id;
      
      // Contamos si quedan paradas pendientes en este viaje
        const { data: pendientes, error: errCount } = await supabase
  .from('ordenes_pendientes')
  .select('ot_id, estado_operacional, eta, hora_real')
  .eq('trip_id', tripId)
  .eq('tenant_id', tenant_id);

if (errCount) {
  throw new Error(`Error verificando pendientes: ${errCount.message}`);
}

      const CLOSED_STOPS = new Set([
        'ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA',
      ]);
      const quedanPendientes = (pendientes || []).some(
        (o) => !CLOSED_STOPS.has(String(o.estado_operacional || '').toUpperCase())
      );

      if (!quedanPendientes) {
        const { error: errLiberacion } = await supabase
          .from('flota_vehiculos')
          .update({
            trip_id_actual: null,
            estado: 'DISPONIBLE',
          })
          .eq('tenant_id', tenant_id)
          .eq('trip_id_actual', tripId);

        if (errLiberacion) {
          throw new Error(`Fallo liberando camión: ${errLiberacion.message}`);
        }

        // A-8: liberar chofer (optimizer filtra estado DISPONIBLE)
        const { data: tripMeta } = await supabase
          .from('trip_metrics')
          .select('chofer_id')
          .eq('trip_id', tripId)
          .eq('tenant_id', tenant_id)
          .maybeSingle();
        const choferIdLiberar = tripMeta?.chofer_id || auth.payload.chofer_id || null;
        if (choferIdLiberar) {
          await supabase
            .from('choferes')
            .update({ estado: 'DISPONIBLE' })
            .eq('tenant_id', tenant_id)
            .eq('chofer_id', choferIdLiberar);
        }

        // Calcular eta_error_promedio_min al cierre — solo stops con eta y hora_real registrados
        const { data: stopsConHoraReal } = await supabase
          .from('ordenes_pendientes')
          .select('eta, hora_real')
          .eq('trip_id', tripId)
          .eq('tenant_id', tenant_id)
          .not('hora_real', 'is', null)
          .not('eta', 'is', null);

        let etaErrorPromedio = null;
        let stopsConDato = 0;
        if (stopsConHoraReal && stopsConHoraReal.length > 0) {
          const errores = stopsConHoraReal
            .map(s => {
              const diffMin = (new Date(s.hora_real) - new Date(s.eta)) / 60000;
              return isNaN(diffMin) ? null : diffMin;
            })
            .filter(v => v !== null);
          if (errores.length > 0) {
            stopsConDato = errores.length;
            // Promedio de error absoluto, redondeado a 1 decimal
            etaErrorPromedio = Math.round(
              (errores.reduce((a, b) => a + Math.abs(b), 0) / errores.length) * 10
            ) / 10;
          }
        }

        // Contadores de outcomes del viaje
        const exitosas   = pendientes.filter(p => p.estado_operacional === 'ENTREGADO').length;
        const rechazadas = pendientes.filter(p => p.estado_operacional === 'RECHAZADO').length;
        const conRetraso = pendientes.filter(p =>
          p.estado_operacional === 'ENTREGADO' &&
          p.hora_real && p.eta &&
          (new Date(p.hora_real) - new Date(p.eta)) > 15 * 60 * 1000
        ).length;

        // Cerrar trip_metrics
        await supabase
          .from('trip_metrics')
          .update({
            estado:                   'finalizado',
            finalizado_at:            horaEvento,
            eta_error_promedio_min:   etaErrorPromedio,
            eta_error_stops_con_dato: stopsConDato,
            entregas_exitosas:        exitosas,
            entregas_rechazadas:      rechazadas,
            entregas_con_retraso:     conRetraso,
            updated_at:               horaEvento,
          })
          .eq('trip_id', tripId)
          .eq('tenant_id', tenant_id);
      }

    }

    return new Response(
      JSON.stringify({ success: true, message: 'Evento registrado y estado actualizado' }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[syncChoferEvent] Error crítico:', error.message);
    return new Response(
      JSON.stringify({ error: 'Internal Server Error' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}