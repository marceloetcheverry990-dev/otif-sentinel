import { describe, expect, it } from 'vitest';
import { perfilKeyFromNombre, resolvePerfilPesos, PERFIL_PESOS } from './perfil-pesos.js';

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
});
