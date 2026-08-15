/**
 * Separa error de VIAJE vs tiempo EN SITIO (dwell).
 *
 * Decisión de producto (crítica F2/F3):
 * - dwell = andén / servicio en cliente
 * - error de viaje = desviación del ETA de tránsito
 * No son la misma cosa; no deben sumarse dos veces.
 */

import { dwellMinutesBetween } from './dwell-stats.js';

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

/**
 * Error de viaje (min, + = tarde) usando llegada real al cliente.
 * Si solo hay hora de entrega (sin LLEGADA), no inventamos: retorna null
 * para no meter dwell en calibración de velocidad.
 *
 * @returns {{ error_viaje_minutos: number, hora_referencia: string, basis: 'llegada' } | null}
 */
export function computeTravelErrorMinutos({
  etaIso,
  llegadaIso = null,
  entregaIso = null,
} = {}) {
  const etaMs = Date.parse(etaIso);
  if (!Number.isFinite(etaMs)) return null;

  const llegadaMs = llegadaIso ? Date.parse(llegadaIso) : NaN;
  if (Number.isFinite(llegadaMs)) {
    return {
      error_viaje_minutos: round1((llegadaMs - etaMs) / 60000),
      hora_referencia: new Date(llegadaMs).toISOString(),
      basis: 'llegada',
    };
  }

  // Sin LLEGADA: no usar ENTREGA como proxy (incluye dwell).
  void entregaIso;
  return null;
}

/**
 * Si un error crudo pudo incluir dwell, restarlo.
 * dwellMinutos desconocido → no altera (caller decide no usar la muestra).
 */
export function stripDwellFromError(errorMinutos, dwellMinutos) {
  if (!Number.isFinite(Number(errorMinutos))) return null;
  const d = Number.isFinite(Number(dwellMinutos)) ? Math.max(0, Number(dwellMinutos)) : 0;
  return round1(Number(errorMinutos) - d);
}

/**
 * Dwell observado llegada→entrega, o null.
 */
export function observedDwellMinutos(llegadaIso, entregaIso) {
  return dwellMinutesBetween(llegadaIso, entregaIso);
}

/**
 * ¿El ETA ya incorpora corrección de tránsito (F2 / Mapbox)?
 * En ese caso F3 NO debe volver a sumar bias de viaje.
 */
export function etaAlreadyTravelCorrected(etaSource) {
  const s = String(etaSource || '').toUpperCase();
  return (
    s === 'HAVERSINE_CASCADE' ||
    s === 'MAPBOX_TRAFFIC' ||
    s === 'MAPBOX'
  );
}

/**
 * Cuándo F3 puede sumar bias de viaje además del dwell.
 * - ETA provisional (sin eta): sí (única señal de tránsito)
 * - HAVERSINE/MAPBOX: no (F2/Mapbox ya corrigió)
 * - source null con ETA real: no (evitar doble pena por defecto)
 * - OPTIMIZER_STATIC / NO_*_FALLBACK: sí
 */
export function shouldApplyTravelBias(etaSource, { provisional = false } = {}) {
  if (provisional) return true;
  const s = String(etaSource || '').toUpperCase();
  if (!s) return false;
  if (etaAlreadyTravelCorrected(s)) return false;
  return true;
}
