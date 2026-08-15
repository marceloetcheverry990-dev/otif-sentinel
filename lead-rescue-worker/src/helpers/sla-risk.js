/**
 * F3 — Riesgo SLA empírico pre-despacho.
 *
 * Separación explícita (anti doble conteo con F2):
 * - dwell_p90 = tiempo EN SITIO (servicio) — siempre se suma al finish
 * - travelBias = error sistemático de VIAJE — SOLO si el ETA aún no está
 *   corregido por F2/Mapbox (ver etaAlreadyTravelCorrected)
 * Nunca sumar bias crudo que incluya dwell + dwell_p90.
 */

import { santiagoDowHour } from './dwell-stats.js';
import { shouldApplyTravelBias } from './travel-error.js';

const MIN_DWELL_SAMPLES = 3;
const SERVICE_FALLBACK_MIN = 5;
const PROVISIONAL_TRAVEL_MIN = 25;

/**
 * Score 0–100 a partir de holgura (minutos). slack negativo = tarde.
 * @param {number|null|undefined} slackMin
 * @returns {{ score: number, level: 'ok'|'watch'|'risk'|'breach'|'unknown' }}
 */
export function scoreFromSlackMin(slackMin) {
  if (slackMin == null || !Number.isFinite(slackMin)) {
    return { score: 0, level: 'unknown' };
  }
  if (slackMin >= 30) {
    return { score: Math.max(0, Math.min(20, Math.round(20 - (slackMin - 30) / 10))), level: 'ok' };
  }
  if (slackMin >= 0) {
    return { score: Math.round(20 + (30 - slackMin) * (30 / 30)), level: 'watch' };
  }
  if (slackMin >= -30) {
    return { score: Math.round(50 + (-slackMin) * (30 / 30)), level: 'risk' };
  }
  const over = Math.min(40, -slackMin - 30);
  return { score: Math.min(100, Math.round(80 + over / 2)), level: 'breach' };
}

/**
 * @param {object} opts
 * @param {string|null} [opts.etaIso]
 * @param {string} opts.fechaHoraSla
 * @param {number|null} [opts.dwellP90Min] servicio en sitio — NO es bias de viaje
 * @param {number|null} [opts.etaBiasMin] bias de VIAJE (solo si applyTravelBias)
 * @param {string|null} [opts.etaSource] HAVERSINE_CASCADE / MAPBOX → no reaplicar bias
 * @param {boolean} [opts.applyTravelBias] override; default según etaSource
 * @param {number} [opts.serviceFallbackMin]
 * @param {number} [opts.provisionalTravelMin] si no hay ETA
 * @param {number} [opts.nowMs]
 * @param {string|null} [opts.cliente]
 */
export function scoreStopSlaRisk({
  etaIso = null,
  fechaHoraSla,
  dwellP90Min = null,
  etaBiasMin = null,
  etaSource = null,
  applyTravelBias = null,
  serviceFallbackMin = SERVICE_FALLBACK_MIN,
  provisionalTravelMin = PROVISIONAL_TRAVEL_MIN,
  nowMs = Date.now(),
  cliente = null,
} = {}) {
  const slaMs = Date.parse(fechaHoraSla);
  if (!Number.isFinite(slaMs)) {
    return { score: 0, level: 'unknown', slack_min: null, reason: null, cliente };
  }

  let etaMs = etaIso ? Date.parse(etaIso) : NaN;
  const provisional = !Number.isFinite(etaMs);
  if (provisional) {
    etaMs = nowMs + provisionalTravelMin * 60000;
  }

  const service = Number.isFinite(Number(dwellP90Min))
    ? Number(dwellP90Min)
    : serviceFallbackMin;

  const useBias =
    applyTravelBias != null
      ? Boolean(applyTravelBias)
      : shouldApplyTravelBias(etaSource, { provisional });
  const bias =
    useBias && Number.isFinite(Number(etaBiasMin)) ? Number(etaBiasMin) : 0;

  const finishMs = etaMs + (bias + service) * 60000;
  const slackMin = (slaMs - finishMs) / 60000;
  const { score, level } = scoreFromSlackMin(slackMin);

  let reason = null;
  if (level === 'risk' || level === 'breach') {
    const cli = cliente || 'Cliente';
    const dwellTxt = Number.isFinite(Number(dwellP90Min))
      ? `dwell p90 ${Number(dwellP90Min).toFixed(0)}m`
      : `servicio ~${serviceFallbackMin}m`;
    const biasTxt = bias !== 0 ? ` + bias viaje ${bias > 0 ? '+' : ''}${bias.toFixed(0)}m` : '';
    reason = `${cli}: ${dwellTxt}${biasTxt} → ${level === 'breach' ? 'quiebra' : 'riesgo'} SLA`;
  }

  return {
    score,
    level,
    slack_min: Math.round(slackMin * 10) / 10,
    reason,
    cliente,
    dwell_p90_min: Number.isFinite(Number(dwellP90Min)) ? Number(dwellP90Min) : null,
    eta_bias_min: bias || null,
    travel_bias_applied: useBias && bias !== 0,
  };
}

