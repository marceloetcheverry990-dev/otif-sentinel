/**
 * Convierte hora de pared America/Santiago → ISO UTC.
 * Evita Date.UTC(...) que interpreta el wall-clock como UTC (A-3).
 */
export function santiagoWallToUtcIso(year, monthIndex, day, hours = 0, minutes = 0, seconds = 0) {
  const desiredAsUtc = Date.UTC(year, monthIndex, day, hours, minutes, seconds);
  let utcMs = desiredAsUtc;

  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utcMs));

    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const asSeenUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second')
    );
    utcMs += desiredAsUtc - asSeenUtc;
  }

  return new Date(utcMs).toISOString();
}

/**
 * Normaliza strings de fecha del CSV operativo (DD/MM/YYYY [HH:mm]) a ISO UTC
 * interpretando la hora como America/Santiago.
 */
/**
 * Parsea "HH:mm" / "HH:mm:ss" (0–23:59).
 * @returns {{ hours: number, minutes: number } | null}
 */
export function parseTimeOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

/**
 * Fecha/hora límite SLA para hoy en America/Santiago a partir de hora de pared.
 * Si la hora ya pasó respecto a refDate, usa el día siguiente.
 */
export function resolveSlaFromTimeOfDay(hhmm, refDate = new Date()) {
  const tod = parseTimeOfDay(hhmm);
  if (!tod) return null;

  const refMs = refDate instanceof Date ? refDate.getTime() : new Date(refDate).getTime();
  if (!Number.isFinite(refMs)) return null;

  const dayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(refMs));

  const get = (type) => Number(dayParts.find((p) => p.type === type)?.value);
  const year = get('year');
  const monthIndex = get('month') - 1;
  const day = get('day');
  if (![year, monthIndex, day].every(Number.isFinite)) return null;

  let iso = santiagoWallToUtcIso(year, monthIndex, day, tod.hours, tod.minutes);
  if (new Date(iso).getTime() <= refMs) {
    const next = new Date(refMs + 24 * 60 * 60 * 1000);
    const nextParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(next);
    const getN = (type) => Number(nextParts.find((p) => p.type === type)?.value);
    iso = santiagoWallToUtcIso(getN('year'), getN('month') - 1, getN('day'), tod.hours, tod.minutes);
  }
  return iso;
}

export function normalizeSantiagoDate(val) {
  if (!val) return null;
  const dateStr = String(val).trim();
  if (dateStr.includes('/')) {
    const parts = dateStr.split(/[\s/:]+/);
    if (parts.length < 3) return null;
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const year = parts[2].length === 2 ? 2000 + parseInt(parts[2], 10) : parseInt(parts[2], 10);
    const hours = parseInt(parts[3] || 0, 10);
    const minutes = parseInt(parts[4] || 0, 10);
    if (![day, month, year, hours, minutes].every(Number.isFinite)) return null;
    return santiagoWallToUtcIso(year, month, day, hours, minutes);
  }
  const d = new Date(dateStr);
  return !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}
