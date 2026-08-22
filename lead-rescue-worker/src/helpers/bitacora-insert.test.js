/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { insertBitacoraEvent } from './bitacora-insert.js';

describe('insertBitacoraEvent', () => {
  it('inserta rut_chofer obligatorio sin latitud/longitud', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = { from: vi.fn(() => ({ insert })) };

    const { error } = await insertBitacoraEvent(supabase, {
      tenant_id: 'empresa_base',
      trip_id: 'TRIP-1',
      stop_id: 'OT-1',
      rut_chofer: '11111111-1',
      tipo_evento: 'SALIDA',
      created_at: '2026-08-22T00:00:00.000Z',
    });

    expect(error).toBeNull();
    expect(insert).toHaveBeenCalledWith([{
      tenant_id: 'empresa_base',
      trip_id: 'TRIP-1',
      rut_chofer: '11111111-1',
      tipo_evento: 'SALIDA',
      leido: false,
      stop_id: 'OT-1',
      created_at: '2026-08-22T00:00:00.000Z',
    }]);
  });
});
