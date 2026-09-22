/**
 * Smoke: los consumers de cola deben poder construirse sin ReferenceError
 * (B-1: Client de pg debe estar importado en queues.js).
 */
import { describe, it, expect, vi } from 'vitest';
import queuesSource from './queues.js?raw';

vi.mock('./monitoring/queue-middleware.js', () => ({
  withQueueMonitoring: (fn) => fn,
}));

vi.mock('./ai.js', () => ({
  evaluateOTRiskWithOpenAI: vi.fn(),
}));

vi.mock('./db.js', () => ({
  withDbTransaction: vi.fn(),
  safeRollback: vi.fn(),
  recordEventTx: vi.fn(),
  classifyError: vi.fn(() => 'TRANSIENT'),
}));

describe('queues consumers (B-1)', () => {
  it('importa Client desde pg', () => {
    expect(queuesSource).toMatch(/import\s+\{\s*Client\s*\}\s+from\s+['"]pg['"]/);
    expect(queuesSource).toMatch(/new Client\(/);
  });

  it('exporta processEnrichmentQueue y processDeliveryQueue como funciones', async () => {
    const mod = await import('./queues.js');
    expect(typeof mod.processEnrichmentQueue).toBe('function');
    expect(typeof mod.processDeliveryQueue).toBe('function');
    expect(typeof mod.processIngestionQueue).toBe('function');
  });
});

describe('processEnrichmentQueue — mensaje con body nulo/malformado no debe atascar el batch', () => {
  it('ackea el mensaje sin body en vez de tirar TypeError no capturado', async () => {
    vi.resetModules();
    vi.doMock('pg', () => ({
      Client: vi.fn().mockImplementation(() => ({
        connect: vi.fn(async () => {}),
        query: vi.fn(async () => ({ rows: [] })),
        end: vi.fn(async () => {}),
      })),
    }));

    const { processEnrichmentQueue } = await import('./queues.js');

    const msgs = [
      { body: null, ack: vi.fn(), retry: vi.fn() },
      { body: undefined, ack: vi.fn(), retry: vi.fn() },
    ];
    const batch = { messages: msgs, ackAll: vi.fn(), retryAll: vi.fn() };
    const env = { HYPERDRIVE: { connectionString: 'postgres://test/db' } };

    await expect(processEnrichmentQueue(batch, env, {})).resolves.not.toThrow();

    for (const m of msgs) {
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(m.retry).not.toHaveBeenCalled();
    }

    vi.doUnmock('pg');
  });
});
