import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Logger,
  createRequestLogger,
  sanitizeLogContext,
  startTimer,
  withLogging,
  LogLevel,
} from '../../src/monitoring/logger.js';

describe('Structured Logger', () => {
  let consoleLogSpy;

  beforeEach(() => {
    // Spy on console.log to capture structured log output
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore console.log after each test
    consoleLogSpy.mockRestore();
  });

  describe('Logger.info()', () => {
    it('should output JSON formatted log with required fields', () => {
      Logger.info('Test message', { tenant_id: 'test-tenant' });

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logOutput = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logOutput);

      // Validate required fields (Requirement 2.2)
      expect(logEntry.timestamp).toBeDefined();
      expect(logEntry.level).toBe('INFO');
      expect(logEntry.message).toBe('Test message');
      expect(logEntry.service).toBe('otif-sentinel');
      expect(logEntry.context.tenant_id).toBe('test-tenant');
    });

    it('should include trace_id when provided', () => {
      Logger.info('Test message', { trace_id: 'req_abc123' });

      const logOutput = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logOutput);

      expect(logEntry.trace_id).toBe('req_abc123');
    });

    it('should include component when provided', () => {
      Logger.info('Test message', { component: 'wms-webhook' });

      const logOutput = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logOutput);

      expect(logEntry.component).toBe('wms-webhook');
    });
  });

  describe('Logger severity levels', () => {
    it('should support DEBUG level', () => {
      Logger.debug('Debug message', {});
      
      const logOutput = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logOutput);
      
      expect(logEntry.level).toBe('DEBUG');
    });

    it('should support WARN level', () => {
      Logger.warn('Warning message', {});
      
      const logOutput = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logOutput);
      
      expect(logEntry.level).toBe('WARN');
    });

    it('should support ERROR level with error object', () => {
      const testError = new Error('Test error');
      Logger.error('Error occurred', {}, testError);
      
      const logOutput = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logOutput);
      
      expect(logEntry.level).toBe('ERROR');
      expect(logEntry.error).toBeDefined();
      expect(logEntry.error.type).toBe('Error');
      expect(logEntry.error.message).toBe('Test error');
      expect(logEntry.error.stack).toBeDefined();
    });

    it('should support CRITICAL level', () => {
      const testError = new Error('Critical failure');
      Logger.critical('System failure', {}, testError);
      
      const logOutput = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logOutput);
      
      expect(logEntry.level).toBe('CRITICAL');
      expect(logEntry.error).toBeDefined();
    });
  });

  describe('sanitizeLogContext()', () => {
    it('should redact Authorization header', () => {
      const context = {
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        },
      };

      const sanitized = sanitizeLogContext(context);

      expect(sanitized.headers.authorization).toBe('[REDACTED]');
      expect(sanitized.headers['content-type']).toBe('application/json');
    });

    it('should redact Cookie header', () => {
      const context = {
        headers: {
          cookie: 'session=abc123',
        },
      };

      const sanitized = sanitizeLogContext(context);

      expect(sanitized.headers.cookie).toBe('[REDACTED]');
    });

    it('should mask credit card numbers', () => {
      const context = {
        message: 'Payment with card 4532015112830366 processed',
      };

      const sanitized = sanitizeLogContext(context);

      expect(sanitized.message).toContain('[CARD-REDACTED]');
      expect(sanitized.message).not.toContain('4532015112830366');
    });

    it('should remove email addresses', () => {
      const context = {
        message: 'Contact user@example.com for details',
      };

      const sanitized = sanitizeLogContext(context);

      expect(sanitized.message).toContain('[EMAIL-REDACTED]');
      expect(sanitized.message).not.toContain('user@example.com');
    });

    it('should remove phone numbers', () => {
      const context = {
        message: 'Call 555-123-4567 for support',
      };

      const sanitized = sanitizeLogContext(context);

      expect(sanitized.message).toContain('[PHONE-REDACTED]');
      expect(sanitized.message).not.toContain('555-123-4567');
    });

    it('should escape control characters', () => {
      const context = {
        message: 'Line1\nLine2\rLine3',
      };

      const sanitized = sanitizeLogContext(context);

      expect(sanitized.message).not.toContain('\n');
      expect(sanitized.message).toContain('\\x0a'); // newline
    });

    it('should redact password fields', () => {
      const context = {
        user_password: 'secret123',
        username: 'testuser',
      };

      const sanitized = sanitizeLogContext(context);

      expect(sanitized.user_password).toBe('[REDACTED]');
      expect(sanitized.username).toBe('testuser');
    });

    it('should handle nested objects', () => {
      const context = {
        request: {
          headers: {
            authorization: 'Bearer token',
          },
          body: {
            email: 'user@test.com',
          },
        },
      };

      const sanitized = sanitizeLogContext(context);

      expect(sanitized.request.headers.authorization).toBe('[REDACTED]');
      expect(sanitized.request.body.email).toContain('[EMAIL-REDACTED]');
    });
  });

  describe('createRequestLogger()', () => {
    it('should create logger with trace_id in all logs', () => {
      const requestLogger = createRequestLogger('req_xyz789', { tenant_id: 'acme' });

      requestLogger.info('Test message', {});

      const logOutput = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logOutput);

      expect(logEntry.trace_id).toBe('req_xyz789');
      expect(logEntry.context.tenant_id).toBe('acme');
    });

    it('should merge additional context with base context', () => {
      const requestLogger = createRequestLogger('req_123', { tenant_id: 'acme' });

      requestLogger.info('Test', { ot_id: 'OT-12345' });

      const logOutput = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logOutput);

      expect(logEntry.trace_id).toBe('req_123');
      expect(logEntry.context.tenant_id).toBe('acme');
      expect(logEntry.context.ot_id).toBe('OT-12345');
    });

    it('should provide timer functionality', () => {
      const requestLogger = createRequestLogger('req_timer');

      const timer = requestLogger.startTimer();
      const duration = timer.stop();

      expect(duration).toBeGreaterThanOrEqual(0);
      expect(typeof duration).toBe('number');
    });

    it('should log with duration using stopAndLog', () => {
      const requestLogger = createRequestLogger('req_timer');

      const timer = requestLogger.startTimer();
      timer.stopAndLog('info', 'Operation completed', { operation: 'test' });

      const logOutput = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logOutput);

      expect(logEntry.duration_ms).toBeDefined();
      expect(logEntry.duration_ms).toBeGreaterThanOrEqual(0);
      expect(logEntry.message).toBe('Operation completed');
    });
  });

  describe('startTimer()', () => {
    it('should measure operation duration', async () => {
      const timer = startTimer();
      
      // Simulate some work
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const duration = timer.stop();

      expect(duration).toBeGreaterThanOrEqual(10);
      expect(typeof duration).toBe('number');
    });
  });

  describe('withLogging()', () => {
    it('should wrap handler and log start/completion', async () => {
      const mockHandler = async (request) => {
        return new Response('OK');
      };

      const wrappedHandler = withLogging(mockHandler, { component: 'test-handler' });
      const request = new Request('http://example.com');

      await wrappedHandler(request);

      // Should have 2 logs: start and completion
      expect(consoleLogSpy).toHaveBeenCalledTimes(2);

      const startLog = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      const endLog = JSON.parse(consoleLogSpy.mock.calls[1][0]);

      expect(startLog.message).toBe('Handler started');
      expect(startLog.component).toBe('test-handler');

      expect(endLog.message).toBe('Handler completed');
      expect(endLog.duration_ms).toBeDefined();
    });

    it('should log errors when handler throws', async () => {
      const mockHandler = async () => {
        throw new Error('Handler failed');
      };

      const wrappedHandler = withLogging(mockHandler, { component: 'failing-handler' });

      await expect(wrappedHandler()).rejects.toThrow('Handler failed');

      // Should have 2 logs: start and error
      expect(consoleLogSpy).toHaveBeenCalledTimes(2);

      const errorLog = JSON.parse(consoleLogSpy.mock.calls[1][0]);

      expect(errorLog.message).toBe('Handler failed');
      expect(errorLog.level).toBe('ERROR');
      expect(errorLog.error).toBeDefined();
      expect(errorLog.duration_ms).toBeDefined();
    });
  });

  describe('LogLevel constants', () => {
    it('should export all log levels', () => {
      expect(LogLevel.DEBUG).toBe('DEBUG');
      expect(LogLevel.INFO).toBe('INFO');
      expect(LogLevel.WARN).toBe('WARN');
      expect(LogLevel.ERROR).toBe('ERROR');
      expect(LogLevel.CRITICAL).toBe('CRITICAL');
    });
  });

  describe('ISO 8601 timestamp format', () => {
    it('should produce ISO 8601 formatted timestamp', () => {
      Logger.info('Test', {});

      const logOutput = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logOutput);

      // Validate ISO 8601 format
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(logEntry.timestamp).toMatch(isoRegex);
    });
  });
});
