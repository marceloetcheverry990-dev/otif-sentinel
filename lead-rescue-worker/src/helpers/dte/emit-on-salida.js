// Emisión de guías Res. 154 al dispararse la primera SALIDA del viaje.
// No bloquea al chofer: se invoca desde ctx.waitUntil.
//
// R1: mode=retry toma la cola desde guias_despacho (PENDING/ERROR/STUB/REVIEW).
// R3: ts_source !== device → REVIEW (operador confirma con retry).
// S6/S7: origen efectivo + fecha estimada de entrega (ETA).

import { createEmisorDTE } from './emisor-dte.js';
import { resolveDteEnv } from './resolve-dte-env.js';
import { resolveCliente } from './cliente-match.js';
import { resolveOrigenTraslado } from './resolve-origen.js';
import { getTenantSettings } from '../tenant-settings.js';

const TIPOS_VALIDOS = new Set(['VENTA', 'TRASLADO_INTERNO', 'DEVOLUCION', 'OTRO']);
const EMITTING_LOCK_MS = 2 * 60 * 1000;
const RETRY_ESTADOS = ['PENDING', 'ERROR', 'STUB', 'REVIEW'];

/**
 * @param {object} env
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   tenant_id: string,
 *   trip_id: string,
 *   fecha_emision_iso: string,
 *   rut_chofer: string,
 *   mode?: 'salida'|'retry',
 *   ts_source?: string|null,
 *   confirm_clamped_ts?: boolean,
 * }} ctx
 */
