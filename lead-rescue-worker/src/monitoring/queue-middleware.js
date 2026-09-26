// src/monitoring/queue-middleware.js
// Queue Processor Monitoring Middleware
// Requirements: 4.4-4.5, 4.12, 8.2, 8.8

/**
 * QUEUE MONITORING MIDDLEWARE
 * 
 * This module provides monitoring instrumentation specifically for
 * Cloudflare Queue processors. It wraps queue message batch processors
 * with automatic metrics collection and error tracking.
 * 
 * Features:
 * - Measure queue processing latency (time from enqueue to completion)
 * - Track queue throughput (messages processed per minute)
 * - Monitor Dead Letter Queue depth
 * - Log queue processing events with structured logger
 * - Capture queue processing errors with full context
 * 
 * Requirements:
 * - 4.4: Measure queue processing throughput
 * - 4.5: Measure queue processing latency
 * - 4.12: Track Dead Letter Queue message counts
 * - 8.2: Integration with existing Queue_System processors
 * - 8.8: Middleware for queue processors
 * 
 * Note: The actual implementation is in middleware.js (withQueueMonitoring function).
 * This file re-exports it for organizational clarity and follows the design document structure.
 */

// Re-export queue monitoring functionality from middleware.js
export { withQueueMonitoring } from './middleware.js';
import { withQueueMonitoring } from './middleware.js';

// Import dependencies for additional queue-specific utilities
import { recordMetric, METRIC_TYPES } from './metrics.js';
import { Logger } from './logger.js';
import { withDb } from '../db.js';

/**
 * Query Dead Letter Queue depth
 * 
 * Connects to database and counts messages in the dead_letter_events table.
 * This provides visibility into failed message processing that requires manual intervention.
 * 
 * Implements requirement 4.12: Track Dead_Letter_Queue message counts
 * 
 * @param {Env} env - Worker environment bindings
 * @param {string} queueName - Optional queue filter (e.g., 'MAIN_QUEUE')
 * @returns {Promise<number>} - Count of messages in DLQ
 * 
 * @example
 * const dlqCount = await getDLQDepth(env, 'MAIN_QUEUE');
 * if (dlqCount > 100) {
 *   // Alert: DLQ threshold exceeded
 * }
 */
export async function getDLQDepth(env, queueName = null) {
  try {
    return await withDb(env, async (client) => {
      // Ventana de 1h — misma convención que checkDLQCount (alerts.js). Sin
      // esto el conteo crece para siempre y el umbral, una vez superado,
      // queda superado por el resto de la vida de la tabla.
      // Filtro por event_type, no por metadata->>'queue': dead_letter_events
      // no tiene columna metadata (columnas reales: id, ot_id, trace_id,
      // event_type, payload, reason, error_detail, died_at, tenant_id) — el
      // filtro anterior lanzaba un error de columna inexistente en cada
      // llamada con queueName, silenciado por el catch de abajo (devolvía 0).
      let query = `SELECT COUNT(*) as count FROM dead_letter_events WHERE died_at > NOW() - INTERVAL '1 hour'`;
      const params = [];

      if (queueName) {
        params.push(queueName);
        query += ` AND event_type = $${params.length}`;
      }

      const result = await client.query(query, params);
      return parseInt(result.rows[0].count, 10);
    }, { statementTimeout: 1000 });

  } catch (error) {
    Logger.error('Failed to query DLQ depth', {
      queue_name: queueName,
      component: 'queue-middleware',
    }, error);

    // Return 0 on error to prevent alerting failures from blocking operations
    return 0;
  }
}

/**
 * Record DLQ depth as a metric
 * 
 * Queries DLQ depth and records it as a metric for dashboard display and alerting.
 * Should be called periodically (e.g., every 5 minutes) via scheduled job.
 * 
 * @param {Env} env - Worker environment bindings
 * @param {ExecutionContext} ctx - Execution context for waitUntil
 * @param {string} queueName - Optional queue filter
 * 
 * @example
 * // In scheduled() function
 * ctx.waitUntil(recordDLQMetrics(env, ctx, 'MAIN_QUEUE'));
 */
