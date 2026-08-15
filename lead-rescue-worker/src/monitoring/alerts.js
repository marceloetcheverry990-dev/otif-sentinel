// src/monitoring/alerts.js
// Alert Manager and Notification System
// Requirements: 5.1-5.13

import { withDb } from '../db.js';
import { MONITORING_CONFIG } from './config.js';

// ============================================================================
// ALERT DEDUPLICATION STORAGE
// In-memory Map to track sent alerts and prevent spam
// Structure: Map<alertKey, { lastSent: timestamp, count: number }>
// ============================================================================
const alertDeduplicationCache = new Map();

// Alert rate limiting per component
// Structure: Map<component, Array<timestamps>>
const alertRateLimiter = new Map();

// ============================================================================
// PUBLIC ENUMS — severidades y tipos de alerta emitidos por evaluateAlerts()
// ============================================================================
export const AlertSeverity = Object.freeze({
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
});

export const AlertType = Object.freeze({
  DATABASE_CONNECTIVITY: 'database_connectivity',
  HIGH_ERROR_RATE: 'high_error_rate',
  HIGH_RESPONSE_TIME: 'high_response_time',
  HIGH_QUEUE_LATENCY: 'high_queue_latency',
  CIRCUIT_BREAKER_OPEN: 'circuit_breaker_open',
  DLQ_OVERFLOW: 'dlq_overflow',
  R2_STORAGE_FAILURE: 'r2_storage_failure',
});

/**
 * Evaluate all monitoring alert conditions and dispatch notifications.
 *
 * Checks seven conditions against live data in the database:
 *   1. Database connectivity (latency > 30s or connection error)
 *   2. Error rate > 5% in the last 5 minutes (`error_logs` table)
 *   3. HTTP response time p95 > 3000ms in the last 5 minutes (`metrics_summary` raw rows)
 *   4. Queue processing latency > 10 minutes
 *   5. Circuit breaker open > 10 minutes (`system_flags` table, columns: `key`/`value`)
 *   6. Dead Letter Queue > 100 messages in the last hour (`dead_letter_events.died_at`)
 *   7. R2 storage inaccessible
 *
 * For each triggered alert:
 *   - Deduplication is applied via an in-memory Map (`alertDeduplicationCache`).
 *     The same alert type+component is suppressed for 15 minutes unless severity escalates.
 *     Note: the Map is lost between Worker isolate invocations, so the dedup window
 *     resets on cold starts.
 *   - Alert is persisted to `alert_history` with `delivery_status = 'pending'`
 *   - Alert is stored in DB / dashboard (sin push externo)
 *   - `delivery_status` is updated to `'sent'` or `'failed'` by PK (id)
 *
 * Designed to be called inside `ctx.waitUntil()` from the `scheduled()` handler
 * on the cron `*\/2 * * * *`. Never throws — all errors are caught and logged
 * with `[ALERT_MANAGER_ERROR]`, returning an empty array on fatal failure.
 *
 * @param {Env}              env - Worker environment bindings
 *   (requires HYPERDRIVE)
 * @param {ExecutionContext}  ctx - Cloudflare execution context (reserved for future use)
 * @returns {Promise<Array<Object>>} All triggered alert objects before deduplication.
 *   Each alert has: `{ type, severity, component, metric_value, threshold_value, message, timestamp }`.
 *   Returns `[]` on any fatal error.
 *
 * Requirements: 5.1-5.8
 */
