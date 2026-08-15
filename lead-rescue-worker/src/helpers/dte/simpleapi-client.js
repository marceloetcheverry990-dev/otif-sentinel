// Cliente HTTP para SimpleAPI (REST).
// Documentación comercial: https://www.simpleapi.cl/Documentacion
// El path exacto se configura con SIMPLEAPI_GUIA_PATH (default /api/dte/guia-despacho).
// Mapeamos nuestro payload interno → cuerpo que SimpleAPI espera recibir.
// Cuando tengas la colección Postman, ajusta solo mapPayloadToSimpleAPI().

/**
 * @param {import('./emisor-dte.js').GuiaDespachoPayload} payload
 * @param {{ DTE_RUT_EMISOR?: string, DTE_RAZON_SOCIAL?: string, DTE_AMBIENTE?: string }} env
 */
/** IndTraslado SII (Anexo técnico DTE) — S10 */
export const IND_TRASLADO_SII = {
  VENTA: 1, // Operación constituye venta
  TRASLADO_INTERNO: 5,
  OTRO: 6, // Otros traslados no venta
  DEVOLUCION: 7, // Guía de devolución
};

export function mapPayloadToSimpleAPI(payload, env) {
  const tipoTraslado = IND_TRASLADO_SII[payload.tipo_traslado] ?? IND_TRASLADO_SII.OTRO;
  const tipoDespacho = Number(payload.tipo_despacho) || 2; // 2 = emisor a cliente (parametrizable)

  return {
    ambiente: env.DTE_AMBIENTE || 'certificacion',
    tipoDTE: 52, // Guía de Despacho Electrónica
    fechaEmision: payload.fecha_emision_iso,
    fechaEstimadaEntrega: payload.fecha_estimada_entrega || null,
    tipoTraslado,
    tipoDespacho,
    emisor: {
      rut: env.DTE_RUT_EMISOR || null,
      razonSocial: env.DTE_RAZON_SOCIAL || null,
    },
    transporte: {
      patente: payload.patente,
      rutChofer: payload.conductor_rut,
      nombreChofer: payload.conductor_nombre,
      direccionOrigen: payload.origen_direccion,
      comunaOrigen: payload.origen_comuna,
      direccionDestino: payload.destino_direccion,
      comunaDestino: payload.destino_comuna,
    },
    receptor: {
      razonSocial: payload.cliente_nombre || null,
      rut: payload.cliente_rut || null,
    },
    detalle: [
      {
        nombre: `OT ${payload.ot_id}`,
        cantidad: payload.cantidad ?? 1,
        unidad: 'UN',
        precio: payload.valor_clp ?? 0,
        pesoKg: payload.peso_kg,
        volumen: payload.volumen,
      },
    ],
    // Idempotencia por traslado (tenant + OT + viaje)
    referenciaExterna: `${payload.tenant_id}:${payload.ot_id}:${payload.trip_id}`,
  };
}

/**
 * @param {import('./emisor-dte.js').GuiaDespachoPayload} payload
 * @param {object} env
 * @returns {Promise<import('./emisor-dte.js').EmisionResult>}
 */
export async function postGuiaSimpleAPI(payload, env) {
  const token = env.SIMPLEAPI_TOKEN;
  if (!token) {
    return {
      estado: 'ERROR',
      folio: null,
      track_id: null,
      respuesta: null,
      error: 'SIMPLEAPI_TOKEN no configurado',
      proveedor: 'simpleapi',
    };
  }

  const base = String(env.SIMPLEAPI_BASE_URL || 'https://api.simpleapi.cl').replace(/\/$/, '');
  const path = env.SIMPLEAPI_GUIA_PATH || '/api/dte/guia-despacho';
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  const body = mapPayloadToSimpleAPI(payload, env);
  if (!body.emisor.rut) {
    return {
      estado: 'ERROR',
      folio: null,
      track_id: null,
      respuesta: null,
      error: 'DTE_RUT_EMISOR no configurado',
      proveedor: 'simpleapi',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Api-Key': token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      return {
        estado: 'ERROR',
        folio: null,
        track_id: null,
        respuesta: data,
        error: `SimpleAPI HTTP ${res.status}: ${data?.message || data?.error || text?.slice(0, 200) || 'error'}`,
        proveedor: 'simpleapi',
      };
    }

    const folio = data?.folio || data?.Folio || data?.identificacion?.folio || null;
    const track_id = data?.trackId || data?.TrackId || data?.track_id || null;

    return {
      estado: 'EMITIDA',
      folio: folio ? String(folio) : null,
      track_id: track_id ? String(track_id) : folio ? String(folio) : null,
      respuesta: data,
      error: null,
      proveedor: 'simpleapi',
    };
  } catch (e) {
    return {
      estado: 'ERROR',
      folio: null,
      track_id: null,
      respuesta: null,
      error: e.name === 'AbortError' ? 'SimpleAPI timeout' : (e.message || 'SimpleAPI network error'),
      proveedor: 'simpleapi',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * S3: consulta por referenciaExterna antes de reemitir (si SIMPLEAPI_LOOKUP_PATH está configurado).
 * @returns {Promise<import('./emisor-dte.js').EmisionResult|null>}
 */
export async function lookupGuiaByReferencia(payload, env) {
  const token = env.SIMPLEAPI_TOKEN;
  const lookupPath = env.SIMPLEAPI_LOOKUP_PATH;
  if (!token || !lookupPath) return null;

  const base = String(env.SIMPLEAPI_BASE_URL || 'https://api.simpleapi.cl').replace(/\/$/, '');
  const ref = `${payload.tenant_id}:${payload.ot_id}`;
  const path = lookupPath.startsWith('/') ? lookupPath : `/${lookupPath}`;
  const url = `${base}${path}?referenciaExterna=${encodeURIComponent(ref)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Api-Key': token,
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    const folio = data?.folio || data?.Folio || data?.identificacion?.folio || null;
    if (!folio) return null;
    const track_id = data?.trackId || data?.TrackId || data?.track_id || null;
    return {
      estado: 'EMITIDA',
      folio: String(folio),
      track_id: track_id ? String(track_id) : String(folio),
      respuesta: data,
      error: null,
      proveedor: 'simpleapi',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
