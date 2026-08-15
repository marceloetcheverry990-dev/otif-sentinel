// src/monitoring/logger.js
// Structured Logger Implementation
// Provides consistent, machine-parsable JSON logs with severity levels and contextual metadata

import { MONITORING_CONFIG } from './config.js';

/**
 * Log Severity Levels
 * Aligned with standard logging practices and operational requirements
 */
export const LogLevel = Object.freeze({
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
});

/**
 * Sanitize log context to remove sensitive data
 * Implements security requirement 10.2, 10.3, and 10.8
 * 
 * @param {Object} context - Raw context object
 * @returns {Object} - Sanitized context object
 */
export function sanitizeLogContext(context) {
  if (!context || typeof context !== 'object') {
    return context;
  }

  // Deep clone to avoid mutating original object
  const sanitized = JSON.parse(JSON.stringify(context));

  /**
   * Sanitize object recursively
   * @param {Object} obj - Object to sanitize
   */
  function sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object') {
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();

      // Redact sensitive headers (Requirement 10.8)
      if (MONITORING_CONFIG.operational.sensitive_headers.includes(lowerKey)) {
        obj[key] = '[REDACTED]';
        continue;
      }

      // Redact common sensitive field names
      if (
        lowerKey.includes('password') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('api_key') ||
        lowerKey.includes('apikey') ||
        lowerKey.includes('auth')
      ) {
        obj[key] = '[REDACTED]';
        continue;
      }

      // If value is string, apply pattern-based sanitization (Requirement 10.2)
      if (typeof value === 'string') {
        let sanitizedValue = value;

        // Mask credit card numbers (13-19 digits)
        sanitizedValue = sanitizedValue.replace(/\b\d{13,19}\b/g, '[CARD-REDACTED]');

        // Remove email addresses
        sanitizedValue = sanitizedValue.replace(
          /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
          '[EMAIL-REDACTED]'
        );

        // Remove phone numbers (US format)
        sanitizedValue = sanitizedValue.replace(
          /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
          '[PHONE-REDACTED]'
        );

        // Escape control characters to prevent log injection (Requirement 10.3)
        sanitizedValue = sanitizedValue.replace(/[\x00-\x1F\x7F]/g, (char) => {
          return '\\x' + char.charCodeAt(0).toString(16).padStart(2, '0');
        });

        obj[key] = sanitizedValue;
      } else if (typeof value === 'object' && value !== null) {
        // Recursively sanitize nested objects
        sanitizeObject(value);
      }
    }
  }

  sanitizeObject(sanitized);
  return sanitized;
}

/**
 * Format error object for logging
 * @param {Error} error - Error instance
 * @returns {Object} - Formatted error details
 */
function formatError(error) {
  if (!error) {
    return null;
  }

  return {
    type: error.name || 'Error',
    message: error.message || 'Unknown error',
    stack: error.stack || null,
    code: error.code || null,
  };
}

/**
 * Create structured log entry
 * Implements requirements 2.1-2.7 and 2.10
 * 
 * @param {string} level - Log severity level
 * @param {string} message - Log message
 * @param {Object} context - Contextual metadata
 * @param {Error} error - Optional error object
 * @param {number} duration - Optional operation duration in milliseconds
 * @returns {Object} - Structured log entry
 */
function createLogEntry(level, message, context = {}, error = null, duration = null) {
  const entry = {
    // Mandatory fields (Requirement 2.2)
    timestamp: new Date().toISOString(), // ISO 8601 format
    level: level,
    message: message,
    service: MONITORING_CONFIG.service.name,
  };

  // Add trace_id if available (Requirement 2.2)
  if (context.trace_id) {
    entry.trace_id = context.trace_id;
  }

  // Add component if specified
  if (context.component) {
    entry.component = context.component;
  }

  // Sanitize and add remaining context (Requirement 2.6)
  // duration_ms se eleva a campo de primer nivel (Requirement 2.10)
  const { trace_id, component, duration_ms, ...restContext } = context;
  if (Object.keys(restContext).length > 0) {
    entry.context = sanitizeLogContext(restContext);
  }

  // Add error details if present (Requirement 2.5)
  if (error) {
    entry.error = formatError(error);
  }

  // Add duration for performance tracking (Requirement 2.10)
  const effectiveDuration = duration ?? duration_ms;
  if (effectiveDuration !== null && effectiveDuration !== undefined) {
    entry.duration_ms = effectiveDuration;
  }

  return entry;
}

/**
 * Write log entry to console
 * Integrates with Cloudflare Workers console (Requirement 2.7)
 * 
 * @param {Object} entry - Structured log entry
 */
function writeLog(entry) {
  // Output as JSON string for machine parsing (Requirement 2.1)
  const logString = JSON.stringify(entry);

  // Use appropriate console method based on severity
  switch (entry.level) {
    case LogLevel.DEBUG:
      console.log(logString);
      break;
    case LogLevel.INFO:
      console.log(logString);
      break;
    case LogLevel.WARN:
      console.log(logString);
      break;
    case LogLevel.ERROR:
      console.log(logString);
      break;
    case LogLevel.CRITICAL:
      console.log(logString);
      break;
    default:
      console.log(logString);
  }
}

/**
 * Structured Logger Instance
 * Main logger object with severity-based methods (Requirement 2.3)
 */
