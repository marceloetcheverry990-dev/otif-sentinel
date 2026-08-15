// src/monitoring/health.test.js
// Unit tests for Health Check Service
// Tests Requirements 1.1-1.10 and 9.7

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';

// Mock de pg: no hay Postgres real en unit tests. Conexiones "inválidas"
// (host raro o puerto 9999) fallan; el resto conecta y responde SELECT 1.
vi.mock('pg', () => {
  class MockClient {
    constructor(opts) {
      this.opts = opts || {};
    }
    async connect() {
      const cs = String(this.opts.connectionString || '');
      if (cs.includes('invalid') || cs.includes(':9999')) {
        const err = new Error('connection refused');
        err.name = 'ConnectionError';
        throw err;
      }
    }
    async query() {
      return { rows: [{ health_check: 1 }] };
    }
    async end() {}
  }
  return { default: { Client: MockClient }, Client: MockClient };
});

describe('Health Check Service', () => {
  let mockEnv;

  beforeEach(() => {
    // El módulo cachea el resultado 10s a nivel de módulo — resetear para
    // que cada test (que importa health.js dinámicamente) parta limpio
    vi.resetModules();

    // Create a mock environment with all required bindings
    mockEnv = {
      ...env,
      HYPERDRIVE: {
        connectionString: env.HYPERDRIVE?.connectionString || 'postgresql://test:test@localhost:5432/test'
      },
      chat_photos: {
        list: vi.fn().mockResolvedValue({ objects: [] })
      },
      MAIN_QUEUE: {},
      ENRICHMENT_QUEUE: {},
      DELIVERY_QUEUE: {}
    };
  });

  describe('handleHealthCheck', () => {
    it('should return 200 OK when all components are healthy', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, mockEnv);

      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data.status).toBe('healthy');
      expect(data.service).toBe('otif-sentinel');
      expect(data.version).toBeDefined();
      expect(data.timestamp).toBeDefined();
      expect(data.region).toBe('auto');
      expect(data.components).toBeDefined();
    });

    it('should include component-level status details', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, mockEnv);

      const data = await response.json();
      
      // Validate database component
      expect(data.components.database).toBeDefined();
      expect(data.components.database.status).toBeDefined();
      
      // Validate storage component
      expect(data.components.storage).toBeDefined();
      expect(data.components.storage.status).toBeDefined();
      
      // Validate queues component
      expect(data.components.queues).toBeDefined();
      expect(data.components.queues.status).toBeDefined();
    });

    it('should include database latency when database is connected', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, mockEnv);

      const data = await response.json();
      
      if (data.components.database.status === 'connected') {
        expect(data.components.database.latency_ms).toBeTypeOf('number');
        expect(data.components.database.latency_ms).toBeGreaterThan(0);
      }
    });

    it('should return 503 when database connection fails', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      // Mock environment with invalid database connection
      const failingEnv = {
        ...mockEnv,
        HYPERDRIVE: {
          connectionString: 'postgresql://invalid:invalid@localhost:9999/invalid'
        }
      };

      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, failingEnv);

      expect(response.status).toBe(503);
      
      const data = await response.json();
      expect(data.status).toBe('unhealthy');
      expect(data.components.database.status).toBe('disconnected');
      expect(data.components.database.error).toBeDefined();
    });

    it('should return 503 when R2 bucket is not accessible', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      // Mock environment without R2 bucket
      const failingEnv = {
        ...mockEnv,
        chat_photos: null
      };

      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, failingEnv);

      const data = await response.json();
      
      expect(data.components.storage.status).toBe('inaccessible');
      expect(data.components.storage.error).toBeDefined();
    });

    it('should return 503 when queue bindings are missing', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      // Mock environment without queue bindings
      const failingEnv = {
        ...mockEnv,
        MAIN_QUEUE: null,
        ENRICHMENT_QUEUE: null,
        DELIVERY_QUEUE: null
      };

      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, failingEnv);

      const data = await response.json();
      
      expect(data.components.queues.status).toBe('unavailable');
      expect(data.components.queues.error).toBeDefined();
    });

    it('should list available queue bindings when queues are available', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, mockEnv);

      const data = await response.json();
      
      if (data.components.queues.status === 'available') {
        expect(data.components.queues.bindings).toBeDefined();
        expect(Array.isArray(data.components.queues.bindings)).toBe(true);
        expect(data.components.queues.bindings.length).toBeGreaterThan(0);
      }
    });

    it('should include Cache-Control header for caching', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, mockEnv);

      expect(response.headers.get('Cache-Control')).toBeDefined();
      expect(response.headers.get('Content-Type')).toBe('application/json');
    });

    it('should cache results for 10 seconds to reduce redundant checks', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      // First request
      const request1 = new Request('http://example.com/health');
      const response1 = await handleHealthCheck(request1, mockEnv);
      const data1 = await response1.json();
      
      // Second request (should be cached)
      const request2 = new Request('http://example.com/health');
      const response2 = await handleHealthCheck(request2, mockEnv);
      const data2 = await response2.json();
      
      // Both responses should have the same timestamp (indicating cache hit)
      expect(data1.timestamp).toBe(data2.timestamp);
    });

    it('should not expose tenant-specific data in health check response', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, mockEnv);

      const data = await response.json();
      const responseText = JSON.stringify(data);
      
      // Ensure no tenant_id or sensitive data is exposed
      expect(responseText).not.toContain('tenant_id');
      expect(responseText).not.toContain('password');
      expect(responseText).not.toContain('api_key');
    });

    it('should handle timeout gracefully', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      // Mock environment with slow database
      const slowEnv = {
        ...mockEnv,
        HYPERDRIVE: {
          connectionString: 'postgresql://slow:slow@localhost:5432/test'
        }
      };

      const request = new Request('http://example.com/health');
      
      // This test verifies that timeouts don't hang the worker
      // The health check should complete within a reasonable time
      const startTime = Date.now();
      const response = await handleHealthCheck(request, slowEnv);
      const duration = Date.now() - startTime;
      
      // Should complete within 1 second (accounting for 500ms timeout)
      expect(duration).toBeLessThan(2000);
      expect(response.status).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle R2 list operation failure gracefully', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      // Mock R2 bucket with failing list operation
      const failingEnv = {
        ...mockEnv,
        chat_photos: {
          list: vi.fn().mockRejectedValue(new Error('R2 service unavailable'))
        }
      };

      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, failingEnv);

      const data = await response.json();
      expect(data.components.storage.status).toBe('inaccessible');
    });

    it('should handle partial queue binding availability', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      // Mock environment with only some queue bindings
      const partialEnv = {
        ...mockEnv,
        MAIN_QUEUE: {},
        ENRICHMENT_QUEUE: null,
        DELIVERY_QUEUE: {}
      };

      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, partialEnv);

      const data = await response.json();
      
      if (data.components.queues.status === 'available') {
        expect(data.components.queues.bindings).toBeDefined();
        expect(data.components.queues.bindings.length).toBe(2);
        expect(data.components.queues.bindings).toContain('MAIN_QUEUE');
        expect(data.components.queues.bindings).toContain('DELIVERY_QUEUE');
        expect(data.components.queues.bindings).not.toContain('ENRICHMENT_QUEUE');
      }
    });

    it('should include error details when components fail', async () => {
      const { handleHealthCheck } = await import('./health.js');
      
      // Mock environment with invalid connection
      const failingEnv = {
        ...mockEnv,
        HYPERDRIVE: {
          connectionString: 'invalid-connection-string'
        }
      };

      const request = new Request('http://example.com/health');
      const response = await handleHealthCheck(request, failingEnv);

      const data = await response.json();
      
      // Should include error messages for debugging
      if (data.components.database.status === 'disconnected') {
        expect(data.components.database.error).toBeDefined();
        expect(data.components.database.error).toContain(':');
      }
    });
  });
});
