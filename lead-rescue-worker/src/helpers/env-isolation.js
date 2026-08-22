/**
 * Informe de aislamiento staging vs producción.
 * No tumba /health: avisa si staging sigue usando el mismo datastore que prod.
 */

export function envIsolationReport(env = {}) {
  const environment = String(env.ENVIRONMENT || env.WORKER_ENV || '').toLowerCase() || 'unspecified';
  const shared = String(env.SHARED_DATASTORE || '').toLowerCase() === 'true';
  const qaReset = String(env.QA_DRIVER_RESET || '') === 'true';
  const stubAllowed = String(env.DTE_ALLOW_STUB || '').toLowerCase() === 'true';
  const provider = String(env.DTE_PROVIDER || 'stub').toLowerCase();

  const warnings = [];
  if (environment === 'staging' && shared) {
    warnings.push('staging_shares_datastore');
  }
  if (environment === 'production' && shared) {
    warnings.push('production_marked_shared_datastore');
  }
  if (environment === 'production' && qaReset) {
    warnings.push('qa_reset_enabled_in_production');
  }
  if (environment === 'production' && stubAllowed) {
    warnings.push('dte_stub_allowed_in_production');
  }
  if (environment === 'production' && provider === 'stub' && !stubAllowed) {
    warnings.push('dte_needs_real_provider');
  }

  return {
    environment,
    shared_datastore: shared,
    qa_driver_reset: qaReset,
    dte_provider: provider,
    dte_allow_stub: stubAllowed,
    warnings,
  };
}
