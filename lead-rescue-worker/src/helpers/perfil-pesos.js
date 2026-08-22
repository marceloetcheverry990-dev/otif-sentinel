/**
 * Pesos de ruteo por perfil. La tabla a veces tiene 1/1/0/0 en los cuatro modos;
 * el nombre del dropdown es el contrato visible, así que el modo manda.
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

export function perfilKeyFromNombre(nombre) {
  const n = String(nombre || '').toLowerCase();
  if (/ahorro|bencina|corta/.test(n)) return 'ahorro';
  if (/vip|monto/.test(n)) return 'vip';
  if (/salva|multa/.test(n)) return 'salvavidas';
  return 'equilibrado';
}

export function resolvePerfilPesos(row, fallbackNombre = 'Equilibrado') {
  const nombre = (row && row.nombre_perfil) || fallbackNombre;
  const key = perfilKeyFromNombre(nombre);
  return { ...PERFIL_PESOS[key], nombre_perfil: nombre, key };
}
