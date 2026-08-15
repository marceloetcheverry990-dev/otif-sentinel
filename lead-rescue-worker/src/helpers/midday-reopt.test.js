import { describe, it, expect } from 'vitest';
import {
  splitFrozenOpen,
  insertionDeltaKm,
  bestInsertion,
  pickBestTripForInsert,
  rebuildSequences,
} from './midday-reopt.js';

function stop(id, lat, lng, estado, seq, vol = 1) {
  return {
    ot_id: id,
    lat,
    lng,
    estado_operacional: estado,
    stop_sequence: seq,
    volumen: vol,
    tags: [],
  };
}

describe('midday-reopt', () => {
  it('splitFrozenOpen congela EN_SITIO y ENTREGADO', () => {
    const { frozen, open } = splitFrozenOpen([
      stop('1', -33.5, -70.7, 'ENTREGADO', 1),
      stop('2', -33.51, -70.71, 'EN_SITIO', 2),
      stop('3', -33.52, -70.72, 'CAMION_ASIGNADO', 3),
    ]);
    expect(frozen.map((s) => s.ot_id)).toEqual(['1', '2']);
    expect(open.map((s) => s.ot_id)).toEqual(['3']);
  });

  it('bestInsertion mete el punto en la ranura de menor delta', () => {
    const open = [
      stop('A', -33.50, -70.70, 'CAMION_ASIGNADO', 1),
      stop('C', -33.52, -70.72, 'CAMION_ASIGNADO', 2),
    ];
    const candidate = stop('B', -33.51, -70.71, 'PENDIENTE_RUTEO', 0);
    const seed = { lat: -33.5132, lng: -70.7672 };
    const best = bestInsertion(open, candidate, { seed, capacity: 100, currentVolume: 2 });
    expect(best).not.toBeNull();
    expect(best.newOpen.map((s) => s.ot_id)).toContain('B');
    expect(best.deltaKm).toBeLessThan(50);
  });

  it('pickBestTripForInsert elige viaje con menor costo', () => {
    const candidate = stop('X', -33.51, -70.71, 'PENDIENTE_RUTEO', 0);
    const trips = [
      {
        trip_id: 'T1',
        chofer_id: 'c1',
        open: [stop('A', -33.60, -70.90, 'CAMION_ASIGNADO', 1)],
        volume: 1,
        capacity: 100,
        seed: { lat: -33.5132, lng: -70.7672 },
        tags: [],
      },
      {
        trip_id: 'T2',
        chofer_id: 'c2',
        open: [stop('B', -33.505, -70.705, 'CAMION_ASIGNADO', 1)],
        volume: 1,
        capacity: 100,
        seed: { lat: -33.5132, lng: -70.7672 },
        tags: [],
      },
    ];
    const pick = pickBestTripForInsert(trips, candidate);
    expect(pick.trip_id).toBe('T2');
  });

  it('rebuildSequences mantiene frozen primero', () => {
    const seq = rebuildSequences(
      [stop('F', -33.5, -70.7, 'ENTREGADO', 9)],
      [stop('O', -33.51, -70.71, 'CAMION_ASIGNADO', 1)]
    );
    expect(seq.map((s) => s.ot_id)).toEqual(['F', 'O']);
    // Frozen conserva seq 9; open continúa en 10 (sin colisión)
    expect(seq.map((s) => s.stop_sequence)).toEqual([9, 10]);
  });

  it('insertionDeltaKm es número finito', () => {
    const d = insertionDeltaKm(
      [stop('A', -33.5, -70.7, 'CAMION_ASIGNADO', 1)],
      stop('B', -33.51, -70.71, 'PENDIENTE_RUTEO', 0),
      1,
      { lat: -33.5132, lng: -70.7672 }
    );
    expect(Number.isFinite(d)).toBe(true);
  });

  it('HAZMAT solo inserta en viaje con tag HAZMAT', () => {
    const hazmat = { ...stop('H', -33.51, -70.71, 'PENDIENTE_RUTEO', 0), tags: ['HAZMAT'] };
    const trips = [
      {
        trip_id: 'T-normal',
        chofer_id: 'c1',
        open: [stop('A', -33.505, -70.705, 'CAMION_ASIGNADO', 1)],
        volume: 1,
        capacity: 100,
        seed: { lat: -33.5132, lng: -70.7672 },
        tags: [],
      },
      {
        trip_id: 'T-hazmat',
        chofer_id: 'c2',
        open: [stop('B', -33.52, -70.72, 'CAMION_ASIGNADO', 1)],
        volume: 1,
        capacity: 100,
        seed: { lat: -33.5132, lng: -70.7672 },
        tags: ['HAZMAT'],
      },
    ];
    const pick = pickBestTripForInsert(trips, hazmat);
    expect(pick.trip_id).toBe('T-hazmat');
  });
});
