// src/monitoring/meta-health.js
// Monitoring System Meta-Health Endpoint
// Reports the operational status of the monitoring subsystem itself.
// Requirements: 11.1-11.6, 11.10

import { withDb } from '../db.js';
import { MONITORING_CONFIG } from './config.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const SCHEMA_VERSION = '1.0.0';

// metrics_pipeline is considered degraded if no writes in last N minutes
const METRICS_STALE_THRESHOLD_MINUTES = 30;

// ============================================================================
// HANDLER
// ============================================================================

/**
 * Handle GET /health/monitoring
 *
 * Reports the operational status of the monitoring subsystem itself — this is
 * the "meta-health" endpoint that tells operators whether the monitoring
 * infrastructure (metrics pipeline, alert pipeline, retention) is functioning
 * correctly, independent of the application's own health.
 *
 * The response always returns HTTP 200 — even when the subsystem is degraded.
 * This is intentional: a degraded monitoring system does not mean the
 * application is down, and we do not want this endpoint to trip circuit
 * breakers or health-check load balancers.
 *
 * Response shape:
 * ```json
 * {
 *   "status": "healthy" | "degraded",
 *   "timestamp": "<ISO-8601>",
 *   "service": "otif-sentinel-monitoring",
 *   "monitoring_version": "1.0.0",
 *   "components": {
 *     "metrics_pipeline": { "status": "healthy"|"degraded", "last_write": "...", ... },
 *     "alert_pipeline":   { "status": "healthy", "last_alert": "...", ... }
 *   },
 *   "retention": { "partition_candidates_for_drop": 0, ... },
 *   "errors": []
 * }
 * ```
 *
 * @param {Request} request - Incoming HTTP request (method/headers not inspected)
 * @param {Env}     env     - Worker environment bindings (HYPERDRIVE required)
 * @returns {Promise<Response>} Always HTTP 200 with JSON body.
 *
 * Requirements: 11.1-11.6, 11.10
 */
