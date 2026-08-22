// Cliente HTTP para Lioren (REST).
// Docs: https://www.lioren.cl/docs  — POST Emisión de DTE / GET Consulta de DTE
// Paths configurables: LIOREN_BASE_URL, LIOREN_DTE_PATH, LIOREN_LOOKUP_PATH.

import { IND_TRASLADO_SII } from './simpleapi-client.js';

function fechaYmd(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {import('./emisor-dte.js').GuiaDespachoPayload} payload
 * @param {object} env
 */
export function mapPayloadToLioren(payload, env) {
  const traslado = IND_TRASLADO_SII[payload.tipo_traslado] ?? IND_TRASLADO_SII.OTRO;
  return {
    tipodoc: 52,
    fecha: fechaYmd(payload.fecha_emision_iso),
    expectiva: payload.fecha_estimada_entrega ? fechaYmd(payload.fecha_estimada_entrega) : null,
    traslado,
    formaenvio: Number(payload.tipo_despacho) || 2,
    patente: payload.patente,
    rutchofer: payload.conductor_rut,
    chofer: payload.conductor_nombre,
    direccionorigen: payload.origen_direccion,
    comunaorigen: payload.origen_comuna,
    receptor: {
      rut: payload.cliente_rut || null,
      rs: payload.cliente_nombre || null,
      direccion: payload.destino_direccion,
      comuna: payload.destino_comuna,
      ciudad: payload.destino_comuna,
    },
    detalles: [
      {
        codigo: payload.ot_id,
        nombre: `OT ${payload.ot_id}`,
        cantidad: payload.cantidad ?? 1,
        unidad: 'UN',
        precio: payload.valor_clp ?? 0,
        exento: true,
      },
    ],
    referencia: `${payload.tenant_id}:${payload.ot_id}:${payload.trip_id}`,
    sucursal: env.LIOREN_SUCURSAL ? Number(env.LIOREN_SUCURSAL) : undefined,
  };
}

function tokenOf(env) {
  return env.LIOREN_TOKEN || env.SIMPLEAPI_TOKEN || null;
}

function baseUrl(env) {
  return String(env.LIOREN_BASE_URL || 'https://www.lioren.cl/api').replace(/\/$/, '');
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function parseFolio(data) {
  return data?.folio || data?.Folio || data?.dte?.folio || data?.documento?.folio || null;
}

function parseTrack(data, folio) {
  const track = data?.id || data?.trackId || data?.track_id || data?.dte?.id || null;
  if (track) return String(track);
  return folio ? String(folio) : null;
}

/**
 * @param {import('./emisor-dte.js').GuiaDespachoPayload} payload
 * @param {object} env
 * @returns {Promise<import('./emisor-dte.js').EmisionResult>}
 */
export async function postGuiaLioren(payload, env) {
  const token = tokenOf(env);
  if (!token) {
    return {
      estado: 'ERROR',
      folio: null,
      track_id: null,
      respuesta: null,
      error: 'LIOREN_TOKEN no configurado',
      proveedor: 'lioren',
    };
  }

  const path = env.LIOREN_DTE_PATH || '/dtes';
  const url = `${baseUrl(env)}${path.startsWith('/') ? path : `/${path}`}`;
  const body = mapPayloadToLioren(payload, env);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let data = null;
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
        error: `Lioren HTTP ${res.status}: ${data?.message || data?.error || data?.mensaje || text?.slice(0, 200) || 'error'}`,
        proveedor: 'lioren',
      };
    }

    const folio = parseFolio(data);
    return {
      estado: 'EMITIDA',
      folio: folio ? String(folio) : null,
      track_id: parseTrack(data, folio),
      respuesta: data,
      error: folio ? null : 'Lioren 200 sin folio; revisar payload/CAF',
      proveedor: 'lioren',
    };
  } catch (e) {
    return {
      estado: 'ERROR',
      folio: null,
      track_id: null,
      respuesta: null,
      error: e.name === 'AbortError' ? 'Lioren timeout' : (e.message || 'Lioren network error'),
      proveedor: 'lioren',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<import('./emisor-dte.js').EmisionResult|null>}
 */
export async function lookupGuiaByReferenciaLioren(payload, env) {
  const token = tokenOf(env);
  const lookupPath = env.LIOREN_LOOKUP_PATH;
  if (!token || !lookupPath) return null;

  const ref = `${payload.tenant_id}:${payload.ot_id}:${payload.trip_id}`;
  const path = lookupPath.startsWith('/') ? lookupPath : `/${lookupPath}`;
  const url = `${baseUrl(env)}${path}${path.includes('?') ? '&' : '?'}referencia=${encodeURIComponent(ref)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(token),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    const folio = parseFolio(data);
    if (!folio) return null;
    return {
      estado: 'EMITIDA',
      folio: String(folio),
      track_id: parseTrack(data, folio),
      respuesta: data,
      error: null,
      proveedor: 'lioren',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
