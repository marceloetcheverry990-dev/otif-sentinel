/**
 * S11: matching de clientes para destino Res.154.
 * Sin fallback nombre→dirección: un mismatch debe ser ERROR accionable.
 */

/**
 * @param {unknown} nombre
 * @returns {string}
 */
export function normalizeClienteNombre(nombre) {
  return String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} tenant_id
 * @param {string|null|undefined} nombre
 * @returns {Promise<{ cliente: object|null, reason: string|null }>}
 */
export async function resolveCliente(supabase, tenant_id, nombre) {
  if (!nombre || !String(nombre).trim()) {
    return { cliente: null, reason: 'cliente_vacio' };
  }
  const raw = String(nombre).trim();
  const norm = normalizeClienteNombre(raw);
  if (!norm) {
    return { cliente: null, reason: 'cliente_vacio' };
  }

  const { data: rows, error } = await supabase
    .from('clientes')
    .select('direccion_calle, comuna, nombre_cliente_raw')
    .eq('tenant_id', tenant_id)
    .ilike('nombre_cliente_raw', `%${raw}%`)
    .limit(25);

  if (error) {
    return { cliente: null, reason: `cliente_query_error:${error.message}` };
  }

  const list = rows || [];
  const exact = list.filter((r) => normalizeClienteNombre(r.nombre_cliente_raw) === norm);
  if (exact.length === 1) {
    return { cliente: exact[0], reason: null };
  }
  if (exact.length > 1) {
    return { cliente: null, reason: `ambiguous_cliente:${raw}` };
  }
  if (list.length === 1) {
    return { cliente: list[0], reason: null };
  }
  if (list.length === 0) {
    return { cliente: null, reason: `cliente_no_encontrado:${raw}` };
  }
  return { cliente: null, reason: `ambiguous_cliente:${raw}` };
}
