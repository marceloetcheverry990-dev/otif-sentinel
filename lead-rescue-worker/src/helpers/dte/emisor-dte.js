// EmisorDTE — interfaz de emisión de guías de despacho (Res. 154).
// Nunca implementar el protocolo SII aquí: solo adapters de terceros.
//
// Proveedores: stub (dev) | simpleapi | lioren
// Cambiar de proveedor = cambiar DTE_PROVIDER / tenant_settings.dte_provider.

import { isDteStubForbidden } from './resolve-dte-env.js';

/**
 * @typedef {object} GuiaDespachoPayload
 * @property {string} tenant_id
 * @property {string} trip_id
 * @property {string} ot_id
 * @property {string} tipo_traslado
 * @property {string} conductor_rut
 * @property {string} conductor_nombre
 * @property {string} patente
 * @property {string} origen_direccion
 * @property {string} origen_comuna
 * @property {string} destino_direccion
 * @property {string} destino_comuna
 * @property {number|null} cantidad
 * @property {number|null} peso_kg
 * @property {number|null} volumen
 * @property {number|null} valor_clp
 * @property {string} fecha_emision_iso  — debe = hora real de inicio del traslado (SALIDA)
 * @property {string} [cliente_nombre]
 * @property {string} [cliente_rut]
 */

/**
 * @typedef {object} EmisionResult
 * @property {'EMITIDA'|'SKIPPED'|'ERROR'|'STUB'} estado
 * @property {string|null} folio
 * @property {string|null} track_id
 * @property {object|null} respuesta
 * @property {string|null} error
 * @property {string} proveedor
 */

/**
 * @param {object} env — ya resuelto con resolveDteEnv(env, tenantSettings)
 * @returns {EmisorDTE}
 */
export function createEmisorDTE(env) {
  const provider = String(env.DTE_PROVIDER || 'stub').toLowerCase();
  if (provider === 'simpleapi') {
    return new SimpleAPIEmisor(env);
  }
  if (provider === 'lioren') {
    return new LiorenEmisor(env);
  }
  if (isDteStubForbidden(env)) {
    return new ForbiddenStubEmisor(env);
  }
  return new StubEmisorDTE(env);
}

/** @interface */
export class EmisorDTE {
  /**
   * @param {GuiaDespachoPayload} _payload
   * @returns {Promise<EmisionResult>}
   */
  async emitirGuia(_payload) {
    throw new Error('EmisorDTE.emitirGuia no implementado');
  }
}

/** Producción sin DTE_ALLOW_STUB: no inventar folios */
export class ForbiddenStubEmisor extends EmisorDTE {
  constructor(env) {
    super();
    this.env = env;
  }

  async emitirGuia(_payload) {
    console.error('[DTE] stub prohibido en producción — configurar DTE_PROVIDER o DTE_ALLOW_STUB=true');
    return {
      estado: 'ERROR',
      folio: null,
      track_id: null,
      respuesta: null,
      error: 'DTE_PROVIDER no configurado (stub prohibido en producción)',
      proveedor: 'stub',
    };
  }
}

/** Dev / CI: no llama a proveedor; estado STUB sin folio (S4). */
export class StubEmisorDTE extends EmisorDTE {
  constructor(env) {
    super();
    this.env = env;
  }

  /** @param {GuiaDespachoPayload} payload */
  async emitirGuia(payload) {
    const missing = validateRequiredFields(payload);
    if (missing.length) {
      return {
        estado: 'ERROR',
        folio: null,
        track_id: null,
        respuesta: null,
        error: `Campos faltantes Res.154: ${missing.join(', ')}`,
        proveedor: 'stub',
      };
    }
    return {
      estado: 'STUB',
      folio: null,
      track_id: null,
      respuesta: { stub: true, ot_id: payload.ot_id },
      error: null,
      proveedor: 'stub',
    };
  }
}

/** SimpleAPI REST — activar con DTE_PROVIDER=simpleapi + SIMPLEAPI_TOKEN + DTE_RUT_EMISOR */
export class SimpleAPIEmisor extends EmisorDTE {
  constructor(env) {
    super();
    this.env = env;
  }

  /** @param {GuiaDespachoPayload} payload */
  async emitirGuia(payload) {
    const missing = validateRequiredFields(payload);
    if (missing.length) {
      return {
        estado: 'ERROR',
        folio: null,
        track_id: null,
        respuesta: null,
        error: `Campos faltantes Res.154: ${missing.join(', ')}`,
        proveedor: 'simpleapi',
      };
    }
    const { postGuiaSimpleAPI } = await import('./simpleapi-client.js');
    return postGuiaSimpleAPI(payload, this.env);
  }
}

/** Placeholder Lioren */
export class LiorenEmisor extends EmisorDTE {
  constructor(env) {
    super();
    this.env = env;
  }

  /** @param {GuiaDespachoPayload} payload */
  async emitirGuia(payload) {
    const missing = validateRequiredFields(payload);
    if (missing.length) {
      return {
        estado: 'ERROR',
        folio: null,
        track_id: null,
        respuesta: null,
        error: `Campos faltantes Res.154: ${missing.join(', ')}`,
        proveedor: 'lioren',
      };
    }
    return {
      estado: 'ERROR',
      folio: null,
      track_id: null,
      respuesta: null,
      error: 'LiorenEmisor: integración HTTP pendiente (sandbox)',
      proveedor: 'lioren',
    };
  }
}

/**
 * Campos mínimos para intentar emitir (Res. 154).
 * @param {GuiaDespachoPayload} p
 * @returns {string[]}
 */
export function validateRequiredFields(p) {
  const missing = [];
  if (!p?.conductor_rut) missing.push('conductor_rut');
  if (!p?.conductor_nombre) missing.push('conductor_nombre');
  if (!p?.patente) missing.push('patente');
  if (!p?.origen_direccion) missing.push('origen_direccion');
  if (!p?.origen_comuna) missing.push('origen_comuna');
  if (!p?.destino_direccion) missing.push('destino_direccion');
  if (!p?.destino_comuna) missing.push('destino_comuna');
  if (!p?.tipo_traslado) missing.push('tipo_traslado');
  if (!p?.fecha_emision_iso) missing.push('fecha_emision');
  return missing;
}
