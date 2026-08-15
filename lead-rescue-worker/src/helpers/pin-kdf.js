// PIN KDF for driver accounts — Web Crypto PBKDF2-SHA256 (Workers-native).
// Stored format: v1$<salt_b64url>$<hash_b64url>
// Legacy plaintext PINs are accepted once, then upgraded on successful login.

import { base64urlEncode, base64urlDecode } from './hmac.js';

const PREFIX = 'v1';
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function getPepper(env) {
  const pepper = env?.PIN_PEPPER || env?.JWT_SECRET;
  if (!pepper || typeof pepper !== 'string') {
    throw new Error('[pin-kdf] PIN_PEPPER o JWT_SECRET requerido para hashear PINs');
  }
  return pepper;
}

export function isHashedPin(stored) {
  return typeof stored === 'string' && stored.startsWith(`${PREFIX}$`);
}

export function isAccountActivated(storedPin) {
  return typeof storedPin === 'string' && storedPin.trim() !== '';
}

function timingSafeEqualBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function timingSafeEqualString(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(String(a ?? ''));
  const bb = enc.encode(String(b ?? ''));
  if (aa.length !== bb.length) {
    // Compare against self to keep roughly constant work on length mismatch
    timingSafeEqualBytes(aa, aa);
    return false;
  }
  return timingSafeEqualBytes(aa, bb);
}

async function derive(pin, salt, pepper) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(`${pepper}:${pin}`),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

/**
 * @param {string} pin
 * @param {{ PIN_PEPPER?: string, JWT_SECRET?: string }} env
 * @returns {Promise<string>}
 */
export async function hashPin(pin, env) {
  const pepper = getPepper(env);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(pin, salt, pepper);
  return `${PREFIX}$${base64urlEncode(salt)}$${base64urlEncode(hash)}`;
}

/**
 * @param {string} pin
 * @param {string|null|undefined} stored
 * @param {{ PIN_PEPPER?: string, JWT_SECRET?: string }} env
 * @returns {Promise<{ ok: boolean, needsUpgrade: boolean }>}
 */
export async function verifyPin(pin, stored, env) {
  if (typeof pin !== 'string' || !pin || typeof stored !== 'string' || !stored) {
    return { ok: false, needsUpgrade: false };
  }

  if (isHashedPin(stored)) {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== PREFIX) {
      return { ok: false, needsUpgrade: false };
    }
    try {
      const salt = base64urlDecode(parts[1]);
      const expected = base64urlDecode(parts[2]);
      const actual = await derive(pin, salt, getPepper(env));
      return { ok: timingSafeEqualBytes(actual, expected), needsUpgrade: false };
    } catch {
      return { ok: false, needsUpgrade: false };
    }
  }

  // Legacy plaintext — accept once and signal upgrade
  const ok = timingSafeEqualString(pin, stored);
  return { ok, needsUpgrade: ok };
}
