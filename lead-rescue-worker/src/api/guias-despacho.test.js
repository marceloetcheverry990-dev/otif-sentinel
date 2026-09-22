import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { resolveFechaEmisionRetry, retryGuiasDespacho, listGuiasDespacho } from './guias-despacho.js';
import { setViajesPollCacheEntry, getViajesPollCacheEntry } from '../helpers/tower-poll-cache.js';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}));

vi.mock('../helpers/tenant-settings.js', () => ({
  getTenantSettings: vi.fn().mockResolvedValue(null),
}));

vi.mock('../helpers/dte/emit-on-salida.js', () => ({
  emitGuiasForTrip: vi.fn(async () => ({ emitted: 0, errors: 0, skipped: 0, stub: 1, review: 0 })),
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

function guiasSupabaseMock({ guiaRows, ordenRows }) {
  return {
    from: vi.fn((table) => {
      if (table === 'guias_despacho') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({ data: guiaRows, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'ordenes_pendientes') {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({ data: ordenRows, error: null }),
            }),
          }),
        };
      }
      throw new Error(`tabla inesperada en el mock: ${table}`);
    }),
  };
}

describe('listGuiasDespacho — RUT demo solo en stub/certificación', () => {
  const guiaRows = [{ id: 'g1', ot_id: 'OT-1', tenant_id: 't1', payload_enviado: null }];
  const ordenRows = [{ ot_id: 'OT-1', cliente: 'Universidad de Chile', metadata: {} }];

  it('con proveedor real (no stub) NO inventa un RUT para un nombre de cliente conocido', async () => {
    createClient.mockReturnValue(guiasSupabaseMock({ guiaRows, ordenRows }));
    const req = new Request('https://x/api/guias-despacho');
    const res = await listGuiasDespacho(req, { DTE_PROVIDER: 'lioren' }, { tenant_id: 't1' });
    const body = await res.json();
    expect(body.guias[0].cliente_nombre).toBe('Universidad de Chile');
    expect(body.guias[0].cliente_rut).toBeNull();
  });

  it('en stub sí usa el RUT demo (comportamiento de certificación/video)', async () => {
    createClient.mockReturnValue(guiasSupabaseMock({ guiaRows, ordenRows }));
    const req = new Request('https://x/api/guias-despacho');
    const res = await listGuiasDespacho(req, { DTE_PROVIDER: 'stub' }, { tenant_id: 't1' });
    const body = await res.json();
    expect(body.guias[0].cliente_rut).toBe('60.910.000-1');
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

function chainable(result) {
  const obj = {
    select: () => obj,
    update: () => obj,
    eq: () => obj,
    not: () => obj,
    order: () => obj,
    limit: () => obj,
    in: () => obj,
    maybeSingle: async () => result,
    then: (resolve) => resolve(result),
  };
  return obj;
}

describe('retryGuiasDespacho (no dry_run) — invalida el cache de poll de Torre', () => {
  it('tras reintentar, el poll de viajes del tenant queda invalidado (antes quedaba con el estado ERROR viejo hasta 3.5s)', async () => {
    createClient.mockReturnValue({
      from: vi.fn((table) => {
        if (table === 'guias_despacho') {
          // .update(...) para liberar ERROR/STUB/REVIEW, y .select(...) dentro de resolveFechaEmisionRetry
          return {
            update: () => chainable({ error: null }),
            select: () => chainable({ data: [{ fecha_emision: '2026-08-08T15:40:00.000Z' }], error: null }),
          };
        }
        if (table === 'flota_vehiculos') {
          return { select: () => chainable({ data: { rut_chofer_asignado: '11.111.111-1' }, error: null }) };
        }
        throw new Error(`tabla inesperada en el mock: ${table}`);
      }),
    });

    setViajesPollCacheEntry('t1|sla=0', '{"viajes":["stale"]}');
    expect(getViajesPollCacheEntry('t1|sla=0')).not.toBeNull();

    const req = new Request('https://x/api/guias-despacho/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trip_id: 'TRIP-1' }),
    });
    const res = await retryGuiasDespacho(req, { DTE_PROVIDER: 'stub' }, { tenant_id: 't1' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.exito).toBe(true);
    expect(getViajesPollCacheEntry('t1|sla=0')).toBeNull();
  });
});
