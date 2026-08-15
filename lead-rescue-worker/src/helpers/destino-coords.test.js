import { describe, it, expect } from 'vitest';
import {
  resolveDestinoCoords,
  resolveDestinoDireccion,
  buildClientesMap,
  normalizeClienteKey,
} from './destino-coords.js';

describe('resolveDestinoCoords', () => {
  it('prioriza columnas de la orden sobre metadata y cliente', () => {
    const r = resolveDestinoCoords(
      { lat: -33.61, lng: -70.88, metadata: { lat_destino: -33.4, lng_destino: -70.6 } },
      { lat: -33.0, lng: -70.0 }
    );
    expect(r).toEqual({ lat: -33.61, lng: -70.88, source: 'orden' });
  });

  it('usa metadata si no hay columnas', () => {
    const r = resolveDestinoCoords(
      { metadata: { lat_destino: '-33.6103', lng_destino: '-70.8874' } },
      { lat: -33.0, lng: -70.0 }
    );
    expect(r.source).toBe('metadata');
    expect(r.lat).toBeCloseTo(-33.6103);
    expect(r.lng).toBeCloseTo(-70.8874);
  });

  it('usa cliente como último recurso', () => {
    const r = resolveDestinoCoords({ metadata: {} }, { lat: -33.43, lng: -70.61 });
    expect(r).toEqual({ lat: -33.43, lng: -70.61, source: 'cliente' });
  });

  it('no inventa Santiago cuando no hay coords', () => {
    const r = resolveDestinoCoords({ cliente: 'X' }, null);
    expect(r).toEqual({ lat: null, lng: null, source: null });
  });
});

describe('resolveDestinoDireccion / buildClientesMap', () => {
  it('lee direccion_entrega de metadata', () => {
    expect(
      resolveDestinoDireccion(
        { metadata: { direccion_entrega: 'Pasaje Cordillera 2610, Peñaflor' } },
        { direccion_calle: 'otra' }
      )
    ).toBe('Pasaje Cordillera 2610, Peñaflor');
  });

  it('matchea clientes case-insensitive', () => {
    const map = buildClientesMap([{ nombre_cliente_raw: 'Juan Pérez', lat: 1, lng: 2 }]);
    expect(map[normalizeClienteKey('juan pérez')].lat).toBe(1);
  });
});
