/**
 * Verificación HMAC para webhooks de plataformas (Shopify/Woo/genérico).
 */

function toBytes(rawBody) {
  if (rawBody instanceof ArrayBuffer) return new Uint8Array(rawBody);
  if (rawBody instanceof Uint8Array) return rawBody;
  return new TextEncoder().encode(String(rawBody || ''));
}

async function hmacSha256(rawBody, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, toBytes(rawBody));
  return new Uint8Array(sig);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function timingSafeEqualStr(a, b) {
  const aa = String(a || '');
  const bb = String(b || '');
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return out === 0;
}

/** Meta/GitHub style: sha256=<hex> */
export async function verifyHexSha256Header(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = `sha256=${bytesToHex(await hmacSha256(rawBody, secret))}`;
  const got = String(signature).trim().toLowerCase();
  return timingSafeEqualStr(expected, got);
}

/** Shopify: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(body)) */
export async function verifyShopifyHmac(rawBody, signatureBase64, secret) {
  if (!secret || !signatureBase64) return false;
  const expected = bytesToBase64(await hmacSha256(rawBody, secret));
  return timingSafeEqualStr(expected, String(signatureBase64).trim());
}

/** WooCommerce: X-WC-Webhook-Signature = base64(HMAC-SHA256(body)) */
export async function verifyWooHmac(rawBody, signatureBase64, secret) {
  return verifyShopifyHmac(rawBody, signatureBase64, secret);
}

/**
 * Resuelve secreto por plataforma+tenant.
 * Orden: PLATFORM_WEBHOOK_SECRETS["shopify:tenant"] → SHOPIFY_WEBHOOK_SECRET → ORDER_INGEST_SECRET
 */
export function resolvePlatformSecret(env, platform, tenantId) {
  const tid = String(tenantId || '').trim();
  const plat = String(platform || '').trim().toLowerCase();
  if (env.PLATFORM_WEBHOOK_SECRETS) {
    try {
      const map = JSON.parse(env.PLATFORM_WEBHOOK_SECRETS);
      const key = `${plat}:${tid}`;
      if (map && typeof map[key] === 'string' && map[key]) return map[key];
      if (map && typeof map[plat] === 'string' && map[plat]) return map[plat];
    } catch (_) {
      /* ignore */
    }
  }
  const envKey = {
    shopify: 'SHOPIFY_WEBHOOK_SECRET',
    woocommerce: 'WOOCOMMERCE_WEBHOOK_SECRET',
    sap: 'SAP_WEBHOOK_SECRET',
    netsuite: 'NETSUITE_WEBHOOK_SECRET',
    pos: 'POS_WEBHOOK_SECRET',
  }[plat];
  if (envKey && env[envKey]) return String(env[envKey]);
  if (env.ORDER_INGEST_SECRET) return String(env.ORDER_INGEST_SECRET);
  return null;
}