export async function emitGuiasForTrip(env, supabase, ctx) {
  const { tenant_id, trip_id, fecha_emision_iso, rut_chofer } = ctx;
  const mode = ctx.mode === 'retry' ? 'retry' : 'salida';
  const ts_source = ctx.ts_source || null;
  const confirmClamped = mode === 'retry' || !!ctx.confirm_clamped_ts;
  const stats = { emitted: 0, errors: 0, skipped: 0, stub: 0, review: 0 };

  const { data: chofer } = await supabase
    .from('choferes')
    .select('nombre_completo, rut, patente_asignada')
    .eq('tenant_id', tenant_id)
    .eq('rut', rut_chofer)
    .maybeSingle();

  const { data: flota } = await supabase
    .from('flota_vehiculos')
    .select('patente, rut_chofer_asignado')
    .eq('tenant_id', tenant_id)
    .eq('trip_id_actual', trip_id)
    .maybeSingle();

  const patente = flota?.patente || chofer?.patente_asignada || null;
  const conductor_rut = chofer?.rut || rut_chofer || null;
  const conductor_nombre = chofer?.nombre_completo || null;

  const origen = await resolveOrigenTraslado(supabase, { tenant_id, trip_id });
  const origen_direccion = origen.origen_direccion;
  const origen_comuna = origen.origen_comuna;

  const loaded = await loadOrdenesForEmit(supabase, { tenant_id, trip_id, mode });
  if (loaded.error) {
    console.warn('[DTE] load ordenes', loaded.error);
    return stats;
  }
  if (!loaded.ordenes.length) {
    console.warn('[DTE] sin OTs para emitir', mode);
    return stats;
  }

  const tenantSettings = await getTenantSettings(env, tenant_id);
  const dteEnv = await resolveDteEnv(env, tenantSettings);
  const emisor = dteEnv.DTE_IDENTITY_ERROR ? null : createEmisorDTE(dteEnv);

  for (const ot of loaded.ordenes) {
    const existing = loaded.guiasByOt.has(ot.ot_id)
      ? loaded.guiasByOt.get(ot.ot_id)
      : (
        await supabase
          .from('guias_despacho')
          .select('id, estado, folio, fecha_emision, updated_at, payload_enviado, error, ts_source, patente')
          .eq('tenant_id', tenant_id)
          .eq('trip_id', trip_id)
          .eq('ot_id', ot.ot_id)
          .maybeSingle()
      ).data;

    if (shouldSkipExisting(existing)) {
      stats.skipped += 1;
      continue;
    }

    const fechaFija = existing?.fecha_emision
      ? new Date(existing.fecha_emision).toISOString()
      : fecha_emision_iso;

    const rowTsSource = existing?.ts_source || ts_source || null;
    const needsReview = rowTsSource && rowTsSource !== 'device' && !confirmClamped;

    const fechaEstimada = ot.eta ? new Date(ot.eta).toISOString() : null;

    if (dteEnv.DTE_IDENTITY_ERROR) {
      await upsertGuiaRow(supabase, existing, {
        tenant_id,
        trip_id,
        ot_id: ot.ot_id,
        estado: 'ERROR',
        fecha_emision: fechaFija,
        ts_source: rowTsSource,
        patente,
        error: dteEnv.DTE_IDENTITY_ERROR,
        proveedor: dteEnv.DTE_PROVIDER || null,
        folio: null,
        track_id: null,
        updated_at: new Date().toISOString(),
      });
      stats.errors += 1;
      continue;
    }

    const { cliente, reason: clienteReason } = await resolveCliente(supabase, tenant_id, ot.cliente);
    const tipo = normalizeTipoTraslado(ot.tipo_traslado || ot.tipo_movimiento);
    const destino_direccion = cliente?.direccion_calle || null;
    const destino_comuna = cliente?.comuna || null;

    const payload = {
      tenant_id,
      trip_id,
      ot_id: ot.ot_id,
      tipo_traslado: tipo,
      tipo_despacho: 2,
      conductor_rut,
      conductor_nombre,
      patente,
      origen_direccion,
      origen_comuna,
      origen_lat: origen.origen_lat,
      origen_lng: origen.origen_lng,
      destino_direccion,
      destino_comuna,
      cantidad: numOrNull(ot.cantidad),
      peso_kg: numOrNull(ot.peso_kg),
      volumen: numOrNull(ot.volumen),
      valor_clp: numOrNull(ot.monto_total ?? ot.valor_oc_clp),
      fecha_emision_iso: fechaFija,
      fecha_estimada_entrega: fechaEstimada,
      cliente_nombre: ot.cliente || null,
      ts_source: rowTsSource,
    };

    if (!destino_direccion || !destino_comuna) {
      const errMsg = clienteReason
        ? `Campos faltantes Res.154: destino (${clienteReason}). Corregir maestro clientes.`
        : 'Campos faltantes Res.154: destino_direccion/destino_comuna (dirección real del cliente)';
      await upsertGuiaRow(supabase, existing, baseGuiaRow({
        tenant_id, trip_id, ot, tipo, conductor_rut, conductor_nombre, patente,
        origen, destino_direccion, destino_comuna, payload, fechaFija, fechaEstimada,
        rowTsSource, estado: 'ERROR', error: errMsg, proveedor: dteEnv.DTE_PROVIDER || 'stub',
      }));
      stats.errors += 1;
      continue;
    }

    // R3: hora clampeada → REVIEW hasta que el operador reintente (confirmación)
    if (needsReview) {
      await upsertGuiaRow(supabase, existing, baseGuiaRow({
        tenant_id, trip_id, ot, tipo, conductor_rut, conductor_nombre, patente,
        origen, destino_direccion, destino_comuna, payload, fechaFija, fechaEstimada,
        rowTsSource,
        estado: 'REVIEW',
        error: `Hora de emisión requiere confirmación (ts_source=${rowTsSource}). Reintentar en Torre confirma la hora.`,
        proveedor: dteEnv.DTE_PROVIDER || 'stub',
      }));
      stats.review += 1;
      continue;
    }

    if (existing?.estado === 'ERROR' && existing?.payload_enviado && dteEnv.DTE_PROVIDER === 'simpleapi') {
      try {
        const { lookupGuiaByReferencia } = await import('./simpleapi-client.js');
        const found = await lookupGuiaByReferencia(payload, dteEnv);
        if (found?.estado === 'EMITIDA' && found.folio) {
          await supabase
            .from('guias_despacho')
            .update({
              estado: 'EMITIDA',
              folio: found.folio,
              track_id: found.track_id,
              respuesta: found.respuesta,
              error: null,
              proveedor: 'simpleapi',
              updated_at: new Date().toISOString(),
            })
            .eq('tenant_id', tenant_id)
            .eq('trip_id', trip_id)
            .eq('ot_id', ot.ot_id);
          stats.emitted += 1;
          continue;
        }
      } catch (e) {
        console.warn('[DTE] lookup referencia', e.message);
      }
    }

    await upsertGuiaRow(supabase, existing, baseGuiaRow({
      tenant_id, trip_id, ot, tipo, conductor_rut, conductor_nombre, patente,
      origen, destino_direccion, destino_comuna, payload, fechaFija, fechaEstimada,
      rowTsSource, estado: 'EMITTING', error: null, proveedor: dteEnv.DTE_PROVIDER || 'stub',
    }));

    let result;
    try {
      result = await emisor.emitirGuia(payload);
    } catch (e) {
      result = {
        estado: 'ERROR',
        folio: null,
        track_id: null,
        respuesta: null,
        error: e.message || 'emisor_exception',
        proveedor: String(dteEnv.DTE_PROVIDER || 'stub'),
      };
    }

    if (result.estado === 'ERROR' && /timeout/i.test(result.error || '')) {
      result = {
        ...result,
        error: `${result.error}; posible_orfanato:consultar referenciaExterna ${tenant_id}:${ot.ot_id}:${trip_id}`,
      };
    }

    await supabase
      .from('guias_despacho')
      .update({
        estado: result.estado,
        folio: result.folio,
        track_id: result.track_id,
        respuesta: result.respuesta,
        error: result.error,
        proveedor: result.proveedor,
        fecha_emision: fechaFija,
        fecha_estimada_entrega: fechaEstimada,
        ts_source: rowTsSource,
        updated_at: new Date().toISOString(),
      })
      .eq('tenant_id', tenant_id)
      .eq('trip_id', trip_id)
      .eq('ot_id', ot.ot_id);

    if (result.estado === 'EMITIDA') stats.emitted += 1;
    else if (result.estado === 'STUB') stats.stub += 1;
    else if (result.estado === 'SKIPPED') stats.skipped += 1;
    else if (result.estado === 'REVIEW') stats.review += 1;
    else stats.errors += 1;
  }

  console.log('[DTE] trip', trip_id, mode, stats);
  return stats;
}

