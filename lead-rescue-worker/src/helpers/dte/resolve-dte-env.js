/**
 * Combina settings de tenant + env Worker para EmisorDTE (S0 / R2 / R4).
 * CAF/certificado viven en el proveedor; aquí solo identidad + provider + token.
 *
 * R2: sin DTE_ALLOW_GLOBAL_IDENTITY, un provider real exige dte_rut_emisor +
 * dte_api_token del tenant. El fallback a env global es silencioso y peligroso
 * en multi-tenant (tenant B emite con la cuenta SII de A).
 *
 * R4: dte_api_token puede venir cifrado (enc$v1$...); se descifra aquí.
 */

import { decryptSecret, isEncryptedSecret } from './secret-at-rest.js';

/**
 * @param {object} env
 * @param {object|null} tenantSettings
 * @returns {Promise<object>} env enriquecido; puede incluir DTE_IDENTITY_ERROR
 */
export async function resolveDteEnv(env, tenantSettings = null) {
  const ts = tenantSettings || {};
  const provider = String(ts.dte_provider || env.DTE_PROVIDER || 'stub').toLowerCase();
  const allowGlobal = String(env.DTE_ALLOW_GLOBAL_IDENTITY || '').toLowerCase() === 'true';

  let rut = ts.dte_rut_emisor || null;
  let razon = ts.dte_razon_social || null;
  let ambiente = ts.dte_ambiente || null;
  let token = ts.dte_api_token || null;
  let decryptError = null;

  if (token && isEncryptedSecret(token)) {
    try {
      token = await decryptSecret(token, env);
    } catch (e) {
      decryptError = e.message || 'decrypt_failed';
      token = null;
    }
  }

  if (provider === 'stub') {
    // Stub no emite DTE real; env solo como metadata opcional
    return {
      ...env,
      DTE_PROVIDER: provider,
      DTE_RUT_EMISOR: rut || env.DTE_RUT_EMISOR || null,
      DTE_RAZON_SOCIAL: razon || env.DTE_RAZON_SOCIAL || null,
      DTE_AMBIENTE: ambiente || env.DTE_AMBIENTE || 'certificacion',
      SIMPLEAPI_TOKEN: null,
      LIOREN_TOKEN: null,
      DTE_IDENTITY_ERROR: null,
    };
  }

  if (allowGlobal) {
    rut = rut || env.DTE_RUT_EMISOR || null;
    razon = razon || env.DTE_RAZON_SOCIAL || null;
    ambiente = ambiente || env.DTE_AMBIENTE || null;
    token = token || env.SIMPLEAPI_TOKEN || env.LIOREN_TOKEN || null;
  }

  const missing = [];
  if (!rut) missing.push('dte_rut_emisor');
  if (!token) missing.push('dte_api_token');

  let identityError = null;
  if (decryptError) {
    identityError = `dte_api_token_decrypt_failed: ${decryptError}`;
  } else if (missing.length) {
    identityError =
      `dte_identity_missing: configure tenant_settings.${missing.join(' y ')} ` +
      '(o DTE_ALLOW_GLOBAL_IDENTITY=true en single-tenant)';
  }

  return {
    ...env,
    DTE_PROVIDER: provider,
    DTE_RUT_EMISOR: rut,
    DTE_RAZON_SOCIAL: razon,
    DTE_AMBIENTE: ambiente || env.DTE_AMBIENTE || 'certificacion',
    SIMPLEAPI_TOKEN: provider === 'lioren' ? (env.SIMPLEAPI_TOKEN || null) : token,
    LIOREN_TOKEN: provider === 'lioren' ? token : (env.LIOREN_TOKEN || null),
    DTE_IDENTITY_ERROR: identityError,
  };
}

/** Producción exige proveedor real salvo DTE_ALLOW_STUB=true */
export function isDteStubForbidden(env) {
  const allow = String(env.DTE_ALLOW_STUB || '').toLowerCase() === 'true';
  if (allow) return false;
  const envName = String(env.ENVIRONMENT || env.WORKER_ENV || '').toLowerCase();
  if (envName === 'production' || envName === 'prod') return true;
  if (String(env.DTE_REQUIRE_REAL_PROVIDER || '').toLowerCase() === 'true') return true;
  return false;
}