export async function handleMonitoringHealth(request, env) {
  const result = await getMonitoringHealthData(env);
  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// CORE LOGIC
// ============================================================================

/**
 * Query the database and build the meta-health payload.
 *
 * Runs three independent queries, each wrapped in its own try/catch so a
 * failure in one section does not prevent the others from completing:
 *
 * 1. **metrics_pipeline** — `MAX(timestamp)` on `metrics_summary` in the last
 *    24 hours. If the most recent write was more than
 *    `METRICS_STALE_THRESHOLD_MINUTES` (30) minutes ago, the pipeline is
 *    considered `'degraded'`.
 *
 * 2. **alert_pipeline** — `MAX(timestamp)` on `alert_history` where
 *    `delivery_status = 'sent'` in the last 7 days. Always reported as
 *    `'healthy'` because no recent alerts indicates system stability.
 *
 * 3. **retention** — Lists `metrics_summary` partitions whose month is older
 *    than 365 days. Only observation — no DROP is executed.
 *
 * All DB queries use `statementTimeout = 1000ms` (set on the connection) to
 * ensure the endpoint always returns quickly even under DB load.
 *
 * @param {Env} env - Worker environment bindings (HYPERDRIVE required)
 * @returns {Promise<Object>} Meta-health payload ready for JSON serialisation
 */
async function getMonitoringHealthData(env) {
  const now = new Date();
  const payload = {
    status:           'healthy',
    timestamp:        now.toISOString(),
    service:          'otif-sentinel-monitoring',
    monitoring_version: SCHEMA_VERSION,
    components: {
      metrics_pipeline: {
        status:                    'unknown',
        last_write:                null,
        minutes_since_last_write:  null,
        threshold_minutes:         METRICS_STALE_THRESHOLD_MINUTES,
      },
      alert_pipeline: {
        status:                  'healthy',
        last_alert:              null,
        hours_since_last_alert:  null,
        note: 'No recent alerts is normal — indicates system stability',
      },
    },
    retention: {
      partition_candidates_for_drop: 0,
      partition_names:               [],
      total_recoverable_bytes:       0,
    },
    errors: [],
  };

  try {
    await withDb(env, async (client) => {

      // ── metrics_pipeline: last raw write ──────────────────────────────────
      try {
        const r = await client.query(`
          SELECT MAX(timestamp) AS last_write
          FROM metrics_summary
          WHERE timestamp > NOW() - INTERVAL '24 hours'
        `);
        const lastWrite = r.rows[0]?.last_write;

        if (lastWrite) {
          const minutesSince = Math.floor((now - new Date(lastWrite)) / 60000);
          payload.components.metrics_pipeline.last_write               = new Date(lastWrite).toISOString();
          payload.components.metrics_pipeline.minutes_since_last_write = minutesSince;
          payload.components.metrics_pipeline.status =
            minutesSince < METRICS_STALE_THRESHOLD_MINUTES ? 'healthy' : 'degraded';

          if (minutesSince >= METRICS_STALE_THRESHOLD_MINUTES) {
            payload.components.metrics_pipeline.reason =
              `No metric writes in the last ${METRICS_STALE_THRESHOLD_MINUTES} minutes`;
          }
        } else {
          payload.components.metrics_pipeline.status = 'degraded';
          payload.components.metrics_pipeline.reason =
            `No metric writes in the last 24 hours`;
        }
      } catch (err) {
        payload.components.metrics_pipeline.status = 'unknown';
        payload.errors.push({ component: 'metrics_pipeline', error: err.message });
      }

      // ── alert_pipeline: last sent alert ───────────────────────────────────
      try {
        const r = await client.query(`
          SELECT MAX(timestamp) AS last_alert
          FROM alert_history
          WHERE delivery_status = 'sent'
            AND timestamp > NOW() - INTERVAL '7 days'
        `);
        const lastAlert = r.rows[0]?.last_alert;

        if (lastAlert) {
          const hoursSince = Math.floor((now - new Date(lastAlert)) / 3600000);
          payload.components.alert_pipeline.last_alert             = new Date(lastAlert).toISOString();
          payload.components.alert_pipeline.hours_since_last_alert = hoursSince;
        }
        // alert_pipeline is always 'healthy' — no recent alerts = stable system
      } catch (err) {
        payload.errors.push({ component: 'alert_pipeline', error: err.message });
      }

      // ── retention: partition observation ──────────────────────────────────
      try {
        const r = await client.query(`
          SELECT
            c.relname                                                      AS partition_name,
            pg_total_relation_size(c.oid)                                  AS size_bytes
          FROM pg_class c
          JOIN pg_inherits i  ON c.oid = i.inhrelid
          JOIN pg_class p     ON i.inhparent = p.oid
          WHERE p.relname = 'metrics_summary'
            AND c.relkind = 'r'
            AND TO_DATE(
                  SUBSTRING(c.relname FROM 'metrics_summary_(\\d{4}_\\d{2})'),
                  'YYYY_MM'
                ) < DATE_TRUNC('month', NOW() - INTERVAL '365 days')
          ORDER BY partition_name ASC
        `);

        payload.retention.partition_candidates_for_drop = r.rows.length;
        payload.retention.partition_names               = r.rows.map(row => row.partition_name);
        payload.retention.total_recoverable_bytes       =
          r.rows.reduce((acc, row) => acc + parseInt(row.size_bytes, 10), 0);
      } catch (err) {
        payload.errors.push({ component: 'retention', error: err.message });
      }

    }, { statementTimeout: 1000 });

  } catch (err) {
    payload.errors.push({ component: 'database', error: err.message });
  }

  // ── Overall status ─────────────────────────────────────────────────────────
  const hasDegraded = Object.values(payload.components)
    .some(c => c.status === 'degraded');
  payload.status = hasDegraded ? 'degraded' : 'healthy';

  return payload;
}
