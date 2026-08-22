/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import {
  assertDriverOwnsTrip,
  assertDriverCanAccessTrip,
} from './trip-ownership.js';

function mockSupabase(handlers) {
  return {
    from: vi.fn((table) => {
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        gte: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => handlers[table]?.() ?? { data: null, error: null }),
      };
      return chain;
    }),
  };
}

describe('trip ownership', () => {
  it('permite via flota activa', async () => {
    const supabase = mockSupabase({
      flota_vehiculos: () => ({ data: { rut_chofer_asignado: '11111111-1' }, error: null }),
    });
    const err = await assertDriverOwnsTrip(supabase, {
      trip_id: 'T1', tenant_id: 'empresa_base', rut: '11111111-1',
    });
    expect(err).toBeNull();
  });

  it('permite via ordenes si flota ya liberó', async () => {
    const supabase = mockSupabase({
      flota_vehiculos: () => ({ data: null, error: null }),
      ordenes_pendientes: () => ({ data: { ot_id: 'OT-1' }, error: null }),
    });
    const err = await assertDriverOwnsTrip(supabase, {
      trip_id: 'T1', tenant_id: 'empresa_base', rut: '11111111-1', chofer_id: '99',
    });
    expect(err).toBeNull();
  });

  it('chat post-viaje permite por bitácora reciente', async () => {
    const supabase = mockSupabase({
      flota_vehiculos: () => ({ data: null, error: null }),
      choferes: () => ({ data: null, error: null }),
      ordenes_pendientes: () => ({ data: null, error: null }),
      bitacora_viajes: () => ({ data: { id: 'ev-1' }, error: null }),
    });
    const err = await assertDriverCanAccessTrip(supabase, {
      trip_id: 'T1', tenant_id: 'empresa_base', rut: '11111111-1',
    });
    expect(err).toBeNull();
  });
});
