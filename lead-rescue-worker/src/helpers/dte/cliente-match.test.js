import { describe, expect, it, vi } from 'vitest';
import { normalizeClienteNombre, resolveCliente } from './cliente-match.js';

describe('normalizeClienteNombre (S11)', () => {
  it('normaliza puntuacion y acentos', () => {
    expect(normalizeClienteNombre('  Super-Mercado  Los Andes Ltda. ')).toBe('SUPER MERCADO LOS ANDES LTDA');
    expect(normalizeClienteNombre('José María')).toBe('JOSE MARIA');
  });
});

describe('resolveCliente (S11)', () => {
  it('match exacto normalizado', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            ilike: () => ({
              limit: async () => ({
                data: [
                  { nombre_cliente_raw: 'Super Mercado Los Andes Ltda', direccion_calle: 'Calle 1', comuna: 'Maipu' },
                ],
                error: null,
              }),
            }),
          }),
        }),
      }),
    };
    const r = await resolveCliente(supabase, 't1', 'SUPER-MERCADO LOS ANDES LTDA');
    expect(r.reason).toBeNull();
    expect(r.cliente.comuna).toBe('Maipu');
  });

  it('ambiguo → reason', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            ilike: () => ({
              limit: async () => ({
                data: [
                  { nombre_cliente_raw: 'Retail A', direccion_calle: 'X', comuna: 'Santiago' },
                  { nombre_cliente_raw: 'Retail B', direccion_calle: 'Y', comuna: 'Santiago' },
                ],
                error: null,
              }),
            }),
          }),
        }),
      }),
    };
    const r = await resolveCliente(supabase, 't1', 'Retail');
    expect(r.cliente).toBeNull();
    expect(r.reason).toMatch(/ambiguous_cliente/);
  });

  it('no encontrado', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            ilike: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        }),
      }),
    };
    const r = await resolveCliente(supabase, 't1', 'Nadie SA');
    expect(r.reason).toMatch(/cliente_no_encontrado/);
  });
});
