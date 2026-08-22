/**
 * Comprobante DTE tipo 52 (Guía de Despacho Electrónica) — Res. Ex. SII N°154.
 * Arma la vista fiscalizable a partir de guias_despacho + payload_enviado + identidad emisor.
 */

import { IND_TRASLADO_SII } from './simpleapi-client.js';

const IND_LABEL = {
  1: 'Operación constituye venta',
  5: 'Traslados internos',
  6: 'Otros traslados no venta',
  7: 'Guía de devolución',
};

const TIPO_DESPACHO_LABEL = {
  1: 'Despacho por cuenta del receptor',
  2: 'Despacho por cuenta del emisor a instalaciones del cliente',
  3: 'Despacho por cuenta del emisor a otras instalaciones',
};

/**
 * @param {object|null|undefined} guia — fila guias_despacho (+ payload_enviado)
 * @param {{ DTE_RUT_EMISOR?: string|null, DTE_RAZON_SOCIAL?: string|null, DTE_AMBIENTE?: string|null }} [emisorEnv]
 */
export function buildComprobanteDte52(guia, emisorEnv = {}) {
  const g = guia && typeof guia === 'object' ? guia : {};
  const p = normalizePayload(g.payload_enviado);

  let tipoTrasladoKey = String(g.tipo_traslado || p.tipo_traslado || 'VENTA').toUpperCase();
  // Despacho a cliente tipificado históricamente como OTRO → IndTraslado 1 (venta).
  if (tipoTrasladoKey === 'OTRO') tipoTrasladoKey = 'VENTA';
  const indTraslado = IND_TRASLADO_SII[tipoTrasladoKey] ?? IND_TRASLADO_SII.OTRO;
  const tipoDespacho = Number(p.tipo_despacho || 2) || 2;

  const emisorRut = emisorEnv.DTE_RUT_EMISOR || p.emisor_rut || null;
  const emisorRazon = emisorEnv.DTE_RAZON_SOCIAL || p.emisor_razon_social || null;
  const ambiente = emisorEnv.DTE_AMBIENTE || p.ambiente || 'certificacion';

  const comprobante = {
    tipo_dte: 52,
    tipo_dte_glosa: 'Guía de Despacho Electrónica',
    normativa: 'Res. Ex. SII N°154/2025 · obligatoria desde 1 nov 2026',
    ambiente,
    estado: g.estado || null,
    folio: g.folio || null,
    track_id: g.track_id || null,
    proveedor: g.proveedor || null,
    referencia_externa: `${g.tenant_id || p.tenant_id || ''}:${g.ot_id || p.ot_id || ''}:${g.trip_id || p.trip_id || ''}`.replace(/^:+|:+$/g, '') || null,
    fecha_emision: g.fecha_emision || p.fecha_emision_iso || null,
    fecha_estimada_entrega: g.fecha_estimada_entrega || p.fecha_estimada_entrega || null,
    ind_traslado: indTraslado,
    ind_traslado_glosa: IND_LABEL[indTraslado] || tipoTrasladoKey,
    tipo_traslado: tipoTrasladoKey,
    tipo_despacho: tipoDespacho,
    tipo_despacho_glosa: TIPO_DESPACHO_LABEL[tipoDespacho] || String(tipoDespacho),
    emisor: {
      rut: emisorRut,
      razon_social: emisorRazon,
    },
    receptor: {
      rut: p.cliente_rut || g.cliente_rut || null,
      razon_social: p.cliente_nombre || g.cliente_nombre || null,
    },
    transporte: {
      patente: g.patente || p.patente || null,
      conductor_rut: g.conductor_rut || p.conductor_rut || null,
      conductor_nombre: g.conductor_nombre || p.conductor_nombre || null,
      origen_direccion: g.origen_direccion || p.origen_direccion || null,
      origen_comuna: g.origen_comuna || p.origen_comuna || null,
      destino_direccion: g.destino_direccion || p.destino_direccion || null,
      destino_comuna: g.destino_comuna || p.destino_comuna || null,
    },
    detalle: [
      {
        nombre: `OT ${g.ot_id || p.ot_id || ''}`.trim(),
        ot_id: g.ot_id || p.ot_id || null,
        trip_id: g.trip_id || p.trip_id || null,
        cantidad: firstNum(g.cantidad, p.cantidad, 1),
        unidad: 'UN',
        precio: firstNum(g.valor_clp, p.valor_clp, 0),
        peso_kg: firstNum(g.peso_kg, p.peso_kg, null),
        volumen: firstNum(g.volumen, p.volumen, null),
      },
    ],
    error: g.error || null,
    ts_source: g.ts_source || p.ts_source || null,
  };

  const faltantes = assessFaltantesRes154(comprobante);
  const emitidaConFolio = String(comprobante.estado || '').toUpperCase() === 'EMITIDA' && !!comprobante.folio;
  const comprobanteCompleto = faltantes.length === 0;

  return {
    ...comprobante,
    faltantes_res154: faltantes,
    comprobante_completo: comprobanteCompleto,
    /** Válido ante fiscalización SII/Carabineros solo con emisión real + folio */
    listo_para_fiscalizacion: emitidaConFolio && comprobanteCompleto,
    aviso_fiscalizacion: emitidaConFolio && comprobanteCompleto
      ? null
      : (!emitidaConFolio
        ? 'Sin folio SII (EMITIDA): el documento es el payload Res.154 completo, pero no sustituye la guía timbrada hasta emitir con SimpleAPI/Lioren.'
        : `Faltan campos Res.154: ${faltantes.join(', ')}`),
  };
}

/**
 * Campos mínimos que debe mostrar/portar una guía tipo 52 bajo Res.154.
 * @param {ReturnType<typeof buildComprobanteDte52>} c
 * @returns {string[]}
 */
export function assessFaltantesRes154(c) {
  const missing = [];
  if (!c?.emisor?.rut) missing.push('emisor_rut');
  if (!c?.emisor?.razon_social) missing.push('emisor_razon_social');
  if (!c?.transporte?.conductor_rut) missing.push('conductor_rut');
  if (!c?.transporte?.conductor_nombre) missing.push('conductor_nombre');
  if (!c?.transporte?.patente) missing.push('patente');
  if (!c?.transporte?.origen_direccion) missing.push('origen_direccion');
  if (!c?.transporte?.origen_comuna) missing.push('origen_comuna');
  if (!c?.transporte?.destino_direccion) missing.push('destino_direccion');
  if (!c?.transporte?.destino_comuna) missing.push('destino_comuna');
  if (!c?.tipo_traslado) missing.push('tipo_traslado');
  if (!c?.fecha_emision) missing.push('fecha_emision');
  if (!c?.receptor?.razon_social) missing.push('receptor_razon_social');
  // RUT receptor: obligatorio en venta (IndTraslado 1); recomendado en el resto
  if (c?.ind_traslado === 1 && !c?.receptor?.rut) missing.push('receptor_rut');
  const det = c?.detalle?.[0];
  if (det && (det.cantidad == null || Number(det.cantidad) <= 0)) missing.push('detalle_cantidad');
  return missing;
}

function normalizePayload(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function firstNum(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
