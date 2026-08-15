// Rate-limit helpers for driver auth endpoints (check-rut / activate / login).

import { CORS_HEADERS } from '../config.js';
import { checkRateLimit } from '../monitoring/rate-limiter.js';

const jsonHeaders = () => ({ ...CORS_HEADERS, 'Content-Type': 'application/json' });

export function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP')
    ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    ?? request.headers.get('X-Real-IP')
    ?? 'unknown'
  );
}

/**
 * @param {Request} request
 * @param {string} endpoint
 * @param {number} limit
 * @param {number} windowMs
 * @returns {Response|null} 429 response when blocked, else null
 */
export function enforceDriverAuthRateLimit(request, endpoint, limit, windowMs) {
  const ip = getClientIp(request);
  const result = checkRateLimit(ip, endpoint, limit, windowMs);
  if (result.allowed) return null;

  return new Response(
    JSON.stringify({
      error: 'Demasiados intentos. Intenta más tarde.',
      code: 'rate_limit_excedido',
      retry_after_seconds: result.retryAfter,
    }),
    {
      status: 429,
      headers: {
        ...jsonHeaders(),
        'Retry-After': String(result.retryAfter),
        'Cache-Control': 'no-store',
      },
    }
  );
}

// Conservative defaults for account-takeover surfaces
export const DRIVER_AUTH_LIMITS = {
  login: { endpoint: '/api/choferes/login', limit: 10, windowMs: 15 * 60 * 1000 },
  activate: { endpoint: '/api/choferes/activate', limit: 5, windowMs: 15 * 60 * 1000 },
  checkRut: { endpoint: '/api/choferes/check-rut', limit: 20, windowMs: 15 * 60 * 1000 },
};
