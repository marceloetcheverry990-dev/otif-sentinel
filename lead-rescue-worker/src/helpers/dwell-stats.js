/**
 * Agregación empírica de tiempo en sitio (dwell) por cliente × chofer × dow × hora.
 */

const MAX_RECENT = 40;

/**
 * @param {number[]} samples
 * @returns {{ p50: number|null, p90: number|null }}
 */
export function computePercentiles(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { p50: null, p90: null };
  }
  const sorted = samples
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return { p50: null, p90: null };

  const at = (q) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return Math.round(sorted[idx] * 10) / 10;
  };
  return { p50: at(0.5), p90: at(0.9) };
}

/**
 * Bucket temporal en America/Santiago.
 * @param {string|Date} iso
 * @returns {{ dow: number, hour_bucket: number } | null}
 */
export function santiagoDowHour(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago',
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(d);
  const wd = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  if (wd == null || !(wd in map) || !Number.isFinite(hour)) return null;
  return { dow: map[wd], hour_bucket: hour };
}

/**
 * Minutos entre llegada y entrega/salida.
 * @returns {number|null}
 */
export function dwellMinutesBetween(llegadaIso, finIso) {
  const a = Date.parse(llegadaIso);
  const b = Date.parse(finIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round(((b - a) / 60000) * 10) / 10;
}

/**
 * Fusiona un dwell nuevo en el estado agregado.
 * @param {{ samples?: number, dwell_sum_min?: number, recent_samples?: number[] }} prev
 * @param {number} dwellMin
 */
export function mergeDwellSample(prev, dwellMin) {
  const dwell = Math.round(Number(dwellMin) * 10) / 10;
  const samples = (Number(prev?.samples) || 0) + 1;
  const dwell_sum_min = (Number(prev?.dwell_sum_min) || 0) + dwell;
  const recent = Array.isArray(prev?.recent_samples) ? [...prev.recent_samples] : [];
  recent.push(dwell);
  while (recent.length > MAX_RECENT) recent.shift();
  const { p50, p90 } = computePercentiles(recent);
  return {
    samples,
    dwell_sum_min: Math.round(dwell_sum_min * 10) / 10,
    dwell_avg_min: Math.round((dwell_sum_min / samples) * 10) / 10,
    dwell_p50_min: p50,
    dwell_p90_min: p90,
    recent_samples: recent,
  };
}

/**
 * Upsert vía Supabase (flujo chofer). Falla en silencio.
 */
export async function upsertDwellStat(supabase, {
  tenant_id,
  cliente,
  chofer_id,
  llegadaIso,
  finIso,
}) {
  try {
    const dwell = dwellMinutesBetween(llegadaIso, finIso);
    if (dwell == null || dwell < 0.5 || dwell > 480) return;

    const bucket = santiagoDowHour(finIso || llegadaIso);
    if (!bucket) return;

    const clienteKey = String(cliente || '').trim().slice(0, 120);
    if (!clienteKey) return;
    const choferKey = String(chofer_id || '').trim().slice(0, 64);

    const { data: existing } = await supabase
      .from('stop_dwell_stats')
      .select('samples, dwell_sum_min, recent_samples')
      .eq('tenant_id', tenant_id)
      .eq('cliente', clienteKey)
      .eq('chofer_id', choferKey)
      .eq('dow', bucket.dow)
      .eq('hour_bucket', bucket.hour_bucket)
      .maybeSingle();

    const merged = mergeDwellSample(
      {
        samples: existing?.samples,
        dwell_sum_min: existing?.dwell_sum_min,
        recent_samples: existing?.recent_samples,
      },
      dwell
    );

    const { error } = await supabase.from('stop_dwell_stats').upsert(
      {
        tenant_id,
        cliente: clienteKey,
        chofer_id: choferKey,
        dow: bucket.dow,
        hour_bucket: bucket.hour_bucket,
        ...merged,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tenant_id,cliente,chofer_id,dow,hour_bucket' }
    );

    if (error) {
      if (error.code === '42P01') {
        console.error('[DWELL_TABLE_MISSING]');
        return;
      }
      console.error('[DWELL_UPSERT_ERROR]', error.message);
    }
  } catch (err) {
    console.error('[DWELL_UPSERT_ERROR]', err.message);
  }
}
