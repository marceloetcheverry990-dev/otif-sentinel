// src/monitoring/rate-limiter.js
// Rate Limiting Implementation for Monitoring Endpoints
// Requirements: 10.4

/**
 * RATE LIMITER
 * 
 * Purpose: Prevent abuse of monitoring endpoints through request rate limiting
 * Uses in-memory Map to track request counts per IP address per time window
 * 
 * Features:
 * - Tracks requests per IP address
 * - Configurable rate limit and time window
 * - Automatic cleanup of expired entries
 * - Returns remaining quota and retry-after information
 * 
 * Requirements:
 * - 10.4: Health check endpoint rate limiting (60 req/min per IP)
 */

import { MONITORING_CONFIG } from './config.js';

/**
 * In-memory storage for rate limit tracking
 * Key format: `${endpoint}:${ipAddress}`
 * Value format: { count: number, windowStart: number, lastCleanup: number }
 */
const rateLimitStore = new Map();

/**
 * Maximum cache size before triggering cleanup
 * Prevents unbounded memory growth from unique IPs
 */
const MAX_CACHE_SIZE = 10000;

/**
 * Extract IP address from request
 * Checks various headers in order of precedence:
 * 1. CF-Connecting-IP (Cloudflare)
 * 2. X-Forwarded-For (proxy)
 * 3. X-Real-IP (nginx)
 * 4. Connection remote address
 * 
 * @param {Request} request - HTTP request
 * @returns {string} - IP address or 'unknown'
 */
function getClientIP(request) {
  // Cloudflare specific header (most reliable)
  const cfIP = request.headers.get('cf-connecting-ip');
  if (cfIP) {
    return cfIP;
  }

  // Standard proxy headers
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // X-Forwarded-For can contain multiple IPs, take the first
    return forwardedFor.split(',')[0].trim();
  }

  const realIP = request.headers.get('x-real-ip');
  if (realIP) {
    return realIP;
  }

  // Fallback
  return 'unknown';
}

/**
 * Clean up expired rate limit entries
 * Removes entries older than the time window
 * 
 * @param {number} windowMs - Time window in milliseconds
 */
function cleanupExpiredEntries(windowMs) {
  const now = Date.now();
  const expiredKeys = [];

  for (const [key, value] of rateLimitStore.entries()) {
    // If window started more than windowMs ago, entry is expired
    if (now - value.windowStart > windowMs) {
      expiredKeys.push(key);
    }
  }

  // Remove expired entries
  for (const key of expiredKeys) {
    rateLimitStore.delete(key);
  }
}

/**
 * Check and update rate limit for a client using a sliding fixed-window algorithm.
 *
 * Algorithm:
 * 1. Compute the cache key as `${endpoint}:${ipAddress}`.
 * 2. Look up the existing entry in `rateLimitStore`.
 * 3. If the entry's window has expired (or no entry exists), start a new window
 *    with count = 1 and return `allowed: true`.
 * 4. If the window is still active and `count >= limit`, return `allowed: false`
 *    with `retryAfter` set to the remaining window time in seconds.
 * 5. Otherwise increment the count and return `allowed: true`.
 * 6. Trigger a full cache cleanup pass when the store exceeds `MAX_CACHE_SIZE`
 *    (10 000 entries) to prevent unbounded memory growth from many unique IPs.
 *
 * @security IP addresses are extracted from `CF-Connecting-IP` (set by
 *   Cloudflare's edge) which is **trusted** within a Workers environment.
 *   Do not use `X-Forwarded-For` as the primary source in production because
 *   it can be spoofed by clients; it is checked only as a fallback.
 *
 * @security The in-memory store is **per-isolate**. In a multi-isolate
 *   deployment each isolate maintains its own store, so the effective limit
 *   may be `N × limit` where N is the number of running isolates. For
 *   precise rate limiting at scale, use Cloudflare Durable Objects.
 *
 * @param {string} ipAddress - Client IP address (use {@link getClientIP} to extract)
 * @param {string} endpoint  - Endpoint identifier used to namespace the limit
 *   (e.g., `'/health'`, `'/dashboard'`)
 * @param {number} limit     - Maximum requests allowed within `windowMs`
 * @param {number} windowMs  - Duration of the rate-limit window in milliseconds
 * @returns {{ allowed: boolean, remaining: number, retryAfter: number|null }}
 *   - `allowed`:    `true` when the request should proceed
 *   - `remaining`:  Requests still available in the current window (0 when blocked)
 *   - `retryAfter`: Seconds until the window resets (only set when `allowed` is `false`)
 *
 * @example
 * const result = checkRateLimit('203.0.113.5', '/health', 60, 60_000);
 * if (!result.allowed) {
 *   return new Response('Too Many Requests', {
 *     status: 429,
 *     headers: { 'Retry-After': String(result.retryAfter) },
 *   });
 * }
 *
 * Requirements: 10.4
 */
