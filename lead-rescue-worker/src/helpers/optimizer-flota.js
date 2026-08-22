/** N° de camiones para /api/optimizar-rutas. 0 = congelar salidas (ops). */

export const FLOTA_MAX = 50;

/**
 * @param {*} raw
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
export function parseFlotaDisponible(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: 99 };
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    if (raw < 0 || raw > FLOTA_MAX) {
      return { ok: false, error: 'flota_disponible debe ser un entero entre 0 y ' + FLOTA_MAX };
    }
    return { ok: true, value: raw };
  }
  const text = String(raw).trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    return { ok: false, error: 'flota_disponible debe ser un entero ≥ 0' };
  }
  const n = parseInt(text, 10);
  if (n > FLOTA_MAX) {
    return { ok: false, error: 'flota_disponible máximo es ' + FLOTA_MAX };
  }
  return { ok: true, value: n };
}
