import { describe, it, expect } from 'vitest';
import { normalizeScannedCode, scannedMatchesStop } from './scan-ot.js';

describe('normalizeScannedCode', () => {
  it('trimea texto plano', () => {
    expect(normalizeScannedCode('  OT-9001  ')).toBe('OT-9001');
  });

  it('lee ot_id de URL', () => {
    expect(normalizeScannedCode('https://app.example/p?ot_id=SPOT-01')).toBe('SPOT-01');
  });

  it('lee JSON', () => {
    expect(normalizeScannedCode('{"ot_id":"OT-42"}')).toBe('OT-42');
  });

  it('no mutila códigos PREFIJO:NUMERO (M-4)', () => {
    expect(normalizeScannedCode('SCL:99871')).toBe('SCL:99871');
    expect(scannedMatchesStop('SCL:99871', 'SCL:99871')).toBe(true);
  });
});

describe('scannedMatchesStop', () => {
  it('match exacto', () => {
    expect(scannedMatchesStop('OT-1', 'OT-1')).toBe(true);
  });

  it('mismatch', () => {
    expect(scannedMatchesStop('OT-2', 'OT-1')).toBe(false);
  });

  it('match via URL', () => {
    expect(scannedMatchesStop('https://x/y?ot_id=OT-1', 'OT-1')).toBe(true);
  });
});
