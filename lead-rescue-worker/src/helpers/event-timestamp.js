/**
 * Resuelve la hora operativa de un evento del chofer (Res.154 / bitácora).
 * Preferimos el reloj del device (offline); validamos y auditamos vs recepción servidor.
 */

const MAX_FUTURE_MS = 2 * 60 * 1000;
const MAX_PAST_MS = 12 * 60 * 60 * 1000;

/**
 * @param {unknown} raw — ISO string, epoch ms, o epoch seconds
 * @returns {number|null} epoch ms
 */
export function parseDeviceTimestamp(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // segundos vs ms
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  const d = Date.parse(s);
  return Number.isFinite(d) ? d : null;
}

/**
 * @param {{
 *   deviceRaw?: unknown,
 *   serverNowMs?: number,
 *   lastEventIso?: string|null,
 * }} opts
 * @returns {{
 *   eventIso: string,
 *   serverReceivedIso: string,
 *   source: 'device'|'server'|'clamped_future'|'clamped_past'|'clamped_mono',
 *   deviceIso: string|null,
 * }}
 */
export function resolveEventTimestamp(opts = {}) {
  const serverNowMs = Number.isFinite(opts.serverNowMs) ? opts.serverNowMs : Date.now();
  const serverReceivedIso = new Date(serverNowMs).toISOString();
  const deviceMs = parseDeviceTimestamp(opts.deviceRaw);
  const deviceIso = deviceMs != null ? new Date(deviceMs).toISOString() : null;

  if (deviceMs == null) {
    return {
      eventIso: serverReceivedIso,
      serverReceivedIso,
      source: 'server',
      deviceIso: null,
    };
  }

  let eventMs = deviceMs;
  let source = 'device';

  if (deviceMs > serverNowMs + MAX_FUTURE_MS) {
    eventMs = serverNowMs;
    source = 'clamped_future';
  } else if (deviceMs < serverNowMs - MAX_PAST_MS) {
    eventMs = serverNowMs;
    source = 'clamped_past';
  }

  const lastMs = opts.lastEventIso ? Date.parse(opts.lastEventIso) : NaN;
  if (Number.isFinite(lastMs) && eventMs < lastMs) {
    eventMs = lastMs;
    source = 'clamped_mono';
  }

  return {
    eventIso: new Date(eventMs).toISOString(),
    serverReceivedIso,
    source,
    deviceIso,
  };
}
