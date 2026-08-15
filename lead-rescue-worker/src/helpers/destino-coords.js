/**
 * Resuelve lat/lng de destino con prioridad:
 * 1) columnas ordenes_pendientes.lat/lng
 * 2) metadata.lat_destino / lng_destino
 * 3) clientes.lat / lng
 *
 * No inventa Santiago ni otros placeholders.
 */

export function parseCoord(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

export function isValidLatLng(lat, lng) {
  return (
    lat !== null &&
    lng !== null &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

export function normalizeClienteKey(nombre) {
  return String(nombre || '').trim().toLowerCase();
}

export function parseOrdenMetadata(orden) {
  if (!orden) return {};
  const raw = orden.metadata;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * @param {object} orden - fila ordenes_pendientes (puede incluir lat/lng/metadata)
 * @param {object|null} cliente - fila clientes o null
 * @returns {{ lat: number|null, lng: number|null, source: string|null }}
 */
export function resolveDestinoCoords(orden, cliente = null) {
  const meta = parseOrdenMetadata(orden);
  const candidates = [
    { lat: orden?.lat, lng: orden?.lng, source: 'orden' },
    { lat: meta.lat_destino, lng: meta.lng_destino, source: 'metadata' },
    { lat: cliente?.lat, lng: cliente?.lng, source: 'cliente' },
  ];

  for (const c of candidates) {
    const lat = parseCoord(c.lat);
    const lng = parseCoord(c.lng);
    if (isValidLatLng(lat, lng)) {
      return { lat, lng, source: c.source };
    }
  }
  return { lat: null, lng: null, source: null };
}

/**
 * Dirección legible: metadata → clientes → fallback.
 */
export function resolveDestinoDireccion(orden, cliente = null, fallback = 'Sin dirección registrada') {
  const meta = parseOrdenMetadata(orden);
  return (
    meta.direccion_entrega ||
    cliente?.direccion_calle ||
    cliente?.direccion ||
    cliente?.comuna ||
    fallback
  );
}

/**
 * Mapa case-insensitive nombre → cliente.
 */
export function buildClientesMap(clientes) {
  const map = {};
  for (const c of clientes || []) {
    const key = normalizeClienteKey(c.nombre_cliente_raw);
    if (key) map[key] = c;
  }
  return map;
}
