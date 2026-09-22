import { describe, expect, it, vi } from 'vitest';

vi.mock('./middleware.js', () => ({ withQueueMonitoring: (fn) => fn }));
vi.mock('./metrics.js', () => ({ recordMetric: vi.fn(), METRIC_TYPES: {} }));
vi.mock('./logger.js', () => ({ Logger: { error: vi.fn(), warn: vi.fn() } }));

let queryImpl;
vi.mock('../db.js', () => ({
  withDb: async (_env, cb) => cb({ query: (...args) => queryImpl(...args) }),
}));

const { getCircuitBreakerStates, getDLQDepth } = await import('./queue-middleware.js');

describe('getCircuitBreakerStates — debe leer las columnas reales de system_flags (key/value/expires_at)', () => {
  it('usa key/value/expires_at en el SQL, no flag_key/flag_value (esas columnas no existen)', async () => {
    let capturedSql = null;
    queryImpl = async (sql) => {
      capturedSql = sql;
      return { rows: [] };
    };
    await getCircuitBreakerStates({});
    expect(capturedSql).toMatch(/\bkey\b/);
    expect(capturedSql).toMatch(/\bvalue\b/);
    expect(capturedSql).toMatch(/\bexpires_at\b/);
    expect(capturedSql).not.toMatch(/flag_key/);
    expect(capturedSql).not.toMatch(/flag_value/);
  });

  it('breaker OPEN y no vencido → true', async () => {
    queryImpl = async () => ({
      rows: [{ key: 'openai_breaker', value: 'OPEN', expires_at: new Date(Date.now() + 60_000).toISOString() }],
    });
    const states = await getCircuitBreakerStates({});
    expect(states.openai_breaker).toBe(true);
    expect(states.tg_breaker).toBe(false);
  });

  it('breaker OPEN pero YA vencido → false (no queda abierto para siempre)', async () => {
    queryImpl = async () => ({
      rows: [{ key: 'openai_breaker', value: 'OPEN', expires_at: new Date(Date.now() - 60_000).toISOString() }],
    });
    const states = await getCircuitBreakerStates({});
    expect(states.openai_breaker).toBe(false);
  });

  it('sin filas → todo CLOSED', async () => {
    queryImpl = async () => ({ rows: [] });
    const states = await getCircuitBreakerStates({});
    expect(states).toEqual({ openai_breaker: false, tg_breaker: false });
  });

  it('error de DB → fail-open (todo CLOSED, no revienta)', async () => {
    queryImpl = async () => { throw new Error('boom'); };
    const states = await getCircuitBreakerStates({});
    expect(states).toEqual({ openai_breaker: false, tg_breaker: false });
  });
});

describe('getDLQDepth — ventana de tiempo y columna real de filtro', () => {
  it('el SQL filtra por died_at con ventana de 1 hora (antes contaba el histórico completo para siempre)', async () => {
    let capturedSql = null;
    queryImpl = async (sql) => {
      capturedSql = sql;
      return { rows: [{ count: '0' }] };
    };
    await getDLQDepth({});
    expect(capturedSql).toMatch(/died_at > NOW\(\) - INTERVAL '1 hour'/);
  });

  it('con queueName, filtra por event_type (no por metadata->>\'queue\' — esa columna no existe en dead_letter_events)', async () => {
    let capturedSql = null;
    let capturedParams = null;
    queryImpl = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [{ count: '3' }] };
    };
    const depth = await getDLQDepth({}, 'ENRICHMENT');
    expect(capturedSql).toMatch(/event_type = \$1/);
    expect(capturedSql).not.toMatch(/metadata/);
    expect(capturedParams).toEqual(['ENRICHMENT']);
    expect(depth).toBe(3);
  });

  it('error de DB (ej. columna inexistente) → devuelve 0 en vez de reventar', async () => {
    queryImpl = async () => { throw new Error('column "metadata" does not exist'); };
    const depth = await getDLQDepth({}, 'ENRICHMENT');
    expect(depth).toBe(0);
  });
});
