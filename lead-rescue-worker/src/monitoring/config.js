// src/monitoring/config.js
// Monitoring System Configuration
// This file centralizes all monitoring feature flags, thresholds, and configuration options.

/**
 * MONITORING_CONFIG
 * Central configuration object for the Stability and Monitoring System.
 *
 * This is the single source of truth for all monitoring thresholds, feature flags,
 * sampling rates, retention periods, and security settings. It is frozen at module
 * load time so values cannot be accidentally mutated at runtime.
 *
 * To override values at runtime (e.g., via environment variables), use
 * {@link getMonitoringConfig} which merges env vars on top of these defaults.
 *
 * Configuration sections:
 * - `features`     — Enable/disable individual monitoring subsystems
 * - `sampling`     — Percentage of events captured per metric type (0.0–1.0)
 * - `alerts`       — Thresholds that trigger operational notifications
 * - `retention`    — How long monitoring data is kept before deletion
 * - `dashboard`    — UI behaviour (refresh interval, auth, time ranges)
 * - `operational`  — Internal timeouts, circuit breaker, sanitization patterns
 * - `metrics`      — Metric name constants and aggregation settings
 * - `security`     — Rate limits, CSP, and input sanitization switches
 * - `service`      — Service identity (name, version, environment)
 *
 * @type {Readonly<Object>}
 *
 * @example
 * import { MONITORING_CONFIG } from './config.js';
 *
 * // Read a threshold
 * const threshold = MONITORING_CONFIG.alerts.error_rate_threshold_percent; // 5
 *
 * // Check a feature flag
 * if (MONITORING_CONFIG.features.alerting) { ... }
 */
