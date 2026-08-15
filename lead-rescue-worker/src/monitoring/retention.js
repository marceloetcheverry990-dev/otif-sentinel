// src/monitoring/retention.js
// Data Retention Policy Enforcement
// Requirements: 7.6, 11.1-11.10

import { withDb } from '../db.js';

// ============================================================================
// RETENTION CONFIGURATION
// Periods are defined in MONITORING_CONFIG but mirrored here for readability
// ============================================================================

const RETENTION = {
  error_logs_days:          90,   // DELETE rows older than 90 days
  alert_history_days:       180,  // DELETE rows older than 180 days
  health_check_results_days: 30,  // DELETE rows older than 30 days
  metrics_partition_days:   365,  // OBSERVE partitions older than 365 days (no DROP yet)
  gps_trail_days:           14,   // Fase 0 — trail GPS muestreado
  fleet_alerts_resolved_days: 30, // Alertas RESOLVED/DISMISSED
};

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * Enforce data retention policies for monitoring tables.
 *
 * Phase 1 (current):
 *   - DELETE old rows from error_logs, alert_history, health_check_results
 *   - OBSERVE metrics_summary partitions that would be candidates for DROP
 *     (log names + total recoverable size — no DROP executed)
 *
 * Phase 2 (future, requires explicit enablement):
 *   - DROP old metrics_summary partitions after observing evidence in production
 *
 * All operations use statementTimeout = 5000ms to prevent long-running deletes
 * from blocking other monitoring operations.
 *
 * @param {Env} env - Worker environment bindings (requires HYPERDRIVE)
 * @returns {Promise<Object>} - Summary of retention actions taken
 */
