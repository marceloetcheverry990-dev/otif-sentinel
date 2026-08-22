import { describe, expect, it } from 'vitest';
import { assessFaltantesRes154, buildComprobanteDte52 } from './comprobante-dte52.js';

const baseGuia = {
  tenant_id: 'empresa_base',
  trip_id: 'TRIP-1',
  ot_id: 'OT-1',
  estado: 'STUB',
  folio: null,
  tipo_traslado: 'VENTA',
  patente: 'KV-JS-99',
  conductor_rut: '11111111-1',
  conductor_nombre: 'felipe jeriverto',
  origen_direccion: 'Bodega Central 100',
  origen_comuna: 'Maipú',
  destino_direccion: 'Av. Pedro Aguirre Cerda 4296',
  destino_comuna: 'Cerrillos',
  cantidad: 1,
  valor_clp: 2500000,
  peso_kg: 800,
  fecha_emision: '2026-08-20T22:18:00.000Z',
  proveedor: 'stub',
  payload_enviado: {
    cliente_nombre: 'Starken CORPROA',
    cliente_rut: '96.791.430-3',
    tipo_despacho: 2,
  },
};

const emisor = {
  DTE_RUT_EMISOR: '76.543.210-K',
  DTE_RAZON_SOCIAL: 'Empresa Base Demo SpA',
  DTE_AMBIENTE: 'certificacion',
};

describe('buildComprobanteDte52', () => {
  it('arma DTE 52 completo Res.154', () => {
    const c = buildComprobanteDte52(baseGuia, emisor);
    expect(c.tipo_dte).toBe(52);
    expect(c.ind_traslado).toBe(1);
    expect(c.comprobante_completo).toBe(true);
    expect(c.listo_para_fiscalizacion).toBe(false); // stub sin folio SII
    expect(c.faltantes_res154).toEqual([]);
    expect(c.emisor.rut).toBe('76.543.210-K');
    expect(c.receptor.rut).toBe('96.791.430-3');
    expect(c.transporte.destino_direccion).toMatch(/Pedro Aguirre/);
  });

  it('listo_para_fiscalizacion solo con EMITIDA + folio', () => {
    const c = buildComprobanteDte52(
      { ...baseGuia, estado: 'EMITIDA', folio: '12345' },
      emisor
    );
    expect(c.listo_para_fiscalizacion).toBe(true);
  });

  it('detecta faltantes de venta sin RUT receptor', () => {
    const c = buildComprobanteDte52(
      {
        ...baseGuia,
        payload_enviado: { cliente_nombre: 'X', tipo_despacho: 2 },
      },
      emisor
    );
    expect(c.faltantes_res154).toContain('receptor_rut');
    expect(c.comprobante_completo).toBe(false);
  });
});

describe('assessFaltantesRes154', () => {
  it('exige emisor y transporte', () => {
    expect(assessFaltantesRes154({
      ind_traslado: 6,
      emisor: {},
      receptor: { razon_social: 'A' },
      transporte: {},
      detalle: [{ cantidad: 1 }],
    }).length).toBeGreaterThan(3);
  });
});
