import { describe, expect, it, vi } from 'vitest';
import { loadOrdenesForEmit, shouldSkipExisting, upsertGuiaRow } from './emit-on-salida.js';

describe('upsertGuiaRow — no debe permitir doble emisión real cuando hay una carrera', () => {
  it('insert exitoso → claimed:true', async () => {
    const supabase = {
      from: () => ({ insert: async () => ({ error: null }) }),
    };
    const claim = await upsertGuiaRow(supabase, null, { estado: 'EMITTING' });
    expect(claim.claimed).toBe(true);
  });

  it('insert choca con 23505 (otra llamada concurrente ya la creó) → claimed:false, no reintenta emitir', async () => {
    const supabase = {
      from: () => ({ insert: async () => ({ error: { code: '23505', message: 'duplicate key' } }) }),
    };
    const claim = await upsertGuiaRow(supabase, null, { estado: 'EMITTING' });
    expect(claim.claimed).toBe(false);
  });

  it('update sobre fila existente exitoso → claimed:true', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
    };
    const claim = await upsertGuiaRow(supabase, { id: 'g1' }, { estado: 'EMITTING' });
    expect(claim.claimed).toBe(true);
  });

  it('update sobre fila existente con error → claimed:false', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: async () => ({ error: { message: 'boom' } }) }) }),
    };
    const claim = await upsertGuiaRow(supabase, { id: 'g1' }, { estado: 'EMITTING' });
    expect(claim.claimed).toBe(false);
  });
});

describe('shouldSkipExisting', () => {
  it('EMITTING antiguo se puede reintentar', () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(shouldSkipExisting({ estado: 'EMITTING', updated_at: old })).toBe(false);
  });

  it('STUB se salta en modo salida normal (no reescribir en cada parada)', () => {
    expect(shouldSkipExisting({ estado: 'STUB' })).toBe(true);
    expect(shouldSkipExisting({ estado: 'STUB' }, { mode: 'salida' })).toBe(true);
  });

  it('STUB NO se salta en modo retry — debe poder promoverse a emisión real (si no, el reintento que loadOrdenesForEmit fue a buscar vía RETRY_ESTADOS nunca hace nada)', () => {
    expect(shouldSkipExisting({ estado: 'STUB' }, { mode: 'retry' })).toBe(false);
  });

  it('EMITIDA siempre se salta, incluso en retry', () => {
    expect(shouldSkipExisting({ estado: 'EMITIDA' }, { mode: 'retry' })).toBe(true);
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
