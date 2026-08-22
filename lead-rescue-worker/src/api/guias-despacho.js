// API operador: listar y reintentar guías de despacho Res. 154

import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { emitGuiasForTrip } from '../helpers/dte/emit-on-salida.js';
import { buildComprobanteDte52 } from '../helpers/dte/comprobante-dte52.js';
import { resolveDteEnv } from '../helpers/dte/resolve-dte-env.js';
import { getTenantSettings } from '../helpers/tenant-settings.js';

const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const GUIA_SELECT = [
  'id', 'tenant_id', 'trip_id', 'ot_id', 'estado', 'folio', 'track_id',
  'fecha_emision', 'fecha_estimada_entrega', 'tipo_traslado',
  'patente', 'conductor_rut', 'conductor_nombre',
  'origen_direccion', 'origen_comuna', 'destino_direccion', 'destino_comuna',
  'cantidad', 'peso_kg', 'volumen', 'valor_clp',
  'payload_enviado', 'error', 'proveedor', 'ts_source', 'updated_at',
].join(', ');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function supabaseClient(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    global: { fetch },
  });
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return typeof raw === 'object' ? raw : {};
}

/** RUTs receptor demo (video / staging) cuando la OT aún no trae cliente_rut en metadata. */
const DEMO_RECEPTOR_RUT = {
  'starken corproa': '96.791.430-3',
  'universidad de santiago': '60.911.000-7',
  'quimicos andes ltda': '76.123.890-K',
  'maqueta suburbano spa': '77.456.123-0',
  'iplacex': '76.234.567-8',
  'universidad de chile': '60.910.000-1',
};

function demoReceptorRutByNombre(nombre) {
  const key = String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return DEMO_RECEPTOR_RUT[key] || null;
}

/**
 * GET /api/guias-despacho?trip_id=... | ?ot_id=...
 * Devuelve filas + comprobante DTE tipo 52 (Res.154) listo para portar/imprimir.
 */
export async function listGuiasDespacho(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  const url = new URL(request.url);
  const trip_id = url.searchParams.get('trip_id');
  const ot_id = url.searchParams.get('ot_id');

  const supabase = supabaseClient(env);
  let q = supabase
    .from('guias_despacho')
    .select(GUIA_SELECT)
    .eq('tenant_id', tenant_id)
    .order('updated_at', { ascending: false })
    .limit(200);

  if (trip_id) q = q.eq('trip_id', trip_id);
  if (ot_id) q = q.eq('ot_id', ot_id);

  const { data, error } = await q;
  if (error) {
    if (/guias_despacho|does not exist|42P01/i.test(error.message)) {
      return json({ exito: true, guias: [], aviso: 'Migración 014 pendiente' });
    }
    return json({ error: error.message }, 500);
  }

  const rows = data || [];
  const otIds = [...new Set(rows.map((g) => g.ot_id).filter(Boolean))];
  const otById = new Map();
  if (otIds.length) {
    const { data: ordenes } = await supabase
      .from('ordenes_pendientes')
      .select('ot_id, cliente, metadata, cantidad, peso_kg, volumen, monto_total, valor_oc_clp')
      .eq('tenant_id', tenant_id)
      .in('ot_id', otIds);
    for (const o of ordenes || []) otById.set(o.ot_id, o);
  }

  const tenantSettings = await getTenantSettings(env, tenant_id);
  const dteEnv = await resolveDteEnv(env, tenantSettings);
  // Staging/stub: identidad emisor visible en comprobante aunque aún no esté en tenant_settings.
  if (!dteEnv.DTE_RUT_EMISOR && (dteEnv.DTE_PROVIDER === 'stub' || String(env.DTE_ALLOW_STUB || '').toLowerCase() === 'true')) {
    dteEnv.DTE_RUT_EMISOR = '76.543.210-K';
    dteEnv.DTE_RAZON_SOCIAL = dteEnv.DTE_RAZON_SOCIAL || 'Empresa Base Demo SpA';
    dteEnv.DTE_AMBIENTE = dteEnv.DTE_AMBIENTE || 'certificacion';
  }

  const guias = rows.map((g) => {
    const ot = otById.get(g.ot_id) || null;
    const meta = parseMeta(ot?.metadata);
    const payload = parseMeta(g.payload_enviado);
    const clienteNombre = payload.cliente_nombre || ot?.cliente || meta.cliente || null;
    let clienteRut = payload.cliente_rut || meta.cliente_rut || meta.rut_receptor || meta.rut || null;
    if (!clienteRut && clienteNombre) {
      clienteRut = demoReceptorRutByNombre(clienteNombre);
    }
    const tipoRaw = g.tipo_traslado || payload.tipo_traslado || meta.tipo_traslado || null;
    const valorHint = g.valor_clp ?? payload.valor_clp ?? ot?.monto_total ?? ot?.valor_oc_clp;
    // Guías viejas tipificadas OTRO en despacho a cliente → VENTA (IndTraslado 1) en el comprobante.
    const tipoTraslado = (!tipoRaw || tipoRaw === 'OTRO')
      ? 'VENTA'
      : tipoRaw;
    const enriched = {
      ...g,
      cliente_nombre: clienteNombre,
      cliente_rut: clienteRut,
      cantidad: g.cantidad ?? payload.cantidad ?? ot?.cantidad ?? null,
      peso_kg: g.peso_kg ?? payload.peso_kg ?? ot?.peso_kg ?? null,
      volumen: g.volumen ?? payload.volumen ?? ot?.volumen ?? null,
      valor_clp: valorHint ?? null,
      destino_direccion: g.destino_direccion || payload.destino_direccion || meta.direccion_entrega || null,
      destino_comuna: g.destino_comuna || payload.destino_comuna || null,
      tipo_traslado: tipoTraslado,
    };
    const comprobante = buildComprobanteDte52(enriched, dteEnv);
    return {
      ...g,
      cliente_nombre: enriched.cliente_nombre,
      cliente_rut: enriched.cliente_rut,
      comprobante,
    };
  });

  return json({
    exito: true,
    guias,
    emisor: {
      rut: dteEnv.DTE_RUT_EMISOR || null,
      razon_social: dteEnv.DTE_RAZON_SOCIAL || null,
      ambiente: dteEnv.DTE_AMBIENTE || null,
      provider: dteEnv.DTE_PROVIDER || null,
    },
  });
}

