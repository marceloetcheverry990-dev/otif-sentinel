import { describe, it, expect } from 'vitest';
import { pickBestTripForInsert } from './midday-reopt.js';
import { DEFAULT_DEPOT } from './vrp-solver.js';

function baseTrip(overrides = {}) {
  return {
    trip_id: 'TRIP-1',
    chofer_id: 'CH-1',
    patente: 'AA-1111',
    open: [],
    volume: 0,
    weight: 0,
    capacity: 100,
    capacityWeight: 99999,
    seed: DEFAULT_DEPOT,
    depot: DEFAULT_DEPOT,
    tags: [], // sin certificación propia — caso típico
    cargoTags: [],
    velocidadKmH: 35,
    ...overrides,
  };
}

function candidate(tags) {
  return {
    ot_id: 'NEW-1',
    lat: DEFAULT_DEPOT.lat + 0.01,
    lng: DEFAULT_DEPOT.lng + 0.01,
    volumen: 1,
    peso_kg: 1,
    tags,
    fecha_hora_sla: new Date(Date.now() + 8 * 3600000).toISOString(),
  };
}

describe('pickBestTripForInsert — segregación contra carga real, no contra el perfil del chofer', () => {
  // En los 3 casos el chofer SÍ tiene el tag que exige el pedido (pasa el
  // gate de "capacidad del chofer"). Lo único que varía es cargoTags — así
  // se aísla el bug real: antes se comparaba contra `tags` (certificación
  // del chofer), por lo que un chofer HAZMAT-certificado podía recibir un
  // pedido HAZMAT igual, aunque el camión ya llevara ALIMENTO a bordo.
  it('rechaza insertar HAZMAT en un viaje que ya lleva FOOD a bordo, aunque el chofer esté certificado HAZMAT', () => {
    const trips = [baseTrip({ tags: ['HAZMAT'], cargoTags: ['ALIMENTO'] })];
    const pick = pickBestTripForInsert(trips, candidate(['HAZMAT']), { depot: DEFAULT_DEPOT });
    expect(pick).toBeNull();
  });

  it('rechaza insertar FOOD en un viaje que ya lleva HAZMAT a bordo, aunque el chofer esté certificado ALIMENTO', () => {
    const trips = [baseTrip({ tags: ['ALIMENTO'], cargoTags: ['HAZMAT'] })];
    const pick = pickBestTripForInsert(trips, candidate(['ALIMENTO']), { depot: DEFAULT_DEPOT });
    expect(pick).toBeNull();
  });

  it('permite insertar FOOD en un viaje sin carga conflictiva a bordo', () => {
    const trips = [baseTrip({ tags: ['ALIMENTO'], cargoTags: [] })];
    const pick = pickBestTripForInsert(trips, candidate(['ALIMENTO']), { depot: DEFAULT_DEPOT });
    expect(pick).not.toBeNull();
    expect(pick.trip_id).toBe('TRIP-1');
  });
});
