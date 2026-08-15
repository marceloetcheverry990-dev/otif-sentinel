/**
 * F2 — Velocidad efectiva calibrada desde eta_accuracy_metrics.
 * Fallback chain: chofer×hora → hora → tenant → CONFIG.VELOCIDAD_FALLBACK_KMH.
 *
 * Usa SOLO error de viaje (error_viaje_minutos / LLEGADA).
 * Nunca meter dwell de andén en la velocidad de tránsito.
 */

import { CONFIG } from '../config.js';
import { santiagoDowHour } from './dwell-stats.js';
import { stripDwellFromError } from './travel-error.js';

const V0_DEFAULT = () => Number(CONFIG.VELOCIDAD_FALLBACK_KMH) || 35;
const V_MIN = 8;
const V_MAX = 80;
const CACHE_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, { exp: number, value: object }>} */
const _cache = new Map();

export function clampSpeedKmh(v) {
  if (!Number.isFinite(v)) return null;
  return Math.round(Math.min(V_MAX, Math.max(V_MIN, v)) * 10) / 10;
}

/**
 * Velocidad realizada a partir de distancia planificada @ v0 y error de VIAJE.
 * @param {number} [dwellMinInError] si el error crudo aún incluye dwell, restarlo aquí
 */
export function speedSampleFromMetric(
  distanciaKm,
  errorMinutos,
  v0 = V0_DEFAULT(),
  { dwellMinInError = 0 } = {}
) {
  const d = Number(distanciaKm);
  const err = stripDwellFromError(errorMinutos, dwellMinInError);
  const base = Math.max(1, Number(v0) || 35);
  if (!Number.isFinite(d) || d < 0.3 || d > 80) return null;
  if (err == null || !Number.isFinite(err)) return null;
  const plannedH = d / base;
  const actualH = Math.max(plannedH + err / 60, 0.05);
  return clampSpeedKmh(d / actualH);
}

