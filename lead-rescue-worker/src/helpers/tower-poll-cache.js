/**
 * Cache corto en isolate para polls de Torre.
 * Invalidar tras mutaciones para que la UI no quede 1 tick atrasada.
 */

const _viajesPollCache = new Map();
const _liveFleetCache = new Map();

const VIAJES_TTL_MS = 3500;
const GPS_TTL_MS = 2500;

export function getViajesPollCacheEntry(cacheKey) {
  const cached = _viajesPollCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < VIAJES_TTL_MS) return cached;
  return null;
}

export function setViajesPollCacheEntry(cacheKey, body) {
  _viajesPollCache.set(cacheKey, { at: Date.now(), body });
  if (_viajesPollCache.size > 40) {
    const oldest = [..._viajesPollCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _viajesPollCache.delete(oldest[0]);
  }
}

export function getLiveFleetCacheEntry(tenantId) {
  const key = String(tenantId);
  const cached = _liveFleetCache.get(key);
  if (cached && (Date.now() - cached.at) < GPS_TTL_MS) return cached;
  return null;
}

export function setLiveFleetCacheEntry(tenantId, body) {
  _liveFleetCache.set(String(tenantId), { at: Date.now(), body });
  if (_liveFleetCache.size > 20) {
    const oldest = [..._liveFleetCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _liveFleetCache.delete(oldest[0]);
  }
}

/** Invalida poll de viajes y GPS live para un tenant. */
export function invalidateTowerPoll(tenant_id) {
  if (!tenant_id) return;
  const prefix = `${tenant_id}|`;
  for (const key of [..._viajesPollCache.keys()]) {
    if (key.startsWith(prefix)) _viajesPollCache.delete(key);
  }
  _liveFleetCache.delete(String(tenant_id));
}
