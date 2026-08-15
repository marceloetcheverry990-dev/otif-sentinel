import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  sealSecret,
} from './secret-at-rest.js';

const ENV = { DASHBOARD_SECRET: 'test-dashboard-secret-32-bytes-min!!' };

describe('secret-at-rest (R4)', () => {
  it('round-trip AES-GCM', async () => {
    const blob = await encryptSecret('simpleapi-token-xyz', ENV);
    expect(isEncryptedSecret(blob)).toBe(true);
    expect(blob).not.toContain('simpleapi-token-xyz');
    expect(await decryptSecret(blob, ENV)).toBe('simpleapi-token-xyz');
  });

  it('plaintext pasa sin tocar en decrypt', async () => {
    expect(await decryptSecret('plain-token', ENV)).toBe('plain-token');
  });

  it('sealSecret no re-cifra blob ya cifrado', async () => {
    const once = await encryptSecret('abc', ENV);
    const again = await sealSecret(once, ENV);
    expect(again.value).toBe(once);
    expect(again.sealed).toBe(false);
  });

  it('falla sin clave larga', async () => {
    await expect(encryptSecret('x', { DASHBOARD_SECRET: 'short' })).rejects.toThrow(/requerido/);
  });
});
