import { describe, expect, it } from 'vitest';
import { classifyTripStops, parseSelectedTripIds, selectRecalcDrivers } from './recalcular-ruteo.js';

describe('classifyTripStops', () => {
  it('sin salir (todo CAMION_ASIGNADO) → unstarted', () => {
    const got = classifyTripStops([
      { ot_id: '1', stop_sequence: 1, estado_operacional: 'CAMION_ASIGNADO' },
      { ot_id: '2', stop_sequence: 2, estado_operacional: 'CAMION_ASIGNADO' },
    ]);
    expect(got.kind).toBe('unstarted');
    expect(got.open).toHaveLength(2);
    expect(got.frozen).toHaveLength(0);
  });

  it('con entrega hecha → in_progress', () => {
    const got = classifyTripStops([
      { ot_id: '1', stop_sequence: 1, estado_operacional: 'ENTREGADO' },
      { ot_id: '2', stop_sequence: 2, estado_operacional: 'CAMION_ASIGNADO' },
    ]);
    expect(got.kind).toBe('in_progress');
    expect(got.frozen).toHaveLength(1);
    expect(got.open).toHaveLength(1);
  });

  it('EN_RUTA sin congeladas → in_progress', () => {
    const got = classifyTripStops([
      { ot_id: '1', stop_sequence: 1, estado_operacional: 'EN_RUTA' },
    ]);
    expect(got.kind).toBe('in_progress');
  });
});

describe('selectRecalcDrivers', () => {
  const a = { chofer_id: '1', patente_asignada: 'AA' };
  const b = { chofer_id: '2', patente_asignada: 'BB' };
  const c = { chofer_id: '3', patente_asignada: 'CC' };
  const noPat = { chofer_id: '4', patente_asignada: null };

  it('prioriza asignados y completa con disponibles hasta N', () => {
    const got = selectRecalcDrivers([a], [b, c], 2);
    expect(got.map((d) => d.chofer_id)).toEqual(['1', '2']);
  });

  it('si N es menor, recorta (fusionar viajes sin salir)', () => {
    const got = selectRecalcDrivers([a, b], [c], 1);
    expect(got).toHaveLength(1);
    expect(got[0].chofer_id).toBe('1');
  });

  it('ignora sin patente', () => {
    const got = selectRecalcDrivers([noPat], [c], 2);
    expect(got.map((d) => d.chofer_id)).toEqual(['3']);
  });
});

describe('parseSelectedTripIds', () => {
  it('exige al menos un id', () => {
    expect(parseSelectedTripIds(null).ok).toBe(false);
    expect(parseSelectedTripIds([]).ok).toBe(false);
    expect(parseSelectedTripIds(['', ' ']).ok).toBe(false);
  });

  it('deduplica y recorta', () => {
    const got = parseSelectedTripIds([' TRIP-A ', 'TRIP-A', 'TRIP-B']);
    expect(got).toEqual({ ok: true, ids: ['TRIP-A', 'TRIP-B'] });
  });
});