export const MONITORING_CONFIG = Object.freeze({
  // ============================================================================
  // 🎛️ FEATURE FLAGS
  // Control which monitoring components are active
  // ============================================================================
  features: {
    // Enable/disable entire monitoring system
    enabled: true,
    
    // Enable structured logging with JSON format
    structured_logging: true,
    
    // Enable automatic error tracking and persistence
    error_tracking: true,
    
    // Enable performance metrics collection
    metrics_collection: true,
    
    // Enable operational alerting (dashboard / alert history)
    alerting: true,
    
    // Enable visual monitoring dashboard
    dashboard: true,
    
    // Enable health check endpoint
    health_checks: true,
    
    // Enable Cloudflare Analytics Engine integration (if available)
    analytics_engine: false, // Set to true if Analytics Engine is configured
  },

  // ============================================================================
  // 📊 SAMPLING RATES
  // Control data collection frequency for cost optimization
  // Values: 0.0 (0%) to 1.0 (100%)
  // ============================================================================
  sampling: {
    // Sample rate for successful HTTP requests (reduce volume)
    successful_requests: 0.1, // 10% sampling
    
    // Sample rate for failed requests (capture more errors)
    failed_requests: 1.0, // 100% sampling
    
    // Sample rate for database query metrics
    database_queries: 0.2, // 20% sampling
    
    // Sample rate for queue processing metrics
    queue_operations: 1.0, // 100% sampling (critical path)
    
    // Sample rate for external API calls
    external_api_calls: 1.0, // 100% sampling (expensive operations)
  },

  // ============================================================================
  // 🚨 ALERT THRESHOLDS
  // Conditions that trigger operational alerts
  // ============================================================================
  alerts: {
    // Database connectivity failure duration (seconds)
    database_down_threshold_seconds: 30,
    
    // Error rate threshold (percentage)
    error_rate_threshold_percent: 5,
    
    // Error rate evaluation window (minutes)
    error_rate_window_minutes: 5,
    
    // HTTP response time p95 threshold (milliseconds)
    response_time_p95_threshold_ms: 3000,
    
    // Response time evaluation window (minutes)
    response_time_window_minutes: 5,
    
    // Queue processing latency threshold (minutes)
    queue_latency_threshold_minutes: 10,
    
    // Circuit breaker open duration threshold (minutes)
    circuit_breaker_open_threshold_minutes: 10,
    
    // Dead Letter Queue message count threshold
    dlq_message_threshold: 100,
    
    // R2 storage failure duration (minutes)
    r2_failure_threshold_minutes: 5,
    
    // Alert deduplication window (minutes)
    alert_deduplication_window_minutes: 15,
    
    // Maximum alerts per component per hour (rate limiting)
    max_alerts_per_hour: 10,
    
    // Alert escalation timeout (minutes)
    escalation_timeout_minutes: 10,
  },

  // ============================================================================
  // 🗄️ RETENTION PERIODS
  // Data retention policies for storage management
  // ============================================================================
  retention: {
    // Error logs retention (days)
    error_logs_days: 90,
    
    // Metrics summary retention (days)
    metrics_summary_days: 365,
    
    // Alert history retention (days)
    alert_history_days: 180,
    
    // Health check results retention (days)
    health_check_results_days: 30,
    
    // Cleanup job execution time (UTC hour)
    cleanup_hour_utc: 2,
  },

  // ============================================================================
  // 📈 DASHBOARD CONFIGURATION
  // Visual dashboard customization options
  // ============================================================================
  dashboard: {
    // Auto-refresh interval (seconds)
    auto_refresh_interval_seconds: 30,
    
    // Recent errors display count
    recent_errors_count: 10,
    
    // Default time range for metrics ('1h', '24h', '7d')
    default_time_range: '1h',
    
    // Enable authentication requirement
    require_authentication: true,
    
    // Dashboard page title
    page_title: 'OTIF Sentinel - Monitoring Dashboard',
    
    // Enable tenant filtering (for multi-tenant deployments)
    enable_tenant_filtering: true,
  },

  // ============================================================================
  // 🔧 OPERATIONAL SETTINGS
  // System behavior configuration
  // ============================================================================
  operational: {
    // Health check cache duration (seconds)
    health_check_cache_seconds: 10,
    
    // Database health check timeout (milliseconds)
    // Hyperdrive cold path puede superar 200ms; 200 generaba falsos "Query timeout".
    db_health_check_timeout_ms: 3000,
    
    // R2 health check timeout (milliseconds)
    r2_health_check_timeout_ms: 500,
    
    // Overall health check timeout (milliseconds)
    health_check_timeout_ms: 5000,
    
    // Monitoring operation timeout (milliseconds)
    monitoring_operation_timeout_ms: 1000,
    
    // Enable graceful degradation (fallback to console logging)
    enable_graceful_degradation: true,
    
    // Circuit breaker for monitoring operations
    monitoring_circuit_breaker: {
      failure_threshold: 5, // consecutive failures before opening
      reset_timeout_ms: 60000, // 1 minute
    },
    
    // Log sanitization patterns (regex patterns to redact)
    sanitization_patterns: [
      /\b\d{13,19}\b/g, // Credit card numbers
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // Email addresses
      /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, // Phone numbers (US format)
      /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi, // Bearer tokens
      /api[_-]?key[:\s]+[A-Za-z0-9\-._~+\/]+/gi, // API keys
    ],
    
    // HTTP headers to redact in logs
    sensitive_headers: [
      'authorization',
      'cookie',
      'x-api-key',
      'x-auth-token',
      'x-session-token',
    ],
  },

  // ============================================================================
  // 📏 METRICS CONFIGURATION
  // Performance metrics collection settings
  // ============================================================================
  metrics: {
    // Calculate percentiles in-memory (p50, p95, p99)
    calculate_percentiles: true,
    
    // Compress metrics after this duration (hours)
    compress_after_hours: 24,
    
    // Compression: store hourly aggregations instead of raw data
    hourly_aggregation_enabled: true,
    
    // Metric names to track
    metric_names: {
      http_request_duration: 'http.request.duration',
      http_request_count: 'http.request.count',
      http_error_rate: 'http.error.rate',
      db_query_duration: 'db.query.duration',
      queue_processing_latency: 'queue.processing.latency',
      queue_throughput: 'queue.throughput',
      circuit_breaker_activations: 'circuit_breaker.activations',
      dlq_message_count: 'dlq.message.count',
      external_api_duration: 'external.api.duration',
    },
  },

  // ============================================================================
  // 🔐 SECURITY CONFIGURATION
  // Access control and security settings
  // ============================================================================
  security: {
    // Health check endpoint rate limit (requests per minute per IP)
    health_check_rate_limit: 60,
    
    // Dashboard endpoint rate limit (requests per minute per IP)
    dashboard_rate_limit: 30,
    
    // Enable SQL injection prevention in dashboard filters
    enable_input_sanitization: true,
    
    // Content Security Policy for dashboard
    csp_header: "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    
    // Enable XSS protection headers
    enable_xss_protection: true,
  },

  // ============================================================================
  // 📌 SERVICE METADATA
  // System identification information
  // ============================================================================
  service: {
    name: 'otif-sentinel',
    version: '8.0.0',
    environment: 'production', // Override via env var if needed
  },
});

