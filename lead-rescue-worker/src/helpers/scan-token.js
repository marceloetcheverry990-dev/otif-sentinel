/**
 * C-11: token de paquete no derivable del ot_id sin el secreto del servidor.
 * El QR debe llevar este token (o JSON {scan_token}); el servidor lo recomputa.
 */

function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function getScanSecret(env) {
  return env?.SCAN_TOKEN_SECRET || env?.JWT_SECRET || null;
}

/**
 * @returns {Promise<string|null>} token corto (base64url) o null si no hay secreto
 */
export async function computeScanToken(tenantId, otId, env) {
  const secret = getScanSecret(env);
  if (!secret || !tenantId || !otId) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`scan:v1:${tenantId}:${otId}`)
  );
  return b64url(new Uint8Array(sig).slice(0, 16));
}

/**
 * Extrae candidato a token desde raw (texto plano o JSON).
 */
export function extractScanTokenCandidate(raw) {
  if (raw == null) return '';
  const data = String(raw).trim();
  if (!data) return '';
  if (data.startsWith('{')) {
    try {
      const obj = JSON.parse(data);
      const t = obj?.scan_token || obj?.token || obj?.codigo;
      if (t) return String(t).trim();
    } catch {
      /* fall through */
    }
  }
  return data;
}

/**
 * Verifica escaneo contra token HMAC (preferido) o token persistido en metadata.
 * Legacy: solo si no hay secreto configurado, permite match con ot_id.
 */
export async function verifyPackageScan({
  scannedRaw,
  stopId,
  tenantId,
  env,
  storedToken = null,
}) {
  const candidate = extractScanTokenCandidate(scannedRaw);
  if (!candidate) return { ok: false, code: 'scan_required' };

  if (storedToken && candidate === String(storedToken).trim()) {
    return { ok: true, mode: 'stored' };
  }

  const expected = await computeScanToken(tenantId, stopId, env);
  if (expected && candidate === expected) {
    return { ok: true, mode: 'hmac' };
  }

  // Sin secreto en el entorno: fallback legacy (no ideal; solo para lab local)
  if (!expected && candidate === String(stopId).trim()) {
    return { ok: true, mode: 'legacy_ot_id' };
  }

  return { ok: false, code: 'scan_mismatch' };
}
