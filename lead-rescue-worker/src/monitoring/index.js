// src/monitoring/index.js
// Main export file for the Stability and Monitoring System
// This module serves as the entry point for all monitoring components

/**
 * Monitoring System Entry Point
 * 
 * This file exports all monitoring components following the module pattern
 * established in the design document. It provides a clean interface for
 * integrating monitoring capabilities throughout the application.
 * 
 * Usage:
 *   import { Logger, handleHealthCheck, MONITORING_CONFIG } from './monitoring';
 * 
 * Architecture:
 *   - Non-invasive middleware pattern
 *   - Fail-safe: monitoring failures don't crash application
 *   - Cost-optimized: batching, sampling, and caching
 *   - Tenant-isolated: maintains multi-tenant data separation
 */

// ============================================================================
// CONFIGURATION EXPORTS
// ============================================================================
export { 
  MONITORING_CONFIG, 
  getMonitoringConfig, 
  validateMonitoringConfig 
} from './config.js';

// ============================================================================
// COMPONENT EXPORTS (to be implemented in subsequent tasks)
// ============================================================================

// Health Check Service (Task 2.2)
export { handleHealthCheck } from './health.js';

// Structured Logger (Task 2.1)
export { 
  Logger, 
  createRequestLogger, 
  sanitizeLogContext, 
  startTimer, 
  withLogging,
  LogLevel 
} from './logger.js';

// Error Tracker (Task 2.3)
export { 
  captureError, 
  captureErrorAsync,
  getErrorStats, 
  generateErrorFingerprint, 
  classifyErrorSeverity,
  sanitizeErrorMessage 
} from './errors.js';

// Metrics Collector (Task 1.6)
export { 
  recordMetric, 
  startTimer as metricsTimer, 
  withMetrics, 
  METRIC_TYPES 
} from './metrics.js';

// Request Monitoring Middleware (Task 4.1)
export {
  withMonitoring,
  withQueueMonitoring,
  withScheduledMonitoring
} from './middleware.js';

// Alert Manager (Task 1.7)
// export { evaluateAlerts, sendAlert } from './alerts.js';

// System Dashboard (Task 1.8)
// export { renderDashboard, getDashboardData } from './dashboard.js';

// ============================================================================
// PLACEHOLDER EXPORTS (will be replaced as components are implemented)
// ============================================================================

// Health check handler is now implemented in health.js and exported above

/**
 * Initialize the monitoring system.
 *
 * Should be called once at the start of each Worker invocation (or on the
 * first request in a long-lived isolate) to validate configuration and
 * confirm that all required bindings are present.
 *
 * Behaviour:
 * - Calls {@link validateMonitoringConfig} — if validation fails, returns
 *   `{ success: false }` with the list of config errors. Monitoring will
 *   still run but the caller can choose to alert or log.
 * - Calls {@link getMonitoringConfig} with `env` to merge environment overrides.
 * - If `config.features.enabled` is `false`, returns early without error
 *   (monitoring is explicitly disabled by the operator).
 * - Logs a structured `console.info` message listing enabled features.
 *
 * @param {Env} env - Worker environment bindings
 * @returns {{ success: boolean, message: string, config?: Object, errors?: string[] }}
 *   - `success: false, errors` if configuration is invalid
 *   - `success: true, message: 'Monitoring disabled'` if feature flag is off
 *   - `success: true, config` on successful initialization
 *
 * @example
 * import { initializeMonitoring } from './monitoring/index.js';
 *
 * export default {
 *   fetch(request, env, ctx) {
 *     const init = initializeMonitoring(env);
 *     if (!init.success) console.warn('Monitoring init failed', init.errors);
 *     // Continue with normal request handling
 *   }
 * };
 */
export function initializeMonitoring(env) {
  const validation = validateMonitoringConfig();
  
  if (!validation.valid) {
    console.error('Monitoring configuration validation failed:', validation.errors);
    return {
      success: false,
      message: 'Configuration validation failed',
      errors: validation.errors,
    };
  }

  const config = getMonitoringConfig(env);
  
  if (!config.features.enabled) {
    console.info('Monitoring system is disabled via configuration');
    return {
      success: true,
      message: 'Monitoring disabled',
      config,
    };
  }

  console.info('Monitoring system initialized successfully', {
    version: config.service.version,
    features: Object.entries(config.features)
      .filter(([_, enabled]) => enabled)
      .map(([name, _]) => name),
  });

  return {
    success: true,
    message: 'Monitoring initialized',
    config,
  };
}

/**
 * Return a snapshot of the monitoring system's current operational status.
 *
 * Useful for debugging, admin tooling, or internal status pages that need to
 * know which monitoring components are active without querying the database.
 *
 * @param {Env} env - Worker environment bindings (passed to {@link getMonitoringConfig})
 * @returns {{
 *   enabled: boolean,
 *   components: {
 *     health_checks: boolean,
 *     structured_logging: boolean,
 *     error_tracking: boolean,
 *     metrics_collection: boolean,
 *     alerting: boolean,
 *     dashboard: boolean,
 *   },
 *   service: { name: string, version: string, environment: string }
 * }}
 *
 * @example
 * import { getMonitoringStatus } from './monitoring/index.js';
 *
 * const status = getMonitoringStatus(env);
 * console.log('Alerting active:', status.components.alerting);
 */
export function getMonitoringStatus(env) {
  const config = getMonitoringConfig(env);
  
  return {
    enabled: config.features.enabled,
    components: {
      health_checks: config.features.health_checks,
      structured_logging: config.features.structured_logging,
      error_tracking: config.features.error_tracking,
      metrics_collection: config.features.metrics_collection,
      alerting: config.features.alerting,
      dashboard: config.features.dashboard,
    },
    service: {
      name: config.service.name,
      version: config.service.version,
      environment: config.service.environment,
    },
  };
}

// ============================================================================
// MONITORING SYSTEM METADATA
// ============================================================================

export const MONITORING_VERSION = '1.0.0';
export const MONITORING_BUILD_DATE = new Date().toISOString();

/**
 * Export monitoring system information for debugging
 */
export const MONITORING_INFO = Object.freeze({
  version: MONITORING_VERSION,
  buildDate: MONITORING_BUILD_DATE,
  components: [
    'health-checks',
    'structured-logger',
    'error-tracker',
    'metrics-collector',
    'alert-manager',
    'system-dashboard',
  ],
  features: [
    'real-time-health-monitoring',
    'structured-json-logging',
    'automatic-error-capture',
    'performance-metrics-collection',
    'operational-alerting',
    'visual-dashboard',
    'tenant-isolation',
    'cost-optimization',
  ],
});