export const Logger = Object.freeze({
  /**
   * Log debug message
   * @param {string} message - Log message
   * @param {Object} context - Optional contextual metadata
   */
  debug(message, context = {}) {
    if (!MONITORING_CONFIG.features.structured_logging) {
      return;
    }
    const entry = createLogEntry(LogLevel.DEBUG, message, context);
    writeLog(entry);
  },

  /**
   * Log informational message
   * @param {string} message - Log message
   * @param {Object} context - Optional contextual metadata
   */
  info(message, context = {}) {
    if (!MONITORING_CONFIG.features.structured_logging) {
      return;
    }
    const entry = createLogEntry(LogLevel.INFO, message, context);
    writeLog(entry);
  },

  /**
   * Log warning message
   * @param {string} message - Log message
   * @param {Object} context - Optional contextual metadata
   */
  warn(message, context = {}) {
    if (!MONITORING_CONFIG.features.structured_logging) {
      return;
    }
    const entry = createLogEntry(LogLevel.WARN, message, context);
    writeLog(entry);
  },

  /**
   * Log error message
   * @param {string} message - Log message
   * @param {Object} context - Optional contextual metadata
   * @param {Error} error - Optional error object
   */
  error(message, context = {}, error = null) {
    if (!MONITORING_CONFIG.features.structured_logging) {
      return;
    }
    const entry = createLogEntry(LogLevel.ERROR, message, context, error);
    writeLog(entry);
  },

  /**
   * Log critical error message
   * @param {string} message - Log message
   * @param {Object} context - Optional contextual metadata
   * @param {Error} error - Optional error object
   */
  critical(message, context = {}, error = null) {
    if (!MONITORING_CONFIG.features.structured_logging) {
      return;
    }
    const entry = createLogEntry(LogLevel.CRITICAL, message, context, error);
    writeLog(entry);
  },
});

/**
 * Create request-scoped logger with trace_id and base context
 * Useful for maintaining correlation across request lifecycle (Requirement 2.2)
 * 
 * @param {string} traceId - Correlation ID for request tracking
 * @param {Object} baseContext - Base context applied to all logs (tenant_id, etc.)
 * @returns {Object} - Scoped logger instance with same methods as Logger
 * 
 * @example
 * const requestLogger = createRequestLogger('req_abc123', { tenant_id: 'acme-corp' });
 * requestLogger.info('Processing webhook', { ot_id: 'OT-12345' });
 * // Output includes trace_id and tenant_id automatically
 */
export function createRequestLogger(traceId, baseContext = {}) {
  // Merge trace_id with base context
  const mergedBaseContext = {
    trace_id: traceId,
    ...baseContext,
  };

  // Return logger instance with base context pre-applied
  return Object.freeze({
    debug(message, context = {}) {
      Logger.debug(message, { ...mergedBaseContext, ...context });
    },

    info(message, context = {}) {
      Logger.info(message, { ...mergedBaseContext, ...context });
    },

    warn(message, context = {}) {
      Logger.warn(message, { ...mergedBaseContext, ...context });
    },

    error(message, context = {}, error = null) {
      Logger.error(message, { ...mergedBaseContext, ...context }, error);
    },

    critical(message, context = {}, error = null) {
      Logger.critical(message, { ...mergedBaseContext, ...context }, error);
    },

    // Provide method to measure and log operation duration (Requirement 2.10)
    /**
     * Create timer for measuring operation duration
     * @returns {Object} - Timer object with stop() method
     */
    startTimer() {
      const startTime = Date.now();
      return {
        /**
         * Stop timer and return duration
         * @returns {number} - Duration in milliseconds
         */
        stop() {
          return Date.now() - startTime;
        },

        /**
         * Stop timer and log with message
         * @param {string} level - Log level (debug/info/warn/error/critical)
         * @param {string} message - Log message
         * @param {Object} context - Additional context
         */
        stopAndLog(level, message, context = {}) {
          const duration = Date.now() - startTime;
          const entry = createLogEntry(
            level.toUpperCase(),
            message,
            { ...mergedBaseContext, ...context },
            null,
            duration
          );
          writeLog(entry);
        },
      };
    },
  });
}

/**
 * Timer utility for measuring operation duration (Requirement 2.10)
 * Standalone version without request context
 * 
 * @returns {Object} - Timer object with stop() method
 * 
 * @example
 * const timer = startTimer();
 * await someOperation();
 * const durationMs = timer.stop();
 * Logger.info('Operation completed', { duration_ms: durationMs });
 */
export function startTimer() {
  const startTime = Date.now();
  return {
    /**
     * Stop timer and return duration in milliseconds
     * @returns {number} - Duration in milliseconds
     */
    stop() {
      return Date.now() - startTime;
    },
  };
}

/**
 * Middleware wrapper that logs request start and completion
 * Useful for HTTP handlers and queue processors
 * 
 * @param {Function} handler - Original handler function
 * @param {Object} config - Configuration { component: string }
 * @returns {Function} - Wrapped handler with logging
 * 
 * @example
 * export const myHandler = withLogging(async (request, env) => {
 *   // handler logic
 * }, { component: 'wms-webhook' });
 */
export function withLogging(handler, config = {}) {
  return async function wrappedHandler(...args) {
    const traceId = crypto.randomUUID();
    const logger = createRequestLogger(traceId, {
      component: config.component || 'unknown',
    });

    logger.info('Handler started', {});
    const timer = startTimer();

    try {
      const result = await handler(...args);
      const duration = timer.stop();
      logger.info('Handler completed', { duration_ms: duration });
      return result;
    } catch (error) {
      const duration = timer.stop();
      logger.error('Handler failed', { duration_ms: duration }, error);
      throw error;
    }
  };
}
