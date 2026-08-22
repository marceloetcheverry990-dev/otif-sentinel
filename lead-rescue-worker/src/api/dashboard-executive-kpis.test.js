import { describe, it, expect } from 'vitest';
import { buildExecutiveKpis, comparisonCaption } from './dashboard-executive-kpis.js';

describe('buildExecutiveKpis', () => {
  it('no inventa delta cuando el período anterior está vacío (period=all)', () => {
    const kpis = buildExecutiveKpis({
      current_entregas: 15,
      previous_entregas: 0,
      previous_total: 0,
      current_ingresos: 0,
      previous_ingresos: 0,
      current_multas: 603400,
      previous_multas: 0,
      otif_actual: 88.2,
      otif_anterior: null,
    }, { km_totales_mes: 10, km_promedio_ruta: 2 }, 'all');

    expect(kpis.comparable).toBe(false);
    expect(kpis.otif.actual).toBe(88.2);
    expect(kpis.otif.cambio).toBeNull();
    expect(kpis.entregas.crecimiento).toBeNull();
    expect(kpis.ingresos.crecimiento).toBeNull();
    expect(kpis.multas.anterior).toBeNull();
    expect(kpis.comparison_caption).toBe('vs período anterior');
  });

  it('calcula el cambio real cuando hay mes anterior', () => {
    const kpis = buildExecutiveKpis({
      current_entregas: 20,
      previous_entregas: 10,
      previous_total: 12,
      current_ingresos: 200,
      previous_ingresos: 100,
      current_multas: 50,
      previous_multas: 80,
      otif_actual: 90,
      otif_anterior: 80,
    }, {}, 'month');

    expect(kpis.comparable).toBe(true);
    expect(kpis.otif.cambio).toBe(10);
    expect(kpis.entregas.crecimiento).toBe(100);
    expect(kpis.ingresos.crecimiento).toBe(100);
    expect(kpis.multas.actual - kpis.multas.anterior).toBe(-30);
    expect(comparisonCaption('month')).toBe('vs mes anterior');
  });
});
