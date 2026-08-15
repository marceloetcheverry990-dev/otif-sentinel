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
