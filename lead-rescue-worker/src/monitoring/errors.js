// src/monitoring/errors.js
// Error Tracking and Aggregation Module
// Requirements: 3.1-3.10, 10.2

import { MONITORING_CONFIG } from './config.js';

/**
 * Capture and persist error asynchronously
 * 
 * This function captures application errors with full contextual information,
 * generates an error fingerprint for aggregation, classifies severity, and
 * stores the error in the database asynchronously to avoid blocking requests.
 * 
 * @param {Error} error - Exception object to capture
 * @param {Object} context - Contextual metadata {
 *   trace_id: string,
 *   tenant_id: string (optional),
 *   endpoint: string (optional),
 *   http_method: string (optional),
 *   user_agent: string (optional),
 *   ot_id: string (optional),
 *   queue: string (optional),
 *   retry_count: number (optional),
 *   ...additional context
 * }
 * @param {Client} dbClient - Optional database client for transaction context
 * @returns {Promise<string>} - Error fingerprint ID
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.7
 * 
 * Usage:
 *   try {
 *     // operation
 *   } catch (error) {
 *     await captureError(error, { 
 *       trace_id: 'req_123', 
 *       tenant_id: 'acme',
 *       endpoint: '/wms-webhook'
 *     });
 *   }
 */
export async function captureError(error, context = {}, dbClient = null) {
  try {
    // Extract error information
    const errorType = error?.name || 'UnknownError';
    const errorMessage = error?.message || String(error);
    const stackTrace = error?.stack || new Error().stack;
    
    // Generate error fingerprint for aggregation (Requirement 3.5)
    const fingerprint = generateErrorFingerprint(error);
    
    // Classify error severity (Requirement 3.4)
    const severity = classifyErrorSeverity(error);
    
    // Sanitize error message to remove sensitive data (Requirement 10.2)
    const sanitizedMessage = sanitizeErrorMessage(errorMessage);
    
    // Prepare error log entry
    const errorLog = {
      severity,
      error_type: errorType,
      error_message: sanitizedMessage,
      error_fingerprint: fingerprint,
      stack_trace: stackTrace,
      trace_id: context.trace_id || null,
      tenant_id: context.tenant_id || null,
      endpoint: context.endpoint || null,
      http_method: context.http_method || null,
      context_metadata: {
        user_agent: context.user_agent || null,
        ot_id: context.ot_id || null,
        queue: context.queue || null,
        retry_count: context.retry_count || null,
        // Include any additional context fields
        ...Object.fromEntries(
          Object.entries(context).filter(
            ([key]) => !['trace_id', 'tenant_id', 'endpoint', 'http_method', 'user_agent', 'ot_id', 'queue', 'retry_count'].includes(key)
          )
        )
      }
    };
    
    // Store error in database
    if (dbClient) {
      // Use provided client (synchronous within transaction)
      await persistError(errorLog, dbClient);
    } else {
      // No dbClient provided - log to console as fallback
      // In production, this would use ctx.waitUntil() when called from request handler
      console.error('[ERROR_TRACKER]', {
        fingerprint,
        severity,
        type: errorType,
        message: sanitizedMessage,
        context: errorLog.context_metadata
      });
    }
    
    return fingerprint;
  } catch (captureError) {
    // Fail-safe: monitoring failures should not crash the application
    console.error('[ERROR_TRACKER_FAILURE]', captureError.message);
    return 'capture-failed';
  }
}

/**
/**
 * Generate a deterministic fingerprint for an error.
 *
 * Produces a 16-character hex hash by combining three normalised components:
 *   1. **Error name** — `error.name` (e.g., `'TypeError'`)
 *   2. **Normalised message** — dynamic values stripped:
 *      - numbers → `N`, UUIDs → `UUID`, quoted strings → `STR`, hex values → `HEX`
 *   3. **First 3 stack frames** — function name + file path, without line numbers
 *      (so the fingerprint remains stable across minor code changes)
 *
 * The same logical error (same type, same location, same root cause) produces the
 * same fingerprint across invocations, enabling aggregation in `error_logs`.
 * Different errors produce different fingerprints with very high probability.
 *
 * The underlying hash is a 32-bit djb2 variant — intentionally fast and
 * non-cryptographic. It is not suitable for security use.
 *
 * @param {Error|*} error - Exception object. If non-Error, only `error.name` is used.
 * @returns {string} 16-character lowercase hex fingerprint (e.g., `'0000ab12cd34ef56'`)
 *
 * Requirement: 3.5
 */
