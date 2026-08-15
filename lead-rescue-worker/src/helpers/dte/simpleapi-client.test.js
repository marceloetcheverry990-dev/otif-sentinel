import { describe, expect, it } from 'vitest';
import { IND_TRASLADO_SII, mapPayloadToSimpleAPI } from './simpleapi-client.js';

describe('mapPayloadToSimpleAPI', () => {
  it('mapea campos Res.154 al cuerpo SimpleAPI', () => {
    const body = mapPayloadToSimpleAPI(
      {
        tenant_id: 'empresa_base',
        trip_id: 'T1',
        ot_id: 'OT-9',
        tipo_traslado: 'VENTA',
        conductor_rut: '1-9',
        conductor_nombre: 'Juan',
        patente: 'ABCD12',
        origen_direccion: 'Bodega',
        origen_comuna: 'Santiago',
        destino_direccion: 'Calle 1',
        destino_comuna: 'Maipu',
        cantidad: 3,
        peso_kg: 12,
        volumen: 1,
        valor_clp: 1000,
        fecha_emision_iso: '2026-11-01T12:00:00.000Z',
        fecha_estimada_entrega: '2026-11-01T18:00:00.000Z',
        cliente_nombre: 'Retail SA',
      },
      { DTE_RUT_EMISOR: '76.123.456-7', DTE_RAZON_SOCIAL: 'Demo SpA', DTE_AMBIENTE: 'certificacion' }
    );
    expect(body.tipoDTE).toBe(52);
    expect(body.tipoTraslado).toBe(IND_TRASLADO_SII.VENTA);
    expect(body.tipoDespacho).toBe(2);
    expect(body.fechaEstimadaEntrega).toBe('2026-11-01T18:00:00.000Z');
    expect(body.transporte.patente).toBe('ABCD12');
    expect(body.transporte.comunaDestino).toBe('Maipu');
    expect(body.emisor.rut).toBe('76.123.456-7');
    expect(body.referenciaExterna).toBe('empresa_base:OT-9:T1');
  });

  it('S10: DEVOLUCION→7 y OTRO→6', () => {
    expect(mapPayloadToSimpleAPI(
      { tenant_id: 't', ot_id: '1', trip_id: 'v', tipo_traslado: 'DEVOLUCION' },
      { DTE_RUT_EMISOR: '1-9' }
    ).tipoTraslado).toBe(7);
    expect(mapPayloadToSimpleAPI(
      { tenant_id: 't', ot_id: '1', trip_id: 'v', tipo_traslado: 'OTRO' },
      { DTE_RUT_EMISOR: '1-9' }
    ).tipoTraslado).toBe(6);
  });
});
