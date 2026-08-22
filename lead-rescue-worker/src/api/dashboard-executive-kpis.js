/**
 * Armado de KPIs ejecutivos: deltas nulos si no hay período previo.
 * Evita pintar "↗ 88.2% vs mes anterior" cuando anterior = 0 por falta de datos.
 */

export function comparisonCaption(period) {
  switch (period) {
    case 'today': return 'vs ayer';
    case 'week': return 'vs semana anterior';
    case 'month': return 'vs mes anterior';
    case 'year': return 'vs año anterior';
    default: return 'vs período anterior';
  }
}

function toNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pctChange(current, previous) {
  if (previous == null || previous === 0 || current == null) return null;
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

/**
 * @param {object} row  fila SQL de current_period × previous_period
 * @param {{ km_totales_mes?: *, km_promedio_ruta?: * }} kmData
 * @param {string} period
 */
export function buildExecutiveKpis(row = {}, kmData = {}, period = 'all') {
  const hasPrevious = Number(row.previous_total) > 0;
  const otifActual = toNum(row.otif_actual);
  const otifAnterior = toNum(row.otif_anterior);
  const ingresosActual = toNum(row.current_ingresos) ?? 0;
  const ingresosAnterior = toNum(row.previous_ingresos);
  const multasActual = toNum(row.current_multas) ?? 0;
  const multasAnterior = toNum(row.previous_multas);

  return {
    comparable: hasPrevious,
    comparison_caption: comparisonCaption(period),
    otif: {
      actual: otifActual == null ? 0 : otifActual,
      anterior: hasPrevious ? otifAnterior : null,
      cambio: hasPrevious && otifActual != null && otifAnterior != null
        ? Math.round((otifActual - otifAnterior) * 100) / 100
        : null,
    },
    entregas: {
      actual: parseInt(row.current_entregas || 0, 10),
      anterior: hasPrevious ? parseInt(row.previous_entregas || 0, 10) : null,
      crecimiento: hasPrevious
        ? pctChange(toNum(row.current_entregas) ?? 0, toNum(row.previous_entregas))
        : null,
    },
    ingresos: {
      actual: ingresosActual,
      anterior: hasPrevious ? (ingresosAnterior ?? 0) : null,
      crecimiento: hasPrevious ? pctChange(ingresosActual, ingresosAnterior) : null,
    },
    multas: {
      actual: multasActual,
      anterior: hasPrevious ? (multasAnterior ?? 0) : null,
    },
    kilometros: {
      totales: toNum(kmData.km_totales_mes) ?? 0,
      promedio: toNum(kmData.km_promedio_ruta) ?? 0,
    },
  };
}
