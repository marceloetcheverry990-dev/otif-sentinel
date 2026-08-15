// src/monitoring/middleware.test.js
// Unit tests for request monitoring middleware

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withMonitoring, withQueueMonitoring, withScheduledMonitoring } from './middleware.js';
import * as metricsModule from './metrics.js';
import * as loggerModule from './logger.js';
import * as errorsModule from './errors.js';
import { MONITORING_CONFIG } from './config.js';

// Mock modules
vi.mock('./metrics.js', () => ({
  startTimer: vi.fn(),
  recordMetric: vi.fn(),
  METRIC_TYPES: {
    HTTP_REQUEST_DURATION: 'http.request.duration',
    HTTP_REQUEST_COUNT: 'http.request.count',
    HTTP_ERROR_RATE: 'http.error.rate',
    QUEUE_PROCESSING_LATENCY: 'queue.processing.latency',
    QUEUE_THROUGHPUT: 'queue.throughput',
  },
}));

vi.mock('./logger.js', () => ({
  createRequestLogger: vi.fn(),
}));

vi.mock('./errors.js', () => ({
  captureErrorAsync: vi.fn(),
}));

vi.mock('./config.js', () => {
  const MONITORING_CONFIG = {
    features: {
      enabled: true,
    },
    operational: {
      sensitive_headers: ['authorization', 'cookie', 'x-api-key'],
    },
  };
  return {
    MONITORING_CONFIG,
    getMonitoringConfig: (env = {}) => ({
      ...MONITORING_CONFIG,
      features: {
        ...MONITORING_CONFIG.features,
        enabled: env.MONITORING_ENABLED !== 'false' && MONITORING_CONFIG.features.enabled !== false,
      },
    }),
  };
});

