import { describe, expect, it, vi } from 'vitest';
import { normalizeClienteNombre, resolveCliente } from './cliente-match.js';

describe('normalizeClienteNombre (S11)', () => {
  it('normaliza puntuacion y acentos', () => {
    expect(normalizeClienteNombre('  Super-Mercado  Los Andes Ltda. ')).toBe('SUPER MERCADO LOS ANDES LTDA');
    expect(normalizeClienteNombre('José María')).toBe('JOSE MARIA');
  });
});

/**
 * resolveCliente ahora hace 2 queries: un ILIKE exacto (sin comodines, sin
 * LIMIT) primero, y solo si no resuelve, un ILIKE fuzzy (%raw%, ORDER BY,
 * LIMIT 25). El mock distingue cuál es cuál por si el pattern trae '%'.
 */
function makeSupabaseClienteMock({ exactRows = [], fuzzyRows = [], exactError = null, fuzzyError = null } = {}) {
  const calls = { exact: 0, fuzzy: 0 };
  return {
    calls,
    from: () => ({
      select: () => ({
        eq: () => ({
          ilike: (_col, pattern) => {
            const isFuzzy = String(pattern).includes('%');
            if (isFuzzy) {
              calls.fuzzy += 1;
              return {
                order: () => ({
                  limit: async () => ({ data: fuzzyRows, error: fuzzyError }),
                }),
              };
            }
            calls.exact += 1;
            return Promise.resolve({ data: exactRows, error: exactError });
          },
        }),
      }),
    }),
  };
}

describe('resolveCliente (S11)', () => {
  it('match exacto normalizado — resuelto por el paso exacto, sin tocar el fuzzy', async () => {
    const supabase = makeSupabaseClienteMock({
      exactRows: [
        { nombre_cliente_raw: 'Super Mercado Los Andes Ltda', direccion_calle: 'Calle 1', comuna: 'Maipu' },
      ],
    });
    const r = await resolveCliente(supabase, 't1', 'SUPER-MERCADO LOS ANDES LTDA');
    expect(r.reason).toBeNull();
    expect(r.cliente.comuna).toBe('Maipu');
    expect(supabase.calls.exact).toBe(1);
    expect(supabase.calls.fuzzy).toBe(0);
  });

  it('match exacto existe aunque el fuzzy (limitado a 25, sin orden) nunca lo hubiera devuelto — no depende del LIMIT', async () => {
    // El fuzzyRows simula "25 clientes que no son el match real" — si el código
    // dependiera solo del fuzzy con LIMIT 25, este caso fallaría. El paso
    // exacto lo resuelve sin pasar por ahí.
    const fuzzyRows = Array.from({ length: 25 }, (_, i) => ({
      nombre_cliente_raw: `Otro Cliente ${i}`,
      direccion_calle: 'X',
      comuna: 'Santiago',
    }));
    const supabase = makeSupabaseClienteMock({
      exactRows: [{ nombre_cliente_raw: 'Retail Andes', direccion_calle: 'Real 1', comuna: 'Providencia' }],
      fuzzyRows,
    });
    const r = await resolveCliente(supabase, 't1', 'Retail Andes');
    expect(r.reason).toBeNull();
    expect(r.cliente.direccion_calle).toBe('Real 1');
    expect(supabase.calls.fuzzy).toBe(0);
  });

  it('ambiguo en el paso exacto (dos clientes con el mismo nombre normalizado) → reason, no cae al fuzzy', async () => {
    const supabase = makeSupabaseClienteMock({
      exactRows: [
        { nombre_cliente_raw: 'Retail Andes', direccion_calle: 'X', comuna: 'Santiago' },
        { nombre_cliente_raw: 'RETAIL ANDES', direccion_calle: 'Y', comuna: 'Santiago' },
      ],
    });
    const r = await resolveCliente(supabase, 't1', 'Retail Andes');
    expect(r.cliente).toBeNull();
    expect(r.reason).toMatch(/ambiguous_cliente/);
    expect(supabase.calls.fuzzy).toBe(0);
  });

  it('sin match exacto, un solo match fuzzy → resuelto por el paso fuzzy', async () => {
    const supabase = makeSupabaseClienteMock({
      exactRows: [],
      fuzzyRows: [{ nombre_cliente_raw: 'Retail Andes Norte', direccion_calle: 'Z', comuna: 'Santiago' }],
    });
    const r = await resolveCliente(supabase, 't1', 'Retail');
    expect(r.reason).toBeNull();
    expect(r.cliente.comuna).toBe('Santiago');
  });

  it('ambiguo en el fuzzy (sin match exacto, varios candidatos) → reason', async () => {
    const supabase = makeSupabaseClienteMock({
      exactRows: [],
      fuzzyRows: [
        { nombre_cliente_raw: 'Retail A', direccion_calle: 'X', comuna: 'Santiago' },
        { nombre_cliente_raw: 'Retail B', direccion_calle: 'Y', comuna: 'Santiago' },
      ],
    });
    const r = await resolveCliente(supabase, 't1', 'Retail');
    expect(r.cliente).toBeNull();
    expect(r.reason).toMatch(/ambiguous_cliente/);
  });

  it('no encontrado', async () => {
    const supabase = makeSupabaseClienteMock({ exactRows: [], fuzzyRows: [] });
    const r = await resolveCliente(supabase, 't1', 'Nadie SA');
    expect(r.reason).toMatch(/cliente_no_encontrado/);
  });
});
