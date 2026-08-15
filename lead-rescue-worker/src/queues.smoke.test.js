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
