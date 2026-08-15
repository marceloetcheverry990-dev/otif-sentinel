// src/monitoring/errors.test.js
// Unit tests for Error Tracking Module
// Requirements: 3.1-3.10, 10.2

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  captureError,
  generateErrorFingerprint,
  classifyErrorSeverity,
  sanitizeErrorMessage,
  getErrorStats,
  captureErrorAsync
} from './errors.js';

describe('Error Tracker Module', () => {
  describe('generateErrorFingerprint', () => {
    it('should generate consistent fingerprints for identical errors', () => {
      const error1 = new Error('Connection timeout after 5000ms');
      error1.name = 'TimeoutError';
      
      const error2 = new Error('Connection timeout after 5000ms');
      error2.name = 'TimeoutError';
      
      const fp1 = generateErrorFingerprint(error1);
      const fp2 = generateErrorFingerprint(error2);
      
      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[0-9a-f]{16}$/);
    });
    
    it('should generate different fingerprints for different error types', () => {
      const error1 = new Error('Connection failed');
      error1.name = 'NetworkError';
      
      const error2 = new Error('Connection failed');
      error2.name = 'DatabaseError';
      
      const fp1 = generateErrorFingerprint(error1);
      const fp2 = generateErrorFingerprint(error2);
      
      expect(fp1).not.toBe(fp2);
    });
    
    it('should normalize dynamic values in error messages', () => {
      const error1 = new Error('Query timeout after 5234ms');
      const error2 = new Error('Query timeout after 8912ms');
      
      const fp1 = generateErrorFingerprint(error1);
      const fp2 = generateErrorFingerprint(error2);
      
      // Should be the same because numbers are normalized to 'N'
      expect(fp1).toBe(fp2);
    });
    
    it('should handle errors without stack traces', () => {
      const error = { name: 'CustomError', message: 'Something went wrong' };
      const fp = generateErrorFingerprint(error);
      
      expect(fp).toBeDefined();
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    });
    
    it('should handle null or undefined errors gracefully', () => {
      const fp1 = generateErrorFingerprint(null);
      const fp2 = generateErrorFingerprint(undefined);
      
      expect(fp1).toBeDefined();
      expect(fp2).toBeDefined();
    });
  });
  
  describe('classifyErrorSeverity', () => {
    it('should classify system failures as CRITICAL', () => {
      const error1 = new Error('Worker exceeded CPU time limit');
      expect(classifyErrorSeverity(error1)).toBe('CRITICAL');
      
      const error2 = new Error('Memory limit exceeded');
      error2.name = 'OutOfMemoryError';
      expect(classifyErrorSeverity(error2)).toBe('CRITICAL');
      
      const error3 = new Error('Fatal error in worker');
      expect(classifyErrorSeverity(error3)).toBe('CRITICAL');
    });
    
    it('should classify validation errors as INFO', () => {
      const error1 = new Error('Validation failed for field email');
      error1.name = 'ValidationError';
      expect(classifyErrorSeverity(error1)).toBe('INFO');
      
      const error2 = new Error('Invalid input provided');
      expect(classifyErrorSeverity(error2)).toBe('INFO');
      
      const error3 = new Error('Required field missing');
      error3.name = 'ZodError';
      expect(classifyErrorSeverity(error3)).toBe('INFO');
    });
    
    it('should classify recoverable errors as WARN', () => {
      const error1 = new Error('Rate limit exceeded, retrying after backoff');
      expect(classifyErrorSeverity(error1)).toBe('WARN');
      
      const error2 = new Error('Temporary connection issue');
      expect(classifyErrorSeverity(error2)).toBe('WARN');
      
      const error3 = new Error('Retry attempt 3 of 5');
      error3.name = 'RetryError';
      expect(classifyErrorSeverity(error3)).toBe('WARN');
    });
    
    it('should classify operation failures as ERROR by default', () => {
      const error1 = new Error('Database query timeout');
      error1.name = 'TimeoutError';
      expect(classifyErrorSeverity(error1)).toBe('ERROR');
      
      const error2 = new Error('Connection refused');
      error2.name = 'NetworkError';
      expect(classifyErrorSeverity(error2)).toBe('ERROR');
      
      const error3 = new Error('Unknown error occurred');
      expect(classifyErrorSeverity(error3)).toBe('ERROR');
    });
  });
  
  describe('sanitizeErrorMessage', () => {
    it('should redact credit card numbers', () => {
      const message = 'Payment failed for card 4532123456789012';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('4532123456789012');
    });
    
    it('should redact email addresses', () => {
      const message = 'Failed to send email to user@example.com';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('user@example.com');
    });
    
    it('should redact phone numbers', () => {
      const message = 'SMS delivery failed to 555-123-4567';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('555-123-4567');
    });
    
    it('should redact Bearer tokens', () => {
      const message = 'Authorization failed: Bearer abc123xyz456token';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('abc123xyz456token');
    });
    
    it('should redact API keys', () => {
      const message = 'API request failed with api_key: sk_live_abc123xyz';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('sk_live_abc123xyz');
    });
    
    it('should redact passwords', () => {
      const message = 'Authentication failed: password=secret123';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('secret123');
    });
    
    it('should redact authorization headers', () => {
      const message = 'Request failed with authorization: Bearer token123';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('token123');
    });
    
    it('should handle messages without sensitive data', () => {
      const message = 'Connection timeout after 5000ms';
      const sanitized = sanitizeErrorMessage(message);
      
      expect(sanitized).toBe(message);
    });
    
    it('should handle empty or null messages', () => {
      expect(sanitizeErrorMessage('')).toBe('');
      expect(sanitizeErrorMessage(null)).toBe('');
      expect(sanitizeErrorMessage(undefined)).toBe('');
    });
  });
  
  describe('captureError', () => {
    let mockDbClient;
    
    beforeEach(() => {
      mockDbClient = {
        query: vi.fn().mockResolvedValue({ rows: [] })
      };
    });
    
    it('should capture error with full context', async () => {
      const error = new Error('Test error');
      error.name = 'TestError';
      
      const context = {
        trace_id: 'trace_123',
        tenant_id: 'tenant_abc',
        endpoint: '/api/test',
        http_method: 'POST',
        ot_id: 'OT-12345',
        queue: 'MAIN_QUEUE',
        retry_count: 2
      };
      
      const fingerprint = await captureError(error, context, mockDbClient);
      
      expect(fingerprint).toBeDefined();
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(mockDbClient.query).toHaveBeenCalledOnce();
      
      const [query, values] = mockDbClient.query.mock.calls[0];
      expect(query).toContain('INSERT INTO error_logs');
      expect(values[0]).toBe('ERROR'); // severity
      expect(values[1]).toBe('TestError'); // error_type
      expect(values[2]).toContain('Test error'); // error_message
      expect(values[5]).toBe('trace_123'); // trace_id
      expect(values[6]).toBe('tenant_abc'); // tenant_id
      expect(values[7]).toBe('/api/test'); // endpoint
      expect(values[8]).toBe('POST'); // http_method
    });
    
    it('should sanitize error message before storage', async () => {
      const error = new Error('Error with card 4532123456789012');
      
      const context = { trace_id: 'trace_123' };
      
      await captureError(error, context, mockDbClient);
      
      const [, values] = mockDbClient.query.mock.calls[0];
      const errorMessage = values[2];
      
      expect(errorMessage).toContain('[REDACTED]');
      expect(errorMessage).not.toContain('4532123456789012');
    });
    
    it('should include context metadata as JSONB', async () => {
      const error = new Error('Test error');
      
      const context = {
        trace_id: 'trace_123',
        custom_field: 'custom_value',
        additional_data: { nested: true }
      };
      
      await captureError(error, context, mockDbClient);
      
      const [, values] = mockDbClient.query.mock.calls[0];
      const metadata = JSON.parse(values[9]);
      
      expect(metadata.custom_field).toBe('custom_value');
      expect(metadata.additional_data).toEqual({ nested: true });
    });
    
    it('should handle errors without dbClient gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      const error = new Error('Test error');
      const context = { trace_id: 'trace_123' };
      
      const fingerprint = await captureError(error, context, null);
      
      expect(fingerprint).toBeDefined();
      expect(consoleSpy).toHaveBeenCalled();
      
      consoleSpy.mockRestore();
    });
    
    it('should not crash on database errors (fail-safe)', async () => {
      mockDbClient.query.mockRejectedValue(new Error('Database connection failed'));
      
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      const error = new Error('Test error');
      const context = { trace_id: 'trace_123' };
      
      const fingerprint = await captureError(error, context, mockDbClient);
      
      expect(fingerprint).toBe('capture-failed');
      expect(consoleSpy).toHaveBeenCalled();
      
      consoleSpy.mockRestore();
    });
  });
  
  describe('captureErrorAsync', () => {
    it('should return fingerprint synchronously', () => {
      const error = new Error('Test error');
      const context = { trace_id: 'trace_123' };
      
      const mockCtx = {
        waitUntil: vi.fn()
      };
      
      const mockEnv = {};
      
      const fingerprint = captureErrorAsync(error, context, mockCtx, mockEnv);
      
      expect(fingerprint).toBeDefined();
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(mockCtx.waitUntil).toHaveBeenCalledOnce();
    });
    
    it('should use ctx.waitUntil for async persistence', () => {
      const error = new Error('Test error');
      const context = { trace_id: 'trace_123' };
      
      const mockCtx = {
        waitUntil: vi.fn()
      };
      
      const mockEnv = {};
      
      captureErrorAsync(error, context, mockCtx, mockEnv);
      
      expect(mockCtx.waitUntil).toHaveBeenCalledOnce();
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      expect(waitUntilPromise).toBeInstanceOf(Promise);
    });
  });
  
  describe('getErrorStats', () => {
    let mockEnv;
    
    beforeEach(() => {
      mockEnv = {
        HYPERDRIVE: {
          connectionString: 'postgresql://mock'
        }
      };
    });
    
    it('should return empty array on database failure (fail-safe)', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      const filters = { timeRange: '1h' };
      // env sin HYPERDRIVE: DB_OPTS lanza antes de abrir sockets — fail-safe puro
      const result = await getErrorStats(filters, {});
      
      expect(result).toEqual([]);
      
      consoleSpy.mockRestore();
    });
  });
  
  describe('Error Fingerprint Consistency', () => {
    it('should group similar errors with different dynamic values', () => {
      const errors = [
        new Error('Query timeout after 1234ms'),
        new Error('Query timeout after 5678ms'),
        new Error('Query timeout after 9012ms')
      ];
      
      const fingerprints = errors.map(generateErrorFingerprint);
      
      // All should have the same fingerprint
      expect(fingerprints[0]).toBe(fingerprints[1]);
      expect(fingerprints[1]).toBe(fingerprints[2]);
    });
    
    it('should differentiate errors from different code locations', () => {
      const error1 = new Error('Connection failed');
      const error2 = new Error('Connection failed');
      
      // Simulate different stack traces (different locations)
      error1.stack = 'Error: Connection failed\n    at functionA (file1.js:10)\n    at handlerA (file2.js:20)';
      error2.stack = 'Error: Connection failed\n    at functionB (file3.js:30)\n    at handlerB (file4.js:40)';
      
      const fp1 = generateErrorFingerprint(error1);
      const fp2 = generateErrorFingerprint(error2);
      
      expect(fp1).not.toBe(fp2);
    });
  });
  
  describe('Integration: Full Error Capture Flow', () => {
    it('should complete full error capture workflow', async () => {
      const mockDbClient = {
        query: vi.fn().mockResolvedValue({ rows: [] })
      };
      
      // Simulate a real error scenario
      const error = new Error('Database query timeout after 5000ms');
      error.name = 'TimeoutError';
      error.stack = 'TimeoutError: Database query timeout\n    at executeQuery (db.js:45)\n    at processQueue (queue.js:123)';
      
      const context = {
        trace_id: 'req_abc123',
        tenant_id: 'acme-corp',
        endpoint: '/wms-webhook',
        http_method: 'POST',
        ot_id: 'OT-67890',
        queue: 'ENRICHMENT_QUEUE',
        retry_count: 3
      };
      
      const fingerprint = await captureError(error, context, mockDbClient);
      
      // Verify fingerprint generation
      expect(fingerprint).toBeDefined();
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
      
      // Verify database persistence was called
      expect(mockDbClient.query).toHaveBeenCalledOnce();
      
      // Verify query structure
      const [query, values] = mockDbClient.query.mock.calls[0];
      expect(query).toContain('INSERT INTO error_logs');
      expect(query).toContain('severity');
      expect(query).toContain('error_fingerprint');
      expect(query).toContain('context_metadata');
      
      // Verify severity classification
      expect(values[0]).toBe('ERROR');
      
      // Verify all context fields preserved
      expect(values[5]).toBe('req_abc123');
      expect(values[6]).toBe('acme-corp');
      expect(values[7]).toBe('/wms-webhook');
      
      // Verify context metadata
      const metadata = JSON.parse(values[9]);
      expect(metadata.ot_id).toBe('OT-67890');
      expect(metadata.queue).toBe('ENRICHMENT_QUEUE');
      expect(metadata.retry_count).toBe(3);
    });
  });
  
  describe('Edge Cases', () => {
    it('should handle circular references in context', async () => {
      const mockDbClient = {
        query: vi.fn().mockResolvedValue({ rows: [] })
      };
      
      const error = new Error('Test error');
      
      // Create circular reference
      const context = {
        trace_id: 'trace_123',
        data: {}
      };
      context.data.self = context;
      
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // Should not crash
      await captureError(error, context, mockDbClient);
      
      consoleSpy.mockRestore();
    });
    
    it('should handle very long error messages', async () => {
      const mockDbClient = {
        query: vi.fn().mockResolvedValue({ rows: [] })
      };
      
      const longMessage = 'Error: ' + 'x'.repeat(10000);
      const error = new Error(longMessage);
      
      const fingerprint = await captureError(error, {}, mockDbClient);
      
      expect(fingerprint).toBeDefined();
      expect(mockDbClient.query).toHaveBeenCalled();
    });
    
    it('should handle errors with no message', async () => {
      const mockDbClient = {
        query: vi.fn().mockResolvedValue({ rows: [] })
      };
      
      const error = new Error();
      
      const fingerprint = await captureError(error, {}, mockDbClient);
      
      expect(fingerprint).toBeDefined();
      expect(mockDbClient.query).toHaveBeenCalled();
    });
  });
});
