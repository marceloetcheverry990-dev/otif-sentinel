import { describe, expect, it } from 'vitest';
import { perfilKeyFromNombre, resolvePerfilPesos, loadPerfilPesos, PERFIL_PESOS } from './perfil-pesos.js';

describe('resolvePerfilPesos', () => {
  it('mapea los cuatro nombres del dropdown a pesos distintos', () => {
    const a = resolvePerfilPesos({ nombre_perfil: 'Modo Ahorro Bencina (Ruta Corta)' });
    const v = resolvePerfilPesos({ nombre_perfil: 'Modo VIP (Priorizar Montos Altos)' });
    const s = resolvePerfilPesos({ nombre_perfil: 'Modo Salvavidas (Evitar Multas)' });
    const e = resolvePerfilPesos({ nombre_perfil: 'Equilibrado (Recomendado)' });
    expect(a.key).toBe('ahorro');
    expect(v.key).toBe('vip');
    expect(s.key).toBe('salvavidas');
    expect(e.key).toBe('equilibrado');
    expect(a.peso_distancia).toBeGreaterThan(v.peso_distancia);
    expect(v.peso_valor_carga).toBeGreaterThan(s.peso_valor_carga);
    expect(s.peso_sla).toBeGreaterThan(a.peso_sla);
    expect(s.peso_riesgo_ia).toBeGreaterThan(e.peso_riesgo_ia);
  });

  it('no usa los 1/1/0/0 de la fila si el nombre ya define el modo', () => {
    const got = resolvePerfilPesos({
      nombre_perfil: 'Modo VIP (Priorizar Montos Altos)',
      peso_distancia: 1,
      peso_sla: 1,
      peso_valor_carga: 0,
      peso_riesgo_ia: 0,
    });
    expect(got.peso_valor_carga).toBe(PERFIL_PESOS.vip.peso_valor_carga);
  });

  it('perfilKeyFromNombre default equilibrado', () => {
    expect(perfilKeyFromNombre('')).toBe('equilibrado');
  });

  it('con la columna modo (mig 029), renombrar un perfil no le cambia el comportamiento', () => {
    const p = resolvePerfilPesos({ nombre_perfil: 'Clientes Premium', modo: 'vip' });
    expect(p.key).toBe('vip');
    expect(p.modo_origen).toBe('bd');
    expect(resolvePerfilPesos({ nombre_perfil: 'Clientes Premium' }).key).toBe('equilibrado');
  });

  it('un modo inválido en la BD cae al nombre', () => {
    const p = resolvePerfilPesos({ nombre_perfil: 'Modo Ahorro Bencina', modo: 'turbo' });
    expect(p.key).toBe('ahorro');
    expect(p.modo_origen).toBe('nombre');
  });
});

describe('loadPerfilPesos', () => {
  const supa = (respuestas) => {
    const pedidas = [];
    return {
      pedidas,
      from: () => {
        let cols = '';
        const b = {
          select: (c) => { cols = c; pedidas.push(c); return b; },
          eq: () => b,
          or: () => b,
          maybeSingle: async () => respuestas(cols),
        };
        return b;
      },
    };
  };

  it('lee el modo de la BD', async () => {
    const s = supa(() => ({ data: { nombre_perfil: 'Clientes Premium', modo: 'vip' }, error: null }));
    expect((await loadPerfilPesos(s, 't', 3)).key).toBe('vip');
  });

  it('BD sin columna modo (antes de la 029): reintenta sin ella y deduce del nombre', async () => {
    const s = supa((cols) => (cols.includes('modo')
      ? { data: null, error: { message: 'column perfiles_optimizacion.modo does not exist' } }
      : { data: { nombre_perfil: 'Modo Salvavidas' }, error: null }));
    const p = await loadPerfilPesos(s, 't', 4);
    expect(p.key).toBe('salvavidas');
    expect(s.pedidas).toHaveLength(2);
  });

  it('sin perfil_id devuelve Equilibrado sin consultar', async () => {
    const s = supa(() => { throw new Error('no debería consultar'); });
    expect((await loadPerfilPesos(s, 't', null)).key).toBe('equilibrado');
  });
});
