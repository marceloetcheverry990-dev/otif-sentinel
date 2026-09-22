import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  sealSecret,
} from './secret-at-rest.js';

const ENV = {
  DASHBOARD_SECRET: 'test-dashboard-secret-32-bytes-min!!',
  DTE_TOKEN_ENCRYPTION_KEY: 'test-dte-encryption-key-32-bytes-min!!',
};
const ENV_SOLO_DASHBOARD = { DASHBOARD_SECRET: 'test-dashboard-secret-32-bytes-min!!' };

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

  it('falla sin clave larga (aun con el flag de compat, el fallback corto no sirve)', async () => {
    await expect(
      encryptSecret('x', { DASHBOARD_SECRET: 'short', DTE_ALLOW_SHARED_ENCRYPTION_KEY: 'true' })
    ).rejects.toThrow(/requerido/);
  });

  it('cifrar un secreto NUEVO exige DTE_TOKEN_ENCRYPTION_KEY dedicada — no reusa DASHBOARD_SECRET por defecto', async () => {
    await expect(encryptSecret('token-real', ENV_SOLO_DASHBOARD)).rejects.toThrow(/DTE_TOKEN_ENCRYPTION_KEY/);
  });

  it('DTE_ALLOW_SHARED_ENCRYPTION_KEY=true restaura el fallback a DASHBOARD_SECRET para cifrar', async () => {
    const envCompat = { ...ENV_SOLO_DASHBOARD, DTE_ALLOW_SHARED_ENCRYPTION_KEY: 'true' };
    const blob = await encryptSecret('token-real', envCompat);
    expect(isEncryptedSecret(blob)).toBe(true);
    expect(await decryptSecret(blob, envCompat)).toBe('token-real');
  });

  it('descifrar SIEMPRE puede caer a DASHBOARD_SECRET (compatibilidad hacia atrás, sin flag)', async () => {
    // Sellado con la clave dedicada, pero un env que luego solo tiene DASHBOARD_SECRET
    // (p.ej. si DTE_TOKEN_ENCRYPTION_KEY se agrega recién ahora) sigue pudiendo
    // descifrar lo que YA estaba cifrado con DASHBOARD_SECRET.
    const blob = await encryptSecret('token-viejo', { ...ENV_SOLO_DASHBOARD, DTE_ALLOW_SHARED_ENCRYPTION_KEY: 'true' });
    expect(await decryptSecret(blob, ENV_SOLO_DASHBOARD)).toBe('token-viejo');
  });
});