/**
 * Get monitoring configuration with environment variable overrides.
 *
 * Merges the static {@link MONITORING_CONFIG} defaults with values read from
 * Cloudflare Worker environment bindings, allowing operators to enable or
 * disable individual features without redeploying code.
 *
 * Supported environment variables:
 * | Variable                    | Type    | Default | Description                          |
 * |-----------------------------|---------|---------|--------------------------------------|
 * | `MONITORING_ENABLED`        | string  | `true`  | Master switch for entire system      |
 * | `MONITORING_ERROR_TRACKING` | string  | `true`  | Enable error capture to DB           |
 * | `MONITORING_METRICS`        | string  | `true`  | Enable metrics recording             |
 * | `MONITORING_ALERTING`       | string  | `true`  | Enable alert evaluation + history    |
 * | `MONITORING_SAMPLE_RATE`    | string  | `0.1`   | Fraction of HTTP requests sampled    |
 *
 * Set any variable to the string `'false'` to disable the feature. Any other
 * value (including omitting the variable) leaves the feature enabled.
 *
 * @param {Env} env - Cloudflare Worker environment bindings object
 * @returns {Object} - Merged configuration with env overrides applied
 *
 * @example
 * // In a Worker fetch handler:
 * import { getMonitoringConfig } from './monitoring/config.js';
 *
 * export default {
 *   fetch(request, env) {
 *     const config = getMonitoringConfig(env);
 *     if (!config.features.enabled) return originalHandler(request, env);
 *     // ... monitored handler
 *   }
 * };
 */
export function getMonitoringConfig(env) {
  // Allow environment variables to override config defaults
  return {
    ...MONITORING_CONFIG,
    features: {
      ...MONITORING_CONFIG.features,
      enabled: env.MONITORING_ENABLED !== 'false', // Default true
      error_tracking: env.MONITORING_ERROR_TRACKING !== 'false',
      metrics_collection: env.MONITORING_METRICS !== 'false',
      alerting: env.MONITORING_ALERTING !== 'false',
    },
    sampling: {
      ...MONITORING_CONFIG.sampling,
      successful_requests: parseFloat(env.MONITORING_SAMPLE_RATE || MONITORING_CONFIG.sampling.successful_requests),
    },
  };
}

/**
 * Validate the static monitoring configuration at startup.
 *
 * Checks that all sampling rates are within the valid range [0.0, 1.0] and that
 * percentage-based alert thresholds are within [0, 100]. Should be called once
 * during worker initialization (see {@link initializeMonitoring}).
 *
 * Acceptable ranges for key values:
 * - `sampling.*`                        — 0.0 to 1.0 (fraction of events captured)
 * - `alerts.error_rate_threshold_percent` — 0 to 100 (percentage)
 *
 * @returns {{ valid: boolean, errors: string[] }} Validation result.
 *   `valid` is `true` when no errors were found.
 *   `errors` is an empty array on success, or contains one message per violation.
 *
 * @example
 * import { validateMonitoringConfig } from './monitoring/config.js';
 *
 * const { valid, errors } = validateMonitoringConfig();
 * if (!valid) {
 *   console.error('Bad monitoring config:', errors);
 *   // Fail fast during development; degrade gracefully in production
 * }
 */
export function validateMonitoringConfig() {
  const errors = [];

  // Validate sampling rates
  Object.entries(MONITORING_CONFIG.sampling).forEach(([key, value]) => {
    if (value < 0 || value > 1) {
      errors.push(`Invalid sampling rate for ${key}: ${value} (must be 0.0-1.0)`);
    }
  });

  // Validate thresholds
  if (MONITORING_CONFIG.alerts.error_rate_threshold_percent < 0 || 
      MONITORING_CONFIG.alerts.error_rate_threshold_percent > 100) {
    errors.push('error_rate_threshold_percent must be 0-100');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
