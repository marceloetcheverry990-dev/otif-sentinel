/**
 * R4: secreto reversible at-rest (AES-256-GCM) para dte_api_token.
 * Formato: enc$v1$<iv_b64url>$<ciphertext_b64url>
 * Clave: SHA-256(DTE_TOKEN_ENCRYPTION_KEY || DASHBOARD_SECRET)
 */

import { base64urlDecode, base64urlEncode } from '../hmac.js';

const PREFIX = 'enc$v1$';
const IV_BYTES = 12;
const MIN_KEY_CHARS = 32;

export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Descifrar (datos ya sellados) siempre puede caer a DASHBOARD_SECRET por
 * compatibilidad — no rompe secretos existentes. Cifrar (sellar uno NUEVO)
 * exige DTE_TOKEN_ENCRYPTION_KEY dedicada por defecto: reusar DASHBOARD_SECRET
 * (que también firma sesiones/JWT) para un secreto nuevo es evitable y no
 * debería ser el default. DTE_ALLOW_SHARED_ENCRYPTION_KEY=true restaura el
 * comportamiento anterior si hace falta.
 */
function resolveKeyMaterial(env, { forEncrypt = false } = {}) {
  const dedicated = env?.DTE_TOKEN_ENCRYPTION_KEY;
  if (dedicated && typeof dedicated === 'string' && dedicated.length >= MIN_KEY_CHARS) {
    return dedicated;
  }

  if (forEncrypt && String(env?.DTE_ALLOW_SHARED_ENCRYPTION_KEY || '').toLowerCase() !== 'true') {
    throw new Error(
      '[dte-secret] DTE_TOKEN_ENCRYPTION_KEY (≥32 chars) requerida para cifrar un secreto nuevo ' +
      '(o DTE_ALLOW_SHARED_ENCRYPTION_KEY=true para reusar DASHBOARD_SECRET)'
    );
  }

  const fallback = env?.DASHBOARD_SECRET;
  if (!fallback || typeof fallback !== 'string' || fallback.length < MIN_KEY_CHARS) {
    throw new Error(
      '[dte-secret] DTE_TOKEN_ENCRYPTION_KEY o DASHBOARD_SECRET (≥32 chars) requerido para cifrar/descifrar'
    );
  }
  return fallback;
}

async function importAesKey(env, usages) {
  const material = resolveKeyMaterial(env, { forEncrypt: usages.includes('encrypt') });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, usages);
}

/**
 * @param {string} plaintext
 * @param {object} env
 * @returns {Promise<string>}
 */
export async function encryptSecret(plaintext, env) {
  if (plaintext == null || plaintext === '') {
    throw new Error('[dte-secret] plaintext vacío');
  }
  if (isEncryptedSecret(plaintext)) return plaintext;

  const key = await importAesKey(env, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(String(plaintext))
  );
  return `${PREFIX}${base64urlEncode(iv)}$${base64urlEncode(ct)}`;
}

/**
 * @param {string} blob
 * @param {object} env
 * @returns {Promise<string>}
 */
export async function decryptSecret(blob, env) {
  if (!isEncryptedSecret(blob)) return String(blob ?? '');

  const parts = blob.split('$');
  // enc$v1$iv$ct → ['enc','v1',iv,ct]
  if (parts.length !== 4 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('[dte-secret] formato inválido');
  }
  const iv = base64urlDecode(parts[2]);
  const ct = base64urlDecode(parts[3]);
  const key = await importAesKey(env, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/**
 * Si el valor ya está cifrado lo deja; si es plaintext lo sella.
 * @returns {Promise<{ value: string, sealed: boolean }>}
 */
export async function sealSecret(value, env) {
  if (value == null || value === '') return { value: null, sealed: false };
  if (isEncryptedSecret(value)) return { value, sealed: false };
  return { value: await encryptSecret(value, env), sealed: true };
}
