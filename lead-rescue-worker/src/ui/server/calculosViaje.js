// src/ui/server/calculosViaje.js
// Funciones de cálculo server-side: financiero, SLA, sanitización y serialización.
// Todas las funciones son puras (sin efectos secundarios de red ni DB).

// ---------------------------------------------------------------------------
// Formateo de moneda
// ---------------------------------------------------------------------------
export const money = (val, moneyFormatterUser) => {
  try {
    return moneyFormatterUser
      ? moneyFormatterUser(val)
      : '$' + Number(val || 0).toLocaleString('es-CL');
  } catch (e) {
    return '$0';
  }
};

// ---------------------------------------------------------------------------
// Parseo defensivo de JSON
// ---------------------------------------------------------------------------
export const safeParseJSON = (data, fallback = {}) => {
  if (!data) return fallback;
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch (e) { return fallback; }
};

// ---------------------------------------------------------------------------
// Sanitización para template literals del servidor
// ---------------------------------------------------------------------------
export const safeVal = (v) =>
  String(v == null ? '' : v).replace(/`/g, '&#96;').replace(/\$\{/g, '&#36;{');

// Produce el override de escapeHTML que también escapa backticks y ${}.
// El escapeHTML original solo cubre &, < y > — no es suficiente para
// template literals. Retorna el escapeHTML sobreescrito y el safeVal.
export const buildSafeHelpers = (escapeHTMLOriginal) => {
  const _base = escapeHTMLOriginal;
  const escapeHTML = (text) => safeVal(_base(text));
  return { escapeHTML, safeVal };
};

// ---------------------------------------------------------------------------
// Serialización JSON segura (escapa < y > para evitar inyección HTML)
// ---------------------------------------------------------------------------
export const safeJsonStringify = (data) =>
  JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

// ---------------------------------------------------------------------------
// Formateo de hora en zona horaria de Chile
// ---------------------------------------------------------------------------
const TIME_CL = new Intl.DateTimeFormat('es-CL', {
  timeZone: 'America/Santiago',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

export const formatHoraCL = (fecha) => {
  if (!fecha) return '--:--';
  const d = new Date(fecha);
  if (isNaN(d.getTime())) {
    console.warn('[TIME] Fecha inválida:', fecha);
    return '--:--';
  }
  return TIME_CL.format(d);
};

// ---------------------------------------------------------------------------
// Cálculo de riesgos SLA, multas y totales financieros
// Muta v._multa_calculada y v._riesgo_dinamico en cada viaje (side-effect
// intencional — igual que el monolito original).
// ---------------------------------------------------------------------------
export const calcularRiesgosSla = (viajesSeguros) => {
  let totalDineroEnCalle = 0;
  let totalDineroRiesgo = 0;
  let totalParadasAbiertas = 0;
  const riesgosSla = [];
  const TERMINALES = new Set(['ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA']);

  viajesSeguros.forEach(v => {
    let multaCalculadaViaje = 0;
    let atrasosDinamicosViaje = 0;

    (v.detalle_paradas || []).forEach(p => {
      const estado = String(p.estado_operacional || '').toUpperCase();
      const isTerminal = TERMINALES.has(estado);
      const montoTotal = Number(p.monto_total || p.valor || 0);

      // Solo carga aún en calle (no entregada / cancelada)
      if (!isTerminal) {
        totalDineroEnCalle += montoTotal;
        totalParadasAbiertas += 1;
      }

      const isLate = Boolean(
        p.eta && p.fecha_hora_sla &&
        new Date(p.eta).getTime() > new Date(p.fecha_hora_sla).getTime()
      );

      if (isLate && !isTerminal) {
        atrasosDinamicosViaje++;
        const multaParada = montoTotal * 0.10;
        totalDineroRiesgo += multaParada;
        multaCalculadaViaje += multaParada;
        riesgosSla.push({ trip_id: v.trip_id, ot_id: p.ot_id, cliente: p.cliente });
      }
    });

    v._multa_calculada = multaCalculadaViaje;
    v._riesgo_dinamico = atrasosDinamicosViaje;
  });

  return { riesgosSla, totalDineroEnCalle, totalDineroRiesgo, totalParadasAbiertas };
};

// ---------------------------------------------------------------------------
// Ordenamiento de viajes por prioridad (riesgo > valor > trip_id)
// ---------------------------------------------------------------------------
export const sortViajesSeguros = (viajesSeguros) => {
  viajesSeguros.sort((a, b) => {
    const riesgoA = (Number(a.entregas_rechazadas) > 0 || Number(a._riesgo_dinamico) > 0 || Number(a.sla_risk_score) >= 50) ? 1 : 0;
    const riesgoB = (Number(b.entregas_rechazadas) > 0 || Number(b._riesgo_dinamico) > 0 || Number(b.sla_risk_score) >= 50) ? 1 : 0;
    if (riesgoA !== riesgoB) return riesgoB - riesgoA;
    const empA = Number(a.sla_risk_score) || 0;
    const empB = Number(b.sla_risk_score) || 0;
    if (empA !== empB) return empB - empA;
    if (a.valor_total_viaje !== b.valor_total_viaje)
      return Number(b.valor_total_viaje) - Number(a.valor_total_viaje);
    return String(a.trip_id || '').localeCompare(String(b.trip_id || ''));
  });
};

// ---------------------------------------------------------------------------
// Pre-calcular strings de hora y búsqueda en las paradas de cada viaje
// ---------------------------------------------------------------------------
export const formatearParadas = (viajesSeguros) => {
  viajesSeguros.forEach(v => {
    (v.detalle_paradas || []).forEach(p => {
      p._fecha_sla_str = formatHoraCL(p.fecha_hora_sla);
      p._hora_real_str = formatHoraCL(p.hora_real);
      p._eta_str       = formatHoraCL(p.eta);
      p._search_str    = `${p.ot_id} ${p.cliente}`.toLowerCase();
    });
    v._search_str =
      `${v.trip_id} ${v.chofer}`.toLowerCase() +
      ' ' +
      (v.detalle_paradas || []).map(p => p._search_str).join(' ');
  });
};

// ---------------------------------------------------------------------------
// Construir los JSON blobs para los <script type="application/json">
// ---------------------------------------------------------------------------
export const buildJsonBlobs = (ordenesSeguras, viajesSeguros, appConfig, listaChoferes, lastSyncDate) => {
  const tenantId = String(appConfig?.tenant_id || ordenesSeguras[0]?.tenant_id || 'empresa_base');

  const safeOrdenesJson  = safeJsonStringify(ordenesSeguras);
  const safeViajesJson   = safeJsonStringify(viajesSeguros);
  const safeConfigJson   = safeJsonStringify({
    ...appConfig,
    tenant_id: tenantId,
    last_sync_date: lastSyncDate || null
  });

  // Escapar < > como los demás blobs: un nombre con </script> cerraría el
  // <script type="application/json"> y filtraría JS al DOM como texto.
  const rawChoferesJson = safeJsonStringify(
    (listaChoferes || []).map(c => ({
      chofer_id: c.chofer_id,
      nombre_completo: c.nombre_completo || '',
      skill_score: c.skill_score,
      rut: c.rut || '',
      gps_interval_seconds: c.gps_interval_seconds || 60
    }))
  );

  return { safeOrdenesJson, safeViajesJson, safeConfigJson, rawChoferesJson, tenantId };
};