export function generateErrorFingerprint(error) {
  try {
    const errorName = error?.name || 'UnknownError';
    
    // Normalize message: remove dynamic values (numbers, UUIDs, etc.)
    const errorMessage = error?.message || '';
    const normalizedMessage = errorMessage
      .replace(/\d+/g, 'N')              // Replace numbers with 'N'
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID') // Replace UUIDs
      .replace(/['"][^'"]*['"]/g, 'STR') // Replace quoted strings
      .replace(/0x[0-9a-f]+/gi, 'HEX')   // Replace hex values
      .trim();
    
    // Extract first 3 stack frames for location fingerprinting
    const stackTrace = error?.stack || '';
    const stackFrames = stackTrace
      .split('\n')
      .slice(1, 4) // Skip error message line, take next 3 frames
      .map(frame => {
        // Extract just the function and file location, not line numbers
        const match = frame.match(/at\s+([^\s]+)\s+\(([^:]+)/);
        if (match) return `${match[1]}@${match[2]}`;
        // Frames sin nombre de función ("at file:///path/x.js:12:5"):
        // quitar query strings y :línea:columna para que el fingerprint sea
        // estable entre errores creados en líneas distintas del mismo archivo
        return frame
          .trim()
          .replace(/\?[^\s:)]*/g, '')
          .replace(/:\d+(?::\d+)?\)?$/, '');
      })
      .join('|');
    
    // Combine components for fingerprinting
    const fingerprintSource = `${errorName}:${normalizedMessage}:${stackFrames}`;
    
    // Generate hash using SubtleCrypto (available in Cloudflare Workers)
    // For simplicity in non-async context, use a simple hash function
    const hash = simpleHash(fingerprintSource);
    
    return hash;
  } catch (err) {
    // Fallback to basic hash if fingerprinting fails
    return simpleHash(error?.name || 'unknown');
  }
}

/**
 * Simple hash function for fingerprint generation
 * Uses a fast string hashing algorithm suitable for Cloudflare Workers
 * 
 * @param {string} str - String to hash
 * @returns {string} - Hex hash string (16 chars)
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Convert to hex and pad to 16 characters
  return Math.abs(hash).toString(16).padStart(16, '0');
}

/**
 * Classify error severity
 * 
 * Determines severity level based on error type and characteristics:
 * - INFO: Handled business errors (validation failures)
 * - WARN: Recoverable errors (retry succeeded)
 * - ERROR: Operation failures (database timeout, API errors)
 * - CRITICAL: System failures (worker crash, memory exhaustion)
 * 
 * Requirement: 3.4
 * 
 * @param {Error} error - Exception object
 * @returns {string} - Severity level ('INFO', 'WARN', 'ERROR', 'CRITICAL')
 */
export function classifyErrorSeverity(error) {
  const errorName = error?.name || '';
  const errorMessage = error?.message || '';
  const lowerMessage = errorMessage.toLowerCase();
  
  // CRITICAL: System-level failures
  if (
    errorName === 'OutOfMemoryError' ||
    errorName === 'SystemError' ||
    lowerMessage.includes('worker exceeded') ||
    lowerMessage.includes('cpu time limit') ||
    lowerMessage.includes('memory limit') ||
    lowerMessage.includes('script exceeded') ||
    lowerMessage.includes('fatal error')
  ) {
    return 'CRITICAL';
  }
  
  // INFO: Handled business/validation errors
  if (
    errorName === 'ValidationError' ||
    errorName === 'ZodError' ||
    lowerMessage.includes('validation failed') ||
    lowerMessage.includes('invalid input') ||
    lowerMessage.includes('bad request') ||
    lowerMessage.includes('required field')
  ) {
    return 'INFO';
  }
  
  // WARN: Recoverable errors
  if (
    errorName === 'RetryError' ||
    lowerMessage.includes('retry') ||
    lowerMessage.includes('temporary') ||
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('backoff')
  ) {
    return 'WARN';
  }
  
  // ERROR: Operation failures (default)
  // This includes:
  // - TimeoutError
  // - DatabaseError
  // - NetworkError
  // - External API failures
  return 'ERROR';
}

/**
 * Sanitize error message to remove sensitive data
 * 
 * Removes patterns that may contain sensitive information:
 * - Credit card numbers
 * - Email addresses
 * - Phone numbers
 * - Bearer tokens
 * - API keys
 * 
 * Requirements: 10.2, 2.6
 * 
 * @param {string} message - Error message to sanitize
 * @returns {string} - Sanitized message
 */
export function sanitizeErrorMessage(message) {
  if (!message) return '';
  
  let sanitized = message;
  
  // Apply sanitization patterns from config
  for (const pattern of MONITORING_CONFIG.operational.sanitization_patterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  
  // Additional specific sanitization
  // Redact anything that looks like a password parameter
  sanitized = sanitized.replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]');
  
  // Redact authorization headers
  sanitized = sanitized.replace(/authorization:\s*\S+/gi, 'authorization: [REDACTED]');
  
  return sanitized;
}

/**
 * Persist error to database (internal helper).
 *
 * Executes the INSERT query against the `error_logs` table using an already-open
 * database client. The caller is responsible for opening and closing the client.
 *
 * Columns written:
 * - `severity`          — INFO | WARN | ERROR | CRITICAL
 * - `error_type`        — Error class name (e.g., `TypeError`)
 * - `error_message`     — Sanitized error message
 * - `error_fingerprint` — 16-char hex hash for grouping duplicates
 * - `stack_trace`       — Full stack trace string
 * - `trace_id`          — Request correlation ID (nullable)
 * - `tenant_id`         — Multi-tenant isolation (nullable)
 * - `endpoint`          — HTTP path where the error occurred (nullable)
 * - `http_method`       — HTTP verb (nullable)
 * - `context_metadata`  — JSONB blob with all remaining context fields
 *
 * @param {Object} errorLog - Prepared error log entry (fields described above)
 * @param {import('pg').Client} dbClient - Open PostgreSQL client
 * @returns {Promise<void>}
 * @throws {Error} Re-throws any database error to the caller for handling
 */
async function persistError(errorLog, dbClient) {
  const query = `
    INSERT INTO error_logs (
      severity,
      error_type,
      error_message,
      error_fingerprint,
      stack_trace,
      trace_id,
      tenant_id,
      endpoint,
      http_method,
      context_metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `;
  
  const values = [
    errorLog.severity,
    errorLog.error_type,
    errorLog.error_message,
    errorLog.error_fingerprint,
    errorLog.stack_trace,
    errorLog.trace_id,
    errorLog.tenant_id,
    errorLog.endpoint,
    errorLog.http_method,
    JSON.stringify(errorLog.context_metadata)
  ];
  
  await dbClient.query(query, values);
}

/**
 * Get error aggregation statistics
 * 
 * Retrieves error data for dashboard display and analysis.
 * Supports filtering by time range, severity, tenant, and endpoint.
 * 
 * Requirement: 3.9
 * 
 * @param {Object} filters - Query filters {
 *   timeRange: string ('1h', '24h', '7d'), default '1h'
 *   severity: string (optional)
 *   tenant_id: string (optional)
 *   endpoint: string (optional)
 *   limit: number (optional), default 100
 * }
 * @param {Env} env - Worker environment bindings
 * @returns {Promise<Array>} - Array of aggregated error statistics [{
 *   error_fingerprint: string,
 *   error_type: string,
 *   error_message: string,
 *   severity: string,
 *   occurrence_count: number,
 *   first_seen: string (ISO timestamp),
 *   last_seen: string (ISO timestamp),
 *   affected_tenants: number,
 *   sample_trace_id: string
 * }]
 * 
 * Usage:
 *   const errorStats = await getErrorStats({ timeRange: '24h' }, env);
 */
export async function getErrorStats(filters, env) {
  try {
    // Import CONFIG for database connection
    const { CONFIG } = await import('../config.js');
    const { Client } = await import('pg');
    
    const client = new Client(CONFIG.DB_OPTS(env));
    await client.connect();
    
    try {
      // Parse time range to interval
      const timeRange = filters.timeRange || '1h';
      const intervalMap = {
        '1h': '1 hour',
        '24h': '24 hours',
        '7d': '7 days',
        '30d': '30 days'
      };
      const interval = intervalMap[timeRange] || '1 hour';
      
      // Build WHERE conditions
      const conditions = [`timestamp > NOW() - INTERVAL '${interval}'`];
      const params = [];
      let paramIndex = 1;
      
      if (filters.severity) {
        conditions.push(`severity = $${paramIndex}`);
        params.push(filters.severity);
        paramIndex++;
      }
      
      if (filters.tenant_id) {
        conditions.push(`tenant_id = $${paramIndex}`);
        params.push(filters.tenant_id);
        paramIndex++;
      }
      
      if (filters.endpoint) {
        conditions.push(`endpoint = $${paramIndex}`);
        params.push(filters.endpoint);
        paramIndex++;
      }
      
      const whereClause = conditions.join(' AND ');
      const limit = filters.limit || 100;
      
      // Query for aggregated error statistics
      const query = `
        SELECT 
          error_fingerprint,
          error_type,
          error_message,
          severity,
          COUNT(*) as occurrence_count,
          MIN(timestamp) as first_seen,
          MAX(timestamp) as last_seen,
          COUNT(DISTINCT tenant_id) as affected_tenants,
          (ARRAY_AGG(trace_id ORDER BY timestamp DESC))[1] as sample_trace_id
        FROM error_logs
        WHERE ${whereClause}
        GROUP BY error_fingerprint, error_type, error_message, severity
        ORDER BY occurrence_count DESC, last_seen DESC
        LIMIT $${paramIndex}
      `;
      
      params.push(limit);
      
      const result = await client.query(query, params);
      
      return result.rows.map(row => ({
        error_fingerprint: row.error_fingerprint,
        error_type: row.error_type,
        error_message: row.error_message,
        severity: row.severity,
        occurrence_count: parseInt(row.occurrence_count),
        first_seen: row.first_seen.toISOString(),
        last_seen: row.last_seen.toISOString(),
        affected_tenants: parseInt(row.affected_tenants),
        sample_trace_id: row.sample_trace_id
      }));
      
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error('[ERROR_STATS_FAILURE]', error.message);
    // Fail-safe: return empty array on failure
    return [];
  }
}

/**
 * Non-blocking error capture using Cloudflare's `ctx.waitUntil`.
 *
 * This is the preferred capture method inside request handlers because it
 * schedules database persistence *after* the response is returned to the client,
 * keeping error tracking off the critical request path (Requirement 3.3).
 *
 * Internally this function:
 * 1. Generates the error fingerprint synchronously (fast, no I/O)
 * 2. Classifies severity synchronously
 * 3. Sanitizes the error message (PII removal)
 * 4. Schedules a `ctx.waitUntil` Promise that opens a fresh DB connection,
 *    inserts the error log row, and closes the connection
 * 5. Returns the fingerprint immediately to the caller
 *
 * Failures during persistence are caught and logged to console — they never
 * propagate back to the request handler.
 *
 * @param {Error} error - The exception object to capture
 * @param {Object} context - Contextual metadata attached to the log entry:
 *   @param {string} [context.trace_id]    - Request correlation UUID
 *   @param {string} [context.tenant_id]   - Tenant identifier for isolation
 *   @param {string} [context.endpoint]    - HTTP path (e.g., '/wms-webhook')
 *   @param {string} [context.http_method] - HTTP verb (e.g., 'POST')
 *   @param {string} [context.user_agent]  - Client user-agent string
 *   @param {string} [context.ot_id]       - Order-tracking ID if applicable
 *   @param {string} [context.queue]       - Queue name if from a queue processor
 *   @param {number} [context.retry_count] - Retry attempt number
 * @param {ExecutionContext} ctx - Cloudflare Worker execution context
 * @param {Env}             env - Worker environment bindings (HYPERDRIVE required)
 * @returns {string} Error fingerprint (16-char hex) — available synchronously
 *
 * @example
 * // Inside a request handler — fire-and-forget style
 * try {
 *   await processWebhook(data);
 * } catch (error) {
 *   const fp = captureErrorAsync(error, {
 *     trace_id: traceId,
 *     tenant_id: 'acme-corp',
 *     endpoint: '/wms-webhook',
 *     http_method: 'POST',
 *   }, ctx, env);
 *   // Response is returned immediately; DB write happens in waitUntil
 *   return new Response('Internal Error', { status: 500 });
 * }
 */
export function captureErrorAsync(error, context, ctx, env) {
  try {
    // Generate fingerprint synchronously
    const fingerprint = generateErrorFingerprint(error);
    const severity = classifyErrorSeverity(error);
    
    // Prepare error log
    const errorType = error?.name || 'UnknownError';
    const errorMessage = error?.message || String(error);
    const stackTrace = error?.stack || new Error().stack;
    const sanitizedMessage = sanitizeErrorMessage(errorMessage);
    
    const errorLog = {
      severity,
      error_type: errorType,
      error_message: sanitizedMessage,
      error_fingerprint: fingerprint,
      stack_trace: stackTrace,
      trace_id: context.trace_id || null,
      tenant_id: context.tenant_id || null,
      endpoint: context.endpoint || null,
      http_method: context.http_method || null,
      context_metadata: {
        user_agent: context.user_agent || null,
        ot_id: context.ot_id || null,
        queue: context.queue || null,
        retry_count: context.retry_count || null,
        ...Object.fromEntries(
          Object.entries(context).filter(
            ([key]) => !['trace_id', 'tenant_id', 'endpoint', 'http_method', 'user_agent', 'ot_id', 'queue', 'retry_count'].includes(key)
          )
        )
      }
    };
    
    // Use ctx.waitUntil for asynchronous persistence
    ctx.waitUntil(
      (async () => {
        try {
          const { CONFIG } = await import('../config.js');
          const { Client } = await import('pg');
          
          const client = new Client(CONFIG.DB_OPTS(env));
          await client.connect();
          
          try {
            await persistError(errorLog, client);
          } finally {
            await client.end();
          }
        } catch (persistError) {
          console.error('[ERROR_PERSIST_FAILURE]', persistError.message);
        }
      })()
    );
    
    return fingerprint;
  } catch (captureError) {
    console.error('[ERROR_TRACKER_FAILURE]', captureError.message);
    return 'capture-failed';
  }
}
