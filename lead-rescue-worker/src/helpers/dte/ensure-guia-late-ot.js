/**
 * S9: si se agrega una OT a un viaje que ya tuvo SALIDA, crear deuda tributaria
 * (fila PENDING) y disparar emisión mode=retry.
 */

import { createClient } from '@supabase/supabase-js';
import { emitGuiasForTrip } from './emit-on-salida.js';

/**
 * @param {object} env
 * @param {object} [supabase]
 * @param {{ tenant_id: string, trip_id: string, ot_id: string, rut_chofer?: string|null, waitUntil?: Function }} opts
 */
export async function ensureGuiaForLateOt(env, supabase, opts) {
  const { tenant_id, trip_id, ot_id } = opts;
  if (!tenant_id || !trip_id || !ot_id) return { skipped: true, reason: 'missing_ids' };

  const sb = supabase || createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    global: { fetch },
  });

  const { data: salida } = await sb
    .from('bitacora_viajes')
    .select('created_at')
    .eq('tenant_id', tenant_id)
    .eq('trip_id', trip_id)
    .eq('tipo_evento', 'SALIDA')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!salida?.created_at) {
    return { skipped: true, reason: 'no_salida_yet' };
  }

  const { data: existing } = await sb
    .from('guias_despacho')
    .select('id, estado')
    .eq('tenant_id', tenant_id)
    .eq('trip_id', trip_id)
    .eq('ot_id', ot_id)
    .maybeSingle();

  if (existing && ['EMITIDA', 'EMITTING'].includes(existing.estado)) {
    return { skipped: true, reason: 'already_emitted' };
  }

  const now = new Date().toISOString();
  const fecha = new Date(salida.created_at).toISOString();
  if (existing?.id) {
    if (['ERROR', 'STUB', 'REVIEW', 'PENDING'].includes(existing.estado)) {
      await sb.from('guias_despacho').update({
        estado: 'PENDING',
        error: null,
        fecha_emision: fecha,
        updated_at: now,
      }).eq('id', existing.id);
    }
  } else {
    await sb.from('guias_despacho').insert([{
      tenant_id,
      trip_id,
      ot_id,
      estado: 'PENDING',
      fecha_emision: fecha,
      created_at: now,
      updated_at: now,
    }]);
  }

  let rut = opts.rut_chofer || null;
  if (!rut) {
    const { data: flota } = await sb
      .from('flota_vehiculos')
      .select('rut_chofer_asignado')
      .eq('tenant_id', tenant_id)
      .eq('trip_id_actual', trip_id)
      .maybeSingle();
    rut = flota?.rut_chofer_asignado || null;
  }
  if (!rut) {
    return { skipped: false, pending: true, reason: 'no_chofer_for_emit' };
  }

  const run = () => emitGuiasForTrip(env, sb, {
    tenant_id,
    trip_id,
    fecha_emision_iso: fecha,
    rut_chofer: rut,
    mode: 'retry',
    confirm_clamped_ts: true,
  });

  if (typeof opts.waitUntil === 'function') {
    opts.waitUntil(run().catch((e) => console.warn('[DTE_LATE_OT]', e.message)));
    return { skipped: false, queued: true };
  }
  const stats = await run();
  return { skipped: false, stats };
}