export function checkRateLimit(ipAddress, endpoint, limit, windowMs) {
  const now = Date.now();
  const key = `${endpoint}:${ipAddress}`;

  // Perform cleanup if cache is getting large (requirement 10.4)
  if (rateLimitStore.size > MAX_CACHE_SIZE) {
    cleanupExpiredEntries(windowMs);
  }

  // Get existing entry or create new one
  let entry = rateLimitStore.get(key);

  if (!entry) {
    // First request from this IP for this endpoint
    entry = {
      count: 1,
      windowStart: now,
    };
    rateLimitStore.set(key, entry);

    return {
      allowed: true,
      remaining: limit - 1,
      retryAfter: null,
    };
  }

  // Check if current window has expired
  const windowElapsed = now - entry.windowStart;
  
  if (windowElapsed > windowMs) {
    // Window expired, start new window
    entry.count = 1;
    entry.windowStart = now;
    rateLimitStore.set(key, entry);

    return {
      allowed: true,
      remaining: limit - 1,
      retryAfter: null,
    };
  }

  // Within current window - check if limit exceeded
  if (entry.count >= limit) {
    // Rate limit exceeded
    const timeUntilReset = windowMs - windowElapsed;
    const retryAfter = Math.ceil(timeUntilReset / 1000); // Convert to seconds

    return {
      allowed: false,
      remaining: 0,
      retryAfter,
    };
  }

  // Within limit - increment count
  entry.count++;
  rateLimitStore.set(key, entry);

  return {
    allowed: true,
    remaining: limit - entry.count,
    retryAfter: null,
  };
}

/**
 * Middleware wrapper for rate-limited endpoints
 * 
 * Applies rate limiting to a handler function.
 * Returns 429 Too Many Requests if limit exceeded.
 * 
 * @param {Function} handler - Original handler function
 * @param {Object} config - Rate limit configuration
 *   {
 *     endpoint: string - Endpoint identifier
 *     limit: number - Maximum requests per window
 *     windowMs: number - Time window in milliseconds
 *   }
 * @returns {Function} - Wrapped handler with rate limiting
 * 
 * @example
 * export const handleHealthCheck = withRateLimit(
 *   async (request, env) => {
 *     // Handler logic
 *   },
 *   { endpoint: '/health', limit: 60, windowMs: 60000 }
 * );
 */
export function withRateLimit(handler, config = {}) {
  const {
    endpoint = 'unknown',
    limit = 60,
    windowMs = 60000, // 1 minute default
  } = config;

  return async function rateLimitedHandler(request, env, ...args) {
    // Extract client IP
    const clientIP = getClientIP(request);

    // Check rate limit
    const result = checkRateLimit(clientIP, endpoint, limit, windowMs);

    if (!result.allowed) {
      // Rate limit exceeded - return 429
      return new Response(
        JSON.stringify({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Maximum ${limit} requests per ${windowMs / 1000} seconds.`,
          retry_after: result.retryAfter,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': result.retryAfter.toString(),
            'X-RateLimit-Limit': limit.toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': (Date.now() + (result.retryAfter * 1000)).toString(),
          },
        }
      );
    }

    // Rate limit OK - add rate limit headers and proceed
    const response = await handler(request, env, ...args);

    // Clone response to add headers (Response is immutable)
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-RateLimit-Limit', limit.toString());
    newResponse.headers.set('X-RateLimit-Remaining', result.remaining.toString());
    
    // Calculate reset time (end of current window)
    const entry = rateLimitStore.get(`${endpoint}:${clientIP}`);
    if (entry) {
      const resetTime = entry.windowStart + windowMs;
      newResponse.headers.set('X-RateLimit-Reset', resetTime.toString());
    }

    return newResponse;
  };
}

/**
 * Apply rate limiting to health check endpoint
 * Convenience function with pre-configured limits for /health
 * 
 * Implements requirement 10.4: 60 requests per minute per IP
 * 
 * @param {Function} handler - Health check handler
 * @returns {Function} - Rate-limited health check handler
 * 
 * @example
 * import { withHealthCheckRateLimit } from './monitoring/rate-limiter.js';
 * 
 * export const handleHealthCheck = withHealthCheckRateLimit(
 *   async (request, env) => {
 *     // Health check logic
 *   }
 * );
 */
export function withHealthCheckRateLimit(handler) {
  return withRateLimit(handler, {
    endpoint: '/health',
    limit: MONITORING_CONFIG.security.health_check_rate_limit, // 60 req/min from config
    windowMs: 60000, // 1 minute
  });
}

/**
 * Apply rate limiting to dashboard endpoint
 * Convenience function with pre-configured limits for /dashboard
 * 
 * @param {Function} handler - Dashboard handler
 * @returns {Function} - Rate-limited dashboard handler
 */
export function withDashboardRateLimit(handler) {
  return withRateLimit(handler, {
    endpoint: '/dashboard',
    limit: MONITORING_CONFIG.security.dashboard_rate_limit, // 30 req/min from config
    windowMs: 60000, // 1 minute
  });
}

/**
 * Get current rate limit statistics
 * Useful for debugging and monitoring the rate limiter itself
 * 
 * @returns {Object} - { totalEntries: number, oldestEntry: Date|null, newestEntry: Date|null }
 */
export function getRateLimitStats() {
  const entries = Array.from(rateLimitStore.values());
  
  if (entries.length === 0) {
    return {
      totalEntries: 0,
      oldestEntry: null,
      newestEntry: null,
    };
  }

  const timestamps = entries.map(e => e.windowStart);
  const oldest = Math.min(...timestamps);
  const newest = Math.max(...timestamps);

  return {
    totalEntries: entries.length,
    oldestEntry: new Date(oldest),
    newestEntry: new Date(newest),
  };
}

/**
 * Clear all rate limit data
 * Useful for testing or manual reset
 */
export function clearRateLimitData() {
  rateLimitStore.clear();
}

/**
 * Export default configuration
 */
export default {
  checkRateLimit,
  withRateLimit,
  withHealthCheckRateLimit,
  withDashboardRateLimit,
  getRateLimitStats,
  clearRateLimitData,
};
