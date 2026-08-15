// src/helpers/tower-operators.test.js
import { describe, it, expect } from 'vitest';
import { hashPin, verifyPin } from './pin-kdf.js';
import { passwordEnv } from './tower-operators.js';
import { signOperatorToken, verifyOperatorToken } from './operator-auth.js';

const ENV = {
  DASHBOARD_SECRET: 'test-dashboard-secret-32-bytes!!',
  MONITORING_USERNAME: 'admin',
  MONITORING_PASSWORD: 'test-password-safe',
  MONITORING_TENANT_ID: 'empresa_base',
};

describe('tower operators identity in JWT', () => {
  it('firma y verifica token con sub + username + is_admin', async () => {
    const token = await signOperatorToken({
      role: 'operator',
      tenant_id: 'empresa_base',
      sub: 'op-123',
      username: 'marcelo',
      display_name: 'Marcelo',
      is_admin: true,
    }, ENV);

    const req = new Request('https://worker.test/control-tower', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await verifyOperatorToken(req, ENV);
    expect(result.ok).toBe(true);
    expect(result.payload.sub).toBe('op-123');
    expect(result.payload.username).toBe('marcelo');
    expect(result.payload.is_admin).toBe(true);
  });

  it('hashea password de operador con DASHBOARD_SECRET como pepper', async () => {
    const stored = await hashPin('secreto-largo-1', passwordEnv(ENV));
    expect(stored.startsWith('v1$')).toBe(true);
    const ok = await verifyPin('secreto-largo-1', stored, passwordEnv(ENV));
    expect(ok.ok).toBe(true);
    const bad = await verifyPin('otra-clave', stored, passwordEnv(ENV));
    expect(bad.ok).toBe(false);
  });
});
