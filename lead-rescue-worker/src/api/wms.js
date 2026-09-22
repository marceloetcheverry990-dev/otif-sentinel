// src/api/wms.js
//Este archivo se encargará exclusivamente de recibir las órdenes de bodega, validarlas de forma segura y mandarlas a la cola de procesamiento.
import { WebhookSchema } from '../config.js';
import { verifyMetaSignature } from '../utils.js';
import { withMonitoring } from '../monitoring/middleware.js';

async function handleWMSWebhookCore(request, env, ctx) {
  try {
    const rawBody = await request.arrayBuffer();
    if (!env.META_APP_SECRET) {
      console.error('[WMS_CONFIG_ERROR] META_APP_SECRET is not configured');
      return new Response('Service unavailable', { status: 503 });
    }
    if (!(await verifyMetaSignature(rawBody, request.headers.get('x-hub-signature-256') || "", env.META_APP_SECRET))) return new Response('Forbidden', { status: 401 });
    const payload = JSON.parse(new TextDecoder().decode(rawBody));
    // Un solo secreto global (META_APP_SECRET) => en la práctica este webhook
    // sirve a un solo tenant hoy. tenant_id explícito en el update gana si viene.
    const defaultTenantId = env.WMS_WEBHOOK_TENANT_ID || env.MONITORING_TENANT_ID || null;
    const ots = [];
    for (const update of payload.updates || []) {
        const parsed = WebhookSchema.safeParse(update);
        if (!parsed.success) continue;
        const tenant_id = parsed.data.tenant_id || defaultTenantId;
        if (!tenant_id) continue; // sin tenant no hay a dónde escribir
        const cryptoApi = globalThis.crypto;
        const traceId = (typeof cryptoApi !== 'undefined' && cryptoApi.randomUUID) ? cryptoApi.randomUUID() : `${Date.now()}-${Math.random()}`;
        ots.push({ body: { ot_id: parsed.data.ot_id, tenant_id, created_at: new Date().toISOString(), data: parsed.data, t: traceId }, contentType: 'json' });
    }
    if (ots.length > 0) {
       await env.MAIN_QUEUE.sendBatch(ots);
    }
    return new Response('Accepted', { status: 202 });
  } catch (e) { return new Response('Error', { status: 500 }); }
}

// Wrapped with monitoring middleware - Task 4.5
export const handleWMSWebhook = withMonitoring(handleWMSWebhookCore, { component: 'wms-webhook' });