export async function enforceRetentionPolicies(env) {
  const summary = {
    timestamp: new Date().toISOString(),
    deleted: {
      error_logs: 0,
      alert_history: 0,
      health_check_results: 0,
      gps_trail: 0,
      fleet_alerts: 0,
    },
    observed_partitions: {
      candidates: [],
      total_recoverable_bytes: 0,
      total_recoverable_pretty: '0 bytes',
    },
    errors: [],
  };

  try {
    await withDb(env, async (client) => {

      // ──────────────────────────────────────────────────────────────────────
      // DELETE: error_logs older than 90 days
      // ──────────────────────────────────────────────────────────────────────
      try {
        const r = await client.query(
          `DELETE FROM error_logs
           WHERE timestamp < NOW() - INTERVAL '${RETENTION.error_logs_days} days'`
        );
        summary.deleted.error_logs = r.rowCount;
        console.info('[RETENTION] error_logs deleted:', r.rowCount,
          `(older than ${RETENTION.error_logs_days} days)`);
      } catch (err) {
        console.error('[RETENTION_ERROR] error_logs delete failed:', err.message);
        summary.errors.push({ table: 'error_logs', error: err.message });
      }

      // ──────────────────────────────────────────────────────────────────────
      // DELETE: alert_history older than 180 days
      // ──────────────────────────────────────────────────────────────────────
      try {
        const r = await client.query(
          `DELETE FROM alert_history
           WHERE timestamp < NOW() - INTERVAL '${RETENTION.alert_history_days} days'`
        );
        summary.deleted.alert_history = r.rowCount;
        console.info('[RETENTION] alert_history deleted:', r.rowCount,
          `(older than ${RETENTION.alert_history_days} days)`);
      } catch (err) {
        console.error('[RETENTION_ERROR] alert_history delete failed:', err.message);
        summary.errors.push({ table: 'alert_history', error: err.message });
      }

      // ──────────────────────────────────────────────────────────────────────
      // DELETE: health_check_results older than 30 days
      // ──────────────────────────────────────────────────────────────────────
      try {
        const r = await client.query(
          `DELETE FROM health_check_results
           WHERE timestamp < NOW() - INTERVAL '${RETENTION.health_check_results_days} days'`
        );
        summary.deleted.health_check_results = r.rowCount;
        console.info('[RETENTION] health_check_results deleted:', r.rowCount,
          `(older than ${RETENTION.health_check_results_days} days)`);
      } catch (err) {
        console.error('[RETENTION_ERROR] health_check_results delete failed:', err.message);
        summary.errors.push({ table: 'health_check_results', error: err.message });
      }

      // ──────────────────────────────────────────────────────────────────────
      // DELETE: gps_trail older than 14 days (Fase 0)
      // ──────────────────────────────────────────────────────────────────────
      try {
        const r = await client.query(
          `DELETE FROM gps_trail
           WHERE recorded_at < NOW() - INTERVAL '${RETENTION.gps_trail_days} days'`
        );
        summary.deleted.gps_trail = r.rowCount;
        console.info('[RETENTION] gps_trail deleted:', r.rowCount,
          `(older than ${RETENTION.gps_trail_days} days)`);
      } catch (err) {
        if (err.code !== '42P01') {
          console.error('[RETENTION_ERROR] gps_trail delete failed:', err.message);
          summary.errors.push({ table: 'gps_trail', error: err.message });
        }
      }

      // ──────────────────────────────────────────────────────────────────────
      // DELETE: fleet_alerts cerradas older than 30 days
      // ──────────────────────────────────────────────────────────────────────
      try {
        const r = await client.query(
          `DELETE FROM fleet_alerts
           WHERE status IN ('RESOLVED', 'DISMISSED')
             AND updated_at < NOW() - INTERVAL '${RETENTION.fleet_alerts_resolved_days} days'`
        );
        summary.deleted.fleet_alerts = r.rowCount;
        console.info('[RETENTION] fleet_alerts deleted:', r.rowCount,
          `(older than ${RETENTION.fleet_alerts_resolved_days} days)`);
      } catch (err) {
        if (err.code !== '42P01') {
          console.error('[RETENTION_ERROR] fleet_alerts delete failed:', err.message);
          summary.errors.push({ table: 'fleet_alerts', error: err.message });
        }
      }

      // ──────────────────────────────────────────────────────────────────────
      // OBSERVE: metrics_summary partitions older than 365 days
      // Lists candidates + total recoverable size. NO DROP executed.
      // ──────────────────────────────────────────────────────────────────────
      try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - RETENTION.metrics_partition_days);
        // Format as YYYY_MM for name matching (partition names: metrics_summary_YYYY_MM)
        const cutoffYYYYMM = cutoffDate.toISOString().slice(0, 7).replace('-', '_');

        const r = await client.query(`
          SELECT
            c.relname                                                      AS partition_name,
            TO_DATE(
              SUBSTRING(c.relname FROM 'metrics_summary_(\\d{4}_\\d{2})'),
              'YYYY_MM'
            )                                                              AS partition_month,
            pg_size_pretty(pg_total_relation_size(c.oid))                  AS size_pretty,
            pg_total_relation_size(c.oid)                                  AS size_bytes
          FROM pg_class c
          JOIN pg_inherits i  ON c.oid  = i.inhrelid
          JOIN pg_class p     ON i.inhparent = p.oid
          WHERE p.relname = 'metrics_summary'
            AND c.relkind = 'r'
            AND TO_DATE(
                  SUBSTRING(c.relname FROM 'metrics_summary_(\\d{4}_\\d{2})'),
                  'YYYY_MM'
                ) < DATE_TRUNC('month', NOW() - INTERVAL '${RETENTION.metrics_partition_days} days')
          ORDER BY partition_month ASC
        `);

        const candidates = r.rows.map(row => ({
          name:   row.partition_name,
          month:  row.partition_month,
          size:   row.size_pretty,
          bytes:  parseInt(row.size_bytes, 10),
        }));

        const totalBytes = candidates.reduce((acc, p) => acc + p.bytes, 0);

        summary.observed_partitions.candidates             = candidates;
        summary.observed_partitions.total_recoverable_bytes = totalBytes;
        summary.observed_partitions.total_recoverable_pretty =
          totalBytes === 0 ? '0 bytes' : formatBytes(totalBytes);

        if (candidates.length > 0) {
          console.info(
            '[RETENTION_OBSERVE] Partition candidates for DROP (not executed):',
            candidates.map(p => `${p.name} (${p.size})`).join(', '),
            '| Total recoverable:', summary.observed_partitions.total_recoverable_pretty
          );
        } else {
          console.info('[RETENTION_OBSERVE] No metrics_summary partitions eligible for DROP.');
        }

      } catch (err) {
        console.error('[RETENTION_ERROR] partition observation failed:', err.message);
        summary.errors.push({ table: 'metrics_summary_partitions', error: err.message });
      }

    }, { statementTimeout: 5000 });

  } catch (err) {
    console.error('[RETENTION_FATAL]', err.message);
    summary.errors.push({ table: 'all', error: err.message });
  }

  console.info('[RETENTION] Summary:', JSON.stringify(summary));
  return summary;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Format a byte count as a human-readable string.
 *
 * Thresholds:
 * - < 1 024 bytes → `"N bytes"`
 * - < 1 048 576 bytes (1 MiB) → `"N.N kB"`
 * - ≥ 1 048 576 bytes → `"N.N MB"`
 *
 * @param {number} bytes - Non-negative integer byte count
 * @returns {string} Human-readable size string (e.g., `"12.3 MB"`)
 */
function formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
