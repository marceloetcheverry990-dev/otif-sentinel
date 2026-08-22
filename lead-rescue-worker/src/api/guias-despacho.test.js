import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { resolveFechaEmisionRetry, retryGuiasDespacho } from './guias-despacho.js';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}));

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

describe('retryGuiasDespacho dry_run', () => {
  it('lista guías pendientes y no emite DTE', async () => {
    const result = {
      data: [{ id: 'g1', ot_id: 'OT-1', estado: 'STUB', proveedor: 'stub' }],
      error: null,
    };
    const api = {
      select: () => api,
      eq: () => api,
      in: () => result,
    };
    createClient.mockReturnValue({ from: () => api });

    const req = new Request('https://x/api/guias-despacho/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trip_id: 'TRIP-1', dry_run: true }),
    });
    const res = await retryGuiasDespacho(req, { DTE_PROVIDER: 'stub' }, { tenant_id: 't1' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.dry_run).toBe(true);
    expect(body.would_retry).toBe(1);
    expect(body.sii_live).toBe(false);
  });
});
