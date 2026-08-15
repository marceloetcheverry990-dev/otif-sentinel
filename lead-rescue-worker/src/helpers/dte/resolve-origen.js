/**
 * S6: origen efectivo del traslado.
 * Preferir depot del viaje (metadata OTs / depot_id) y, si no, default;
 * lat/lng de la primera SALIDA como ancla GPS (sin reverse-geocode automático).
 */

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ tenant_id: string, trip_id: string }} ctx
 */
export async function resolveOrigenTraslado(supabase, { tenant_id, trip_id }) {
  let depot = null;

  // Depot referenciado en metadata de alguna OT del viaje
  const { data: ots } = await supabase
    .from('ordenes_pendientes')
    .select('metadata, depot_id')
    .eq('tenant_id', tenant_id)
    .eq('trip_id', trip_id)
    .limit(20);

  let depotId = null;
  for (const o of ots || []) {
    if (o.depot_id) {
      depotId = o.depot_id;
      break;
    }
    let meta = o.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    if (meta?.depot_id) {
      depotId = meta.depot_id;
      break;
    }
  }

  if (depotId) {
    const { data } = await supabase
      .from('depots')
      .select('nombre, direccion, comuna, lat, lng, is_default, activo')
      .eq('tenant_id', tenant_id)
      .eq('depot_id', depotId)
      .eq('activo', true)
      .maybeSingle();
    depot = data;
  }

  if (!depot) {
    const { data } = await supabase
      .from('depots')
      .select('nombre, direccion, comuna, lat, lng, is_default, activo')
      .eq('tenant_id', tenant_id)
      .eq('activo', true)
      .order('is_default', { ascending: false })
      .limit(1)
      .maybeSingle();
    depot = data;
  }

  // GPS de la primera SALIDA del viaje
  let salidaGps = null;
  const { data: salida } = await supabase
    .from('bitacora_viajes')
    .select('latitud, longitud, created_at')
    .eq('tenant_id', tenant_id)
    .eq('trip_id', trip_id)
    .eq('tipo_evento', 'SALIDA')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (salida?.latitud != null && salida?.longitud != null) {
    salidaGps = {
      lat: Number(salida.latitud),
      lng: Number(salida.longitud),
    };
  }

  return {
    origen_direccion: depot?.direccion || depot?.nombre || null,
    origen_comuna: depot?.comuna || null,
    origen_lat: Number.isFinite(salidaGps?.lat) ? salidaGps.lat : (depot?.lat != null ? Number(depot.lat) : null),
    origen_lng: Number.isFinite(salidaGps?.lng) ? salidaGps.lng : (depot?.lng != null ? Number(depot.lng) : null),
    origen_source: salidaGps ? 'salida_gps+depot' : 'depot',
  };
}
