// Ownership checks for driver-scoped trip/stop mutations.

import { CORS_HEADERS } from '../config.js';

const jsonHeaders = () => ({ ...CORS_HEADERS, 'Content-Type': 'application/json' });

export function tenantMismatchResponse() {
  return new Response(
    JSON.stringify({
      error: 'Prohibido: tenant_id del token no coincide',
      code: 'tenant_mismatch',
    }),
    { status: 403, headers: jsonHeaders() }
  );
}

export function tripNotAssignedResponse() {
  return new Response(
    JSON.stringify({
      error: 'Prohibido: el viaje no está asignado a este chofer',
      code: 'trip_not_assigned',
    }),
    { status: 403, headers: jsonHeaders() }
  );
}

export function stopNotOnTripResponse() {
  return new Response(
    JSON.stringify({
      error: 'Prohibido: la parada no pertenece a este viaje',
      code: 'stop_not_on_trip',
    }),
    { status: 403, headers: jsonHeaders() }
  );
}

/**
 * @param {object} authPayload - driver JWT payload
 * @param {string} tenant_id
 * @returns {Response|null}
 */
export function requireMatchingTenant(authPayload, tenant_id) {
  if (!authPayload?.tenant_id || authPayload.tenant_id !== tenant_id) {
    return tenantMismatchResponse();
  }
  return null;
}

async function driverAssignedOnOrdenes(supabase, { trip_id, tenant_id, rut, chofer_id }) {
  let cid = chofer_id ? String(chofer_id) : null;
  if (!cid && rut) {
    const { data: ch } = await supabase
      .from('choferes')
      .select('chofer_id')
      .eq('tenant_id', tenant_id)
      .eq('rut', rut)
      .maybeSingle();
    cid = ch?.chofer_id ? String(ch.chofer_id) : null;
  }
  if (!cid) return false;

  const { data: ord } = await supabase
    .from('ordenes_pendientes')
    .select('ot_id')
    .eq('trip_id', trip_id)
    .eq('tenant_id', tenant_id)
    .eq('chofer_asignado_id', cid)
    .limit(1)
    .maybeSingle();
  return Boolean(ord);
}

async function driverRecentTripActivity(supabase, { trip_id, tenant_id, rut }) {
  if (!rut) return false;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('bitacora_viajes')
    .select('id')
    .eq('trip_id', trip_id)
    .eq('tenant_id', tenant_id)
    .eq('rut_chofer', rut)
    .gte('created_at', since)
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Supabase client: verify trip is assigned to driver (flota activa u ordenes).
 * @returns {Promise<Response|null>}
 */
export async function assertDriverOwnsTrip(supabase, { trip_id, tenant_id, rut, chofer_id }) {
  const { data, error } = await supabase
    .from('flota_vehiculos')
    .select('rut_chofer_asignado')
    .eq('trip_id_actual', trip_id)
    .eq('tenant_id', tenant_id)
    .eq('rut_chofer_asignado', rut)
    .maybeSingle();

  if (!error && data) return null;

  if (await driverAssignedOnOrdenes(supabase, { trip_id, tenant_id, rut, chofer_id })) {
    return null;
  }

  return tripNotAssignedResponse();
}

/**
 * Chat / lectura post-viaje: flota, ordenes o actividad reciente del chofer.
 * @returns {Promise<Response|null>}
 */
export async function assertDriverCanAccessTrip(supabase, { trip_id, tenant_id, rut, chofer_id }) {
  const err = await assertDriverOwnsTrip(supabase, { trip_id, tenant_id, rut, chofer_id });
  if (!err) return null;

  if (await driverRecentTripActivity(supabase, { trip_id, tenant_id, rut })) {
    return null;
  }

  return tripNotAssignedResponse();
}

/**
 * Supabase: OT belongs to trip + tenant.
 * @returns {Promise<{ ok: true, orden: object } | { ok: false, response: Response }>}
 */
export async function assertStopOnTrip(supabase, { stop_id, trip_id, tenant_id, select = 'ot_id, trip_id, estado_operacional' }) {
  const { data, error } = await supabase
    .from('ordenes_pendientes')
    .select(select)
    .eq('ot_id', stop_id)
    .eq('trip_id', trip_id)
    .eq('tenant_id', tenant_id)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, response: stopNotOnTripResponse() };
  }
  return { ok: true, orden: data };
}

/**
 * Combined: tenant match + trip assignment + stop on trip (when stop_id provided).
 */
export async function assertDriverCanMutateStop(supabase, authPayload, { tenant_id, trip_id, stop_id, select }) {
  const tenantErr = requireMatchingTenant(authPayload, tenant_id);
  if (tenantErr) return { ok: false, response: tenantErr };

  const tripErr = await assertDriverOwnsTrip(supabase, {
    trip_id,
    tenant_id,
    rut: authPayload.rut,
    chofer_id: authPayload.chofer_id || null,
  });
  if (tripErr) return { ok: false, response: tripErr };

  if (stop_id) {
    const stop = await assertStopOnTrip(supabase, { stop_id, trip_id, tenant_id, select });
    if (!stop.ok) return stop;
    return { ok: true, orden: stop.orden };
  }

  return { ok: true, orden: null };
}
