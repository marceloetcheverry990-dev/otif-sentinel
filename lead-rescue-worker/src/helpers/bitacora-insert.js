/**
 * Inserta filas en bitacora_viajes con el contrato real de la tabla.
 * rut_chofer es NOT NULL; latitud/longitud no existen como columnas.
 */
export async function insertBitacoraEvent(supabase, {
  tenant_id,
  trip_id,
  rut_chofer,
  tipo_evento,
  stop_id = null,
  mensaje = null,
  foto_url = null,
  evidencia_url = null,
  created_at = null,
  server_received_at = null,
  leido = false,
}) {
  const row = {
    tenant_id,
    trip_id,
    rut_chofer: rut_chofer || 'N/A',
    tipo_evento,
    leido,
  };
  if (stop_id) row.stop_id = stop_id;
  if (mensaje != null) row.mensaje = mensaje;
  if (foto_url) row.foto_url = foto_url;
  if (evidencia_url) row.evidencia_url = evidencia_url;
  if (created_at) row.created_at = created_at;
  if (server_received_at) row.server_received_at = server_received_at;

  const { error } = await supabase.from('bitacora_viajes').insert([row]);
  return { error };
}
