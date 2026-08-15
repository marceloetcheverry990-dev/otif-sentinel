// Parser for the optional ACEPTA financial file uploaded with syncExcel.
// xlsx was removed (unpatched SheetJS vulns); operators must upload CSV.

import { parseCSVLine } from './csv.js';

const MAX_BYTES = 5 * 1024 * 1024;

function looksLikeZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function cleanFinancial(val) {
  const num = Number(val?.toString().replace(/[^0-9.-]+/g, ''));
  return Number.isNaN(num) ? 0 : num;
}

function sanitizeFolio(val) {
  if (val === null || val === undefined) return null;
  // Debe coincidir con sync.js: alfanumérico + guiones (no colapsar A-1001 y B-1001 a "1001")
  const cleaned = val.toString().trim().toUpperCase().replace(/[^A-Z0-9._:-]/g, '');
  return cleaned === '' ? null : cleaned;
}

/**
 * @param {ArrayBuffer} buffer
 * @param {string} [fileName]
 * @returns {Record<string, { monto_total: number, uri: string|null }>}
 */
export function parseAceptaCsv(buffer, fileName = '') {
  if (!buffer || buffer.byteLength === 0) return {};
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error('Archivo ACEPTA excede 5MB');
  }

  const bytes = new Uint8Array(buffer);
  const name = String(fileName || '').toLowerCase();

  if (looksLikeZip(bytes) || name.endsWith('.xlsx') || name.endsWith('.xls')) {
    throw new Error(
      'ACEPTA en Excel ya no está soportado por seguridad. Exporta a CSV (Folio, Monto_Total, Uri) e intenta de nuevo.'
    );
  }

  const text = new TextDecoder('utf-8').decode(bytes);
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length <= 1) return {};

  const headers = parseCSVLine(lines[0]).map((h) => h.trim().toUpperCase());
  const idxFolio = headers.findIndex((h) => h === 'FOLIO');
  const idxMonto = headers.findIndex((h) => h === 'MONTO_TOTAL' || h === 'MONTO TOTAL');
  const idxUri = headers.findIndex((h) => h === 'URI');

  if (idxFolio === -1) {
    throw new Error('CSV ACEPTA sin columna Folio');
  }

  const dict = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const folio = sanitizeFolio(cols[idxFolio]);
    if (!folio) continue;
    dict[folio] = {
      monto_total: idxMonto >= 0 ? cleanFinancial(cols[idxMonto]) : 0,
      uri: idxUri >= 0 ? (cols[idxUri] || null) : null,
    };
  }
  return dict;
}
