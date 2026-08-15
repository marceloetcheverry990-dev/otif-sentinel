import { describe, expect, it } from 'vitest';
import { encryptSecret } from './secret-at-rest.js';
import { resolveDteEnv } from './resolve-dte-env.js';

const SECRET = { DASHBOARD_SECRET: 'test-dashboard-secret-32-bytes-min!!' };

describe('resolveDteEnv (R2/R4)', () => {
  it('stub no exige token de tenant', async () => {
    const env = await resolveDteEnv({ DTE_PROVIDER: 'stub' }, null);
    expect(env.DTE_IDENTITY_ERROR).toBeNull();
    expect(env.DTE_PROVIDER).toBe('stub');
  });

  it('simpleapi sin tenant settings falla con error claro', async () => {
    const env = await resolveDteEnv(
      { DTE_PROVIDER: 'simpleapi', DTE_RUT_EMISOR: '76.1-1', SIMPLEAPI_TOKEN: 'global-token' },
      null
    );
    expect(env.DTE_IDENTITY_ERROR).toMatch(/dte_identity_missing/);
    expect(env.SIMPLEAPI_TOKEN).toBeNull();
    expect(env.DTE_RUT_EMISOR).toBeNull();
  });

  it('simpleapi usa solo settings del tenant (plaintext legacy)', async () => {
    const env = await resolveDteEnv(
      { DTE_PROVIDER: 'simpleapi', DTE_RUT_EMISOR: '76.GLOBAL-1', SIMPLEAPI_TOKEN: 'global' },
      {
        dte_provider: 'simpleapi',
        dte_rut_emisor: '76.TENANT-9',
        dte_api_token: 'tenant-token',
        dte_razon_social: 'Tenant SpA',
      }
    );
    expect(env.DTE_IDENTITY_ERROR).toBeNull();
    expect(env.DTE_RUT_EMISOR).toBe('76.TENANT-9');
    expect(env.SIMPLEAPI_TOKEN).toBe('tenant-token');
  });

  it('R4: descifra dte_api_token enc$v1$', async () => {
    const sealed = await encryptSecret('tenant-secret-token', SECRET);
    const env = await resolveDteEnv(
      { DTE_PROVIDER: 'simpleapi', ...SECRET },
      {
        dte_provider: 'simpleapi',
        dte_rut_emisor: '76.TENANT-9',
        dte_api_token: sealed,
      }
    );
    expect(env.DTE_IDENTITY_ERROR).toBeNull();
    expect(env.SIMPLEAPI_TOKEN).toBe('tenant-secret-token');
  });

  it('DTE_ALLOW_GLOBAL_IDENTITY habilita fallback env', async () => {
    const env = await resolveDteEnv(
      {
        DTE_PROVIDER: 'simpleapi',
        DTE_RUT_EMISOR: '76.GLOBAL-1',
        SIMPLEAPI_TOKEN: 'global',
        DTE_ALLOW_GLOBAL_IDENTITY: 'true',
      },
      null
    );
    expect(env.DTE_IDENTITY_ERROR).toBeNull();
    expect(env.DTE_RUT_EMISOR).toBe('76.GLOBAL-1');
    expect(env.SIMPLEAPI_TOKEN).toBe('global');
  });
});
