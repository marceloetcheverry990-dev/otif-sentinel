import { describe, expect, it } from 'vitest';
import { envIsolationReport } from './env-isolation.js';

describe('envIsolationReport', () => {
  it('staging con SHARED_DATASTORE avisa', () => {
    const r = envIsolationReport({
      ENVIRONMENT: 'staging',
      SHARED_DATASTORE: 'true',
      QA_DRIVER_RESET: 'true',
      DTE_ALLOW_STUB: 'true',
    });
    expect(r.environment).toBe('staging');
    expect(r.shared_datastore).toBe(true);
    expect(r.warnings).toContain('staging_shares_datastore');
  });

  it('producción no permite QA reset ni stub', () => {
    const r = envIsolationReport({
      ENVIRONMENT: 'production',
      DTE_PROVIDER: 'stub',
    });
    expect(r.warnings).toContain('dte_needs_real_provider');
    expect(r.warnings).not.toContain('qa_reset_enabled_in_production');
  });

  it('staging aislado no avisa datastore compartido', () => {
    const r = envIsolationReport({
      ENVIRONMENT: 'staging',
      SHARED_DATASTORE: 'false',
      DTE_ALLOW_STUB: 'true',
    });
    expect(r.warnings).not.toContain('staging_shares_datastore');
  });
});
