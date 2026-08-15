/**
 * Resuelve la hora del evento GPS desde el cliente (offline replay-safe).
 * Si el timestamp es inválido o fuera de rango, cae a now (recepción).
 */

export const GPS_TS_MAX_FUTURE_MS = 2 * 60 * 1000; // 2 min
export const GPS_TS_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 h

/**
 * @param {unknown} raw - ms epoch, seconds epoch, o ISO string
 * @param {number} [nowMs]
 * @returns {{ ms: number, iso: string, usedClient: boolean, reason: string|null }}
 */
export function resolveGpsEventTime(raw, nowMs = Date.now()) {
  if (raw == null || raw === '') {
    return { ms: nowMs, iso: new Date(nowMs).toISOString(), usedClient: false, reason: 'missing' };
  }

  let ms = NaN;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    ms = raw < 1e12 ? raw * 1000 : raw; // segundos vs ms
  } else if (typeof raw === 'string') {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && String(raw).trim() !== '') {
      ms = asNum < 1e12 ? asNum * 1000 : asNum;
    } else {
      ms = Date.parse(raw);
    }
  }

  if (!Number.isFinite(ms)) {
    return { ms: nowMs, iso: new Date(nowMs).toISOString(), usedClient: false, reason: 'unparseable' };
  }

  if (ms > nowMs + GPS_TS_MAX_FUTURE_MS) {
    return { ms: nowMs, iso: new Date(nowMs).toISOString(), usedClient: false, reason: 'future' };
  }
  if (ms < nowMs - GPS_TS_MAX_AGE_MS) {
    return { ms: nowMs, iso: new Date(nowMs).toISOString(), usedClient: false, reason: 'too_old' };
  }

  return { ms, iso: new Date(ms).toISOString(), usedClient: true, reason: null };
}
