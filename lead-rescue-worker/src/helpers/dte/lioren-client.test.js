import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapPayloadToLioren, postGuiaLioren, lookupGuiaByReferenciaLioren } from './lioren-client.js';

const payload = {
  tenant_id: 'empresa_base',
  trip_id: 'T1',
  ot_id: 'OT-9',
  tipo_traslado: 'VENTA',
  conductor_rut: '11111111-1',
  conductor_nombre: 'Felipe',
  patente: 'KVJS99',
  origen_direccion: 'Bodega',
  origen_comuna: 'Santiago',
  destino_direccion: 'Calle 1',
  destino_comuna: 'Maipu',
  cantidad: 2,
  valor_clp: 0,
  fecha_emision_iso: '2026-11-01T12:00:00.000Z',
  cliente_nombre: 'Retail SA',
  cliente_rut: '76.111.111-1',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mapPayloadToLioren', () => {
  it('mapea guía 52 con transporte y referencia', () => {
    const body = mapPayloadToLioren(payload, {});
    expect(body.tipodoc).toBe(52);
    expect(body.fecha).toBe('2026-11-01');
    expect(body.traslado).toBe(1);
    expect(body.patente).toBe('KVJS99');
    expect(body.rutchofer).toBe('11111111-1');
    expect(body.receptor.comuna).toBe('Maipu');
    expect(body.referencia).toBe('empresa_base:OT-9:T1');
  });
});

describe('postGuiaLioren', () => {
  it('ERROR sin token', async () => {
    const r = await postGuiaLioren(payload, {});
    expect(r.estado).toBe('ERROR');
    expect(r.error).toMatch(/LIOREN_TOKEN/);
  });

  it('EMITIDA con folio de Lioren', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ folio: 4521, id: 99 }), { status: 200 })));
    const r = await postGuiaLioren(payload, { LIOREN_TOKEN: 'tok' });
    expect(r.estado).toBe('EMITIDA');
    expect(r.folio).toBe('4521');
    expect(r.track_id).toBe('99');
    expect(r.proveedor).toBe('lioren');
  });

  it('ERROR HTTP del proveedor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mensaje: 'sin CAF' }), { status: 422 })));
    const r = await postGuiaLioren(payload, { LIOREN_TOKEN: 'tok' });
    expect(r.estado).toBe('ERROR');
    expect(r.error).toMatch(/422/);
    expect(r.error).toMatch(/CAF/);
  });
});

describe('lookupGuiaByReferenciaLioren', () => {
  it('null si no hay lookup path', async () => {
    const r = await lookupGuiaByReferenciaLioren(payload, { LIOREN_TOKEN: 'tok' });
    expect(r).toBeNull();
  });

  it('recupera folio por referencia', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ folio: 7, id: 1 }), { status: 200 })));
    const r = await lookupGuiaByReferenciaLioren(payload, {
      LIOREN_TOKEN: 'tok',
      LIOREN_LOOKUP_PATH: '/dtes',
    });
    expect(r).toMatchObject({ estado: 'EMITIDA', folio: '7', proveedor: 'lioren' });
  });
});