export async function evaluateAlerts(env, ctx) {
  const triggeredAlerts = [];
  try {
    await withDb(env, async (client) => {
      await client.query('SET statement_timeout = 1000');

      // ========================================================================
      // ALERT 1: Database Connectivity
      // ========================================================================
      const dbAlert = await checkDatabaseConnectivity(client);
      if (dbAlert) triggeredAlerts.push(dbAlert);

      // ========================================================================
      // ALERT 2: High Error Rate
      // ========================================================================
      const errorRateAlert = await checkErrorRate(client);
      if (errorRateAlert) triggeredAlerts.push(errorRateAlert);

      // ========================================================================
      // ALERT 3: High Response Time (p95)
      // ========================================================================
      const responseTimeAlert = await checkResponseTime(client);
      if (responseTimeAlert) triggeredAlerts.push(responseTimeAlert);

      // ========================================================================
      // ALERT 4: Queue Latency
      // ========================================================================
      const queueAlert = await checkQueueLatency(client);
      if (queueAlert) triggeredAlerts.push(queueAlert);

      // ========================================================================
      // ALERT 5: Circuit Breaker Open
      // ========================================================================
      const circuitBreakerAlert = await checkCircuitBreakers(client);
      if (circuitBreakerAlert) triggeredAlerts.push(circuitBreakerAlert);

      // ========================================================================
      // ALERT 6: Dead Letter Queue Overflow
      // ========================================================================
      const dlqAlert = await checkDLQCount(client);
      if (dlqAlert) triggeredAlerts.push(dlqAlert);

      // ========================================================================
      // ALERT 7: R2 Storage Failure
      // ========================================================================
      const r2Alert = await checkR2Status(env);
      if (r2Alert) triggeredAlerts.push(r2Alert);
    });

    // ========================================================================
    // Process triggered alerts
    // ========================================================================
    if (triggeredAlerts.length > 0) {
      console.info('[ALERT_MANAGER] Triggered alerts:', triggeredAlerts.length);
      
      // Apply deduplication and rate limiting
      const dedupedAlerts = applyDeduplication(triggeredAlerts);
      
      // Send alerts and store history
      for (const alert of dedupedAlerts) {
        // Store in database — canal de entrega = historial / dashboard (sin push externo)
        const alertId = await storeAlertHistory(alert, env);
        const deliverySuccess = await sendAlert(alert, env);
        await updateAlertDeliveryStatus(
          alertId,
          deliverySuccess ? 'sent' : 'failed',
          deliverySuccess ? null : 'Alert store/log failed',
          env
        );
      }
    }

    return triggeredAlerts;
  } catch (error) {
    console.error('[ALERT_MANAGER_ERROR]', error.message);
    // Fail gracefully - monitoring failures should not crash
    return [];
  }
}

// ============================================================================
// ALERT CONDITION CHECKS
// ============================================================================

/**
 * Check database connectivity
 * @param {Client} client - Database client
 * @returns {Promise<Object|null>} - Alert object or null
 */
