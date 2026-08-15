/**
 * Normaliza el contenido de un QR/barcode de paquete a un ot_id comparable.
 * Acepta: "OT-123", URLs con ?ot_id=, o path .../OT-123
 */

export function normalizeScannedCode(raw) {
  if (raw == null) return '';
  let data = String(raw).trim();
  if (!data) return '';

  // JSON {"ot_id":"..."} 
  if (data.startsWith('{')) {
    try {
      const obj = JSON.parse(data);
      if (obj && (obj.ot_id || obj.otId || obj.stop_id)) {
        return String(obj.ot_id || obj.otId || obj.stop_id).trim();
      }
    } catch {
      /* fall through */
    }
  }

  // M-4: solo parsear URL real (http/https). "SCL:99871" no es URL.
  if (/^https?:\/\//i.test(data)) {
    try {
      const u = new URL(data);
      const q =
        u.searchParams.get('ot_id') ||
        u.searchParams.get('ot') ||
        u.searchParams.get('stop_id');
      if (q) return String(q).trim();
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length) return decodeURIComponent(parts[parts.length - 1]).trim();
    } catch {
      /* fall through */
    }
  }

  return data;
}

export function scannedMatchesStop(scannedRaw, stopId) {
  const expected = String(stopId || '').trim();
  if (!expected) return false;
  const got = normalizeScannedCode(scannedRaw);
  if (!got) return false;
  return got === expected;
}
