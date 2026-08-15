/**
 * Muestreo de trail GPS: movimiento significativo o heartbeat periódico.
 */

/** @param {{ lastTrailAtMs?: number|null, nowMs?: number, deltaKm?: number, minIntervalSec?: number, moveThresholdKm?: number }} opts */
export function shouldSampleTrail(opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const last = opts.lastTrailAtMs ?? null;
  const deltaKm = Number(opts.deltaKm);
  const minIntervalSec = Number(opts.minIntervalSec) || 45;
  const moveThresholdKm = Number(opts.moveThresholdKm) || 0.05;

  const significant = Number.isFinite(deltaKm) && deltaKm >= moveThresholdKm;
  if (significant) return { sample: true, isHeartbeat: false };

  if (last == null || !Number.isFinite(last)) {
    return { sample: true, isHeartbeat: true };
  }
  const elapsedSec = (nowMs - last) / 1000;
  if (elapsedSec >= minIntervalSec) {
    return { sample: true, isHeartbeat: true };
  }
  return { sample: false, isHeartbeat: false };
}
