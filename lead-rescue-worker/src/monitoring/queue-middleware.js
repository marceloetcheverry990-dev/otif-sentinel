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
      let query = 'SELECT COUNT(*) as count FROM dead_letter_events';
      const params = [];

      // Filter by queue name if provided
      if (queueName) {
        query += ' WHERE metadata->>\'queue\' = $1';
        params.push(queueName);
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
 * (openai_breaker, tg_breaker). Records state changes as metrics and events.
 * 
 * Implements requirement 8.3: Integration with existing Circuit_Breaker implementations
 * 
 * @param {Env} env - Worker environment bindings
 * @returns {Promise<Object>} - { openai_breaker: boolean, tg_breaker: boolean }
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
      // Query circuit breaker flags
      const result = await client.query(`
        SELECT flag_key, flag_value
        FROM system_flags
        WHERE flag_key IN ('openai_breaker', 'tg_breaker')
      `);

      const states = {
        openai_breaker: false,
        tg_breaker: false,
      };

      for (const row of result.rows) {
        // Flag value 'true' means circuit is OPEN (blocking requests)
        states[row.flag_key] = row.flag_value === 'true';
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
      tg_breaker: false,
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
