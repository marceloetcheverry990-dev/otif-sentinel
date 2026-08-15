import { describe, expect, it } from 'vitest';
import {
  StubEmisorDTE,
  ForbiddenStubEmisor,
  createEmisorDTE,
  validateRequiredFields,
} from './emisor-dte.js';
import { shouldSkipExisting } from './emit-on-salida.js';

const complete = {
  tenant_id: 'empresa_base',
  trip_id: 'T1',
  ot_id: 'OT-1',
  tipo_traslado: 'VENTA',
  conductor_rut: '1-9',
  conductor_nombre: 'Juan',
  patente: 'ABCD12',
  origen_direccion: 'Bodega 1',
  origen_comuna: 'Santiago',
  destino_direccion: 'Av. Siempre Viva 742',
  destino_comuna: 'La Florida',
  cantidad: 10,
  peso_kg: 100,
  volumen: 2,
  valor_clp: 50000,
  fecha_emision_iso: new Date().toISOString(),
};

describe('EmisorDTE', () => {
  it('validateRequiredFields detecta faltantes', () => {
    expect(validateRequiredFields({}).length).toBeGreaterThan(0);
    expect(validateRequiredFields(complete)).toEqual([]);
  });

  it('StubEmisorDTE usa STUB sin folio (S4)', async () => {
    const emisor = new StubEmisorDTE({});
    const r = await emisor.emitirGuia(complete);
    expect(r.estado).toBe('STUB');
    expect(r.folio).toBeNull();
    expect(r.proveedor).toBe('stub');
  });

  it('StubEmisorDTE ERROR si falta patente', async () => {
    const emisor = new StubEmisorDTE({});
    const r = await emisor.emitirGuia({ ...complete, patente: null });
    expect(r.estado).toBe('ERROR');
    expect(r.error).toMatch(/patente/);
  });

  it('ForbiddenStubEmisor en producción', async () => {
    const emisor = new ForbiddenStubEmisor({ ENVIRONMENT: 'production' });
    const r = await emisor.emitirGuia(complete);
    expect(r.estado).toBe('ERROR');
    expect(r.error).toMatch(/producción/);
  });

  it('createEmisorDTE respeta DTE_ALLOW_STUB en prod', async () => {
    const blocked = createEmisorDTE({ ENVIRONMENT: 'production', DTE_PROVIDER: 'stub' });
    expect(await blocked.emitirGuia(complete)).toMatchObject({ estado: 'ERROR' });
    const allowed = createEmisorDTE({
      ENVIRONMENT: 'production',
      DTE_PROVIDER: 'stub',
      DTE_ALLOW_STUB: 'true',
    });
    expect(await allowed.emitirGuia(complete)).toMatchObject({ estado: 'STUB', folio: null });
  });
});

describe('shouldSkipExisting (S3/S4)', () => {
  it('omite EMITIDA y EMITTING reciente', () => {
    expect(shouldSkipExisting({ estado: 'EMITIDA', folio: '1' })).toBe(true);
    expect(shouldSkipExisting({
      estado: 'EMITTING',
      updated_at: new Date().toISOString(),
    })).toBe(true);
  });

  it('permite reintentar STUB y ERROR', () => {
    expect(shouldSkipExisting({ estado: 'STUB', folio: null })).toBe(false);
    expect(shouldSkipExisting({ estado: 'ERROR', folio: null })).toBe(false);
    expect(shouldSkipExisting({ estado: 'SKIPPED', folio: 'STUB-x' })).toBe(false);
  });
});