async function checkDatabaseConnectivity(client) {
  const threshold = MONITORING_CONFIG.alerts.database_down_threshold_seconds;
  
  try {
    const start = Date.now();
    await client.query('SELECT 1');
    const latency = Date.now() - start;
    
    // Check if latency exceeds threshold (convert to ms)
    if (latency > threshold * 1000) {
      return {
        type: 'database_connectivity',
        severity: 'CRITICAL',
        component: 'database',
        metric_value: latency,
        threshold_value: threshold * 1000,
        message: `Base de datos respondiendo lentamente: ${latency}ms (umbral: ${threshold}s)`,
        timestamp: new Date().toISOString()
      };
    }
    
    return null;
  } catch (error) {
    return {
      type: 'database_connectivity',
      severity: 'CRITICAL',
      component: 'database',
      metric_value: null,
      threshold_value: threshold * 1000,
      message: `Error de conectividad a base de datos: ${error.message}`,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Check error rate over last N minutes
 * @param {Client} client - Database client
 * @returns {Promise<Object|null>} - Alert object or null
 */
async function checkErrorRate(client) {
  const threshold = MONITORING_CONFIG.alerts.error_rate_threshold_percent;
  const window = MONITORING_CONFIG.alerts.error_rate_window_minutes;
  
  try {
    const query = `
      SELECT 
        COUNT(*) FILTER (WHERE severity IN ('ERROR', 'CRITICAL')) as error_count,
        COUNT(*) as total_count
      FROM error_logs
      WHERE timestamp > NOW() - INTERVAL '${window} minutes'
    `;
    
    const result = await client.query(query);
    const { error_count, total_count } = result.rows[0];
    
    if (total_count === 0) return null;
    
    const errorRate = (parseInt(error_count) / parseInt(total_count)) * 100;
    
    if (errorRate > threshold) {
      return {
        type: 'high_error_rate',
        severity: errorRate > threshold * 2 ? 'CRITICAL' : 'ERROR',
        component: 'application',
        metric_value: errorRate.toFixed(2),
        threshold_value: threshold,
        message: `Tasa de errores elevada: ${errorRate.toFixed(2)}% en los últimos ${window} minutos (umbral: ${threshold}%)`,
        timestamp: new Date().toISOString()
      };
    }
    
    return null;
  } catch (error) {
    console.error('[CHECK_ERROR_RATE]', error.message);
    return null;
  }
}

/**
 * Check response time p95
 * @param {Client} client - Database client
 * @returns {Promise<Object|null>} - Alert object or null
 */
async function checkResponseTime(client) {
  const threshold = MONITORING_CONFIG.alerts.response_time_p95_threshold_ms;
  const window = MONITORING_CONFIG.alerts.response_time_window_minutes;
  
  try {
    const query = `
      SELECT
        COUNT(*) AS n,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value) AS p95_value
      FROM metrics_summary
      WHERE metric_name = 'http.request.duration'
        AND aggregation_type = 'raw'
        AND timestamp > NOW() - INTERVAL '${window} minutes'
    `;
    
    const result = await client.query(query);
    
    if (result.rows.length === 0 || parseInt(result.rows[0].n) === 0) return null;
    
    const p95Value = parseFloat(result.rows[0].p95_value);
    
    if (p95Value > threshold) {
      return {
        type: 'high_response_time',
        severity: p95Value > threshold * 1.5 ? 'ERROR' : 'WARN',
        component: 'http_endpoints',
        metric_value: p95Value,
        threshold_value: threshold,
        message: `Tiempo de respuesta p95 elevado: ${p95Value.toFixed(0)}ms (umbral: ${threshold}ms)`,
        timestamp: new Date().toISOString()
      };
    }
    
    return null;
  } catch (error) {
    console.error('[CHECK_RESPONSE_TIME]', error.message);
    return null;
  }
}

/**
 * Check queue processing latency
 * @param {Client} client - Database client
 * @returns {Promise<Object|null>} - Alert object or null
 */
async function checkQueueLatency(client) {
  const threshold = MONITORING_CONFIG.alerts.queue_latency_threshold_minutes;
  
  try {
    const query = `
      SELECT metric_value, dimension_tags->>'queue_name' as queue_name
      FROM metrics_summary
      WHERE metric_name = 'queue.processing.latency'
        AND aggregation_type = 'avg'
        AND timestamp > NOW() - INTERVAL '10 minutes'
      ORDER BY timestamp DESC
      LIMIT 1
    `;
    
    const result = await client.query(query);
    
    if (result.rows.length === 0) return null;
    
    const latencyMs = parseFloat(result.rows[0].metric_value);
    const latencyMinutes = latencyMs / 60000;
    const queueName = result.rows[0].queue_name || 'unknown';
    
    if (latencyMinutes > threshold) {
      return {
        type: 'high_queue_latency',
        severity: latencyMinutes > threshold * 2 ? 'CRITICAL' : 'ERROR',
        component: `queue_${queueName}`,
        metric_value: latencyMinutes.toFixed(2),
        threshold_value: threshold,
        message: `Latencia de cola elevada (${queueName}): ${latencyMinutes.toFixed(2)} minutos (umbral: ${threshold} min)`,
        timestamp: new Date().toISOString()
      };
    }
    
    return null;
  } catch (error) {
    console.error('[CHECK_QUEUE_LATENCY]', error.message);
    return null;
  }
}

/**
 * Check circuit breaker status
 * @param {Client} client - Database client
 * @returns {Promise<Object|null>} - Alert object or null
 */
async function checkCircuitBreakers(client) {
  const threshold = MONITORING_CONFIG.alerts.circuit_breaker_open_threshold_minutes;
  
  try {
    const query = `
      SELECT key, value, updated_at
      FROM system_flags
      WHERE key LIKE '%_breaker%'
        AND value = 'OPEN'
        AND updated_at < NOW() - INTERVAL '${threshold} minutes'
    `;
    
    const result = await client.query(query);
    
    if (result.rows.length > 0) {
      const breaker = result.rows[0];
      const openDuration = (Date.now() - new Date(breaker.updated_at).getTime()) / 60000;
      
      return {
        type: 'circuit_breaker_open',
        severity: 'ERROR',
        component: breaker.key,
        metric_value: openDuration.toFixed(2),
        threshold_value: threshold,
        message: `Circuit breaker abierto por mucho tiempo (${breaker.key}): ${openDuration.toFixed(0)} minutos (umbral: ${threshold} min)`,
        timestamp: new Date().toISOString()
      };
    }
    
    return null;
  } catch (error) {
    console.error('[CHECK_CIRCUIT_BREAKERS]', error.message);
    return null;
  }
}

/**
 * Check Dead Letter Queue count
 * @param {Client} client - Database client
 * @returns {Promise<Object|null>} - Alert object or null
 */
async function checkDLQCount(client) {
  const threshold = MONITORING_CONFIG.alerts.dlq_message_threshold;
  
  try {
    const query = `
      SELECT COUNT(*) as dlq_count
      FROM dead_letter_events
      WHERE died_at > NOW() - INTERVAL '1 hour'
    `;
    
    const result = await client.query(query);
    const dlqCount = parseInt(result.rows[0].dlq_count);
    
    if (dlqCount > threshold) {
      return {
        type: 'dlq_overflow',
        severity: dlqCount > threshold * 2 ? 'CRITICAL' : 'ERROR',
        component: 'dead_letter_queue',
        metric_value: dlqCount,
        threshold_value: threshold,
        message: `Dead Letter Queue desbordada: ${dlqCount} mensajes en la última hora (umbral: ${threshold})`,
        timestamp: new Date().toISOString()
      };
    }
    
    return null;
  } catch (error) {
    console.error('[CHECK_DLQ_COUNT]', error.message);
    return null;
  }
}

/**
 * Check R2 storage status
 * @param {Env} env - Worker environment bindings
 * @returns {Promise<Object|null>} - Alert object or null
 */
async function checkR2Status(env) {
  const threshold = MONITORING_CONFIG.alerts.r2_failure_threshold_minutes;
  
  try {
    if (!env.R2_BUCKET) {
      return null; // R2 not configured
    }
    
    // Try to perform a head operation
    const testKey = '.health-check';
    await env.R2_BUCKET.head(testKey);
    
    return null; // R2 is healthy
  } catch (error) {
    return {
      type: 'r2_storage_failure',
      severity: 'ERROR',
      component: 'r2_storage',
      metric_value: null,
      threshold_value: threshold,
      message: `Fallo en almacenamiento R2: ${error.message}`,
      timestamp: new Date().toISOString()
    };
  }
}

// ============================================================================
// ALERT DEDUPLICATION
// Requirements: 5.11, 9.5
// ============================================================================

/**
 * Apply deduplication logic to alerts
 * 
 * Suppresses duplicate alerts within the deduplication window (15 minutes).
 * Resets suppression on severity escalation.
 * Implements per-component rate limiting (max 10 alerts/hour).
 * 
 * @param {Array} alerts - Array of triggered alert objects
 * @returns {Array} - Filtered array of alerts to send
 */
function applyDeduplication(alerts) {
  const dedupWindowMs = MONITORING_CONFIG.alerts.alert_deduplication_window_minutes * 60 * 1000;
  const maxAlertsPerHour = MONITORING_CONFIG.alerts.max_alerts_per_hour;
  const now = Date.now();
  const dedupedAlerts = [];

  for (const alert of alerts) {
    const alertKey = `${alert.type}:${alert.component}`;
    const cached = alertDeduplicationCache.get(alertKey);

    // Check deduplication window
    if (cached) {
      const timeSinceLastSent = now - cached.lastSent;
      
      // Within deduplication window
      if (timeSinceLastSent < dedupWindowMs) {
        // Check for severity escalation
        if (shouldEscalate(cached.severity, alert.severity)) {
          console.info(`[ALERT_DEDUP] Severity escalation: ${alertKey} from ${cached.severity} to ${alert.severity}`);
          // Allow escalation (reset deduplication)
        } else {
          console.info(`[ALERT_DEDUP] Suppressed duplicate: ${alertKey}`);
          continue; // Skip this alert
        }
      }
    }

    // Check rate limiting per component
    const componentAlerts = alertRateLimiter.get(alert.component) || [];
    const oneHourAgo = now - (60 * 60 * 1000);
    
    // Clean old timestamps
    const recentAlerts = componentAlerts.filter(ts => ts > oneHourAgo);
    
    if (recentAlerts.length >= maxAlertsPerHour) {
      console.warn(`[ALERT_RATE_LIMIT] Max alerts reached for component: ${alert.component}`);
      continue; // Skip this alert
    }

    // Update deduplication cache
    alertDeduplicationCache.set(alertKey, {
      lastSent: now,
      severity: alert.severity
    });

    // Update rate limiter
    recentAlerts.push(now);
    alertRateLimiter.set(alert.component, recentAlerts);

    dedupedAlerts.push(alert);
  }

  // Cleanup old deduplication cache entries (older than 1 hour)
  const oneHourAgo = now - (60 * 60 * 1000);
  for (const [key, value] of alertDeduplicationCache.entries()) {
    if (value.lastSent < oneHourAgo) {
      alertDeduplicationCache.delete(key);
    }
  }

  return dedupedAlerts;
}

/**
 * Determine if severity escalation occurred
 * @param {string} oldSeverity - Previous severity
 * @param {string} newSeverity - New severity
 * @returns {boolean} - True if escalated
 */
function shouldEscalate(oldSeverity, newSeverity) {
  const severityLevels = { INFO: 1, WARN: 2, ERROR: 3, CRITICAL: 4 };
  return severityLevels[newSeverity] > severityLevels[oldSeverity];
}

// ============================================================================
// ALERT DELIVERY (dashboard / logs — sin canal push externo)
// ============================================================================

/**
 * Registra la alerta en logs de Workers. La persistencia ya ocurrió en
 * `storeAlertHistory`; el dashboard de monitoring es el canal de lectura.
 *
 * @returns {Promise<boolean>} siempre `true` (entrega = historial en DB)
 */
export async function sendAlert(alert, env) {
  try {
    const emoji = getSeverityEmoji(alert.severity);
    const message = formatAlertMessage(alert, emoji);
    console.info(`[ALERT_DASHBOARD] ${alert.type} (${alert.severity})`, message.replace(/\n/g, ' | '));
    return true;
  } catch (error) {
    console.error('[ALERT_DASHBOARD] log error:', error.message);
    return false;
  }
}

/**
 * Get emoji for severity level
 * @param {string} severity - Severity level
 * @returns {string} - Emoji character
 */
function getSeverityEmoji(severity) {
  const emojiMap = {
    INFO: '🔵',
    WARN: '🟡',
    ERROR: '🔴',
    CRITICAL: '🚨'
  };
  return emojiMap[severity] || '⚠️';
}

/**
 * Format alert message for logs / dashboard
 * @param {Object} alert - Alert object
 * @param {string} emoji - Emoji prefix
 * @returns {string} - Formatted Markdown message
 */
function formatAlertMessage(alert, emoji) {
  const lines = [
    `${emoji} *ALERTA: ${alert.severity}*`,
    '',
    `*Tipo:* ${alert.type}`,
    `*Componente:* ${alert.component}`,
    ''
  ];

  if (alert.metric_value !== null && alert.metric_value !== undefined) {
    lines.push(`*Valor actual:* ${alert.metric_value}`);
  }

  if (alert.threshold_value !== null && alert.threshold_value !== undefined) {
    lines.push(`*Umbral:* ${alert.threshold_value}`);
  }

  lines.push('');
  lines.push(`*Mensaje:* ${alert.message}`);
  lines.push('');
  lines.push(`*Timestamp:* ${new Date(alert.timestamp).toLocaleString('es-AR')}`);
  lines.push('');
  lines.push(`🔗 [Ver Dashboard](https://lead-rescue-pipeline.marceloetcheverry990.workers.dev/dashboard/monitoring)`);
  
  // Add recommended action based on alert type
  const action = getRecommendedAction(alert.type);
  if (action) {
    lines.push('');
    lines.push(`*Acción recomendada:* ${action}`);
  }

  return lines.join('\n');
}

/**
 * Get recommended action for alert type
 * @param {string} alertType - Alert type
 * @returns {string} - Recommended action text
 */
function getRecommendedAction(alertType) {
  const actions = {
    'database_connectivity': 'Verificar estado de Supabase y conexiones activas',
    'high_error_rate': 'Revisar logs de errores recientes en el dashboard',
    'high_response_time': 'Verificar carga del sistema y consultas lentas',
    'high_queue_latency': 'Revisar backlog de cola y procesamiento',
    'circuit_breaker_open': 'Verificar servicio externo y reintentar manualmente',
    'dlq_overflow': 'Revisar mensajes en DLQ y reprocesar si es necesario',
    'r2_storage_failure': 'Verificar configuración y permisos de R2'
  };
  return actions[alertType] || 'Investigar en dashboard de monitoreo';
}

// ============================================================================
// DATABASE PERSISTENCE
// Requirements: 5.13, 7.4
// ============================================================================

/**
 * Store alert in database history
 * @param {Object} alert - Alert object
 * @param {Env} env - Worker environment bindings
 * @returns {Promise<number>} - Alert ID
 */
async function storeAlertHistory(alert, env) {
  try {
    return await withDb(env, async (client) => {
      const query = `
        INSERT INTO alert_history (
          timestamp,
          alert_type,
          severity,
          component,
          metric_value,
          threshold_value,
          message,
          delivery_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
        RETURNING id
      `;
      const values = [
        alert.timestamp,
        alert.type,
        alert.severity,
        alert.component,
        alert.metric_value,
        alert.threshold_value,
        alert.message
      ];
      const result = await client.query(query, values);
      return result.rows[0].id;
    }, { statementTimeout: 1000 });
  } catch (error) {
    console.error('[STORE_ALERT_HISTORY]', error.message);
    throw error;
  }
}

/**
 * Update alert delivery status by PK
 * @param {number} alertId - Alert PK from storeAlertHistory
 * @param {string} status - 'sent' or 'failed'
 * @param {string|null} deliveryError - Error message if failed, null if sent
 * @param {Env} env - Worker environment bindings
 * @returns {Promise<void>}
 */
async function updateAlertDeliveryStatus(alertId, status, deliveryError, env) {
  try {
    await withDb(env, async (client) => {
      await client.query(
        `UPDATE alert_history
         SET delivery_status = $1,
             delivery_error  = $2
         WHERE id = $3`,
        [status, deliveryError, alertId]
      );
    }, { statementTimeout: 1000 });
  } catch (error) {
    console.error('[UPDATE_ALERT_STATUS]', error.message);
    // Don't throw - this is not critical
  }
}

/**
 * Retrieve alert history for dashboard display.
 *
 * Queries `alert_history` ordered by `timestamp DESC` and returns up to 100
 * records within the selected time range. All timestamps are serialised to
 * ISO-8601 strings. Uses `statementTimeout = 1000ms`.
 *
 * @param {Object} filters            - Query filters
 * @param {string} [filters.timeRange='24h'] - Time range: `'1h'` | `'24h'` | `'7d'`
 * @param {Env}    env                - Worker environment bindings (requires HYPERDRIVE)
 * @returns {Promise<Array<Object>>}  Array of alert records, each with:
 *   `{ id, timestamp, alert_type, severity, component, metric_value,
 *      threshold_value, message, delivery_status, acknowledged_at, acknowledged_by }`.
 *   Returns `[]` on database error.
 *
 * Requirements: 5.13, 7.4
 */
export async function getAlertHistory(filters, env) {
  const timeRange = filters.timeRange || '24h';
  const intervalMap = {
    '1h': '1 hour',
    '24h': '24 hours',
    '7d': '7 days'
  };
  const interval = intervalMap[timeRange] || '24 hours';

  try {
    return await withDb(env, async (client) => {
      const query = `
      SELECT 
        id,
        timestamp,
        alert_type,
        severity,
        component,
        metric_value,
        threshold_value,
        message,
        delivery_status,
        acknowledged_at,
        acknowledged_by
      FROM alert_history
      WHERE timestamp > NOW() - INTERVAL '${interval}'
      ORDER BY timestamp DESC
      LIMIT 100
    `;
      const result = await client.query(query);
      return result.rows.map(row => ({
        id: row.id,
        timestamp: row.timestamp.toISOString(),
        alert_type: row.alert_type,
        severity: row.severity,
        component: row.component,
        metric_value: row.metric_value,
        threshold_value: row.threshold_value,
        message: row.message,
        delivery_status: row.delivery_status,
        acknowledged_at: row.acknowledged_at ? row.acknowledged_at.toISOString() : null,
        acknowledged_by: row.acknowledged_by
      }));
    }, { statementTimeout: 1000 });
  } catch (error) {
    console.error('[GET_ALERT_HISTORY]', error.message);
    return [];
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  evaluateAlerts,
  sendAlert,
  getAlertHistory
};
