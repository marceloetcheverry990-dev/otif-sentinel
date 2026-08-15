/**
 * Fixtures + tests: cada plataforma se mapea correctamente a OT canónica.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mapShopifyPayload,
  mapWooCommercePayload,
  mapSapPayload,
  mapNetSuitePayload,
  mapPosPayload,
} from '../helpers/integrations/mappers.js';
import {
  verifyShopifyHmac,
  verifyHexSha256Header,
  resolvePlatformSecret,
} from '../helpers/integrations/hmac.js';
import {
  handleShopify,
  handleWoo,
  handleSap,
  handleNetSuite,
  handlePos,
} from '../api/platform-ingest-webhook.js';

const TENANT = 'empresa_base';
const SECRET = 'test-platform-secret-32chars-min!!';

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

async function signShopify(body, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const bytes = new Uint8Array(sig);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function signHex(body, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

describe('mappers leen payloads reales', () => {
  it('Shopify → ot_id, cliente, dirección, monto', () => {
    const { orders, warnings } = mapShopifyPayload({
      id: 5678901234,
      name: '#1042',
      order_number: 1042,
      total_price: '45990.00',
      created_at: '2026-07-21T15:00:00-04:00',
      shipping_address: {
        name: 'María Pérez',
        address1: 'Av Providencia 1234',
        address2: 'Depto 501',
        city: 'Providencia',
        province: 'Santiago',
        zip: '7500000',
        country: 'Chile',
        phone: '+56911112222',
        latitude: -33.4263,
        longitude: -70.6208,
      },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0].ot_id).toBe('1042');
    expect(orders[0].cliente).toBe('María Pérez');
    expect(orders[0].direccion).toContain('Av Providencia 1234');
    expect(orders[0].lat).toBeCloseTo(-33.4263);
    expect(orders[0].valor_oc_clp).toBe(45990);
    expect(warnings.filter((w) => w.includes('sin_'))).toHaveLength(0);
  });

  it('WooCommerce → WOO-{number}', () => {
    const { orders } = mapWooCommercePayload({
      id: 88,
      number: '88',
      total: '12000.50',
      date_created_gmt: '2026-07-21T18:00:00',
      shipping: {
        first_name: 'Juan',
        last_name: 'Soto',
        address_1: 'Los Leones 100',
        city: 'Las Condes',
        state: 'RM',
        postcode: '7550000',
        country: 'CL',
        phone: '+56999998888',
      },
    });
    expect(orders[0].ot_id).toBe('WOO-88');
    expect(orders[0].cliente).toBe('Juan Soto');
    expect(orders[0].direccion).toContain('Los Leones 100');
    expect(orders[0].valor_oc_clp).toBeCloseTo(12000.5);
  });

  it('SAP delivery document → DeliveryDocument + hazmat', () => {
    const { orders } = mapSapPayload({
      DeliveryDocument: '80001234',
      SoldToPartyName: 'Distribuidora Andes',
      StreetName: 'Camino Lo Boza',
      HouseNumber: '100',
      CityName: 'Pudahuel',
      PostalCode: '9020000',
      Country: 'CL',
      NetAmount: '250000',
      DeliveryDate: '2026-07-22',
      DangerousGoods: true,
      ShippingPoint: '1000',
    });
    expect(orders[0].ot_id).toBe('80001234');
    expect(orders[0].cliente).toContain('Andes');
    expect(orders[0].requires_hazmat).toBe(true);
    expect(orders[0].depot_id).toBe('1000');
  });

  it('NetSuite tranId + shippingAddress', () => {
    const { orders } = mapNetSuitePayload({
      id: '999',
      tranId: 'SO-7788',
      entity: { name: 'Retail Sur SpA' },
      total: 89000,
      shippingAddress: {
        addr1: 'Av Apoquindo 3000',
        city: 'Las Condes',
        state: 'RM',
        zip: '7550000',
        country: 'CL',
      },
    });
    expect(orders[0].ot_id).toBe('SO-7788');
    expect(orders[0].cliente).toBe('Retail Sur SpA');
    expect(orders[0].direccion).toContain('Apoquindo');
  });

  it('POS Square-like order_id + fulfillments', () => {
    const { orders } = mapPosPayload({
      order_id: 'sq_ord_abc',
      created_at: '2026-07-21T20:00:00Z',
      total_money: { amount: 15990, currency: 'CLP' },
      fulfillments: [
        {
          shipment_details: {
            recipient: {
              display_name: 'Cliente Mostrador',
              phone_number: '+56955554444',
              address: {
                address_line_1: 'Huérfanos 500',
                locality: 'Santiago',
                postal_code: '8320000',
                country: 'CL',
              },
            },
          },
        },
      ],
    });
    expect(orders[0].ot_id).toBe('sq_ord_abc');
    expect(orders[0].cliente).toBe('Cliente Mostrador');
    expect(orders[0].valor_oc_clp).toBe(15990);
    expect(orders[0].direccion).toContain('Huérfanos');
  });
});

describe('HMAC plataformas', () => {
  it('Shopify base64 ok', async () => {
    const body = '{"id":1}';
    const sig = await signShopify(body, SECRET);
    expect(await verifyShopifyHmac(new TextEncoder().encode(body), sig, SECRET)).toBe(true);
    expect(await verifyShopifyHmac(new TextEncoder().encode(body), 'bad', SECRET)).toBe(false);
  });

  it('SAP hex hub ok', async () => {
    const body = '{"DeliveryDocument":"1"}';
    const sig = await signHex(body, SECRET);
    expect(await verifyHexSha256Header(new TextEncoder().encode(body), sig, SECRET)).toBe(true);
  });

  it('resolvePlatformSecret prioriza PLATFORM_WEBHOOK_SECRETS', () => {
    expect(
      resolvePlatformSecret(
        {
          PLATFORM_WEBHOOK_SECRETS: JSON.stringify({ 'shopify:empresa_base': 's1' }),
          ORDER_INGEST_SECRET: 'fallback',
        },
        'shopify',
        'empresa_base'
      )
    ).toBe('s1');
  });
});

describe('handlers end-to-end (mock DB)', () => {
  beforeEach(() => {
    pgQueryMock = vi.fn(async () => ({ rowCount: 1, rows: [] }));
  });

  it('Shopify webhook 200 upsert', async () => {
    const payload = {
      id: 1,
      name: '#2001',
      total_price: '1000',
      shipping_address: {
        name: 'Test',
        address1: 'Calle 1',
        city: 'Santiago',
        country: 'CL',
      },
    };
    const body = JSON.stringify(payload);
    const sig = await signShopify(body, SECRET);
    const req = new Request('https://worker.test/api/webhooks/shopify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': TENANT,
        'X-Shopify-Hmac-Sha256': sig,
        'X-Shopify-Topic': 'orders/create',
      },
      body,
    });
    const res = await handleShopify(req, {
      ORDER_INGEST_SECRET: SECRET,
      SHOPIFY_WEBHOOK_SECRET: SECRET,
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.exito).toBe(true);
    expect(j.platform).toBe('shopify');
    expect(j.prepared).toBe(1);
  });

  it('WooCommerce webhook 200', async () => {
    const payload = {
      id: 55,
      number: '55',
      total: '5000',
      shipping: {
        first_name: 'Ana',
        last_name: 'Ruiz',
        address_1: 'Calle Woo 9',
        city: 'Maipú',
        country: 'CL',
      },
    };
    const body = JSON.stringify(payload);
    const sig = await signShopify(body, SECRET);
    const req = new Request('https://worker.test/api/webhooks/woocommerce', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': TENANT,
        'X-WC-Webhook-Signature': sig,
      },
      body,
    });
    const res = await handleWoo(req, { WOOCOMMERCE_WEBHOOK_SECRET: SECRET });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.exito).toBe(true);
    expect(j.platform).toBe('woocommerce');
  });

  it('SAP webhook 200', async () => {
    const payload = {
      DeliveryDocument: '800099',
      SoldToPartyName: 'SAP Cliente',
      StreetName: 'Calle SAP',
      CityName: 'Santiago',
      Country: 'CL',
      NetAmount: '10',
    };
    const body = JSON.stringify(payload);
    const sig = await signHex(body, SECRET);
    const req = new Request('https://worker.test/api/webhooks/sap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': TENANT,
        'X-Hub-Signature-256': sig,
      },
      body,
    });
    const res = await handleSap(req, { SAP_WEBHOOK_SECRET: SECRET });
    expect(res.status).toBe(200);
    expect((await res.json()).platform).toBe('sap');
  });

  it('NetSuite webhook 200', async () => {
    const payload = {
      tranId: 'SO-1',
      entity: { name: 'NS Co' },
      total: 1,
      shippingAddress: { addr1: 'Calle NS', city: 'Santiago', country: 'CL' },
    };
    const body = JSON.stringify(payload);
    const sig = await signHex(body, SECRET);
    const req = new Request('https://worker.test/api/webhooks/netsuite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': TENANT,
        'X-Hub-Signature-256': sig,
      },
      body,
    });
    const res = await handleNetSuite(req, { NETSUITE_WEBHOOK_SECRET: SECRET });
    expect(res.status).toBe(200);
    expect((await res.json()).platform).toBe('netsuite');
  });

  it('POS webhook 200', async () => {
    const payload = {
      order_id: 'pos-1',
      customer_name: 'POS User',
      address: 'Calle POS 1, Santiago, CL',
      total: 2000,
    };
    const body = JSON.stringify(payload);
    const sig = await signHex(body, SECRET);
    const req = new Request('https://worker.test/api/webhooks/pos', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': TENANT,
        'X-Hub-Signature-256': sig,
      },
      body,
    });
    const res = await handlePos(req, { POS_WEBHOOK_SECRET: SECRET });
    expect(res.status).toBe(200);
    expect((await res.json()).platform).toBe('pos');
  });

  it('401 si firma inválida', async () => {
    const req = new Request('https://worker.test/api/webhooks/shopify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': TENANT,
        'X-Shopify-Hmac-Sha256': 'aaaa',
      },
      body: '{"id":1,"name":"#1","shipping_address":{"name":"A","address1":"x","city":"y","country":"CL"}}',
    });
    const res = await handleShopify(req, { SHOPIFY_WEBHOOK_SECRET: SECRET });
    expect(res.status).toBe(401);
  });
});
