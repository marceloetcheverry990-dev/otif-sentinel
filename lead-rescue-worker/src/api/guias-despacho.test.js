import { describe, expect, it, vi } from 'vitest';
import { resolveFechaEmisionRetry } from './guias-despacho.js';

function mockQuery(result) {
  const api = {
    select: () => api,
    eq: () => api,
    not: () => api,
    order: () => api,
    limit: () => result,
  };
  return api;
}

describe('resolveFechaEmisionRetry (S2)', () => {
  it('prefiere fecha_emision de guias_despacho', async () => {
    const supabase = {
      from: vi.fn((table) => {
        if (table === 'guias_despacho') {
          return mockQuery({ data: [{ fecha_emision: '2026-08-08T15:40:00.000Z' }], error: null });
        }
        return mockQuery({ data: [], error: null });
      }),
    };
    const iso = await resolveFechaEmisionRetry(supabase, 't1', 'TRIP-1');
    expect(iso).toBe('2026-08-08T15:40:00.000Z');
  });

  it('cae a MIN SALIDA de bitacora', async () => {
    const supabase = {
      from: vi.fn((table) => {
        if (table === 'guias_despacho') {
          return mockQuery({ data: [], error: null });
        }
        return mockQuery({ data: [{ created_at: '2026-08-08T11:40:00.000Z' }], error: null });
      }),
    };
    const iso = await resolveFechaEmisionRetry(supabase, 't1', 'TRIP-1');
    expect(iso).toBe('2026-08-08T11:40:00.000Z');
  });
});
