// src/monitoring/metrics.js
// Metrics Collection System - Performance measurement and aggregation
// Requirements: 4.1-4.12, 9.1, 9.3, 9.8

/**
 * METRICS COLLECTOR
 * 
 * Purpose: Gather quantitative performance measurements for response times,
 * throughput, and resource usage to identify bottlenecks, optimize performance,
 * and ensure SLA compliance.
 * 
 * Features:
 * - Timer utility for measuring operation duration
 * - Direct persistence: each sampled event is inserted immediately as aggregation_type='raw'
 * - Sampling: 10% for successful requests, 100% for errors
 * - Multi-tenant isolation via dimension_tags
 * 
 * Metric Types:
 * - http.request.duration
 * - http.request.count
 * - http.error.rate
 * - db.query.duration
 * - queue.processing.latency
 * - queue.throughput
 * - circuit_breaker.activations
 * - dlq.message.count
 */

import { MONITORING_CONFIG } from './config.js';
import { withDb } from '../db.js';

// ============================================================================
// TIMER UTILITY
// ============================================================================

/**
 * Start a high-resolution timer for measuring operation duration.
 *
 * Returns an object with a `stop()` method that returns the elapsed time in
 * milliseconds since the timer was created. Uses `Date.now()` internally.
 *
 * Typical usage pattern inside a request handler:
 * ```js
 * const timer = startTimer();
 * await someOperation();
 * const durationMs = timer.stop();
 * await recordMetric('http.request.duration', durationMs, { endpoint }, env);
 * ```
 *
 * @returns {{ stop: () => number }} Timer object.
 *   `stop()` returns elapsed duration in milliseconds as a non-negative integer.
 */
export function startTimer() {
  const startTime = Date.now();
  
  return {
    /**
     * Stop the timer and return elapsed duration
     * @returns {number} - Duration in milliseconds
     */
    stop() {
      return Date.now() - startTime;
    }
  };
}

// ============================================================================
// SAMPLING LOGIC
// ============================================================================

/**
 * Determine if a metric should be sampled based on metric name and tags.
 *
 * Sampling algorithm (evaluated in priority order):
 * 1. **Always sample (100%)**: errors, circuit breaker events, DLQ counts,
 *    queue operations, external API calls — these are low-volume but critical.
 * 2. **Database queries**: sampled at `MONITORING_CONFIG.sampling.database_queries`
 *    (default 20%) to reduce write volume from frequent queries.
 * 3. **Successful HTTP requests**: sampled at
 *    `MONITORING_CONFIG.sampling.successful_requests` (default 10%) for
 *    cost optimization on high-traffic endpoints.
 * 4. **All other metrics**: sampled (returns `true`) to capture unknown types.
 *
 * The `tags.status_code >= 400` check ensures that HTTP error responses are
 * always recorded regardless of the metric type name.
 *
 * @param {string} metricName - Metric identifier (e.g., 'http.request.duration')
 * @param {Object} [tags={}]  - Dimension tags; `tags.status_code` and `tags.error`
 *   are inspected to force 100% sampling on error conditions
 * @returns {boolean} `true` if this data point should be persisted, `false` to skip
 */
function shouldSample(metricName, tags = {}) {
  // Always sample errors (100% sampling)
  if (tags.status_code >= 400 || tags.error || metricName.includes('error')) {
    return true;
  }

  // Circuit breaker and DLQ metrics always sampled (critical)
  if (metricName.includes('circuit_breaker') || metricName.includes('dlq')) {
    return true;
  }

  // Queue operations: 100% sampling (critical path)
  if (metricName.includes('queue')) {
    return true;
  }

  // Database queries: 20% sampling
  if (metricName.includes('db.query')) {
    return Math.random() < (MONITORING_CONFIG.sampling.database_queries || 0.2);
  }

  // Successful HTTP requests: 10% sampling
  if (metricName.includes('http.request')) {
    return Math.random() < (MONITORING_CONFIG.sampling.successful_requests || 0.1);
  }

  // External API calls: 100% sampling
  if (metricName.includes('external')) {
    return true;
  }

  // Default: sample
  return true;
}

// ============================================================================
// METRIC RECORDING
// ============================================================================

/**
 * Record a single metric data point to `metrics_summary`.
 *
 * Applies sampling before writing: successful HTTP requests are sampled at
 * `MONITORING_SAMPLE_RATE` (default 10%); errors, queue operations, and
 * circuit-breaker metrics are always captured at 100%. Rows are inserted with
 * `aggregation_type = 'raw'` (requires migration 002).
 *
 * The DB write uses `statementTimeout = 1000ms` to avoid blocking under load.
 * Failures are caught and logged with `[METRICS_ERROR]` — this function never
 * throws.
 *
 * **Call site pattern:** always wrap inside `ctx.waitUntil()` so the write
 * does not block the HTTP response:
 * ```js
 * ctx.waitUntil(recordMetric('http.request.duration', durationMs, { endpoint }, env));
 * ```
 *
 * @param {string} metricName - Metric identifier. Use constants from `METRIC_TYPES`
 *   (e.g. `'http.request.duration'`, `'queue.processing.latency'`).
 * @param {number} value      - Numeric measurement (milliseconds, count, percentage, etc.)
 * @param {Object} [tags={}]  - Dimension tags stored as JSONB in `dimension_tags`.
 *   Common keys: `endpoint`, `status_code`, `method`, `component`, `tenant_id`, `queue_name`.
 * @param {Env}    env        - Worker environment bindings (requires HYPERDRIVE)
 * @returns {Promise<void>}   Resolves when the write completes or is skipped by sampling.
 *
 * Requirements: 4.1-4.12, 9.1, 9.3, 9.8
 */
