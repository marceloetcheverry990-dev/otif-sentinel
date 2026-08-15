import { describe, it, expect } from 'vitest';
import {
  computeScanToken,
  extractScanTokenCandidate,
  verifyPackageScan,
} from './scan-token.js';

const ENV = { JWT_SECRET: 'test-secret-32-bytes-minimum-len!!' };

describe('scan-token (C-11)', () => {
  it('computeScanToken es estable y distinto del ot_id', async () => {
    const a = await computeScanToken('empresa_a', '1001', ENV);
    const b = await computeScanToken('empresa_a', '1001', ENV);
    const c = await computeScanToken('empresa_b', '1001', ENV);
    expect(a).toBe(b);
    expect(a).not.toBe('1001');
    expect(a).not.toBe(c);
    expect(a.length).toBeGreaterThan(10);
  });

  it('extractScanTokenCandidate lee JSON', () => {
    expect(extractScanTokenCandidate('{"scan_token":"abc"}')).toBe('abc');
    expect(extractScanTokenCandidate('plain')).toBe('plain');
  });

  it('verifyPackageScan acepta HMAC y rechaza ot_id crudo', async () => {
    const token = await computeScanToken('t1', 'OT-9', ENV);
    const ok = await verifyPackageScan({
      scannedRaw: token,
      stopId: 'OT-9',
      tenantId: 't1',
      env: ENV,
    });
    expect(ok.ok).toBe(true);

    const bad = await verifyPackageScan({
      scannedRaw: 'OT-9',
      stopId: 'OT-9',
      tenantId: 't1',
      env: ENV,
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('scan_mismatch');
  });

  it('verifyPackageScan acepta token persistido', async () => {
    const r = await verifyPackageScan({
      scannedRaw: 'stored-xyz',
      stopId: 'OT-1',
      tenantId: 't1',
      env: ENV,
      storedToken: 'stored-xyz',
    });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('stored');
  });
});