export async function recordDLQMetrics(env, ctx, queueName = null) {
  try {
    const dlqCount = await getDLQDepth(env, queueName);

    const tags = {
      component: 'queue-monitoring',
    };

    if (queueName) {
      tags.queue_name = queueName;
    }

    await recordMetric(
      METRIC_TYPES.DLQ_MESSAGE_COUNT,
      dlqCount,
      tags,
      env
    );

    Logger.info('DLQ metrics recorded', {
      queue_name: queueName || 'all',
      dlq_count: dlqCount,
      component: 'queue-middleware',
    });

  } catch (error) {
    Logger.error('Failed to record DLQ metrics', {
      queue_name: queueName,
      component: 'queue-middleware',
    }, error);
  }
}

/**
 * Monitor circuit breaker state transitions
 * 
 * Queries the system_flags table to check circuit breaker states for external services
 * (openai_breaker). Records state changes as metrics and events.
 *
 * Implements requirement 8.3: Integration with existing Circuit_Breaker implementations
 *
 * @param {Env} env - Worker environment bindings
 * @returns {Promise<Object>} - { openai_breaker: boolean }
 * 
 * @example
 * const breakerStates = await getCircuitBreakerStates(env);
 * if (breakerStates.openai_breaker) {
 *   // OpenAI circuit is OPEN (service unavailable)
 * }
 */
export async function getCircuitBreakerStates(env) {
  try {
    return await withDb(env, async (client) => {
      // system_flags real: columnas key/value/expires_at (no flag_key/flag_value
      // — esas no existen en el schema; ver queues.js processEnrichmentQueue,
      // que es quien realmente escribe/lee este breaker).
      const result = await client.query(`
        SELECT key, value, expires_at
        FROM system_flags
        WHERE key IN ('openai_breaker')
      `);

      const states = {
        openai_breaker: false,
      };

      for (const row of result.rows) {
        // value='OPEN' bloquea requests solo mientras no haya vencido expires_at
        // (mismo criterio que processEnrichmentQueue al resetear el breaker).
        const notExpired = row.expires_at && new Date(row.expires_at).getTime() > Date.now();
        states[row.key] = row.value === 'OPEN' && Boolean(notExpired);
      }

      return states;
    }, { statementTimeout: 1000 });

  } catch (error) {
    Logger.error('Failed to query circuit breaker states', {
      component: 'queue-middleware',
    }, error);

    // Return all closed on error (fail-open for monitoring)
    return {
      openai_breaker: false,
    };
  }
}

/**
 * Record circuit breaker activation metrics
 * 
 * Checks circuit breaker states and records activation events as metrics.
 * Should be called periodically to track circuit breaker reliability.
 * 
 * Implements requirement 4.11: Measure Circuit_Breaker activation frequency
 * 
 * @param {Env} env - Worker environment bindings
 * @param {ExecutionContext} ctx - Execution context
 * 
 * @example
 * // In scheduled() function
 * ctx.waitUntil(recordCircuitBreakerMetrics(env, ctx));
 */
export async function recordCircuitBreakerMetrics(env, ctx) {
  try {
    const states = await getCircuitBreakerStates(env);

    // Record activation for each breaker if OPEN
    for (const [breakerName, isOpen] of Object.entries(states)) {
      if (isOpen) {
        await recordMetric(
          METRIC_TYPES.CIRCUIT_BREAKER_ACTIVATIONS,
          1,
          {
            service: breakerName.replace('_breaker', ''),
            component: 'queue-middleware',
          },
          env
        );

        Logger.warn('Circuit breaker is OPEN', {
          breaker: breakerName,
          component: 'queue-middleware',
        });
      }
    }

  } catch (error) {
    Logger.error('Failed to record circuit breaker metrics', {
      component: 'queue-middleware',
    }, error);
  }
}

/**
 * Export all queue monitoring utilities
 */
export default {
  withQueueMonitoring,
  getDLQDepth,
  recordDLQMetrics,
  getCircuitBreakerStates,
  recordCircuitBreakerMetrics,
};
