import { describe, expect, it } from 'vitest';
import { parseAceptaCsv } from './acepta-csv.js';

describe('parseAceptaCsv', () => {
  it('parsea CSV con Folio, Monto_Total y Uri', () => {
    const csv = 'Folio,Monto_Total,Uri\n12345,1500.5,https://example.com/a\n';
    const buf = new TextEncoder().encode(csv).buffer;
    const dict = parseAceptaCsv(buf, 'acepta.csv');
    expect(dict['12345']).toEqual({
      monto_total: 1500.5,
      uri: 'https://example.com/a',
    });
  });

  it('rechaza archivos xlsx (PK zip magic)', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(() => parseAceptaCsv(bytes.buffer, 'acepta.xlsx')).toThrow(/CSV/);
  });

  it('conserva prefijos alfanuméricos del Folio (alineado con sync OT_ID)', () => {
    const csv = 'Folio,Monto_Total,Uri\nA-1001,2000,https://example.com/b\nSPOT-99,500,\n';
    const buf = new TextEncoder().encode(csv).buffer;
    const dict = parseAceptaCsv(buf, 'acepta.csv');
    expect(dict['A-1001'].monto_total).toBe(2000);
    expect(dict['SPOT-99'].monto_total).toBe(500);
  });
});
