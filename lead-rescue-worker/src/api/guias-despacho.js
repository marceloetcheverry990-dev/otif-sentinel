// API operador: listar y reintentar guías de despacho Res. 154

import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { emitGuiasForTrip } from '../helpers/dte/emit-on-salida.js';

const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function supabaseClient(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    global: { fetch },
  });
}

/**
 * GET /api/guias-despacho?trip_id=... | ?ot_id=...
 */
export async function listGuiasDespacho(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  const url = new URL(request.url);
  const trip_id = url.searchParams.get('trip_id');
  const ot_id = url.searchParams.get('ot_id');

  const supabase = supabaseClient(env);
  let q = supabase
    .from('guias_despacho')
    .select('id, trip_id, ot_id, estado, folio, track_id, fecha_emision, tipo_traslado, patente, conductor_rut, conductor_nombre, origen_comuna, destino_comuna, error, proveedor, updated_at')
    .eq('tenant_id', tenant_id)
    .order('updated_at', { ascending: false })
    .limit(200);

  if (trip_id) q = q.eq('trip_id', trip_id);
  if (ot_id) q = q.eq('ot_id', ot_id);

  const { data, error } = await q;
  if (error) {
    if (/guias_despacho|does not exist|42P01/i.test(error.message)) {
      return json({ exito: true, guias: [], aviso: 'Migración 014 pendiente' });
    }
    return json({ error: error.message }, 500);
  }
  return json({ exito: true, guias: data || [] });
}

/**
 * S2: fecha de emisión = original del traslado, nunca "ahora".
 */
export async function resolveFechaEmisionRetry(supabase, tenant_id, trip_id) {
  const { data: guias } = await supabase
    .from('guias_despacho')
    .select('fecha_emision')
    .eq('tenant_id', tenant_id)
    .eq('trip_id', trip_id)
    .not('fecha_emision', 'is', null)
    .order('fecha_emision', { ascending: true })
    .limit(1);

  if (guias?.[0]?.fecha_emision) {
    return new Date(guias[0].fecha_emision).toISOString();
  }

  const { data: salida } = await supabase
    .from('bitacora_viajes')
    .select('created_at')
    .eq('tenant_id', tenant_id)
    .eq('trip_id', trip_id)
    .eq('tipo_evento', 'SALIDA')
    .order('created_at', { ascending: true })
    .limit(1);

  if (salida?.[0]?.created_at) {
    return new Date(salida[0].created_at).toISOString();
  }

  return null;
}

/**
 * POST /api/guias-despacho/retry
 * body: { trip_id } — reemite OTs del viaje en ERROR/PENDING/STUB (idempotente)
 */
export async function retryGuiasDespacho(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  const trip_id = body?.trip_id;
  if (!trip_id) return json({ error: 'trip_id requerido' }, 400);

  const supabase = supabaseClient(env);

  // Liberar ERROR / STUB / REVIEW (retry = confirmación de hora clampeada R3)
  await supabase
    .from('guias_despacho')
    .update({ estado: 'PENDING', error: null, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenant_id)
    .eq('trip_id', trip_id)
    .in('estado', ['ERROR', 'STUB', 'REVIEW']);

  const fecha_emision_iso = await resolveFechaEmisionRetry(supabase, tenant_id, trip_id);
  if (!fecha_emision_iso) {
    return json({
      error: 'No hay fecha de SALIDA ni fecha_emision previa para este viaje; no se puede reemitir con fecha tributaria válida',
    }, 400);
  }

  const { data: flota } = await supabase
    .from('flota_vehiculos')
    .select('rut_chofer_asignado')
    .eq('tenant_id', tenant_id)
    .eq('trip_id_actual', trip_id)
    .maybeSingle();

  let rut = flota?.rut_chofer_asignado;
  if (!rut) {
    const { data: ot } = await supabase
      .from('ordenes_pendientes')
      .select('chofer_asignado_id')
      .eq('tenant_id', tenant_id)
      .eq('trip_id', trip_id)
      .not('chofer_asignado_id', 'is', null)
      .limit(1)
      .maybeSingle();
    if (ot?.chofer_asignado_id) {
      const { data: ch } = await supabase
        .from('choferes')
        .select('rut')
        .eq('tenant_id', tenant_id)
        .eq('chofer_id', ot.chofer_asignado_id)
        .maybeSingle();
      rut = ch?.rut;
    }
  }

  if (!rut) {
    return json({ error: 'No se encontró chofer del viaje para reemitir' }, 400);
  }

  // R1: cola = guias_despacho (PENDING/ERROR/STUB), no OTs abiertas
  const stats = await emitGuiasForTrip(env, supabase, {
    tenant_id,
    trip_id,
    fecha_emision_iso,
    rut_chofer: rut,
    mode: 'retry',
    confirm_clamped_ts: true,
  });

  return json({ exito: true, fecha_emision_iso, ...stats });
}
