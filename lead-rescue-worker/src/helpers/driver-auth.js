// src/helpers/driver-auth.js
// JWT helper para autenticación de choferes — Web Crypto API nativa (Cloudflare Workers)
// Revocación: memoria (isolate) + KV DRIVER_REVOKED_JTI (cross-isolate).

import { CORS_HEADERS } from '../config.js';
import { HMAC_ALGO, importHmacKey, base64urlEncode, base64urlDecode } from './hmac.js';

const JWT_EXPIRY_SECONDS = 10 * 60 * 60;
const KV_PREFIX = 'drv_rev:';

// Cache local por isolate (rápido). Fuente de verdad en prod: KV.
const revokedJti = new Map();
const MAX_REVOKED = 5000;

function pruneRevoked(nowSec) {
  for (const [jti, exp] of revokedJti.entries()) {
    if (exp <= nowSec) revokedJti.delete(jti);
  }
  if (revokedJti.size > MAX_REVOKED) {
    const overflow = revokedJti.size - MAX_REVOKED;
    let removed = 0;
    for (const key of revokedJti.keys()) {
      revokedJti.delete(key);
      if (++removed >= overflow) break;
    }
  }
}

/**
 * Revoca un jti hasta su expiración natural (memoria + KV si hay binding).
 * @param {string} jti
 * @param {number} expUnixSeconds
 * @param {{ DRIVER_REVOKED_JTI?: KVNamespace }} [env]
 */
export async function revokeDriverJti(jti, expUnixSeconds, env = null) {
  if (!jti || typeof expUnixSeconds !== 'number') return { ok: false, reason: 'bad_args' };
  const nowSec = Math.floor(Date.now() / 1000);
  pruneRevoked(nowSec);
  revokedJti.set(jti, expUnixSeconds);

  const kv = env?.DRIVER_REVOKED_JTI;
  if (kv && typeof kv.put === 'function') {
    const ttl = Math.max(60, expUnixSeconds - nowSec);
    try {
      await kv.put(`${KV_PREFIX}${jti}`, String(expUnixSeconds), { expirationTtl: ttl });
      return { ok: true, persisted: true };
    } catch (e) {
      console.error('[DRIVER_REVOKE_KV]', e.message);
      return { ok: false, persisted: false, reason: 'kv_put_failed' };
    }
  }
  // Sin KV: solo memoria del isolate — no garantiza cross-isolate
  return { ok: true, persisted: false, reason: 'kv_unavailable' };
}

/** Sync check — solo memoria (tests / fast path). Preferí isDriverJtiRevokedAsync. */
export function isDriverJtiRevoked(jti) {
  if (!jti) return false;
  const now = Math.floor(Date.now() / 1000);
  const exp = revokedJti.get(jti);
  if (exp == null) return false;
  if (exp <= now) {
    revokedJti.delete(jti);
    return false;
  }
  return true;
}

/**
 * @param {string} jti
 * @param {{ DRIVER_REVOKED_JTI?: KVNamespace }} [env]
 */
export async function isDriverJtiRevokedAsync(jti, env = null) {
  if (!jti) return false;
  if (isDriverJtiRevoked(jti)) return true;

  const kv = env?.DRIVER_REVOKED_JTI;
  if (!kv || typeof kv.get !== 'function') return false;

  try {
    const val = await kv.get(`${KV_PREFIX}${jti}`);
    if (!val) return false;
    const exp = Number(val);
    const now = Math.floor(Date.now() / 1000);
    if (Number.isFinite(exp) && exp > now) {
      revokedJti.set(jti, exp);
      return true;
    }
    return false;
  } catch (e) {
    console.error('[DRIVER_REVOKE_KV_GET]', e.message);
    return false;
  }
}

/** Testing helper */
export function clearDriverRevocations() {
  revokedJti.clear();
}

const MIN_SECRET_BYTES = 32;

function validateSecret(env) {
  if (!env?.JWT_SECRET || typeof env.JWT_SECRET !== 'string') {
    throw new Error(
      '[driver-auth] JWT_SECRET no está configurado en el entorno. ' +
      'Configurar con `wrangler secret put JWT_SECRET` en producción ' +
      'o agregarlo a .dev.vars para desarrollo local.'
    );
  }
  const byteLength = new TextEncoder().encode(env.JWT_SECRET).byteLength;
  if (byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `[driver-auth] JWT_SECRET es demasiado corto (${byteLength} bytes). ` +
      `Mínimo requerido: ${MIN_SECRET_BYTES} bytes para HMAC-SHA256. ` +
      'Generar con: openssl rand -base64 32'
    );
  }
}

export async function signDriverToken(payload, env) {
  validateSecret(env);
  const enc = new TextEncoder();

  const headerB64 = base64urlEncode(
    enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  );

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + JWT_EXPIRY_SECONDS;
  const jti = crypto.randomUUID();
  const bodyB64 = base64urlEncode(
    enc.encode(JSON.stringify({
      ...payload,
      role: 'chofer',
      sub: payload.chofer_id,
      iat,
      exp,
      jti,
    }))
  );

  const signingInput = `${headerB64}.${bodyB64}`;

  const key = await importHmacKey(env.JWT_SECRET, ['sign']);
  const signatureBuffer = await crypto.subtle.sign(
    HMAC_ALGO,
    key,
    enc.encode(signingInput)
  );

  return `${signingInput}.${base64urlEncode(signatureBuffer)}`;
}

export async function verifyDriverToken(request, env) {
  validateSecret(env);
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'No autorizado: token ausente', code: 'token_ausente' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      ),
    };
  }

  const token = authHeader.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'No autorizado: token malformado', code: 'token_invalido' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      ),
    };
  }

  try {
    const signingInput = `${parts[0]}.${parts[1]}`;
    const key = await importHmacKey(env.JWT_SECRET, ['verify']);

    const isValid = await crypto.subtle.verify(
      HMAC_ALGO,
      key,
      base64urlDecode(parts[2]),
      new TextEncoder().encode(signingInput)
    );

    if (!isValid) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ error: 'No autorizado: firma inválida', code: 'token_invalido' }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        ),
      };
    }

    const payload = JSON.parse(
      new TextDecoder().decode(base64urlDecode(parts[1]))
    );

    if (typeof payload.exp !== 'number') {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ error: 'No autorizado: token sin expiración', code: 'token_invalido' }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        ),
      };
    }

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ error: 'No autorizado: token expirado', code: 'token_expirado' }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        ),
      };
    }

    if (payload.jti && await isDriverJtiRevokedAsync(payload.jti, env)) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ error: 'No autorizado: sesión revocada', code: 'token_revocado' }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        ),
      };
    }

    return { ok: true, payload };

  } catch {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'No autorizado: token inválido', code: 'token_invalido' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      ),
    };
  }
}
