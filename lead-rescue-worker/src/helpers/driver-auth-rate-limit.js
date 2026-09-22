// Rate-limit helpers for driver auth endpoints (check-rut / activate / login).
//
// Antes: Map en memoria (monitoring/rate-limiter.js) — se reinicia por
// isolate. En Cloudflare Workers los isolates se reciclan constantemente
// (no solo bajo ataque distribuido), así que el límite efectivo era mucho
// más alto que el nominal, casi siempre. Con un PIN de 4 dígitos (10.000
// combinaciones) eso es una ventana de fuerza bruta real.
//
// Ahora: respaldado por el KV que ya existe (DRIVER_REVOKED_JTI) — se
// comparte entre isolates y PoPs. KV es eventually-consistent (~60s de
// propagación), así que el conteo es aproximado bajo ráfagas muy
// concurrentes desde múltiples PoPs a la vez — pero cierra por completo el
// hueco de "cada isolate nuevo arranca en cero", que era el problema real.

import { CORS_HEADERS } from '../config.js';

const jsonHeaders = () => ({ ...CORS_HEADERS, 'Content-Type': 'application/json' });

export function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP')
    ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    ?? request.headers.get('X-Real-IP')
    ?? 'unknown'
  );
}

function rateLimitResponse(retryAfter) {
  return new Response(
    JSON.stringify({
      error: 'Demasiados intentos. Intenta más tarde.',
      code: 'rate_limit_excedido',
      retry_after_seconds: retryAfter,
    }),
    {
      status: 429,
      headers: {
        ...jsonHeaders(),
        'Retry-After': String(retryAfter),
        'Cache-Control': 'no-store',
      },
    }
  );
}

/**
 * @param {KVNamespace|undefined} kv
 * @returns {Promise<{ allowed: boolean, retryAfter: number|null }>}
 */
async function checkKvRateLimit(kv, key, limit, windowMs) {
  if (!kv) {
    // Sin KV bindeado (ej. test env sin binding) — fail-open, no bloquear.
    console.warn('[RATE_LIMIT] KV no disponible, rate limit no aplicado:', key);
    return { allowed: true, retryAfter: null };
  }
  const now = Date.now();
  let entry = null;
  try {
    entry = await kv.get(key, 'json');
  } catch (e) {
    console.warn('[RATE_LIMIT] KV get error, fail-open:', e.message);
    return { allowed: true, retryAfter: null };
  }

  const ttlSeconds = Math.ceil(windowMs / 1000) + 60;

  if (!entry || now - entry.windowStart > windowMs) {
    await kv.put(key, JSON.stringify({ count: 1, windowStart: now }), {
      expirationTtl: ttlSeconds,
    }).catch(() => {});
    return { allowed: true, retryAfter: null };
  }

  if (entry.count >= limit) {
    const retryAfter = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }

  await kv.put(key, JSON.stringify({ count: entry.count + 1, windowStart: entry.windowStart }), {
    expirationTtl: ttlSeconds,
  }).catch(() => {});
  return { allowed: true, retryAfter: null };
}

/**
 * Límite por IP. Se llama antes de parsear el body (barato, corta rápido).
 * @param {Request} request
 * @param {object} env - bindings del Worker (usa env.DRIVER_REVOKED_JTI como KV)
 * @param {string} endpoint
 * @param {number} limit
 * @param {number} windowMs
 * @returns {Promise<Response|null>} 429 response cuando está bloqueado, si no null
 */
export async function enforceDriverAuthRateLimit(request, env, endpoint, limit, windowMs) {
  const ip = getClientIp(request);
  const key = `ratelimit:${endpoint}:ip:${ip}`;
  const result = await checkKvRateLimit(env?.DRIVER_REVOKED_JTI, key, limit, windowMs);
  if (result.allowed) return null;
  return rateLimitResponse(result.retryAfter);
}

/**
 * Límite por cuenta (tenant_id + rut) — independiente de la IP. Sin esto,
 * un atacante que rota de IP (proxies, botnet) evade el límite por-IP sin
 * problema y sigue probando los 10.000 PINs contra la misma cuenta.
 * Se llama DESPUÉS de parsear el body (ya se conoce el rut), antes de
 * verificar el PIN.
 * @returns {Promise<Response|null>}
 */
export async function enforceAccountRateLimit(env, endpoint, tenantId, rut, limit, windowMs) {
  const key = `ratelimit:${endpoint}:acct:${String(tenantId || '')}:${String(rut || '')}`;
  const result = await checkKvRateLimit(env?.DRIVER_REVOKED_JTI, key, limit, windowMs);
  if (result.allowed) return null;
  return rateLimitResponse(result.retryAfter);
}

// Conservative defaults for account-takeover surfaces
export const DRIVER_AUTH_LIMITS = {
  login: { endpoint: '/api/choferes/login', limit: 10, windowMs: 15 * 60 * 1000 },
  activate: { endpoint: '/api/choferes/activate', limit: 5, windowMs: 15 * 60 * 1000 },
  checkRut: { endpoint: '/api/choferes/check-rut', limit: 20, windowMs: 15 * 60 * 1000 },
};

// Límite por cuenta específico para login (PIN de 4 dígitos): más estricto
// que el límite por IP, porque el objetivo es la cuenta, no la IP.
export const LOGIN_ACCOUNT_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };
