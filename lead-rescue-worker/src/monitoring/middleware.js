// src/monitoring/middleware.js
// Request Handler Middleware - Automatic monitoring instrumentation
// Requirements: 8.7, 9.2

/**
 * REQUEST MONITORING MIDDLEWARE
 * 
 * Purpose: Wrap request handlers with automatic monitoring instrumentation
 * including request/response logging, metrics collection, and error tracking.
 * 
 * Features:
 * - Start timer when request begins
 * - Generate trace_id (UUID) for request correlation
 * - Create request-scoped logger with trace context
 * - Log request start with method, URL, sanitized headers
 * - Execute original handler and capture response
 * - Record metrics asynchronously using ctx.waitUntil()
 * - Log request completion with status code and duration
 * - Catch and handle errors: log, capture, record metrics, re-throw
 * - Ensure monitoring does not block request response
 * 
 * Requirements:
 * - 8.7: Integration with existing infrastructure via middleware wrapper
 * - 9.2: Asynchronous operations to avoid blocking request responses
 */

import { startTimer } from './metrics.js';
import { recordMetric, METRIC_TYPES } from './metrics.js';
import { createRequestLogger } from './logger.js';
import { captureErrorAsync } from './errors.js';
import { MONITORING_CONFIG, getMonitoringConfig } from './config.js';

/** Env flags ganan; tests pueden mutar MONITORING_CONFIG.features.enabled. */
function isMonitoringEnabled(env) {
  if (MONITORING_CONFIG.features.enabled === false) return false;
  return getMonitoringConfig(env || {}).features.enabled !== false;
}

/**
 * Sanitize HTTP headers to remove sensitive data
 * 
 * Implements requirement 10.8: Redact sensitive headers
 * 
 * @param {Headers} headers - Request headers object
 * @returns {Object} - Sanitized headers as plain object
 */