function clienteKey(cliente) {
  return String(cliente || '').trim().slice(0, 120);
}

/**
 * Dwell p90: exacto (cliente×chofer×dow×hora) → fallback promedio cliente/dow/hora.
 * @returns {Promise<number|null>}
 */
export async function lookupDwellP90(clientOrSb, {
  tenant_id,
  cliente,
  chofer_id = '',
  atIso = new Date().toISOString(),
  minSamples = MIN_DWELL_SAMPLES,
}) {
  const bucket = santiagoDowHour(atIso);
  const cli = clienteKey(cliente);
  if (!bucket || !cli || !tenant_id) return null;

  const choferKey = String(chofer_id || '').trim().slice(0, 64);
  const isPg = typeof clientOrSb?.query === 'function';

  if (isPg) {
    if (choferKey) {
      const exact = await clientOrSb.query(
        `SELECT dwell_p90_min, samples FROM stop_dwell_stats
         WHERE tenant_id = $1 AND cliente = $2 AND chofer_id = $3
           AND dow = $4 AND hour_bucket = $5
         LIMIT 1`,
        [tenant_id, cli, choferKey, bucket.dow, bucket.hour_bucket]
      );
      const row = exact.rows?.[0];
      if (row && Number(row.samples) >= minSamples && row.dwell_p90_min != null) {
        return Number(row.dwell_p90_min);
      }
    }
    const avg = await clientOrSb.query(
      `SELECT AVG(dwell_p90_min) AS p90, SUM(samples) AS samples
       FROM stop_dwell_stats
       WHERE tenant_id = $1 AND cliente = $2 AND dow = $3 AND hour_bucket = $4
         AND dwell_p90_min IS NOT NULL`,
      [tenant_id, cli, bucket.dow, bucket.hour_bucket]
    );
    const a = avg.rows?.[0];
    if (a && Number(a.samples) >= minSamples && a.p90 != null) return Number(a.p90);
    return null;
  }

  // Supabase client
  const sb = clientOrSb;
  if (choferKey) {
    const { data } = await sb
      .from('stop_dwell_stats')
      .select('dwell_p90_min, samples')
      .eq('tenant_id', tenant_id)
      .eq('cliente', cli)
      .eq('chofer_id', choferKey)
      .eq('dow', bucket.dow)
      .eq('hour_bucket', bucket.hour_bucket)
      .maybeSingle();
    if (data && Number(data.samples) >= minSamples && data.dwell_p90_min != null) {
      return Number(data.dwell_p90_min);
    }
  }
  const { data: rows } = await sb
    .from('stop_dwell_stats')
    .select('dwell_p90_min, samples')
    .eq('tenant_id', tenant_id)
    .eq('cliente', cli)
    .eq('dow', bucket.dow)
    .eq('hour_bucket', bucket.hour_bucket);
  if (!rows?.length) return null;
  let sumW = 0;
  let sumS = 0;
  for (const r of rows) {
    const s = Number(r.samples) || 0;
    if (r.dwell_p90_min == null || s <= 0) continue;
    sumW += Number(r.dwell_p90_min) * s;
    sumS += s;
  }
  if (sumS < minSamples) return null;
  return sumW / sumS;
}

/**
 * Bias de VIAJE (promedio). Prefiere error_viaje_minutos; ignora filas sin basis llegada.
 * @returns {Promise<number|null>}
 */