describe('withMonitoring middleware', () => {
  let mockTimer;
  let mockLogger;
  let mockRequest;
  let mockEnv;
  let mockCtx;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Setup timer mock
    mockTimer = {
      stop: vi.fn(() => 250), // 250ms duration
    };
    metricsModule.startTimer.mockReturnValue(mockTimer);

    // Setup logger mock
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    loggerModule.createRequestLogger.mockReturnValue(mockLogger);

    // Setup request mock
    mockRequest = {
      method: 'POST',
      url: 'https://example.com/wms-webhook',
      headers: new Map([
        ['content-type', 'application/json'],
        ['authorization', 'Bearer secret-token'],
        ['user-agent', 'TestClient/1.0'],
      ]),
    };

    // Make headers iterable for sanitization
    mockRequest.headers.entries = function* () {
      yield ['content-type', 'application/json'];
      yield ['authorization', 'Bearer secret-token'];
      yield ['user-agent', 'TestClient/1.0'];
    };
    mockRequest.headers.get = (key) => {
      const map = {
        'content-type': 'application/json',
        'authorization': 'Bearer secret-token',
        'user-agent': 'TestClient/1.0',
        'x-tenant-id': null,
      };
      return map[key.toLowerCase()] || null;
    };

    // Setup env and ctx mocks
    mockEnv = {
      DB: {},
    };

    mockCtx = {
      waitUntil: vi.fn((promise) => promise), // Execute promise immediately for testing
    };

    // Mock crypto.randomUUID
    global.crypto = {
      randomUUID: vi.fn(() => 'test-trace-id-123'),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    MONITORING_CONFIG.features.enabled = true;
  });

  it('should wrap handler and log request start', async () => {
    const originalHandler = vi.fn(async () => new Response('OK', { status: 200 }));
    const wrappedHandler = withMonitoring(originalHandler, { component: 'wms-webhook' });

    await wrappedHandler(mockRequest, mockEnv, mockCtx);

    // Verify logger was created with trace_id
    expect(loggerModule.createRequestLogger).toHaveBeenCalledWith(
      'test-trace-id-123',
      expect.objectContaining({
        component: 'wms-webhook',
        endpoint: '/wms-webhook',
      })
    );

    // Verify request start was logged
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Request started',
      expect.objectContaining({
        method: 'POST',
        url: 'https://example.com/wms-webhook',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'authorization': '[REDACTED]', // Sensitive header redacted
        }),
      })
    );
  });

  it('should execute original handler', async () => {
    const originalHandler = vi.fn(async () => new Response('OK', { status: 200 }));
    const wrappedHandler = withMonitoring(originalHandler, { component: 'test' });

    const response = await wrappedHandler(mockRequest, mockEnv, mockCtx);

    expect(originalHandler).toHaveBeenCalledWith(mockRequest, mockEnv, mockCtx);
    expect(response.status).toBe(200);
  });

  it('should record metrics asynchronously using ctx.waitUntil', async () => {
    const originalHandler = vi.fn(async () => new Response('OK', { status: 200 }));
    const wrappedHandler = withMonitoring(originalHandler, { component: 'test' });

    await wrappedHandler(mockRequest, mockEnv, mockCtx);

    // Verify waitUntil was called
    expect(mockCtx.waitUntil).toHaveBeenCalled();

    // Verify metrics were recorded
    expect(metricsModule.recordMetric).toHaveBeenCalledWith(
      'http.request.duration',
      250,
      expect.objectContaining({
        endpoint: '/wms-webhook',
        status_code: 200,
        method: 'POST',
      }),
      mockEnv
    );

    expect(metricsModule.recordMetric).toHaveBeenCalledWith(
      'http.request.count',
      1,
      expect.any(Object),
      mockEnv
    );
  });

  it('should log request completion with duration', async () => {
    const originalHandler = vi.fn(async () => new Response('OK', { status: 200 }));
    const wrappedHandler = withMonitoring(originalHandler, { component: 'test' });

    await wrappedHandler(mockRequest, mockEnv, mockCtx);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Request completed',
      expect.objectContaining({
        status_code: 200,
        duration_ms: 250,
        had_error: false,
      })
    );
  });

  it('should handle errors and capture them', async () => {
    const testError = new Error('Test error');
    const originalHandler = vi.fn(async () => {
      throw testError;
    });
    const wrappedHandler = withMonitoring(originalHandler, { component: 'test' });

    await expect(wrappedHandler(mockRequest, mockEnv, mockCtx)).rejects.toThrow('Test error');

    // Verify error was logged
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Request handler error',
      expect.any(Object),
      testError
    );

    // Verify error was captured asynchronously
    expect(errorsModule.captureErrorAsync).toHaveBeenCalledWith(
      testError,
      expect.objectContaining({
        trace_id: 'test-trace-id-123',
        endpoint: '/wms-webhook',
        http_method: 'POST',
      }),
      mockCtx,
      mockEnv
    );

    // Verify error metrics were recorded
    expect(metricsModule.recordMetric).toHaveBeenCalledWith(
      'http.error.rate',
      1,
      expect.any(Object),
      mockEnv
    );
  });

  it('should record error metrics for 4xx responses', async () => {
    const originalHandler = vi.fn(async () => new Response('Bad Request', { status: 400 }));
    const wrappedHandler = withMonitoring(originalHandler, { component: 'test' });

    await wrappedHandler(mockRequest, mockEnv, mockCtx);

    // Wait for async operations to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    // Verify error rate metric was recorded for 4xx status
    expect(metricsModule.recordMetric).toHaveBeenCalledWith(
      'http.error.rate',
      1,
      expect.objectContaining({
        status_code: 400,
      }),
      mockEnv
    );
  });

  it('should skip instrumentation when monitoring disabled (runtime)', async () => {
    MONITORING_CONFIG.features.enabled = false;

    const originalHandler = vi.fn(async () => new Response('OK', { status: 200 }));
    const wrappedHandler = withMonitoring(originalHandler, { component: 'test' });

    await wrappedHandler(mockRequest, mockEnv, mockCtx);

    expect(originalHandler).toHaveBeenCalledWith(mockRequest, mockEnv, mockCtx);
    // Sin instrumentación: no logger de request started
    expect(loggerModule.createRequestLogger).not.toHaveBeenCalled();

    MONITORING_CONFIG.features.enabled = true;
  });

  it('should sanitize sensitive headers', async () => {
    const originalHandler = vi.fn(async () => new Response('OK'));
    const wrappedHandler = withMonitoring(originalHandler, { component: 'test' });

    await wrappedHandler(mockRequest, mockEnv, mockCtx);

    // Check that authorization header was redacted in log
    const logCall = mockLogger.info.mock.calls.find(call => call[0] === 'Request started');
    expect(logCall[1].headers['authorization']).toBe('[REDACTED]');
    expect(logCall[1].headers['content-type']).toBe('application/json');
  });
});

