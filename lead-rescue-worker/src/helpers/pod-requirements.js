/**
 * Requisitos POD por tenant / orden.
 * Default de producto: foto + firma + scan.
 */

export const DEFAULT_POD_REQUIREMENTS = Object.freeze({
  foto: true,
  firma: true,
  scan: true,
  notas: false,
});

/** Piloto: POD_SCAN_ENABLED=false desconecta escaneo QR sin borrar código. */
export function isPodScanEnabled(env) {
  const v = String(env?.POD_SCAN_ENABLED ?? 'false').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function applyPilotPodFlags(req, env) {
  if (env && !isPodScanEnabled(env)) {
    return { ...req, scan: false };
  }
  return req;
}

function coerceBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === '0' || v === 'false' || v === 'False') return false;
  if (v === 1 || v === '1' || v === 'true' || v === 'True') return true;
  return fallback;
}

export function normalizePodRequirements(raw) {
  const base = { ...DEFAULT_POD_REQUIREMENTS };
  if (!raw || typeof raw !== 'object') return base;
  return {
    foto: coerceBool(raw.foto, base.foto),
    firma: coerceBool(raw.firma, base.firma),
    scan: coerceBool(raw.scan, base.scan),
    notas: coerceBool(raw.notas, base.notas),
  };
}

/**
 * Orden metadata.pod_requirements gana sobre tenant.
 */
export function resolvePodRequirements({ tenantSettings, orderMetadata, env } = {}) {
  const fromTenant = normalizePodRequirements(tenantSettings?.pod_requirements);
  const meta = orderMetadata && typeof orderMetadata === 'object' ? orderMetadata : {};
  let resolved;
  if (meta.pod_requirements && typeof meta.pod_requirements === 'object') {
    resolved = normalizePodRequirements({ ...fromTenant, ...meta.pod_requirements });
  } else {
    resolved = fromTenant;
  }
  return applyPilotPodFlags(resolved, env);
}
