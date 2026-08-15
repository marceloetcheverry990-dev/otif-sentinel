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

function resolveKeyMaterial(env) {
  const material = env?.DTE_TOKEN_ENCRYPTION_KEY || env?.DASHBOARD_SECRET;
  if (!material || typeof material !== 'string' || material.length < MIN_KEY_CHARS) {
    throw new Error(
      '[dte-secret] DTE_TOKEN_ENCRYPTION_KEY o DASHBOARD_SECRET (≥32 chars) requerido para cifrar/descifrar'
    );
  }
  return material;
}

async function importAesKey(env, usages) {
  const material = resolveKeyMaterial(env);
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
