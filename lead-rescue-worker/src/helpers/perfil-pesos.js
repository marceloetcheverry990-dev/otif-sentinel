/**
 * Pesos de ruteo por perfil. Los pesos numéricos de la tabla no se usan (a veces
 * tenían 1/1/0/0 en los cuatro modos): manda el modo. Desde la migración 029 el
 * modo se guarda en perfiles_optimizacion.modo, así renombrar un perfil no le
 * cambia el comportamiento. Sin esa columna se deduce del nombre (legado).
 */

export const PERFIL_PESOS = {
  equilibrado: {
    peso_distancia: 1.0,
    peso_sla: 1.0,
    peso_valor_carga: 0.4,
    peso_riesgo_ia: 0.4,
  },
  ahorro: {
    peso_distancia: 2.6,
    peso_sla: 0,
    peso_valor_carga: 0,
    peso_riesgo_ia: 0,
  },
  vip: {
    peso_distancia: 0.4,
    peso_sla: 0.45,
    peso_valor_carga: 3.2,
    peso_riesgo_ia: 0.2,
  },
  salvavidas: {
    peso_distancia: 0.35,
    peso_sla: 3.0,
    peso_valor_carga: 0.15,
    peso_riesgo_ia: 2.4,
  },
};

export const MODOS_PERFIL = Object.keys(PERFIL_PESOS);

export function perfilKeyFromNombre(nombre) {
  const n = String(nombre || '').toLowerCase();
  if (/ahorro|bencina|corta/.test(n)) return 'ahorro';
  if (/vip|monto/.test(n)) return 'vip';
  if (/salva|multa/.test(n)) return 'salvavidas';
  return 'equilibrado';
}

export function resolvePerfilPesos(row, fallbackNombre = 'Equilibrado') {
  const nombre = (row && row.nombre_perfil) || fallbackNombre;
  const modo = String((row && row.modo) || '').trim().toLowerCase();
  const desdeBd = MODOS_PERFIL.includes(modo);
  const key = desdeBd ? modo : perfilKeyFromNombre(nombre);
  return { ...PERFIL_PESOS[key], nombre_perfil: nombre, key, modo_origen: desdeBd ? 'bd' : 'nombre' };
}

const COLS = 'nombre_perfil, modo, tenant_id';
const COLS_SIN_MODO = 'nombre_perfil, tenant_id';

/**
 * Carga el perfil del tenant (o global) y devuelve sus pesos.
 * Acepta cliente Supabase o pg (quick-route). Tolera BD sin columna `modo`
 * (pre-029) y sin `tenant_id` (pre-011).
 */
export async function loadPerfilPesos(source, tenantId, perfilId) {
  const id = parseInt(perfilId, 10);
  if (!Number.isFinite(id) || !source) return resolvePerfilPesos(null);

  if (typeof source.query === 'function') {
    const intentos = [
      [`SELECT ${COLS} FROM perfiles_optimizacion WHERE perfil_id = $1 AND (tenant_id = $2 OR tenant_id IS NULL) LIMIT 1`, [id, tenantId]],
      [`SELECT ${COLS_SIN_MODO} FROM perfiles_optimizacion WHERE perfil_id = $1 AND (tenant_id = $2 OR tenant_id IS NULL) LIMIT 1`, [id, tenantId]],
      ['SELECT nombre_perfil FROM perfiles_optimizacion WHERE perfil_id = $1 LIMIT 1', [id]],
    ];
    for (let i = 0; i < intentos.length; i++) {
      const sp = `sp_perfil_${i}`;
      try {
        await source.query(`SAVEPOINT ${sp}`).catch(() => {});
        const res = await source.query(intentos[i][0], intentos[i][1]);
        await source.query(`RELEASE SAVEPOINT ${sp}`).catch(() => {});
        return resolvePerfilPesos(res.rows[0] || null);
      } catch (e) {
        await source.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
        if (e.code !== '42703' && !/column .* does not exist/i.test(String(e.message || ''))) {
          console.warn('[PERFIL]', e.message);
          return resolvePerfilPesos(null);
        }
      }
    }
    return resolvePerfilPesos(null);
  }

  const q = (cols, withTenant) => {
    let b = source.from('perfiles_optimizacion').select(cols).eq('perfil_id', id);
    if (withTenant) b = b.or(`tenant_id.eq.${tenantId},tenant_id.is.null`);
    return b.maybeSingle();
  };
  let { data, error } = await q(COLS, true);
  if (error && /modo/.test(String(error.message || ''))) ({ data, error } = await q(COLS_SIN_MODO, true));
  if (error && /tenant_id/.test(String(error.message || ''))) ({ data, error } = await q('nombre_perfil', false));
  if (error) console.warn('[PERFIL]', error.message);
  if (!data) console.warn('[PERFIL] no encontrado; uso Equilibrado', id);
  return resolvePerfilPesos(data || null);
}
