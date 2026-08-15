// src/helpers/hmac.js
// Primitivas HMAC compartidas entre driver-auth.js y operator-auth.js.
// No contiene lógica de negocio ni semántica de tokens — solo las operaciones
// criptográficas de bajo nivel que ambos helpers de autenticación necesitan.
//
// Req 7.6: extraer aquí evita que los dos helpers diverjan silenciosamente
// en su implementación criptográfica.

export const HMAC_ALGO = { name: 'HMAC', hash: 'SHA-256' };

const MIN_SECRET_BYTES = 32;

// ─── Base64url encode / decode ────────────────────────────────────────────────
// Copiadas exactamente de driver-auth.js para garantizar comportamiento idéntico.
// btoa/atob están disponibles en el runtime de Cloudflare Workers.

export function base64urlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64urlDecode(str) {
  // Restaurar padding y caracteres de base64 estándar antes de decodificar
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const withPadding = padded.padEnd(padded.length + (4 - (padded.length % 4)) % 4, '=');
  const binary = atob(withPadding);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// ─── Importar clave HMAC ──────────────────────────────────────────────────────

/**
 * Importa una clave HMAC-SHA256 desde un secreto de texto plano.
 *
 * @param {string}   secret - Secreto en texto plano. Mínimo 32 bytes.
 * @param {string[]} usage  - Array de usos permitidos, ej. ['sign'], ['verify'], ['sign', 'verify']
 * @returns {Promise<CryptoKey>}
 * @throws {Error} Si el secreto tiene menos de 32 bytes.
 */
export async function importHmacKey(secret, usage = ['sign', 'verify']) {
  const encoded = new TextEncoder().encode(secret);
  if (encoded.byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `[hmac] Secret must be at least ${MIN_SECRET_BYTES} bytes ` +
      `(got ${encoded.byteLength}). Generate with: openssl rand -base64 32`
    );
  }
  return crypto.subtle.importKey(
    'raw',
    encoded,
    HMAC_ALGO,
    false,   // no exportable
    usage
  );
}
