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

/**
 * Supabase client: verify trip is assigned to driver rut in tenant.
 * @returns {Promise<Response|null>}
 */
export async function assertDriverOwnsTrip(supabase, { trip_id, tenant_id, rut }) {
  const { data, error } = await supabase
    .from('flota_vehiculos')
    .select('rut_chofer_asignado')
    .eq('trip_id_actual', trip_id)
    .eq('tenant_id', tenant_id)
    .eq('rut_chofer_asignado', rut)
    .maybeSingle();

  if (error || !data) return tripNotAssignedResponse();
  return null;
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
  });
  if (tripErr) return { ok: false, response: tripErr };

  if (stop_id) {
    const stop = await assertStopOnTrip(supabase, { stop_id, trip_id, tenant_id, select });
    if (!stop.ok) return stop;
    return { ok: true, orden: stop.orden };
  }

  return { ok: true, orden: null };
}
