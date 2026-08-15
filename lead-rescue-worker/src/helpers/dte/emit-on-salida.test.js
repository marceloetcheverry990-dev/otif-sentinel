import { describe, expect, it, vi } from 'vitest';
import { loadOrdenesForEmit, shouldSkipExisting } from './emit-on-salida.js';

describe('shouldSkipExisting', () => {
  it('EMITTING antiguo se puede reintentar', () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(shouldSkipExisting({ estado: 'EMITTING', updated_at: old })).toBe(false);
  });
});

describe('loadOrdenesForEmit (R1)', () => {
  it('retry carga OTs desde guias aunque esten ENTREGADO', async () => {
    const supabase = {
      from: vi.fn((table) => {
        if (table === 'guias_despacho') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      { id: 'g1', ot_id: '1001', estado: 'ERROR', folio: null, fecha_emision: '2026-08-08T12:00:00.000Z' },
                      { id: 'g2', ot_id: '1002', estado: 'STUB', folio: null, fecha_emision: '2026-08-08T12:00:00.000Z' },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({
                data: [
                  { ot_id: '1001', cliente: 'A', estado_operacional: 'ENTREGADO' },
                  { ot_id: '1002', cliente: 'B', estado_operacional: 'ENTREGADO' },
                ],
                error: null,
              }),
            }),
          }),
        };
      }),
    };

    const loaded = await loadOrdenesForEmit(supabase, {
      tenant_id: 'empresa_base',
      trip_id: 'TRIP-1',
      mode: 'retry',
    });
    expect(loaded.error).toBeNull();
    expect(loaded.ordenes).toHaveLength(2);
    expect(loaded.ordenes.map((o) => o.ot_id)).toEqual(['1001', '1002']);
    expect(loaded.guiasByOt.get('1001').estado).toBe('ERROR');
  });

  it('salida no incluye ENTREGADO', async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              not: async () => ({
                data: [{ ot_id: 'OPEN-1', cliente: 'X' }],
                error: null,
              }),
            }),
          }),
        }),
      })),
    };
    const loaded = await loadOrdenesForEmit(supabase, {
      tenant_id: 't',
      trip_id: 'TRIP',
      mode: 'salida',
    });
    expect(loaded.ordenes).toHaveLength(1);
    expect(loaded.guiasByOt.size).toBe(0);
  });
});
