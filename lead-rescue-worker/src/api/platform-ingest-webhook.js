/**
 * Webhooks nativos por plataforma → mapeo → ingest canónico.
 *
 * POST /api/webhooks/shopify
 * POST /api/webhooks/woocommerce
 * POST /api/webhooks/sap
 * POST /api/webhooks/netsuite
 * POST /api/webhooks/pos
 *
 * Tenant: header X-Tenant-Id (o ?tenant= / body.tenant_id en SAP/NS/POS).
 */

import { CORS_HEADERS, requireTenantId } from '../config.js';
import { ingestCanonicalOrders } from './order-ingest-webhook.js';
import {
  resolvePlatformSecret,
  verifyShopifyHmac,
  verifyWooHmac,
  verifyHexSha256Header,
} from '../helpers/integrations/hmac.js';
import { PLATFORM_MAPPERS } from '../helpers/integrations/mappers.js';
import { withMonitoring } from '../monitoring/middleware.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function resolveTenant(request, payload) {
  const url = new URL(request.url);
  return String(
    request.headers.get('x-tenant-id')
    || url.searchParams.get('tenant')
    || payload?.tenant_id
    || ''
  ).trim();
}

async function handlePlatformIngest(request, env, platform) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const mapper = PLATFORM_MAPPERS[platform];
  if (!mapper) return json({ error: `Plataforma desconocida: ${platform}` }, 400);

  const rawBody = await request.arrayBuffer();
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return json({ error: 'Body JSON inválido' }, 400);
  }

  const tenantId = resolveTenant(request, payload);
  const tenantErr = requireTenantId(tenantId);
  if (tenantErr) return tenantErr;

  const secret = resolvePlatformSecret(env, platform, tenantId);
  if (!secret) {
    return json({
      error: `Service unavailable: webhook ${platform} not configured (secret)`,
      code: 'secret_missing',
    }, 503);
  }

  let okSig = false;
  if (platform === 'shopify') {
    okSig = await verifyShopifyHmac(
      rawBody,
      request.headers.get('x-shopify-hmac-sha256') || '',
      secret
    );
  } else if (platform === 'woocommerce') {
    okSig = await verifyWooHmac(
      rawBody,
      request.headers.get('x-wc-webhook-signature') || '',
      secret
    );
  } else {
    okSig = await verifyHexSha256Header(
      rawBody,
      request.headers.get('x-hub-signature-256') || '',
      secret
    );
  }

  if (!okSig) {
    return json({ error: 'Forbidden: invalid signature', platform }, 401);
  }

  // Shopify/Woo a veces mandan topics que no son órdenes
  if (platform === 'shopify') {
    const topic = String(request.headers.get('x-shopify-topic') || '').toLowerCase();
    if (topic && !topic.includes('order')) {
      return json({
        exito: true,
        ignored: true,
        reason: 'topic_no_order',
        topic,
      }, 200);
    }
  }

  const mapped = mapper(payload);
  if (!mapped.orders.length) {
    return json({
      exito: false,
      error: 'No se pudo mapear ninguna orden desde el payload',
      platform,
      warnings: mapped.warnings,
    }, 400);
  }

  return ingestCanonicalOrders(env, {
    tenantId,
    source: platform.toUpperCase(),
    orders: mapped.orders,
    extra: {
      platform,
      map_warnings: mapped.warnings,
      mapped_count: mapped.orders.length,
    },
  });
}

async function handleShopify(request, env) {
  return handlePlatformIngest(request, env, 'shopify');
}
async function handleWoo(request, env) {
  return handlePlatformIngest(request, env, 'woocommerce');
}
async function handleSap(request, env) {
  return handlePlatformIngest(request, env, 'sap');
}
async function handleNetSuite(request, env) {
  return handlePlatformIngest(request, env, 'netsuite');
}
async function handlePos(request, env) {
  return handlePlatformIngest(request, env, 'pos');
}

export const handleShopifyOrderWebhook = withMonitoring(handleShopify, {
  component: 'webhook-shopify',
});
export const handleWooCommerceOrderWebhook = withMonitoring(handleWoo, {
  component: 'webhook-woocommerce',
});
export const handleSapOrderWebhook = withMonitoring(handleSap, {
  component: 'webhook-sap',
});
export const handleNetSuiteOrderWebhook = withMonitoring(handleNetSuite, {
  component: 'webhook-netsuite',
});
export const handlePosOrderWebhook = withMonitoring(handlePos, {
  component: 'webhook-pos',
});

export {
  handlePlatformIngest,
  handleShopify,
  handleWoo,
  handleSap,
  handleNetSuite,
  handlePos,
};
