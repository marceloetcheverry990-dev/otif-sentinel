// Shared evidence image validation + upload helpers.

const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

const MAGIC = {
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
  webp: null, // RIFF....WEBP — checked separately
};

function startsWith(bytes, sig) {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ ok: true, mime: string, ext: string } | { ok: false, error: string }}
 */
export function detectImageMagic(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) {
    return { ok: false, error: 'Archivo de imagen inválido o vacío' };
  }
  if (startsWith(bytes, MAGIC.jpeg)) {
    return { ok: true, mime: 'image/jpeg', ext: 'jpg' };
  }
  if (startsWith(bytes, MAGIC.png)) {
    return { ok: true, mime: 'image/png', ext: 'png' };
  }
  // WEBP: RIFF....WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { ok: true, mime: 'image/webp', ext: 'webp' };
  }
  return { ok: false, error: 'Tipo de imagen no permitido (solo JPEG/PNG/WebP)' };
}

/**
 * Decode base64 data-URL or raw base64 into bytes with size cap.
 * @param {string} photo
 */
export function decodeBase64Image(photo) {
  if (typeof photo !== 'string' || !photo) {
    return { ok: false, error: 'Falta el campo photo (base64)' };
  }
  // Rough pre-check: base64 expands ~4/3
  if (photo.length > Math.ceil(MAX_BYTES * 1.4) + 128) {
    return { ok: false, error: `Imagen excede el límite de ${MAX_BYTES} bytes` };
  }

  const base64Data = photo.includes(',') ? photo.split(',')[1] : photo;
  let binary;
  try {
    binary = atob(base64Data);
  } catch {
    return { ok: false, error: 'Base64 inválido' };
  }
  if (binary.length > MAX_BYTES) {
    return { ok: false, error: `Imagen excede el límite de ${MAX_BYTES} bytes` };
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const magic = detectImageMagic(bytes);
  if (!magic.ok) return magic;
  return { ok: true, bytes, mime: magic.mime, ext: magic.ext };
}

/**
 * Upload validated image to Supabase evidencias with random key.
 * @returns {Promise<{ ok: true, url: string, fileName: string } | { ok: false, error: string }>}
 */
export async function uploadEvidenceImage(supabase, { tenant_id, photo, prefix = 'ev' }) {
  const decoded = decodeBase64Image(photo);
  if (!decoded.ok) return decoded;

  const fileName = `${tenant_id}/${prefix}_${crypto.randomUUID()}.${decoded.ext}`;
  const { error: uploadError } = await supabase.storage
    .from('evidencias')
    .upload(fileName, decoded.bytes, {
      contentType: decoded.mime,
      upsert: false,
    });

  if (uploadError) {
    return { ok: false, error: `Upload falló: ${uploadError.message}` };
  }

  const { data: publicData } = supabase.storage.from('evidencias').getPublicUrl(fileName);
  return { ok: true, url: publicData.publicUrl, fileName };
}

/**
 * Allow only evidence URLs under this project's Supabase storage for the tenant.
 * @param {string|null|undefined} url
 * @param {{ SUPABASE_URL?: string }} env
 * @param {string} tenant_id
 */
export function isTrustedEvidenceUrl(url, env, tenant_id) {
  if (url == null || url === '') return true; // optional field
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;

  const base = env.SUPABASE_URL ? new URL(env.SUPABASE_URL) : null;
  if (!base) return false;
  if (parsed.hostname !== base.hostname) return false;

  // M-5: anclar prefijo; decodificar %2e%2e antes de comparar
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (path.includes('..')) return false;
  const marker = `/storage/v1/object/public/evidencias/${tenant_id}/`;
  return path.startsWith(marker);
}
