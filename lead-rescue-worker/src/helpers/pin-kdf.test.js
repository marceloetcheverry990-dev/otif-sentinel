import { describe, expect, it } from 'vitest';
import { hashPin, isAccountActivated, isHashedPin, verifyPin } from './pin-kdf.js';

const env = { JWT_SECRET: 'x'.repeat(40) };

describe('pin-kdf', () => {
  it('hashea PIN y verifica correctamente', async () => {
    const stored = await hashPin('1234', env);
    expect(isHashedPin(stored)).toBe(true);
    expect(isAccountActivated(stored)).toBe(true);

    const ok = await verifyPin('1234', stored, env);
    expect(ok).toEqual({ ok: true, needsUpgrade: false });

    const bad = await verifyPin('9999', stored, env);
    expect(bad.ok).toBe(false);
  });

  it('acepta plaintext legacy y marca needsUpgrade', async () => {
    const legacy = await verifyPin('4321', '4321', env);
    expect(legacy).toEqual({ ok: true, needsUpgrade: true });

    const wrong = await verifyPin('0000', '4321', env);
    expect(wrong.ok).toBe(false);
  });

  it('hashes distintos para el mismo PIN (salt aleatorio)', async () => {
    const a = await hashPin('1234', env);
    const b = await hashPin('1234', env);
    expect(a).not.toBe(b);
  });
});