describe('withQueueMonitoring middleware', () => {
  let mockTimer;
  let mockLogger;
  let mockBatch;
  let mockEnv;
  let mockCtx;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTimer = {
      stop: vi.fn(() => 1500), // 1500ms duration
    };
    metricsModule.startTimer.mockReturnValue(mockTimer);

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    loggerModule.createRequestLogger.mockReturnValue(mockLogger);

    mockBatch = {
      messages: [
        { id: '1', body: 'message1' },
        { id: '2', body: 'message2' },
        { id: '3', body: 'message3' },
      ],
    };

    mockEnv = { DB: {} };
    mockCtx = {
      waitUntil: vi.fn((promise) => promise),
    };

    global.crypto = {
      randomUUID: vi.fn(() => 'queue-trace-id-456'),
    };
  });

  it('should wrap queue processor and log processing start', async () => {
    const originalProcessor = vi.fn(async () => {});
    const wrappedProcessor = withQueueMonitoring(originalProcessor, {
      queueName: 'MAIN_QUEUE',
      component: 'ingestion-processor',
    });

    await wrappedProcessor(mockBatch, mockEnv, mockCtx);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Queue processing started',
      expect.objectContaining({
        queue: 'MAIN_QUEUE',
        message_count: 3,
      })
    );
  });

  it('should record queue-specific metrics', async () => {
    const originalProcessor = vi.fn(async () => {});
    const wrappedProcessor = withQueueMonitoring(originalProcessor, {
      queueName: 'MAIN_QUEUE',
      component: 'ingestion-processor',
    });

    await wrappedProcessor(mockBatch, mockEnv, mockCtx);

    // Verify processing latency metric
    expect(metricsModule.recordMetric).toHaveBeenCalledWith(
      'queue.processing.latency',
      1500,
      expect.objectContaining({
        queue_name: 'MAIN_QUEUE',
      }),
      mockEnv
    );

    // Verify throughput metric (3 messages / 1500ms * 60000 = 120 msg/min)
    expect(metricsModule.recordMetric).toHaveBeenCalledWith(
      'queue.throughput',
      120,
      expect.objectContaining({
        queue_name: 'MAIN_QUEUE',
      }),
      mockEnv
    );
  });

  it('should handle queue processing errors', async () => {
    const testError = new Error('Queue processing error');
    const originalProcessor = vi.fn(async () => {
      throw testError;
    });
    const wrappedProcessor = withQueueMonitoring(originalProcessor, {
      queueName: 'ENRICHMENT_QUEUE',
      component: 'enrichment-processor',
    });

    await expect(wrappedProcessor(mockBatch, mockEnv, mockCtx)).rejects.toThrow(
      'Queue processing error'
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Queue processing error',
      expect.any(Object),
      testError
    );

    expect(errorsModule.captureErrorAsync).toHaveBeenCalledWith(
      testError,
      expect.objectContaining({
        queue: 'ENRICHMENT_QUEUE',
        message_count: 3,
      }),
      mockCtx,
      mockEnv
    );
  });
});

describe('withScheduledMonitoring middleware', () => {
  let mockTimer;
  let mockLogger;
  let mockEvent;
  let mockEnv;
  let mockCtx;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTimer = {
      stop: vi.fn(() => 3000), // 3000ms duration
    };
    metricsModule.startTimer.mockReturnValue(mockTimer);

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    loggerModule.createRequestLogger.mockReturnValue(mockLogger);

    mockEvent = {
      cron: '0 2 * * *',
    };

    mockEnv = { DB: {} };
    mockCtx = {
      waitUntil: vi.fn((promise) => promise),
    };

    global.crypto = {
      randomUUID: vi.fn(() => 'job-trace-id-789'),
    };
  });

  it('should wrap scheduled job and log start', async () => {
    const originalJob = vi.fn(async () => {});
    const wrappedJob = withScheduledMonitoring(originalJob, {
      jobName: 'outbox-recovery',
      component: 'scheduled-jobs',
    });

    await wrappedJob(mockEvent, mockEnv, mockCtx);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Scheduled job started',
      expect.objectContaining({
        job: 'outbox-recovery',
        cron: '0 2 * * *',
      })
    );
  });

  it('should record scheduled job metrics', async () => {
    const originalJob = vi.fn(async () => {});
    const wrappedJob = withScheduledMonitoring(originalJob, {
      jobName: 'outbox-recovery',
      component: 'scheduled-jobs',
    });

    await wrappedJob(mockEvent, mockEnv, mockCtx);

    expect(metricsModule.recordMetric).toHaveBeenCalledWith(
      'scheduled_job.duration',
      3000,
      expect.objectContaining({
        job_name: 'outbox-recovery',
      }),
      mockEnv
    );
  });

  it('should handle scheduled job errors', async () => {
    const testError = new Error('Job failed');
    const originalJob = vi.fn(async () => {
      throw testError;
    });
    const wrappedJob = withScheduledMonitoring(originalJob, {
      jobName: 'audit-fleet',
      component: 'scheduled-jobs',
    });

    await expect(wrappedJob(mockEvent, mockEnv, mockCtx)).rejects.toThrow('Job failed');

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Scheduled job error',
      expect.any(Object),
      testError
    );

    expect(metricsModule.recordMetric).toHaveBeenCalledWith(
      'scheduled_job.error',
      1,
      expect.objectContaining({
        job_name: 'audit-fleet',
      }),
      mockEnv
    );
  });
});