export async function recordMetric(metricName, value, tags = {}, env) {
  try {
    // Sampling check — 10% for successful HTTP requests, 100% for errors/queues
    if (!shouldSample(metricName, tags)) {
      return;
    }

    const metricUnit = getMetricUnit(metricName);
    await withDb(env, async (client) => {
      await client.query(
        `INSERT INTO metrics_summary (
           timestamp,
           metric_name,
           metric_value,
           metric_unit,
           aggregation_type,
           dimension_tags,
           sample_count
         ) VALUES (NOW(), $1, $2, $3, 'raw', $4, 1)`,
        [metricName, value, metricUnit, JSON.stringify(tags)]
      );
    }, { statementTimeout: 1000 });
  } catch (error) {
    console.error('[METRICS_ERROR]', {
      metricName,
      value,
      error: error.message,
    });
  }
}

/**
 * Derive the measurement unit for a metric from its name.
 *
 * Mapping rules (evaluated in order):
 * - Name contains `'duration'` or `'latency'`  → `'ms'`
 * - Name contains both `'rate'` and `'error'`   → `'%'`
 * - Name contains `'throughput'`                → `'msg/min'`
 * - Name contains `'count'`                     → `'count'`
 * - Everything else                             → `'value'`
 *
 * @param {string} metricName - Metric identifier (e.g., 'http.request.duration')
 * @returns {string} Unit string stored in the `metric_unit` column
 */
function getMetricUnit(metricName) {
  if (metricName.includes('duration') || metricName.includes('latency')) {
    return 'ms';
  }
  if (metricName.includes('rate') && metricName.includes('error')) {
    return '%';
  }
  if (metricName.includes('throughput')) {
    return 'msg/min';
  }
  if (metricName.includes('count')) {
    return 'count';
  }
  return 'value'; // Default unit
}

// ============================================================================
// MIDDLEWARE WRAPPER
// ============================================================================

/**
 * Middleware wrapper that automatically captures request metrics
 * 
 * Wraps an HTTP request handler to automatically measure and record
 * request duration, count, and error rate.
 * 
 * @param {Function} handler - Original request handler
 * @param {Object} config - Configuration { component: string }
 * @returns {Function} - Wrapped handler
 * 
 * @example
 * const wrappedHandler = withMetrics(originalHandler, { component: 'wms-webhook' });
 * export default { fetch: wrappedHandler };
 */
export function withMetrics(handler, config = {}) {
  return async function metricsWrapper(request, env, ctx) {
    const timer = startTimer();
    const url = new URL(request.url);
    const endpoint = url.pathname;
    let statusCode = 200;
    let hadError = false;

    try {
      // Call original handler
      const response = await handler(request, env, ctx);
      statusCode = response.status;
      hadError = statusCode >= 400;

      return response;
    } catch (error) {
      statusCode = 500;
      hadError = true;
      throw error; // Re-throw to preserve error handling
    } finally {
      // Record metrics asynchronously
      const duration = timer.stop();
      const tags = {
        endpoint,
        status_code: statusCode,
        method: request.method,
        component: config.component || 'unknown'
      };

      // Use waitUntil to record metrics without blocking response
      ctx.waitUntil((async () => {
        try {
          // Record duration
          await recordMetric('http.request.duration', duration, tags, env);

          // Record count
          await recordMetric('http.request.count', 1, tags, env);

          // Record error if applicable
          if (hadError) {
            await recordMetric('http.error.rate', 1, tags, env);
          }
        } catch (metricsError) {
          console.error('[METRICS_WRAPPER_ERROR]', metricsError.message);
        }
      })());
    }
  };
}

// ============================================================================
// METRIC TYPE CONSTANTS
// ============================================================================

/**
 * Predefined metric type identifiers
 * Use these constants for consistency across the codebase
 */
export const METRIC_TYPES = Object.freeze({
  HTTP_REQUEST_DURATION: 'http.request.duration',
  HTTP_REQUEST_COUNT: 'http.request.count',
  HTTP_ERROR_RATE: 'http.error.rate',
  DB_QUERY_DURATION: 'db.query.duration',
  QUEUE_PROCESSING_LATENCY: 'queue.processing.latency',
  QUEUE_THROUGHPUT: 'queue.throughput',
  CIRCUIT_BREAKER_ACTIVATIONS: 'circuit_breaker.activations',
  DLQ_MESSAGE_COUNT: 'dlq.message.count',
  EXTERNAL_API_DURATION: 'external.api.duration'
});

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  recordMetric,
  startTimer,
  withMetrics,
  METRIC_TYPES
};
