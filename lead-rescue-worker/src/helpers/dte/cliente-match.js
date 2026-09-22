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

  // Match exacto (case/acento-insensitive) primero, sin LIMIT: si hay muchos
  // clientes cuyo nombre contiene `raw` como substring, el fuzzy de abajo
  // (con LIMIT 25 y sin ORDER BY) puede truncar la lista antes de llegar al
  // match exacto real — acá no, porque ILIKE sin comodines ya filtra por
  // igualdad y el set de candidatos es chico.
  const exactRes = await supabase
    .from('clientes')
    .select('direccion_calle, comuna, nombre_cliente_raw')
    .eq('tenant_id', tenant_id)
    .ilike('nombre_cliente_raw', raw);

  if (exactRes.error) {
    return { cliente: null, reason: `cliente_query_error:${exactRes.error.message}` };
  }
  const exactRows = (exactRes.data || []).filter(
    (r) => normalizeClienteNombre(r.nombre_cliente_raw) === norm
  );
  if (exactRows.length === 1) {
    return { cliente: exactRows[0], reason: null };
  }
  if (exactRows.length > 1) {
    return { cliente: null, reason: `ambiguous_cliente:${raw}` };
  }

  // Sin match exacto: buscar por substring, con orden determinístico (antes
  // no tenía ORDER BY — Postgres no garantiza orden estable sin uno, así que
  // qué 25 filas quedaban dentro del LIMIT podía variar entre llamadas).
  const { data: rows, error } = await supabase
    .from('clientes')
    .select('direccion_calle, comuna, nombre_cliente_raw')
    .eq('tenant_id', tenant_id)
    .ilike('nombre_cliente_raw', `%${raw}%`)
    .order('nombre_cliente_raw', { ascending: true })
    .limit(25);

  if (error) {
    return { cliente: null, reason: `cliente_query_error:${error.message}` };
  }

  const list = rows || [];
  if (list.length === 1) {
    return { cliente: list[0], reason: null };
  }
  if (list.length === 0) {
    return { cliente: null, reason: `cliente_no_encontrado:${raw}` };
  }
  return { cliente: null, reason: `ambiguous_cliente:${raw}` };
}