export function median(nums) {
  const a = (nums || []).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 === 1 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Bias positivo (tarde) → reduce velocidad efectiva. */
export function speedFromBiasMin(biasMin, {
  v0 = V0_DEFAULT(),
  typicalLegMin = 20,
} = {}) {
  if (!Number.isFinite(biasMin)) return clampSpeedKmh(v0);
  const t0 = Math.max(5, Number(typicalLegMin) || 20);
  const actual = Math.max(t0 + Number(biasMin), 5);
  return clampSpeedKmh(Number(v0) * (t0 / actual));
}

/** Aplica factor clima relativo a la base histórica 35→25/15. */
export function applyClimaToSpeed(velocidadKmH, clima = 'NORMAL') {
  const v = Number(velocidadKmH);
  const base = Number.isFinite(v) ? v : V0_DEFAULT();
  switch (String(clima || 'NORMAL').toUpperCase()) {
    case 'LLUVIA':
      return clampSpeedKmh(base * (25 / 35));
    case 'NIEBLA':
      return clampSpeedKmh(base * (15 / 35));
    default:
      return clampSpeedKmh(base);
  }
}

function hourFromIso(iso) {
  const b = santiagoDowHour(iso || new Date());
  return b?.hour_bucket ?? null;
}

function travelErrorOfRow(r) {
  if (r.error_viaje_minutos != null && Number.isFinite(Number(r.error_viaje_minutos))) {
    return Number(r.error_viaje_minutos);
  }
  // Legado: solo confiar si arrival_basis=llegada
  if (String(r.arrival_basis || '') === 'llegada' && r.error_minutos != null) {
    return Number(r.error_minutos);
  }
  return null;
}

async function fetchMetricRows(clientOrSb, { tenant_id, days }) {
  const isPg = typeof clientOrSb?.query === 'function';
  if (isPg) {
    try {
      const res = await clientOrSb.query(
        `SELECT chofer_id, hora_real_llegada, distancia_restante_km,
                error_minutos, error_viaje_minutos, arrival_basis
         FROM eta_accuracy_metrics
         WHERE tenant_id = $1
           AND fecha >= (CURRENT_DATE - ($2::int))
           AND distancia_restante_km IS NOT NULL
           AND distancia_restante_km BETWEEN 0.3 AND 80
           AND (
             error_viaje_minutos IS NOT NULL
             OR arrival_basis = 'llegada'
           )
         ORDER BY hora_real_llegada DESC
         LIMIT 1000`,
        [tenant_id, days]
      );
      return res.rows || [];
    } catch (err) {
      // Pre-009: columna inexistente → vacío (no calibrar con datos contaminados)
      if (err?.code === '42703') return [];
      throw err;
    }
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  let q = clientOrSb
    .from('eta_accuracy_metrics')
    .select('chofer_id, hora_real_llegada, distancia_restante_km, error_minutos, error_viaje_minutos, arrival_basis')
    .eq('tenant_id', tenant_id)
    .gte('fecha', sinceStr)
    .not('distancia_restante_km', 'is', null)
    .gte('distancia_restante_km', 0.3)
    .lte('distancia_restante_km', 80)
    .order('hora_real_llegada', { ascending: false })
    .limit(1000);
  let { data, error } = await q;
  if (error && /error_viaje_minutos|arrival_basis/i.test(error.message || '')) {
    // Sin 009: no usar filas legacy ambiguas
    return [];
  }
  if (error) throw error;
  return (data || []).filter((r) => travelErrorOfRow(r) != null);
}

function speedsFromRows(rows, v0) {
  const out = [];
  for (const r of rows) {
    const travelErr = travelErrorOfRow(r);
    if (travelErr == null) continue;
    const v = speedSampleFromMetric(r.distancia_restante_km, travelErr, v0, {
      dwellMinInError: 0,
    });
    if (v != null) {
      out.push({
        v,
        chofer_id: r.chofer_id != null ? String(r.chofer_id) : null,
        hour_bucket: hourFromIso(r.hora_real_llegada),
        err: travelErr,
      });
    }
  }
  return out;
}

function pickTier(speeds, {
  chofer_id,
  hour_bucket,
  minSamplesChofer = 8,
  minSamplesHour = 15,
  minSamplesTenant = 30,
}) {
  const cid = chofer_id != null && chofer_id !== '' ? String(chofer_id) : null;

  if (cid != null && hour_bucket != null) {
    const subset = speeds.filter(
      (s) => s.chofer_id === cid && s.hour_bucket === hour_bucket
    );
    const med = median(subset.map((s) => s.v));
    if (subset.length >= minSamplesChofer && med != null) {
      return { velocidadKmH: med, source: 'chofer_hour', samples: subset.length };
    }
  }

  if (hour_bucket != null) {
    const subset = speeds.filter((s) => s.hour_bucket === hour_bucket);
    const med = median(subset.map((s) => s.v));
    if (subset.length >= minSamplesHour && med != null) {
      return { velocidadKmH: med, source: 'hour', samples: subset.length };
    }
  }

  const medTenant = median(speeds.map((s) => s.v));
  if (speeds.length >= minSamplesTenant && medTenant != null) {
    return { velocidadKmH: medTenant, source: 'tenant', samples: speeds.length };
  }

  // Pocas muestras con distancia: bias → multiplicador sobre v0
  if (speeds.length >= 5) {
    const bias = median(speeds.map((s) => s.err));
    const fromBias = speedFromBiasMin(bias, { v0: V0_DEFAULT() });
    return {
      velocidadKmH: fromBias,
      source: 'bias',
      samples: speeds.length,
    };
  }

  return {
    velocidadKmH: clampSpeedKmh(V0_DEFAULT()),
    source: 'config',
    samples: speeds.length,
  };
}

/**
 * @returns {Promise<{ velocidadKmH: number, source: string, samples: number }>}
 */
export async function lookupEffectiveSpeedKmh(clientOrSb, {
  tenant_id,
  chofer_id = null,
  atIso = new Date().toISOString(),
  days = 30,
  minSamplesChofer = 8,
  minSamplesHour = 15,
  minSamplesTenant = 30,
} = {}) {
  const v0 = V0_DEFAULT();
  if (!tenant_id) {
    return { velocidadKmH: clampSpeedKmh(v0), source: 'config', samples: 0 };
  }

  let rows = [];
  try {
    rows = await fetchMetricRows(clientOrSb, { tenant_id, days });
  } catch (err) {
    if (err?.code === '42P01') {
      return { velocidadKmH: clampSpeedKmh(v0), source: 'config', samples: 0 };
    }
    console.warn('[SPEED_CALIBRATION]', err.message);
    return { velocidadKmH: clampSpeedKmh(v0), source: 'config', samples: 0 };
  }

  const speeds = speedsFromRows(rows, v0);
  const hour_bucket = hourFromIso(atIso);
  return pickTier(speeds, {
    chofer_id,
    hour_bucket,
    minSamplesChofer,
    minSamplesHour,
    minSamplesTenant,
  });
}

/** Cached (isolate) — TTL 10 min. */
export async function getEffectiveSpeedKmh(clientOrSb, opts = {}, { ttlMs = CACHE_TTL_MS } = {}) {
  const hour = hourFromIso(opts.atIso || new Date().toISOString());
  const key = [
    opts.tenant_id || '',
    opts.chofer_id || '*',
    hour ?? '*',
    opts.days ?? 30,
  ].join('|');

  const hit = _cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;

  const value = await lookupEffectiveSpeedKmh(clientOrSb, opts);
  _cache.set(key, { exp: Date.now() + ttlMs, value });
  return value;
}

/** Test helper */
export function _clearSpeedCache() {
  _cache.clear();
}
