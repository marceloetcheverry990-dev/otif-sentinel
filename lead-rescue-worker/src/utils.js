// src/utils.js//Aquí van las funciones de ayuda matemática y de formateo.

export function escapeHTML(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** ID DOM estable y único por trip_id (hex padded, sin truncar — evita colisiones SPOT-…-001/-002). */
export function makeSafeTripId(tripId) {
  return 'trip_' + Array.from(String(tripId ?? ''), (c) =>
    c.charCodeAt(0).toString(16).padStart(2, '0')
  ).join('');
}

/** Solo http(s) para href; vacío si el esquema no es seguro. */
export function safeHttpUrl(url) {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;');
}

const ESTADOS_TERMINALES_VIAJE = ['ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA'];

export function isViajeTerminalCompleto(viaje) {
  const pars = (viaje && viaje.detalle_paradas) || [];
  return pars.length > 0 && pars.every((p) => ESTADOS_TERMINALES_VIAJE.includes(p.estado_operacional));
}

export function countViajesFlotaVisibles(viajes) {
  return (viajes || []).filter((v) => !isViajeTerminalCompleto(v)).length;
}

export function getExponentialBackoff(attempts, maxSeconds = 300) {
  const base = Math.pow(2, attempts);
  const jitter = Math.random() * 5;
  return Math.min(maxSeconds, base + jitter);
}

// 🧮 MOTOR MATEMÁTICO: Fórmula de Haversine (Distancia GPS)
export function calcularDistanciaKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radio de la Tierra en km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

export async function verifyMetaSignature(rawBody, signature, secret) {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const cryptoApi = globalThis.crypto;
  try {
    const key = await cryptoApi.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = new Uint8Array(32);
    const hex = signature.slice(7);
    for (let i = 0; i < 64; i += 2) {
      const byte = parseInt(hex.slice(i, i + 2), 16);
      if (Number.isNaN(byte)) return false; 
      sigBytes[i / 2] = byte;
    }
    return await cryptoApi.subtle.verify('HMAC', key, sigBytes, rawBody);
  } catch { return false; }
}