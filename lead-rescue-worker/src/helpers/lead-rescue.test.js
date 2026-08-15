import { describe, expect, it } from 'vitest';
import { rankRescueCandidates } from './lead-rescue.js';

describe('rankRescueCandidates', () => {
  it('elige los 2 más cercanos con cupo', () => {
    const ranked = rankRescueCandidates({
      stuckLat: -33.45,
      stuckLng: -70.66,
      cargoVolume: 10,
      limit: 2,
      candidates: [
        {
          trip_id: 'FAR',
          lat: -33.6,
          lng: -70.8,
          capacity: 100,
          volume: 10,
          nombre: 'Lejos',
        },
        {
          trip_id: 'NEAR',
          lat: -33.46,
          lng: -70.67,
          capacity: 100,
          volume: 20,
          nombre: 'Cerca',
        },
        {
          trip_id: 'FULL',
          lat: -33.451,
          lng: -70.661,
          capacity: 30,
          volume: 28,
          nombre: 'Lleno',
        },
        {
          trip_id: 'MID',
          lat: -33.48,
          lng: -70.70,
          capacity: 80,
          volume: 10,
          nombre: 'Medio',
        },
      ],
    });
    expect(ranked).toHaveLength(2);
    expect(ranked[0].trip_id).toBe('NEAR');
    expect(ranked.map((c) => c.trip_id)).not.toContain('FULL');
  });

  it('filtra por tags HAZMAT', () => {
    const ranked = rankRescueCandidates({
      stuckLat: -33.45,
      stuckLng: -70.66,
      cargoVolume: 5,
      cargoTags: ['HAZMAT'],
      limit: 2,
      candidates: [
        { trip_id: 'A', lat: -33.46, lng: -70.67, capacity: 50, volume: 0, tags: [] },
        { trip_id: 'B', lat: -33.47, lng: -70.68, capacity: 50, volume: 0, tags: ['HAZMAT'] },
      ],
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].trip_id).toBe('B');
  });

  it('filtra por cupo de peso', () => {
    const ranked = rankRescueCandidates({
      stuckLat: -33.45,
      stuckLng: -70.66,
      cargoVolume: 5,
      cargoWeight: 50,
      limit: 2,
      candidates: [
        {
          trip_id: 'LIGHT',
          lat: -33.46,
          lng: -70.67,
          capacity: 100,
          capacityWeight: 40,
          volume: 0,
          weight: 0,
        },
        {
          trip_id: 'HEAVY',
          lat: -33.47,
          lng: -70.68,
          capacity: 100,
          capacityWeight: 200,
          volume: 0,
          weight: 10,
        },
      ],
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].trip_id).toBe('HEAVY');
  });
});
