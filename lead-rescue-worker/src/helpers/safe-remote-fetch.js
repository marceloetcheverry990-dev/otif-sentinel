// SSRF-hardened fetch for operator-controlled remote URLs (e.g. syncExcel).

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
const DEFAULT_TIMEOUT_MS = 15_000;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
]);

function ipv4ToInt(ip) {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isBlockedIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  // 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 224/4 (multicast+)
  // >>> 0 fuerza unsigned: sin él, máscaras con bit alto (>= 0x80000000) comparan mal
  if (((n & 0xff000000) >>> 0) === 0x00000000) return true;
  if (((n & 0xff000000) >>> 0) === 0x0a000000) return true;
  if (((n & 0xff000000) >>> 0) === 0x7f000000) return true;
  if (((n & 0xffff0000) >>> 0) === 0xa9fe0000) return true;
  if (((n & 0xfff00000) >>> 0) === 0xac100000) return true;
  if (((n & 0xffff0000) >>> 0) === 0xc0a80000) return true;
  if (((n & 0xf0000000) >>> 0) === 0xe0000000) return true;
  return false;
}

function isBlockedIpv6(host) {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // ULA
  if (h.startsWith('fe80')) return true; // link-local
  return false;
}

/**
 * @param {string} rawUrl
 * @param {{ allowedHosts?: string[] }} [opts]
 * @returns {{ ok: true, url: URL } | { ok: false, error: string }}
 */
export function validateRemoteUrl(rawUrl, opts = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return { ok: false, error: 'URL inválida' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'Solo se permiten URLs HTTPS' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'URL con credenciales no permitida' };
  }

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: 'Host no permitido' };
  }

  // Literal IPv4 / IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isBlockedIpv4(host)) {
    return { ok: false, error: 'IP privada o reservada no permitida' };
  }
  if (host.includes(':') && isBlockedIpv6(host.replace(/^\[|\]$/g, ''))) {
    return { ok: false, error: 'IP privada o reservada no permitida' };
  }

  if (opts.allowedHosts?.length) {
    const allow = opts.allowedHosts.map((h) => h.toLowerCase());
    if (!allow.includes(host)) {
      return { ok: false, error: 'Host fuera de la allowlist' };
    }
  }

  return { ok: true, url };
}

/**
 * Fetch remote body with redirect denial, timeout, and size cap.
 * @param {string} rawUrl
 * @param {{ maxBytes?: number, timeoutMs?: number, allowedHosts?: string[] }} [opts]
 */
export async function fetchRemoteTextSafe(rawUrl, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const validated = validateRemoteUrl(rawUrl, { allowedHosts: opts.allowedHosts });
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(validated.url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'text/csv,text/plain,*/*' },
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirecciones remotas no permitidas');
    }
    if (!response.ok) {
      throw new Error(`Error descargando recurso: ${response.status} ${response.statusText}`);
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) {
      throw new Error(`Archivo remoto excede el límite de ${maxBytes} bytes`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      if (text.length > maxBytes) {
        throw new Error(`Archivo remoto excede el límite de ${maxBytes} bytes`);
      }
      return text;
    }

    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Archivo remoto excede el límite de ${maxBytes} bytes`);
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged);
  } finally {
    clearTimeout(timer);
  }
}
