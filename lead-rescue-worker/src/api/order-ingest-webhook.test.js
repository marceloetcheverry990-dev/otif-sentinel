import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleOrderIngestWebhookCore,
  resolveOrderIngestSecret,
} from './order-ingest-webhook.js';
import { OrderIngestPayloadSchema } from '../config.js';

const SECRET = 'order-ingest-test-secret-32bytes-min!!';
const TENANT = 'empresa_base';

let pgQueryMock;

vi.mock('../db.js', () => ({
  withDbTransaction: async (_env, cb) => {
    const client = {
      query: (...args) => pgQueryMock(...args),
    };
    return cb(client);
  },
}));

vi.mock('../helpers/geocode.js', () => ({
  geocodeAddress: vi.fn(async () => null),
}));

vi.mock('../monitoring/middleware.js', () => ({
  withMonitoring: (fn) => fn,
}));

async function signBody(rawText, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawText));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `sha256=${hex}`;
}

function makeRequest(bodyObj, { tenant = TENANT, secret = SECRET, badSig = false } = {}) {
  const raw = JSON.stringify(bodyObj);
  return (async () => {
    const sig = badSig ? 'sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : await signBody(raw, secret);
    return new Request('https://worker.test/api/webhooks/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': tenant,
        'X-Hub-Signature-256': sig,
      },
      body: raw,
    });
  })();
}

describe('resolveOrderIngestSecret', () => {
  it('usa mapa por tenant', () => {
    expect(
      resolveOrderIngestSecret(
        { ORDER_INGEST_SECRETS: JSON.stringify({ [TENANT]: SECRET }) },
        TENANT
      )
    ).toBe(SECRET);
  });

  it('cae al secreto global', () => {
    expect(resolveOrderIngestSecret({ ORDER_INGEST_SECRET: SECRET }, TENANT)).toBe(SECRET);
  });

  it('null si no hay secreto', () => {
    expect(resolveOrderIngestSecret({}, TENANT)).toBeNull();
  });
});

describe('OrderIngestPayloadSchema', () => {
  it('acepta payload minimo', () => {
    const r = OrderIngestPayloadSchema.safeParse({
      tenant_id: TENANT,
      orders: [{ ot_id: 'OT-100', cliente: 'ACME' }],
    });
    expect(r.success).toBe(true);
    expect(r.data.source).toBe('ERP');
  });

  it('acepta tags hazmat y depot_id', () => {
    const r = OrderIngestPayloadSchema.safeParse({
      tenant_id: TENANT,
      orders: [{
        ot_id: 'OT-HAZ-1',
        cliente: 'Quimica SA',
        requires_hazmat: true,
        tags_requeridos: ['FRIO'],
        depot_id: 'empresa_base-bodega-central',
      }],
    });
    expect(r.success).toBe(true);
    expect(r.data.orders[0].requires_hazmat).toBe(true);
    expect(r.data.orders[0].tags_requeridos).toEqual(['FRIO']);
  });
});

describe('handleOrderIngestWebhookCore', () => {
  beforeEach(() => {
    pgQueryMock = vi.fn(async () => ({ rowCount: 1, rows: [] }));
  });

  it('503 si no hay secreto configurado', async () => {
    const req = await makeRequest({
      tenant_id: TENANT,
      orders: [{ ot_id: '1', cliente: 'A' }],
    });
    const res = await handleOrderIngestWebhookCore(req, {});
    expect(res.status).toBe(503);
  });

  it('401 con firma invalida', async () => {
    const req = await makeRequest(
      { tenant_id: TENANT, orders: [{ ot_id: '1', cliente: 'A' }] },
      { badSig: true }
    );
    const res = await handleOrderIngestWebhookCore(req, { ORDER_INGEST_SECRET: SECRET });
    expect(res.status).toBe(401);
  });

  it('403 si tenant body != header', async () => {
    const req = await makeRequest({
      tenant_id: 'otro_tenant',
      orders: [{ ot_id: '1', cliente: 'A' }],
    });
    const res = await handleOrderIngestWebhookCore(req, { ORDER_INGEST_SECRET: SECRET });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('tenant_mismatch');
  });

  it('200 upsert camino feliz', async () => {
    const payload = {
      tenant_id: TENANT,
      source: 'Shopify',
      idempotency_key: 'batch-1',
      orders: [
        {
          ot_id: 'OT-9001',
          cliente: 'Casa Peñaflor',
          direccion: 'Pasaje Cordillera de Doña Ana 2610, Peñaflor',
          lat: -33.6103,
          lng: -70.8874,
          valor_oc_clp: 15000,
          fecha_hora_sla: '2026-07-22T20:00:00.000Z',
        },
      ],
    };
    const req = await makeRequest(payload);
    const res = await handleOrderIngestWebhookCore(req, { ORDER_INGEST_SECRET: SECRET });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exito).toBe(true);
    expect(body.prepared).toBe(1);
    expect(body.source).toBe('Shopify');
    expect(pgQueryMock).toHaveBeenCalled();
  });
});
