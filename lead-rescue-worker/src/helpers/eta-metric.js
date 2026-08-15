/**
 * Helper compartido: insertEtaMetric
 * 
 * Persiste una fila en eta_accuracy_metrics cuando una parada llega a estado terminal.
 * Diseñado para ser llamado con ctx.waitUntil() — falla silenciosamente sin afectar el chofer.
 *
 * error_minutos / error_viaje_minutos: medidos contra LLEGADA (viaje), nunca contra ENTREGA
 * (eso metería dwell en la calibración de velocidad F2).
 */

import { computeTravelErrorMinutos } from './travel-error.js';

/**
 * Mapa de confianza heurística por fuente ETA.
 * 
 * NOTA DE EVOLUCIÓN: En la versión actual, estos valores son heurísticos estáticos.
 * En versiones futuras, eta_confidence podrá calcularse dinámicamente a partir de
 * la precisión histórica real de cada fuente (AVG(error_absoluto_minutos) por eta_source),
 * derivado de los propios datos de eta_accuracy_metrics.
 */
const ETA_CONFIDENCE_MAP = {
  MAPBOX_TRAFFIC:     0.90,  // GPS activo + tráfico en tiempo real — mayor confianza
  OPTIMIZER_STATIC:   0.70,  // ETA inicial del optimizer sin recálculo posterior
  HAVERSINE_CASCADE:  0.55,  // Haversine con GPS — distancia exacta, velocidad estimada
  NO_GPS_FALLBACK:    0.20,  // Sin coordenadas GPS del chofer — fallback de 20min fijo
  NO_COORDS_FALLBACK: 0.15,  // Sin coordenadas del destino — fallback más precario
};

/**
 * Inserta una métrica de precisión ETA en eta_accuracy_metrics.
 * 
 * @param {object} supabase - Cliente Supabase ya instanciado del handler padre
 * @param {object} params
 * @param {string}      params.tenant_id   - Obligatorio
 * @param {string}      params.stop_id     - Obligatorio — clave única junto con tenant_id
 * @param {string|null} params.trip_id
 * @param {string|null} params.chofer_id   - Del payload o desde orden.chofer_asignado_id
 * @param {object}      params.orden       - Fila de ordenes_pendientes con: eta, hora_llegada_chofer, hora_real, metadata, chofer_asignado_id, stop_sequence
 * @param {string}      params.hora_evento - ISO timestamp del evento (último fallback para hora_real_llegada)
 */
export async function insertEtaMetric(supabase, params) {
  const { tenant_id, stop_id, trip_id, chofer_id, orden, hora_evento } = params;

  try {
    // Guard 1: eta_calculado requerido
    const eta_calculado = orden?.eta ?? null;
    if (!eta_calculado) {
      console.log(`[ETA_METRIC_SKIP] stop_id=${stop_id} — eta es null`);
      return;
    }

    // Solo LLEGADA = error de viaje. Sin LLEGADA no contaminamos F2/F3 con dwell.
    const travel = computeTravelErrorMinutos({
      etaIso: eta_calculado,
      llegadaIso: orden?.hora_llegada_chofer ?? null,
      entregaIso: orden?.hora_real ?? hora_evento ?? null,
    });
    if (!travel) {
      console.log(`[ETA_METRIC_SKIP] stop_id=${stop_id} — sin hora_llegada_chofer (evitar dwell en error de viaje)`);
      return;
    }

    const hora_real_llegada = travel.hora_referencia;
    const horaRealMs = Date.parse(hora_real_llegada);
    const error_minutos = travel.error_viaje_minutos;
    const error_viaje_minutos = travel.error_viaje_minutos;
    const arrival_basis = travel.basis;
    const error_absoluto_minutos = Math.abs(error_minutos);

    // Extracción de campos de contexto desde metadata.routing
    const routing = orden?.metadata?.routing ?? {};
    const eta_source             = routing.eta_source ?? null;
    const distancia_restante_km  = routing.km_al_siguiente ?? null;
    const optimization_run_id    = routing.optimization_run_id ?? null;

    // stop_sequence directo de la fila de la orden
    const stop_sequence = orden?.stop_sequence ?? null;

    // zona: siempre null en fase 1 — se poblará en fase 2 con lookup geográfico
    const zona = null;

    // Confianza heurística basada en la fuente del ETA
    const eta_confidence = eta_source !== null
      ? (ETA_CONFIDENCE_MAP[eta_source] ?? null)
      : null;

    // chofer_id: del payload primero, fallback desde la orden
    const choferIdFinal = chofer_id ?? orden?.chofer_asignado_id ?? null;

    // fecha derivada en JS respetando America/Santiago
    // Supabase JS SDK no soporta ON CONFLICT directamente — la idempotencia la garantiza
    // la constraint UNIQUE (tenant_id, stop_id) en la BD: un duplicado retorna error 23505
    // que capturamos silenciosamente abajo.
    const fechaStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(horaRealMs));

    const row = {
      tenant_id,
      trip_id,
      stop_id,
      chofer_id:              choferIdFinal,
      eta_calculado,
      hora_real_llegada,
      error_minutos,
      error_absoluto_minutos,
      error_viaje_minutos,
      arrival_basis,
      eta_source,
      distancia_restante_km,
      optimization_run_id,
      stop_sequence,
      zona,
      eta_confidence,
      fecha:                  fechaStr,
    };

    let { error: insertError } = await supabase
      .from('eta_accuracy_metrics')
      .insert(row);

    // Si 009 aún no está aplicada, reintentar sin columnas nuevas
    if (insertError && /error_viaje_minutos|arrival_basis/i.test(insertError.message || '')) {
      delete row.error_viaje_minutos;
      delete row.arrival_basis;
      ({ error: insertError } = await supabase.from('eta_accuracy_metrics').insert(row));
    }

    if (insertError) {
      // 23505 = violación UNIQUE (tenant_id, stop_id) → idempotencia garantizada, silencioso
      if (insertError.code === '23505') return;
      // 42P01 = tabla no existe (entorno sin migrar)
      if (insertError.code === '42P01') {
        console.error(`[ETA_METRIC_TABLE_MISSING] stop_id=${stop_id}`);
        return;
      }
      console.error(`[ETA_METRIC_ERROR] stop_id=${stop_id} error=${insertError.message}`);
    }

  } catch (err) {
    // Absorber cualquier error — el flujo del chofer nunca debe verse afectado
    if (err?.code === '42P01') {
      console.error(`[ETA_METRIC_TABLE_MISSING] stop_id=${stop_id}`);
      return;
    }
    console.error(`[ETA_METRIC_ERROR] stop_id=${stop_id} error=${err.message}`);
  }
}
