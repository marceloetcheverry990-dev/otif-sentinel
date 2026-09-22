// src/erp/core.js
// Herramientas compartidas por todas las transacciones del ERP.

/**
 * Error "de negocio" con el mismo formato que los mensajes de SAP:
 *   tipo 'E' (error, rojo), 'W' (advertencia, amarillo), 'S' (éxito, verde), 'I' (info).
 * El router lo convierte en { tipo, mensaje } con el status HTTP indicado.
 */
export class ErpError extends Error {
  constructor(mensaje, status = 400, tipo = 'E') {
    super(mensaje);
    this.name = 'ErpError';
    this.status = status;
    this.tipo = tipo;
  }
}

export function fallo(mensaje, status = 400) {
  return new ErpError(mensaje, status, 'E');
}

// Rangos de números (transacción SNRO en SAP). El primer número emitido es `inicio`.
export const RANGOS = Object.freeze({
  PROVEEDOR: { objeto: 'PROVEEDOR', inicio: 100000 },
  PEDIDO: { objeto: 'PEDIDO_COMPRA', inicio: 4500000000 },
  DOC_MATERIAL: { objeto: 'DOC_MATERIAL', inicio: 5000000000 },
});

/** Siguiente número del rango. Bloquea la fila del numerador hasta el COMMIT. */
export async function siguienteNumero(client, tenant_id, rango) {
  const r = await client.query(
    `INSERT INTO erp_numeradores (tenant_id, objeto, ultimo) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, objeto) DO UPDATE SET ultimo = erp_numeradores.ultimo + 1
     RETURNING ultimo`,
    [tenant_id, rango.objeto, rango.inicio]
  );
  return String(r.rows[0].ultimo);
}

// ─── Validación de campos ──────────────────────────────────────────────────

export function texto(v, { campo, max, requerido = false } = {}) {
  const s = v == null ? '' : String(v).trim();
  if (!s) {
    if (requerido) throw fallo(`Rellene todos los campos obligatorios (${campo})`);
    return null;
  }
  if (max && s.length > max) throw fallo(`${campo}: máximo ${max} caracteres`);
  return s;
}

export function cantidad(v, { campo = 'Cantidad', permitirCero = false } = {}) {
  const n = Number(String(v ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || (!permitirCero && n === 0)) {
    throw fallo(`${campo}: introduzca una cantidad mayor que cero`);
  }
  if (n > 1e9) throw fallo(`${campo}: cantidad demasiado grande`);
  return Math.round(n * 1000) / 1000;
}

export function importe(v, { campo = 'Precio' } = {}) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw fallo(`${campo}: importe inválido`);
  return Math.round(n * 100) / 100;
}

export function fecha(v, { campo = 'Fecha' } = {}) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw fallo(`${campo}: formato de fecha inválido (AAAA-MM-DD)`);
  }
  return s;
}

export function opcion(v, permitidos, { campo, porDefecto } = {}) {
  const s = v == null || v === '' ? porDefecto : String(v).trim().toUpperCase();
  if (!permitidos.includes(s)) {
    throw fallo(`${campo}: valor "${s}" no permitido (${permitidos.join(', ')})`);
  }
  return s;
}

/** Valida un RUT chileno con dígito verificador. Devuelve "12345678-5" o lanza. */
export function rutChileno(v) {
  if (v == null || String(v).trim() === '') return null;
  const limpio = String(v).replace(/[.\s]/g, '').toUpperCase();
  const m = limpio.match(/^(\d{1,8})-?([\dK])$/);
  if (!m) throw fallo('RUT inválido (formato 12345678-9)');
  const [, cuerpo, dv] = m;
  let suma = 0;
  let mult = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const resto = 11 - (suma % 11);
  const esperado = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
  if (dv !== esperado) throw fallo('RUT inválido: dígito verificador incorrecto');
  return `${cuerpo}-${dv}`;
}

// ─── Lookups comunes ───────────────────────────────────────────────────────

/** En este ERP un "centro" SAP es una bodega (depot) de la Torre. */
export async function validarCentro(client, tenant_id, centro) {
  const id = texto(centro, { campo: 'Centro', max: 64, requerido: true });
  const r = await client.query(
    `SELECT depot_id, nombre FROM depots WHERE tenant_id = $1 AND depot_id = $2 AND activo = TRUE`,
    [tenant_id, id]
  );
  if (!r.rowCount) throw fallo(`El centro ${id} no existe`, 404);
  return r.rows[0];
}

export async function leerMaterial(client, tenant_id, sku, { paraActualizar = false } = {}) {
  const id = texto(sku, { campo: 'Material', max: 64, requerido: true });
  const r = await client.query(
    `SELECT sku, nombre, unidad, activo, tipo_material, grupo_articulos,
            peso_bruto_kg, precio_estandar, created_at, updated_at
     FROM productos WHERE tenant_id = $1 AND sku = $2${paraActualizar ? ' FOR UPDATE' : ''}`,
    [tenant_id, id]
  );
  if (!r.rowCount) throw fallo(`El material ${id} no existe`, 404);
  return r.rows[0];
}

export async function leerProveedor(client, tenant_id, proveedor_id) {
  const id = texto(proveedor_id, { campo: 'Proveedor', max: 10, requerido: true });
  const r = await client.query(
    `SELECT * FROM erp_proveedores WHERE tenant_id = $1 AND proveedor_id = $2`,
    [tenant_id, id]
  );
  if (!r.rowCount) throw fallo(`El proveedor ${id} no existe`, 404);
  return r.rows[0];
}

/** Estado de un pedido según lo recibido en sus posiciones. */
export function estadoPedido(posiciones) {
  if (!posiciones.length) return 'ABIERTO';
  const completas = posiciones.every((p) => Number(p.cantidad_recibida) >= Number(p.cantidad));
  if (completas) return 'CERRADO';
  const alguna = posiciones.some((p) => Number(p.cantidad_recibida) > 0);
  return alguna ? 'PARCIAL' : 'ABIERTO';
}

export function operadorDe(operator) {
  return String(operator?.username || operator?.sub || 'desconocido').slice(0, 64);
}