export async function lookupEtaBiasMin(clientOrSb, {
  tenant_id,
  chofer_id = null,
  days = 30,
  minSamples = 5,
}) {
  if (!tenant_id) return null;
  const isPg = typeof clientOrSb?.query === 'function';

  if (isPg) {
    const params = [tenant_id, days];
    let sql = `
      SELECT AVG(COALESCE(error_viaje_minutos, error_minutos))::float AS bias,
             COUNT(*)::int AS n
      FROM eta_accuracy_metrics
      WHERE tenant_id = $1
        AND fecha >= (CURRENT_DATE - ($2::int))
        AND (
          error_viaje_minutos IS NOT NULL
          OR arrival_basis = 'llegada'
        )`;
    if (chofer_id) {
      params.push(String(chofer_id));
      sql += ` AND chofer_id = $3`;
    }
    try {
      const res = await clientOrSb.query(sql, params);
      const row = res.rows?.[0];
      if (!row || Number(row.n) < minSamples || row.bias == null) return null;
      return Math.round(Number(row.bias) * 10) / 10;
    } catch (err) {
      if (err?.code === '42703') return null; // pre-009
      throw err;
    }
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  let q = clientOrSb
    .from('eta_accuracy_metrics')
    .select('error_minutos, error_viaje_minutos, arrival_basis')
    .eq('tenant_id', tenant_id)
    .gte('fecha', sinceStr)
    .limit(500);
  if (chofer_id) q = q.eq('chofer_id', String(chofer_id));
  const { data, error } = await q;
  if (error) return null;
  const vals = (data || [])
    .map((r) => {
      if (r.error_viaje_minutos != null) return Number(r.error_viaje_minutos);
      if (r.arrival_basis === 'llegada') return Number(r.error_minutos);
      return null;
    })
    .filter((n) => Number.isFinite(n));
  if (vals.length < minSamples) return null;
  const avg = vals.reduce((s, n) => s + n, 0) / vals.length;
  return Math.round(avg * 10) / 10;
}

/**
 * Precarga dwell + bias para enriquecer muchas órdenes (optimizer / dashboard).
 */
export async function loadSlaRiskLookups(clientOrSb, {
  tenant_id,
  clientes = [],
  choferIds = [],
  atIso = new Date().toISOString(),
}) {
  const bucket = santiagoDowHour(atIso) || santiagoDowHour(new Date());
  const cliSet = [...new Set(clientes.map(clienteKey).filter(Boolean))];
  const dwellByCliente = new Map(); // cli -> p90
  const biasByChofer = new Map();
  let biasTenant = null;

  const isPg = typeof clientOrSb?.query === 'function';

  if (isPg && bucket && cliSet.length) {
    const res = await clientOrSb.query(
      `SELECT cliente, SUM(samples) AS samples,
              CASE WHEN SUM(samples) > 0
                THEN SUM(dwell_p90_min * samples) / SUM(samples) END AS p90
       FROM stop_dwell_stats
       WHERE tenant_id = $1 AND dow = $2 AND hour_bucket = $3
         AND cliente = ANY($4::text[])
         AND dwell_p90_min IS NOT NULL
       GROUP BY cliente`,
      [tenant_id, bucket.dow, bucket.hour_bucket, cliSet]
    );
    for (const row of res.rows || []) {
      if (Number(row.samples) >= MIN_DWELL_SAMPLES && row.p90 != null) {
        dwellByCliente.set(clienteKey(row.cliente), Number(row.p90));
      }
    }
    biasTenant = await lookupEtaBiasMin(clientOrSb, { tenant_id });
    for (const cid of [...new Set(choferIds.map(String).filter(Boolean))]) {
      const b = await lookupEtaBiasMin(clientOrSb, { tenant_id, chofer_id: cid });
      if (b != null) biasByChofer.set(cid, b);
    }
  } else if (!isPg && bucket && cliSet.length) {
    const { data: rows } = await clientOrSb
      .from('stop_dwell_stats')
      .select('cliente, dwell_p90_min, samples')
      .eq('tenant_id', tenant_id)
      .eq('dow', bucket.dow)
      .eq('hour_bucket', bucket.hour_bucket)
      .in('cliente', cliSet);
    const acc = new Map();
    for (const r of rows || []) {
      const k = clienteKey(r.cliente);
      const cur = acc.get(k) || { w: 0, s: 0 };
      const s = Number(r.samples) || 0;
      if (r.dwell_p90_min == null || s <= 0) continue;
      cur.w += Number(r.dwell_p90_min) * s;
      cur.s += s;
      acc.set(k, cur);
    }
    for (const [k, cur] of acc) {
      if (cur.s >= MIN_DWELL_SAMPLES) dwellByCliente.set(k, cur.w / cur.s);
    }
    biasTenant = await lookupEtaBiasMin(clientOrSb, { tenant_id });
    for (const cid of [...new Set(choferIds.map(String).filter(Boolean))]) {
      const b = await lookupEtaBiasMin(clientOrSb, { tenant_id, chofer_id: cid });
      if (b != null) biasByChofer.set(cid, b);
    }
  } else {
    biasTenant = await lookupEtaBiasMin(clientOrSb, { tenant_id }).catch(() => null);
  }

  return {
    dwellByCliente,
    biasByChofer,
    biasTenant,
    getDwell(cliente) {
      return dwellByCliente.get(clienteKey(cliente)) ?? null;
    },
    getBias(choferId) {
      if (choferId && biasByChofer.has(String(choferId))) {
        return biasByChofer.get(String(choferId));
      }
      return biasTenant;
    },
  };
}

/**
 * Enriquece órdenes para VRP: setea riesgo_score y sla_risk.
 * Conserva max(score IA previo, empírico).
 */
export async function enrichOrdersWithSlaRisk(clientOrSb, tenant_id, ordenes, {
  atIso = new Date().toISOString(),
  nowMs = Date.now(),
} = {}) {
  if (!Array.isArray(ordenes) || !ordenes.length) return ordenes;

  const lookups = await loadSlaRiskLookups(clientOrSb, {
    tenant_id,
    clientes: ordenes.map((o) => o.cliente),
    choferIds: ordenes.map((o) => o.chofer_asignado_id || o.chofer_id).filter(Boolean),
    atIso,
  });

  for (const o of ordenes) {
    const prev = Number(o.riesgo_score) || 0;
    const meta = typeof o.metadata === 'string'
      ? (() => { try { return JSON.parse(o.metadata); } catch { return {}; } })()
      : (o.metadata || {});
    const etaSource = meta?.routing?.eta_source || o.eta_source || null;
    const risk = scoreStopSlaRisk({
      etaIso: o.eta || null,
      fechaHoraSla: o.fecha_hora_sla,
      dwellP90Min: lookups.getDwell(o.cliente),
      etaBiasMin: lookups.getBias(o.chofer_asignado_id || o.chofer_id),
      etaSource,
      nowMs,
      cliente: o.cliente,
      provisionalTravelMin: o.eta ? 0 : PROVISIONAL_TRAVEL_MIN,
    });
    o.riesgo_score = Math.max(prev, risk.score);
    o.sla_risk = risk;
  }
  return ordenes;
}

/**
 * Adjunta sla_risk a detalle_paradas y resumen en cada viaje (dashboard / poll).
 */
export async function attachSlaRiskToViajes(client, tenant_id, viajes, {
  atIso = new Date().toISOString(),
  nowMs = Date.now(),
} = {}) {
  if (!Array.isArray(viajes) || !viajes.length) return viajes;

  const clientes = [];
  const choferIds = [];
  for (const v of viajes) {
    if (v.chofer_id) choferIds.push(v.chofer_id);
    for (const p of v.detalle_paradas || []) {
      if (p.cliente) clientes.push(p.cliente);
    }
  }

  let lookups;
  try {
    lookups = await loadSlaRiskLookups(client, { tenant_id, clientes, choferIds, atIso });
  } catch (err) {
    console.warn('[SLA_RISK_LOOKUP]', err.message);
    return viajes;
  }

  const TERMINAL = new Set(['ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA']);

  for (const v of viajes) {
    let maxScore = 0;
    let worst = null;
    for (const p of v.detalle_paradas || []) {
      const st = String(p.estado_operacional || p.estado || '').toUpperCase();
      if (TERMINAL.has(st)) {
        p.sla_risk = null;
        continue;
      }
      const risk = scoreStopSlaRisk({
        etaIso: p.eta || null,
        fechaHoraSla: p.fecha_hora_sla,
        dwellP90Min: lookups.getDwell(p.cliente),
        etaBiasMin: lookups.getBias(v.chofer_id),
        etaSource: p.eta_source || null,
        nowMs,
        cliente: p.cliente,
        provisionalTravelMin: p.eta ? 0 : PROVISIONAL_TRAVEL_MIN,
      });
      p.sla_risk = risk;
      if (risk.score > maxScore) {
        maxScore = risk.score;
        worst = risk;
      }
    }
    v.sla_risk_score = maxScore;
    v.sla_risk_cliente = worst?.cliente || null;
    v.sla_risk_level = worst?.level || 'ok';
    v.sla_risk_reason = worst?.reason || null;
  }
  return viajes;
}