function baseGuiaRow(p) {
  return {
    tenant_id: p.tenant_id,
    trip_id: p.trip_id,
    ot_id: p.ot.ot_id,
    estado: p.estado,
    tipo_traslado: p.tipo,
    conductor_rut: p.conductor_rut,
    conductor_nombre: p.conductor_nombre,
    patente: p.patente,
    origen_direccion: p.origen.origen_direccion,
    origen_comuna: p.origen.origen_comuna,
    origen_lat: p.origen.origen_lat,
    origen_lng: p.origen.origen_lng,
    destino_direccion: p.destino_direccion,
    destino_comuna: p.destino_comuna,
    cantidad: numOrNull(p.ot.cantidad),
    peso_kg: numOrNull(p.ot.peso_kg),
    volumen: numOrNull(p.ot.volumen),
    valor_clp: numOrNull(p.ot.monto_total ?? p.ot.valor_oc_clp),
    fecha_emision: p.fechaFija,
    fecha_estimada_entrega: p.fechaEstimada,
    ts_source: p.rowTsSource,
    payload_enviado: p.payload,
    folio: null,
    track_id: null,
    respuesta: null,
    error: p.error,
    proveedor: p.proveedor,
    updated_at: new Date().toISOString(),
  };
}

export async function loadOrdenesForEmit(supabase, { tenant_id, trip_id, mode }) {
  if (mode === 'retry') {
    const { data: guias, error: gErr } = await supabase
      .from('guias_despacho')
      .select('id, ot_id, estado, folio, fecha_emision, updated_at, payload_enviado, error, ts_source, patente')
      .eq('tenant_id', tenant_id)
      .eq('trip_id', trip_id)
      .in('estado', RETRY_ESTADOS);

    if (gErr) return { ordenes: [], guiasByOt: new Map(), error: gErr.message };
    if (!guias?.length) return { ordenes: [], guiasByOt: new Map(), error: null };

    const guiasByOt = new Map(guias.map((g) => [g.ot_id, g]));
    const otIds = [...guiasByOt.keys()];
    const { data: ordenes, error: oErr } = await supabase
      .from('ordenes_pendientes')
      .select('ot_id, cliente, peso_kg, volumen, cantidad, valor_oc_clp, monto_total, tipo_traslado, tipo_movimiento, metadata, eta')
      .eq('tenant_id', tenant_id)
      .in('ot_id', otIds);

    if (oErr) return { ordenes: [], guiasByOt, error: oErr.message };
    const byId = new Map((ordenes || []).map((o) => [o.ot_id, o]));
    const ordered = otIds.map((id) => byId.get(id)).filter(Boolean);
    return { ordenes: ordered, guiasByOt, error: null };
  }

  const { data: ordenes, error } = await supabase
    .from('ordenes_pendientes')
    .select('ot_id, cliente, peso_kg, volumen, cantidad, valor_oc_clp, monto_total, tipo_traslado, tipo_movimiento, metadata, eta')
    .eq('tenant_id', tenant_id)
    .eq('trip_id', trip_id)
    .not('estado_operacional', 'in', '("ENTREGADO","RECHAZADO","CANCELADO_PLANILLA")');

  return {
    ordenes: ordenes || [],
    guiasByOt: new Map(),
    error: error?.message || null,
  };
}

export function shouldSkipExisting(existing) {
  if (!existing) return false;
  if (existing.estado === 'EMITIDA') return true;
  if (existing.estado === 'EMITTING') {
    const updated = existing.updated_at ? Date.parse(existing.updated_at) : 0;
    if (Number.isFinite(updated) && Date.now() - updated < EMITTING_LOCK_MS) {
      return true;
    }
    return false;
  }
  if (existing.estado === 'SKIPPED' && existing.folio && !String(existing.folio).startsWith('STUB-')) {
    return true;
  }
  return false;
}

async function upsertGuiaRow(supabase, existing, row) {
  if (existing?.id) {
    await supabase.from('guias_despacho').update(row).eq('id', existing.id);
  } else {
    await supabase.from('guias_despacho').insert([{ ...row, created_at: new Date().toISOString() }]);
  }
}

function normalizeTipoTraslado(raw) {
  if (!raw) return null;
  const t = String(raw).trim().toUpperCase().replace(/\s+/g, '_');
  if (TIPOS_VALIDOS.has(t)) return t;
  if (t.includes('DEVOL')) return 'DEVOLUCION';
  if (t.includes('INTERNO') || t.includes('TRASLADO')) return 'TRASLADO_INTERNO';
  if (t.includes('VENTA') || t === 'DESPACHO') return 'VENTA';
  return 'OTRO';
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
