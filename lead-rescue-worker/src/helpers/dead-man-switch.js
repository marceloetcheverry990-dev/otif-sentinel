/**
 * Dead Man's Switch — detección de camión quieto / señal perdida.
 */

export const DEFAULT_DMS = {
  YELLOW_STUCK_MIN: 15,
  RED_STUCK_MIN: 40,
  SIGNAL_LOST_MIN: 15,
  RECENT_PING_MAX_MIN: 5,
};

/**
 * @param {{
 *   lastSignificantMoveAt: string|Date|null,
 *   ultimaActualizacion: string|Date|null,
 *   nowMs?: number,
 *   hasEnSitio?: boolean,
 *   thresholds?: Partial<typeof DEFAULT_DMS>
 * }} input
 * @returns {{ kind: 'ok'|'stuck'|'signal_lost', severity: 'YELLOW'|'RED'|null, stuckMinutes: number } }
 */
export function evaluateDeadMan(input) {
  const t = { ...DEFAULT_DMS, ...(input.thresholds || {}) };
  const now = input.nowMs ?? Date.now();

  if (input.hasEnSitio) {
    return { kind: 'ok', severity: null, stuckMinutes: 0 };
  }

  const moveAt = input.lastSignificantMoveAt
    ? Date.parse(input.lastSignificantMoveAt)
    : NaN;
  const pingAt = input.ultimaActualizacion
    ? Date.parse(input.ultimaActualizacion)
    : NaN;

  const stuckMinutes = Number.isFinite(moveAt)
    ? Math.floor((now - moveAt) / 60000)
    : Number.isFinite(pingAt)
      ? Math.floor((now - pingAt) / 60000)
      : 0;

  const pingAgeMin = Number.isFinite(pingAt) ? (now - pingAt) / 60000 : Infinity;

  // Sin pings recientes → señal perdida
  if (pingAgeMin >= t.SIGNAL_LOST_MIN) {
    const severity = pingAgeMin >= t.RED_STUCK_MIN ? 'RED' : 'YELLOW';
    return {
      kind: 'signal_lost',
      severity,
      stuckMinutes: Math.floor(pingAgeMin),
    };
  }

  // Pings vivos pero sin movimiento significativo
  if (stuckMinutes >= t.YELLOW_STUCK_MIN && pingAgeMin <= t.RECENT_PING_MAX_MIN) {
    const severity = stuckMinutes >= t.RED_STUCK_MIN ? 'RED' : 'YELLOW';
    return { kind: 'stuck', severity, stuckMinutes };
  }

  // Movimiento viejo pero ping aún no califica como signal_lost estricto
  if (stuckMinutes >= t.YELLOW_STUCK_MIN) {
    const severity = stuckMinutes >= t.RED_STUCK_MIN ? 'RED' : 'YELLOW';
    return { kind: 'stuck', severity, stuckMinutes };
  }

  return { kind: 'ok', severity: null, stuckMinutes: Math.max(0, stuckMinutes) };
}

export function alertTypeForKind(kind) {
  if (kind === 'signal_lost') return 'SIGNAL_LOST';
  if (kind === 'stuck') return 'STUCK_VEHICLE';
  return null;
}