function sanitizeHeaders(headers) {
  const sanitized = {};
  const sensitiveHeaders = MONITORING_CONFIG.operational.sensitive_headers;

  for (const [key, value] of headers.entries()) {
    const lowerKey = key.toLowerCase();
    
    if (sensitiveHeaders.includes(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Extract tenant_id from request context
 * 
 * Attempts to extract tenant ID from:
 * 1. X-Tenant-ID header
 * 2. JWT token (if present)
 * 3. Request body (for POST requests)
 * 
 * @param {Request} request - HTTP request
 * @returns {string|null} - Tenant ID or null if not found
 */
function extractTenantId(request) {
  // Try header first
  const headerTenant = request.headers.get('x-tenant-id');
  if (headerTenant) {
    return headerTenant;
  }

  // Try JWT token (simplified extraction - in production use proper JWT parsing)
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      // In a real implementation, decode JWT and extract tenant_id claim
      // For now, we'll leave this as a placeholder
      // const decoded = decodeJWT(token);
      // return decoded.tenant_id;
    } catch (error) {
      // JWT parsing failed, continue
    }
  }

  // Note: For POST requests with body, tenant_id might be extracted after
  // body parsing in the actual handler. We can't access body here without
  // consuming the stream.

  return null;
}

/**
 * Wrap a Cloudflare Workers request handler with automatic monitoring.
 *
 * Adds the following instrumentation without modifying the handler's logic:
 *   - Generates a UUID `trace_id` for request correlation
 *   - Creates a request-scoped structured logger
 *   - Logs request start (method, URL, sanitized headers)
 *   - Measures end-to-end request duration with `startTimer()`
 *   - On success: records `http.request.duration` and `http.request.count` via
 *     `ctx.waitUntil()` (non-blocking)
 *   - On error: captures the error with `captureErrorAsync`, records
 *     `http.error.rate`, then re-throws to preserve existing error handling
 *   - Logs request completion with status code and duration
 *
 * Feature-flag: `MONITORING_ENABLED=false` en env (vía getMonitoringConfig)
 * o `MONITORING_CONFIG.features.enabled = false` (tests) desactiva el wrap en runtime.
 *
 * @param {Function} handler - Original request handler.
 *   Signature: `async (request: Request, env: Env, ctx: ExecutionContext) => Response`
 * @param {Object}  [config={}]         - Optional middleware configuration
 * @param {string}  [config.component]  - Component label used in logs and metrics
 *   (e.g., `'wms-webhook'`, `'health-check'`). Defaults to `'unknown'`.
 * @param {string}  [config.endpoint]   - Override the URL pathname in metrics tags.
 *   If omitted, `url.pathname` is used.
 * @returns {Function} Wrapped handler with the same signature as the original.
 *
 * Requirements: 8.7, 9.2
 */
export function withMonitoring(handler, config = {}) {
  return async function monitoredHandler(request, env, ctx) {
    if (!isMonitoringEnabled(env)) {
      return handler(request, env, ctx);
    }

    // =========================================================================
    // 1. START TIMER AND GENERATE TRACE_ID
    // =========================================================================
    const timer = startTimer();
    const traceId = crypto.randomUUID(); // Generate UUID for request correlation
    const url = new URL(request.url);
    const endpoint = config.endpoint || url.pathname;
    const method = request.method;

    // =========================================================================
    // 2. EXTRACT CONTEXT INFORMATION
    // =========================================================================
    const tenantId = extractTenantId(request);
    const userAgent = request.headers.get('user-agent') || 'unknown';
    
    // =========================================================================
    // 3. CREATE REQUEST-SCOPED LOGGER
    // =========================================================================
    const logger = createRequestLogger(traceId, {
      component: config.component || 'unknown',
      tenant_id: tenantId,
      endpoint,
    });

    // =========================================================================
    // 4. LOG REQUEST START WITH SANITIZED HEADERS
    // =========================================================================
    const sanitizedHeaders = sanitizeHeaders(request.headers);
    
    logger.info('Request started', {
      method,
      url: url.href,
      headers: sanitizedHeaders,
      user_agent: userAgent,
    });

    // =========================================================================
    // 5. EXECUTE ORIGINAL HANDLER AND CAPTURE RESPONSE/ERROR
    // =========================================================================
    let response;
    let statusCode = 200;
    let hadError = false;
    let errorCaptured = null;

    try {
      // Call original handler
      response = await handler(request, env, ctx);
      statusCode = response.status;
      hadError = statusCode >= 400;

    } catch (error) {
      // Capture error information
      statusCode = 500;
      hadError = true;
      errorCaptured = error;

      // Log error with request-scoped logger
      logger.error('Request handler error', {
        method,
        endpoint,
        user_agent: userAgent,
      }, error);

      // Capture error asynchronously (requirement 3.3)
      captureErrorAsync(
        error,
        {
          trace_id: traceId,
          tenant_id: tenantId,
          endpoint,
          http_method: method,
          user_agent: userAgent,
          component: config.component || 'unknown',
        },
        ctx,
        env
      );

      // Re-throw error to maintain existing error handling behavior
      // This ensures the application's error handling logic still works
      throw error;

    } finally {
      // ========================================================================
      // 6. RECORD METRICS ASYNCHRONOUSLY (REQUIREMENT 9.2)
      // ========================================================================
      const duration = timer.stop();

      // Use ctx.waitUntil to record metrics without blocking response
      ctx.waitUntil(
        (async () => {
          try {
            // Prepare metric tags
            const tags = {
              endpoint,
              status_code: statusCode,
              method,
              component: config.component || 'unknown',
            };

            // Add tenant_id to tags if available (requirement 4.10)
            if (tenantId) {
              tags.tenant_id = tenantId;
            }

            // Record metrics (requirement 4.1, 4.6)
            await recordMetric(
              METRIC_TYPES.HTTP_REQUEST_DURATION,
              duration,
              tags,
              env
            );

            await recordMetric(
              METRIC_TYPES.HTTP_REQUEST_COUNT,
              1,
              tags,
              env
            );

            // Record error rate if request failed (requirement 4.6)
            if (hadError) {
              await recordMetric(
                METRIC_TYPES.HTTP_ERROR_RATE,
                1,
                tags,
                env
              );
            }
          } catch (metricsError) {
            // Graceful degradation: metrics failure should not affect application
            console.error('[MONITORING_METRICS_ERROR]', {
              trace_id: traceId,
              error: metricsError.message,
            });
          }
        })()
      );

      // ========================================================================
      // 7. LOG REQUEST COMPLETION
      // ========================================================================
      logger.info('Request completed', {
        method,
        endpoint,
        status_code: statusCode,
        duration_ms: duration,
        had_error: hadError,
      });
    }

    return response;
  };
}

/**
 * Wrap a Cloudflare Queues batch processor with monitoring instrumentation.
 *
 * Analogous to `withMonitoring` but adapted for queue processors:
 *   - Records `queue.processing.latency` (total batch duration in ms)
 *   - Records `queue.throughput` (messages per minute)
 *   - Logs queue start/completion/error with structured logger
 *   - Captures errors via `captureErrorAsync` on failure, then re-throws
 *   - All metric writes are non-blocking via `ctx.waitUntil()`
 *
 * @param {Function} processor - Original queue processor.
 *   Signature: `async (batch: MessageBatch, env: Env, ctx: ExecutionContext) => void`
 * @param {Object}  [config={}]            - Optional configuration
 * @param {string}  [config.queueName]     - Queue identifier used in metric tags
 *   (e.g., `'MAIN_QUEUE'`). Defaults to `'unknown-queue'`.
 * @param {string}  [config.component]     - Component label for logs.
 *   Defaults to `'queue-processor'`.
 * @returns {Function} Wrapped processor with the same signature as the original.
 *
 * @example
 * // In src/queues.js
 * export const processIngestionQueue = withQueueMonitoring(
 *   async (batch, env, ctx) => { ... },
 *   { queueName: 'MAIN_QUEUE', component: 'ingestion-processor' }
 * );
 *
 * Requirements: 4.4-4.5, 4.12, 8.2, 8.8
 */
export function withQueueMonitoring(processor, config = {}) {
  return async function monitoredQueueProcessor(batch, env, ctx) {
    if (!isMonitoringEnabled(env)) {
      return processor(batch, env, ctx);
    }

    const timer = startTimer();
    const traceId = crypto.randomUUID();
    const queueName = config.queueName || 'unknown-queue';
    const messageCount = batch.messages?.length || 0;

    // Create request-scoped logger
    const logger = createRequestLogger(traceId, {
      component: config.component || 'queue-processor',
      queue: queueName,
    });

    logger.info('Queue processing started', {
      queue: queueName,
      message_count: messageCount,
    });

    let hadError = false;
    let errorCaptured = null;

    try {
      // Execute original processor
      await processor(batch, env, ctx);

    } catch (error) {
      hadError = true;
      errorCaptured = error;

      logger.error('Queue processing error', {
        queue: queueName,
        message_count: messageCount,
      }, error);

      // Capture error asynchronously
      captureErrorAsync(
        error,
        {
          trace_id: traceId,
          queue: queueName,
          component: config.component || 'queue-processor',
          message_count: messageCount,
        },
        ctx,
        env
      );

      // Re-throw to maintain existing error handling
      throw error;

    } finally {
      const duration = timer.stop();

      // Record queue-specific metrics asynchronously (requirement 4.4, 4.5)
      ctx.waitUntil(
        (async () => {
          try {
            const tags = {
              queue_name: queueName,
              component: config.component || 'queue-processor',
            };

            // Processing latency (requirement 4.5)
            await recordMetric(
              METRIC_TYPES.QUEUE_PROCESSING_LATENCY,
              duration,
              tags,
              env
            );

            // Throughput: messages per minute (requirement 4.4)
            // Calculate rate: (messageCount / duration_ms) * 60000
            const throughput = (messageCount / duration) * 60000;
            await recordMetric(
              METRIC_TYPES.QUEUE_THROUGHPUT,
              throughput,
              tags,
              env
            );

            // Error tracking
            if (hadError) {
              await recordMetric(
                METRIC_TYPES.HTTP_ERROR_RATE,
                1,
                tags,
                env
              );
            }
          } catch (metricsError) {
            console.error('[QUEUE_MONITORING_ERROR]', {
              trace_id: traceId,
              error: metricsError.message,
            });
          }
        })()
      );

      logger.info('Queue processing completed', {
        queue: queueName,
        message_count: messageCount,
        duration_ms: duration,
        had_error: hadError,
      });
    }
  };
}

/**
 * SCHEDULED JOB MIDDLEWARE
 * 
 * Wrapper for scheduled/cron jobs that require monitoring.
 * Similar to request monitoring but adapted for scheduled execution context.
 * 
 * @param {Function} job - Original scheduled job function
 *   Signature: async (event, env, ctx) => void
 * @param {Object} config - Middleware configuration
 *   {
 *     jobName: string - Job identifier (e.g., 'outbox-recovery')
 *     component: string - Component name for logging
 *   }
 * @returns {Function} - Wrapped job with monitoring
 * 
 * @example
 * export const runOutboxRecovery = withScheduledMonitoring(
 *   async (event, env, ctx) => {
 *     // Original job logic
 *   },
 *   { jobName: 'outbox-recovery', component: 'scheduled-jobs' }
 * );
 */
export function withScheduledMonitoring(job, config = {}) {
  return async function monitoredScheduledJob(event, env, ctx) {
    if (!isMonitoringEnabled(env)) {
      return job(event, env, ctx);
    }

    const timer = startTimer();
    const traceId = crypto.randomUUID();
    const jobName = config.jobName || 'unknown-job';

    const logger = createRequestLogger(traceId, {
      component: config.component || 'scheduled-job',
      job: jobName,
    });

    logger.info('Scheduled job started', {
      job: jobName,
      cron: event.cron || 'manual',
    });

    let hadError = false;

    try {
      await job(event, env, ctx);

    } catch (error) {
      hadError = true;

      logger.error('Scheduled job error', {
        job: jobName,
      }, error);

      captureErrorAsync(
        error,
        {
          trace_id: traceId,
          job: jobName,
          component: config.component || 'scheduled-job',
          cron: event.cron || 'manual',
        },
        ctx,
        env
      );

      throw error;

    } finally {
      const duration = timer.stop();

      ctx.waitUntil(
        (async () => {
          try {
            const tags = {
              job_name: jobName,
              component: config.component || 'scheduled-job',
            };

            await recordMetric(
              'scheduled_job.duration',
              duration,
              tags,
              env
            );

            if (hadError) {
              await recordMetric(
                'scheduled_job.error',
                1,
                tags,
                env
              );
            }
          } catch (metricsError) {
            console.error('[SCHEDULED_JOB_MONITORING_ERROR]', metricsError.message);
          }
        })()
      );

      logger.info('Scheduled job completed', {
        job: jobName,
        duration_ms: duration,
        had_error: hadError,
      });
    }
  };
}

/**
 * Export all middleware functions
 */
export default {
  withMonitoring,
  withQueueMonitoring,
  withScheduledMonitoring,
};