/**
 * S2: fecha de emisión = original del traslado, nunca "ahora".
 */
export async function resolveFechaEmisionRetry(supabase, tenant_id, trip_id) {
  const { data: guias } = await supabase
    .from('guias_despacho')
    .select('fecha_emision')
    .eq('tenant_id', tenant_id)
    .eq('trip_id', trip_id)
    .not('fecha_emision', 'is', null)
    .order('fecha_emision', { ascending: true })
    .limit(1);

  if (guias?.[0]?.fecha_emision) {
    return new Date(guias[0].fecha_emision).toISOString();
  }

  const { data: salida } = await supabase
    .from('bitacora_viajes')
    .select('created_at')
    .eq('tenant_id', tenant_id)
    .eq('trip_id', trip_id)
    .eq('tipo_evento', 'SALIDA')
    .order('created_at', { ascending: true })
    .limit(1);

  if (salida?.[0]?.created_at) {
    return new Date(salida[0].created_at).toISOString();
  }

  return null;
}

/**
 * POST /api/guias-despacho/retry
 * body: { trip_id } — reemite OTs del viaje en ERROR/PENDING/STUB (idempotente)
 */
export async function retryGuiasDespacho(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  const trip_id = body?.trip_id;
  if (!trip_id) return json({ error: 'trip_id requerido' }, 400);

  const supabase = supabaseClient(env);

  if (body.dry_run === true) {
    const { data, error } = await supabase
      .from('guias_despacho')
      .select('id, ot_id, estado, folio, error, proveedor, updated_at')
      .eq('tenant_id', tenant_id)
      .eq('trip_id', trip_id)
      .in('estado', ['ERROR', 'STUB', 'REVIEW', 'PENDING']);
    if (error && /guias_despacho|42P01/i.test(error.message)) {
      return json({ exito: true, dry_run: true, would_retry: 0, guias: [], proveedor: String(env.DTE_PROVIDER || 'stub') });
    }
    if (error) return json({ error: error.message }, 500);
    return json({
      exito: true,
      dry_run: true,
      would_retry: (data || []).length,
      guias: data || [],
      proveedor: String(env.DTE_PROVIDER || 'stub'),
      sii_live: false,
    });
  }

  // Liberar ERROR / STUB / REVIEW (retry = confirmación de hora clampeada R3)
  await supabase
    .from('guias_despacho')
    .update({ estado: 'PENDING', error: null, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenant_id)
    .eq('trip_id', trip_id)
    .in('estado', ['ERROR', 'STUB', 'REVIEW']);

  const fecha_emision_iso = await resolveFechaEmisionRetry(supabase, tenant_id, trip_id);
  if (!fecha_emision_iso) {
    return json({
      error: 'No hay fecha de SALIDA ni fecha_emision previa para este viaje; no se puede reemitir con fecha tributaria válida',
    }, 400);
  }

  const { data: flota } = await supabase
    .from('flota_vehiculos')
    .select('rut_chofer_asignado')
    .eq('tenant_id', tenant_id)
    .eq('trip_id_actual', trip_id)
    .maybeSingle();

  let rut = flota?.rut_chofer_asignado;
  if (!rut) {
    const { data: ot } = await supabase
      .from('ordenes_pendientes')
      .select('chofer_asignado_id')
      .eq('tenant_id', tenant_id)
      .eq('trip_id', trip_id)
      .not('chofer_asignado_id', 'is', null)
      .limit(1)
      .maybeSingle();
    if (ot?.chofer_asignado_id) {
      const { data: ch } = await supabase
        .from('choferes')
        .select('rut')
        .eq('tenant_id', tenant_id)
        .eq('chofer_id', ot.chofer_asignado_id)
        .maybeSingle();
      rut = ch?.rut;
    }
  }

  if (!rut) {
    return json({ error: 'No se encontró chofer del viaje para reemitir' }, 400);
  }

  // R1: cola = guias_despacho (PENDING/ERROR/STUB), no OTs abiertas
  const stats = await emitGuiasForTrip(env, supabase, {
    tenant_id,
    trip_id,
    fecha_emision_iso,
    rut_chofer: rut,
    mode: 'retry',
    confirm_clamped_ts: true,
  });

  return json({ exito: true, fecha_emision_iso, ...stats });
}
