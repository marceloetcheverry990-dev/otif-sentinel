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

// Bodega: controlamos si el tenant tiene WMS y qué devuelve la reserva.
let wmsEnabled = false;
let reservarImpl = async () => ({ ok: true, estado: 'PENDIENTE_PICKING' });
let reservarCalls;

vi.mock('../helpers/wms-stock.js', () => ({
  isWmsEnabledForTenant: async () => wmsEnabled,
  ensureWmsSchema: async () => {},
  reservarOt: async (...args) => {
    reservarCalls.push(args[1]);
    return reservarImpl(...args);
  },
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

  it('NO cae al secreto global por defecto (evita inyección cross-tenant vía X-Tenant-Id)', () => {
    expect(resolveOrderIngestSecret({ ORDER_INGEST_SECRET: SECRET }, TENANT)).toBeNull();
  });

  it('cae al secreto global solo con ORDER_INGEST_ALLOW_GLOBAL_SECRET=true', () => {
    expect(
      resolveOrderIngestSecret(
        { ORDER_INGEST_SECRET: SECRET, ORDER_INGEST_ALLOW_GLOBAL_SECRET: 'true' },
        TENANT
      )
    ).toBe(SECRET);
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
    wmsEnabled = false;
    reservarCalls = [];
    reservarImpl = async () => ({ ok: true, estado: 'PENDIENTE_PICKING' });
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
    const res = await handleOrderIngestWebhookCore(req, {
      ORDER_INGEST_SECRETS: JSON.stringify({ [TENANT]: SECRET }),
    });
    expect(res.status).toBe(401);
  });

  it('403 si tenant body != header', async () => {
    const req = await makeRequest({
      tenant_id: 'otro_tenant',
      orders: [{ ot_id: '1', cliente: 'A' }],
    });
    const res = await handleOrderIngestWebhookCore(req, {
      ORDER_INGEST_SECRETS: JSON.stringify({ [TENANT]: SECRET }),
    });
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
    const res = await handleOrderIngestWebhookCore(req, {
      ORDER_INGEST_SECRETS: JSON.stringify({ [TENANT]: SECRET }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exito).toBe(true);
    expect(body.prepared).toBe(1);
    expect(body.source).toBe('Shopify');
    expect(pgQueryMock).toHaveBeenCalled();
  });
});

// ─── Reserva automática de bodega al ingresar el pedido ─────────────────────
// Antes: toda orden entraba directo a PENDIENTE_RUTEO y reservarOt solo se
// llamaba a mano vía POST /api/bodega/reservar — el WMS nunca veía un pedido real.
describe('handleOrderIngestWebhookCore — reserva de bodega en la ingesta', () => {
  const ENV = { ORDER_INGEST_SECRETS: JSON.stringify({ [TENANT]: SECRET }) };

  function pedidoConLineas(lineas, extra = {}) {
    return {
      tenant_id: TENANT,
      orders: [{
        ot_id: 'OT-WMS-1',
        cliente: 'Cliente WMS',
        lineas,
        ...extra,
      }],
    };
  }

  beforeEach(() => {
    pgQueryMock = vi.fn(async (sql) => {
      if (String(sql).includes('FROM depots')) {
        return { rowCount: 1, rows: [{ depot_id: 'empresa_base-bodega-central' }] };
      }
      return { rowCount: 1, rows: [] };
    });
    wmsEnabled = false;
    reservarCalls = [];
    reservarImpl = async () => ({ ok: true, estado: 'PENDIENTE_PICKING' });
  });

  it('con WMS activo y líneas: reserva stock y lo reporta en la respuesta', async () => {
    wmsEnabled = true;
    const req = await makeRequest(pedidoConLineas([{ sku: 'SKU-A', qty: 2 }]));
    const res = await handleOrderIngestWebhookCore(req, ENV);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wms).toEqual({ reservadas: 1, quiebres: 0, omitidas: 0, errores: 0 });
    expect(reservarCalls).toHaveLength(1);
    expect(reservarCalls[0].ot_id).toBe('OT-WMS-1');
    expect(reservarCalls[0].lineas).toEqual([{ sku: 'SKU-A', qty: 2 }]);
  });

  it('sin stock suficiente: cuenta quiebre (la OT queda fuera del ruteo) sin romper la ingesta', async () => {
    wmsEnabled = true;
    reservarImpl = async () => ({ ok: false, code: 'quiebre', sku: 'SKU-A' });
    const req = await makeRequest(pedidoConLineas([{ sku: 'SKU-A', qty: 999 }]));
    const res = await handleOrderIngestWebhookCore(req, ENV);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exito).toBe(true);
    expect(body.wms).toEqual({ reservadas: 0, quiebres: 1, omitidas: 0, errores: 0 });
  });

  it('WMS apagado: no intenta reservar aunque el pedido traiga líneas', async () => {
    wmsEnabled = false;
    const req = await makeRequest(pedidoConLineas([{ sku: 'SKU-A', qty: 2 }]));
    const res = await handleOrderIngestWebhookCore(req, ENV);

    const body = await res.json();
    expect(body.wms).toBeUndefined();
    expect(reservarCalls).toHaveLength(0);
  });

  it('WMS activo pero pedido sin líneas: camino de siempre, PENDIENTE_RUTEO directo', async () => {
    wmsEnabled = true;
    const req = await makeRequest({
      tenant_id: TENANT,
      orders: [{ ot_id: 'OT-SIN-SKU', cliente: 'Cliente' }],
    });
    const res = await handleOrderIngestWebhookCore(req, ENV);

    const body = await res.json();
    expect(body.wms).toBeUndefined();
    expect(reservarCalls).toHaveLength(0);
    expect(body.mensaje).toMatch(/PENDIENTE_RUTEO/);
  });

  it('si la reserva explota, el batch de pedidos NO se pierde (SAVEPOINT por orden)', async () => {
    wmsEnabled = true;
    reservarImpl = async () => { throw new Error('inventario_bodega no existe'); };
    const req = await makeRequest(pedidoConLineas([{ sku: 'SKU-A', qty: 1 }]));
    const res = await handleOrderIngestWebhookCore(req, ENV);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exito).toBe(true);
    expect(body.upserted).toBe(1);
    expect(body.wms).toEqual({ reservadas: 0, quiebres: 0, omitidas: 0, errores: 1 });

    const sqls = pgQueryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT wms_reserva');
  });

  it('reenvío de una OT ya reservada (tiene orden_lineas): NO reserva de nuevo — antes descontaba el stock dos veces', async () => {
    wmsEnabled = true;
    pgQueryMock = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes('FROM orden_lineas')) return { rowCount: 1, rows: [{ ot_id: 'OT-WMS-1' }] };
      if (s.includes('FROM depots')) return { rowCount: 1, rows: [{ depot_id: 'empresa_base-bodega-central' }] };
      return { rowCount: 1, rows: [] };
    });
    const req = await makeRequest(pedidoConLineas([{ sku: 'SKU-A', qty: 4 }]));
    const res = await handleOrderIngestWebhookCore(req, ENV);

    const body = await res.json();
    expect(reservarCalls).toHaveLength(0);
    expect(body.wms).toEqual({ reservadas: 0, quiebres: 0, omitidas: 1, errores: 0 });
  });

  it('OT en estado no reservable (ya ruteada/en calle): cuenta como omitida, no como error', async () => {
    wmsEnabled = true;
    reservarImpl = async () => ({ ok: false, code: 'estado_no_reservable', estado: 'EN_RUTA' });
    const req = await makeRequest(pedidoConLineas([{ sku: 'SKU-A', qty: 1 }]));
    const res = await handleOrderIngestWebhookCore(req, ENV);

    const body = await res.json();
    expect(body.wms).toEqual({ reservadas: 0, quiebres: 0, omitidas: 1, errores: 0 });
  });

  it('el upsert no pisa PICKING/PACKING (estados del WMS): un reenvío no saca el pedido de bodega', async () => {
    const req = await makeRequest(pedidoConLineas([{ sku: 'SKU-A', qty: 1 }]));
    await handleOrderIngestWebhookCore(req, ENV);

    const upsert = pgQueryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO ordenes_pendientes'));
    const estadosPisables = upsert[1][upsert[1].length - 1];
    expect(estadosPisables).toContain('PENDIENTE_RUTEO');
    expect(estadosPisables).not.toContain('PICKING');
    expect(estadosPisables).not.toContain('PACKING');
  });

  it('mergea líneas del mismo SKU antes de reservar', async () => {
    wmsEnabled = true;
    const req = await makeRequest(pedidoConLineas([
      { sku: 'SKU-A', qty: 2 },
      { sku: 'SKU-A', qty: 3 },
      { sku: 'SKU-B', qty: 1 },
    ]));
    await handleOrderIngestWebhookCore(req, ENV);

    expect(reservarCalls[0].lineas).toEqual([
      { sku: 'SKU-A', qty: 5 },
      { sku: 'SKU-B', qty: 1 },
    ]);
  });
});
