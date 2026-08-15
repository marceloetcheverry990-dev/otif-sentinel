/**
 * POST /api/webhooks/orders
 * Ingestión genérica de órdenes logísticas (ERP / e-commerce / WMS outbound).
 *
 * Auth:
 *   - Header X-Tenant-Id (elige el secreto)
 *   - Header X-Hub-Signature-256: sha256=<hex> sobre el body raw
 *   - Secret: ORDER_INGEST_SECRETS JSON map { "tenant": "secret" } o ORDER_INGEST_SECRET global
 *
 * Escribe ordenes_pendientes + clientes (mismo modelo que sync CSV).
 * NO cancela OTs ausentes. NO asigna trip/chofer.
 */

import {
  CORS_HEADERS,
  OrderIngestPayloadSchema,
  requireTenantId,
} from '../config.js';
import { withDbTransaction } from '../db.js';
import { geocodeAddress } from '../helpers/geocode.js';
import { isValidLatLng, parseCoord } from '../helpers/destino-coords.js';
import { verifyMetaSignature } from '../utils.js';
import { withMonitoring } from '../monitoring/middleware.js';

const PRE_ROUTE_STATES = [
  'PENDIENTE_RUTEO',
  'PICKING',
  'PACKING',
  'STAGING',
  'ATRASO',
];

const MAX_GEOCODE_PER_REQUEST = 10;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/**
 * Resuelve el secreto HMAC para un tenant.
 * Preferencia: ORDER_INGEST_SECRETS[tenant] → ORDER_INGEST_SECRET.
 */
export function resolveOrderIngestSecret(env, tenantId) {
  const tid = String(tenantId || '').trim();
  if (!tid) return null;

  if (env.ORDER_INGEST_SECRETS) {
    try {
      const map = JSON.parse(env.ORDER_INGEST_SECRETS);
      if (map && typeof map === 'object' && typeof map[tid] === 'string' && map[tid].length > 0) {
        return map[tid];
      }
    } catch (e) {
      console.error('[ORDER_INGEST] ORDER_INGEST_SECRETS JSON inválido:', e.message);
    }
  }

  if (env.ORDER_INGEST_SECRET && String(env.ORDER_INGEST_SECRET).length > 0) {
    return String(env.ORDER_INGEST_SECRET);
  }
  return null;
}

function normalizeSla(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sanitizeOtId(val) {
  return String(val || '').trim().slice(0, 120);
}

/**
 * Prepara filas en memoria (geocode opcional si hay dirección sin coords).
 */
async function prepareOrders(orders, source, env) {
  const prepared = [];
  const rejected = [];
  const seen = new Set();
  let geocodeBudget = MAX_GEOCODE_PER_REQUEST;

  for (const raw of orders) {
    const otId = sanitizeOtId(raw.ot_id);
    if (!otId) {
      rejected.push({ ot_id: raw.ot_id, reason: 'ot_id_vacio' });
      continue;
    }
    if (seen.has(otId)) {
      rejected.push({ ot_id: otId, reason: 'duplicado_en_batch' });
      continue;
    }
    seen.add(otId);

    let lat = parseCoord(raw.lat);
    let lng = parseCoord(raw.lng);
    let geocodePrecision = null;
    let geocodeProvider = null;

    if (!isValidLatLng(lat, lng) && raw.direccion && geocodeBudget > 0) {
      geocodeBudget -= 1;
      try {
        const hit = await geocodeAddress(raw.direccion, env);
        if (hit && isValidLatLng(hit.lat, hit.lng)) {
          lat = hit.lat;
          lng = hit.lng;
          geocodePrecision = hit.precision || null;
          geocodeProvider = hit.provider || null;
        }
      } catch (e) {
        console.warn('[ORDER_INGEST] geocode falló:', otId, e.message);
      }
    }

    const meta = {
      origen: source,
      ingest: 'webhook_orders',
      direccion_entrega: raw.direccion || null,
      lat_destino: isValidLatLng(lat, lng) ? lat : null,
      lng_destino: isValidLatLng(lat, lng) ? lng : null,
      external_ref: raw.external_ref || null,
      telefono_contacto: raw.telefono || null,
      email_contacto: raw.email || null,
      peso_kg: Number.isFinite(Number(raw.peso_kg)) ? Number(raw.peso_kg) : null,
      ventana_inicio: raw.ventana_inicio || null,
      ventana_fin: raw.ventana_fin || raw.fecha_hora_sla || null,
      geocode_precision: geocodePrecision,
      geocode_provider: geocodeProvider,
      ingestido_en: new Date().toISOString(),
      depot_id: raw.depot_id || null,
      tags_requeridos: (() => {
        const tags = Array.isArray(raw.tags_requeridos)
          ? raw.tags_requeridos.map((t) => String(t).trim().toUpperCase()).filter(Boolean)
          : [];
        if (raw.requires_hazmat && !tags.includes('HAZMAT')) tags.push('HAZMAT');
        return tags.length ? tags : null;
      })(),
      requires_hazmat: !!raw.requires_hazmat,
    };

    const tagsRequeridos = meta.tags_requeridos || [];

    prepared.push({
      otId,
      cliente: String(raw.cliente).trim(),
      valorOc: Number.isFinite(Number(raw.valor_oc_clp)) ? Number(raw.valor_oc_clp) : 0,
      montoTotal: Number.isFinite(Number(raw.monto_total)) ? Number(raw.monto_total) : null,
      slaIso: normalizeSla(raw.fecha_hora_sla),
      metadata: JSON.stringify(meta),
      tagsRequeridos,
      lat: isValidLatLng(lat, lng) ? lat : null,
      lng: isValidLatLng(lat, lng) ? lng : null,
      direccion: raw.direccion || null,
    });
  }

  prepared.sort((a, b) => a.otId.localeCompare(b.otId));
  return { prepared, rejected };
}

async function upsertOrders(env, tenantId, prepared) {
  if (prepared.length === 0) {
    return { upserted: 0, clientes: 0 };
  }

  return withDbTransaction(env, async (client) => {
    await client.query('SET statement_timeout = 8000');

    const arrOtId = prepared.map((o) => o.otId);
    const arrCliente = prepared.map((o) => o.cliente);
    const arrValorOc = prepared.map((o) => o.valorOc);
    const arrSlaIso = prepared.map((o) => o.slaIso);
    const arrMetadata = prepared.map((o) => o.metadata);
    const arrMontoTotal = prepared.map((o) => o.montoTotal);
    const arrLat = prepared.map((o) => o.lat);
    const arrLng = prepared.map((o) => o.lng);
    const arrTags = prepared.map((o) => JSON.stringify(o.tagsRequeridos || []));

    // Upsert órdenes: solo actualiza si sigue en estados pre-ruteo del mismo tenant.
    // Si lat/lng columnas no existen en algún entorno legacy, el catch externo lo reporta.
    const resOrd = await client.query(
      `
      INSERT INTO ordenes_pendientes (
        ot_id, cliente, estado_operacional, valor_oc_clp, fecha_hora_sla,
        metadata, monto_total, tenant_id, lat, lng, tags_requeridos
      )
      SELECT
        ot_id, cliente, 'PENDIENTE_RUTEO', valor_oc_clp, fecha_hora_sla,
        metadata, monto_total, $10::text, lat, lng, tags_requeridos
      FROM UNNEST(
        $1::text[], $2::text[], $3::numeric[], $4::timestamptz[],
        $5::jsonb[], $6::numeric[], $7::numeric[], $8::numeric[], $9::jsonb[]
      ) AS t(ot_id, cliente, valor_oc_clp, fecha_hora_sla, metadata, monto_total, lat, lng, tags_requeridos)
      ON CONFLICT (ot_id) DO UPDATE SET
        cliente = EXCLUDED.cliente,
        valor_oc_clp = EXCLUDED.valor_oc_clp,
        fecha_hora_sla = COALESCE(EXCLUDED.fecha_hora_sla, ordenes_pendientes.fecha_hora_sla),
        monto_total = COALESCE(EXCLUDED.monto_total, ordenes_pendientes.monto_total),
        metadata = COALESCE(ordenes_pendientes.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        lat = COALESCE(EXCLUDED.lat, ordenes_pendientes.lat),
        lng = COALESCE(EXCLUDED.lng, ordenes_pendientes.lng),
        tags_requeridos = EXCLUDED.tags_requeridos,
        estado_operacional = 'PENDIENTE_RUTEO',
        trip_id = NULL,
        chofer_asignado_id = NULL,
        tenant_id = EXCLUDED.tenant_id
      WHERE ordenes_pendientes.estado_operacional = ANY($11::text[])
        AND ordenes_pendientes.tenant_id = $10
      `,
      [
        arrOtId,
        arrCliente,
        arrValorOc,
        arrSlaIso,
        arrMetadata,
        arrMontoTotal,
        arrLat,
        arrLng,
        arrTags,
        tenantId,
        PRE_ROUTE_STATES,
      ]
    );

    // Clientes (dedupe por nombre en el batch)
    const clientesMap = new Map();
    for (const o of prepared) {
      if (!o.cliente) continue;
      clientesMap.set(o.cliente, {
        nombre: o.cliente,
        direccion: o.direccion,
        lat: o.lat,
        lng: o.lng,
      });
    }
    const clientesArr = Array.from(clientesMap.values());
    let clientesCount = 0;
    if (clientesArr.length > 0) {
      await client.query(
        `
        INSERT INTO clientes (nombre_cliente_raw, direccion_calle, lat, lng, tenant_id)
        SELECT nombre_cliente_raw, direccion_calle, lat, lng, $5::text
        FROM UNNEST($1::text[], $2::text[], $3::numeric[], $4::numeric[])
        AS t(nombre_cliente_raw, direccion_calle, lat, lng)
        ON CONFLICT (nombre_cliente_raw) DO UPDATE SET
          direccion_calle = COALESCE(EXCLUDED.direccion_calle, clientes.direccion_calle),
          lat = COALESCE(EXCLUDED.lat, clientes.lat),
          lng = COALESCE(EXCLUDED.lng, clientes.lng),
          tenant_id = COALESCE(EXCLUDED.tenant_id, clientes.tenant_id)
        `,
        [
          clientesArr.map((c) => c.nombre),
          clientesArr.map((c) => c.direccion),
          clientesArr.map((c) => c.lat),
          clientesArr.map((c) => c.lng),
          tenantId,
        ]
      );
      clientesCount = clientesArr.length;
    }

    return {
      upserted: resOrd.rowCount ?? prepared.length,
      clientes: clientesCount,
    };
  });
}

async function handleOrderIngestWebhookCore(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const tenantHeader = String(request.headers.get('x-tenant-id') || '').trim();
  const tenantErr = requireTenantId(tenantHeader);
  if (tenantErr) return tenantErr;

  const secret = resolveOrderIngestSecret(env, tenantHeader);
  if (!secret) {
    console.error('[ORDER_INGEST] Secret no configurado para tenant', tenantHeader);
    return json({ error: 'Service unavailable: order ingest not configured' }, 503);
  }

  const rawBody = await request.arrayBuffer();
  const signature = request.headers.get('x-hub-signature-256') || '';
  if (!(await verifyMetaSignature(rawBody, signature, secret))) {
    return json({ error: 'Forbidden: invalid signature' }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return json({ error: 'Body JSON inválido' }, 400);
  }

  const parsed = OrderIngestPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return json({
      error: 'Payload inválido',
      details: parsed.error.issues.slice(0, 12).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    }, 400);
  }

  if (parsed.data.tenant_id !== tenantHeader) {
    return json({
      error: 'tenant_id del body no coincide con X-Tenant-Id',
      code: 'tenant_mismatch',
    }, 403);
  }

  const source = parsed.data.source || 'ERP';
  return ingestCanonicalOrders(env, {
    tenantId: tenantHeader,
    source,
    orders: parsed.data.orders,
    idempotency_key: parsed.data.idempotency_key || null,
  });
}

/**
 * Entrada canónica post-mapeo (usada por adaptadores Shopify/Woo/SAP/…).
 * @returns {Promise<Response>}
 */
export async function ingestCanonicalOrders(env, {
  tenantId,
  source,
  orders,
  idempotency_key = null,
  extra = null,
}) {
  const tenantErr = requireTenantId(tenantId);
  if (tenantErr) return tenantErr;

  const wrapped = OrderIngestPayloadSchema.safeParse({
    tenant_id: tenantId,
    source: source || 'ERP',
    orders,
  });
  if (!wrapped.success) {
    return json({
      error: 'Órdenes mapeadas inválidas',
      details: wrapped.error.issues.slice(0, 12).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    }, 400);
  }

  const src = wrapped.data.source || source || 'ERP';
  const { prepared, rejected } = await prepareOrders(wrapped.data.orders, src, env);

  if (prepared.length === 0) {
    return json({
      exito: false,
      error: 'Ninguna orden válida para upsert',
      rejected,
      idempotency_key,
      ...(extra || {}),
    }, 400);
  }

  try {
    const result = await upsertOrders(env, tenantId, prepared);
    return json({
      exito: true,
      tenant_id: tenantId,
      source: src,
      received: wrapped.data.orders.length,
      prepared: prepared.length,
      upserted: result.upserted,
      clientes: result.clientes,
      rejected,
      idempotency_key,
      mensaje: `${result.upserted} orden(es) en PENDIENTE_RUTEO. Asigná ruta desde Torre / optimizar.`,
      ...(extra || {}),
    }, 200);
  } catch (e) {
    if (/column .*lat.* does not exist|column .*lng.* does not exist|tags_requeridos/i.test(e.message || '')) {
      console.warn('[ORDER_INGEST] schema parcial — reintentando sin lat/lng columnas:', e.message);
      try {
        const result = await upsertOrdersWithoutLatLngColumns(env, tenantId, prepared);
        return json({
          exito: true,
          tenant_id: tenantId,
          source: src,
          received: wrapped.data.orders.length,
          prepared: prepared.length,
          upserted: result.upserted,
          clientes: result.clientes,
          rejected,
          idempotency_key,
          aviso: 'Coords/tags guardados en metadata (schema legacy)',
          ...(extra || {}),
        }, 200);
      } catch (e2) {
        console.error('[ORDER_INGEST] fallback falló:', e2.message);
        return json({ error: e2.message }, 500);
      }
    }
    console.error('[ORDER_INGEST]', e.message);
    return json({ error: e.message || 'Internal Server Error' }, 500);
  }
}

/** Variante sin columnas lat/lng en ordenes_pendientes (schema legacy). */
async function upsertOrdersWithoutLatLngColumns(env, tenantId, prepared) {
  return withDbTransaction(env, async (client) => {
    await client.query('SET statement_timeout = 8000');

    const arrTags = prepared.map((o) => JSON.stringify(o.tagsRequeridos || []));
    let resOrd;
    try {
      resOrd = await client.query(
        `
        INSERT INTO ordenes_pendientes (
          ot_id, cliente, estado_operacional, valor_oc_clp, fecha_hora_sla,
          metadata, monto_total, tenant_id, tags_requeridos
        )
        SELECT
          ot_id, cliente, 'PENDIENTE_RUTEO', valor_oc_clp, fecha_hora_sla,
          metadata, monto_total, $8::text, tags_requeridos
        FROM UNNEST(
          $1::text[], $2::text[], $3::numeric[], $4::timestamptz[],
          $5::jsonb[], $6::numeric[], $7::jsonb[]
        ) AS t(ot_id, cliente, valor_oc_clp, fecha_hora_sla, metadata, monto_total, tags_requeridos)
        ON CONFLICT (ot_id) DO UPDATE SET
          cliente = EXCLUDED.cliente,
          valor_oc_clp = EXCLUDED.valor_oc_clp,
          fecha_hora_sla = COALESCE(EXCLUDED.fecha_hora_sla, ordenes_pendientes.fecha_hora_sla),
          monto_total = COALESCE(EXCLUDED.monto_total, ordenes_pendientes.monto_total),
          metadata = COALESCE(ordenes_pendientes.metadata, '{}'::jsonb) || EXCLUDED.metadata,
          tags_requeridos = EXCLUDED.tags_requeridos,
          estado_operacional = 'PENDIENTE_RUTEO',
          trip_id = NULL,
          chofer_asignado_id = NULL,
          tenant_id = EXCLUDED.tenant_id
        WHERE ordenes_pendientes.estado_operacional = ANY($9::text[])
          AND ordenes_pendientes.tenant_id = $8
        `,
        [
          prepared.map((o) => o.otId),
          prepared.map((o) => o.cliente),
          prepared.map((o) => o.valorOc),
          prepared.map((o) => o.slaIso),
          prepared.map((o) => o.metadata),
          prepared.map((o) => o.montoTotal),
          arrTags,
          tenantId,
          PRE_ROUTE_STATES,
        ]
      );
    } catch (tagErr) {
      if (!/tags_requeridos/i.test(tagErr.message || '')) throw tagErr;
      // tags quedan en metadata
      resOrd = await client.query(
        `
        INSERT INTO ordenes_pendientes (
          ot_id, cliente, estado_operacional, valor_oc_clp, fecha_hora_sla,
          metadata, monto_total, tenant_id
        )
        SELECT
          ot_id, cliente, 'PENDIENTE_RUTEO', valor_oc_clp, fecha_hora_sla,
          metadata, monto_total, $7::text
        FROM UNNEST(
          $1::text[], $2::text[], $3::numeric[], $4::timestamptz[],
          $5::jsonb[], $6::numeric[]
        ) AS t(ot_id, cliente, valor_oc_clp, fecha_hora_sla, metadata, monto_total)
        ON CONFLICT (ot_id) DO UPDATE SET
          cliente = EXCLUDED.cliente,
          valor_oc_clp = EXCLUDED.valor_oc_clp,
          fecha_hora_sla = COALESCE(EXCLUDED.fecha_hora_sla, ordenes_pendientes.fecha_hora_sla),
          monto_total = COALESCE(EXCLUDED.monto_total, ordenes_pendientes.monto_total),
          metadata = COALESCE(ordenes_pendientes.metadata, '{}'::jsonb) || EXCLUDED.metadata,
          estado_operacional = 'PENDIENTE_RUTEO',
          trip_id = NULL,
          chofer_asignado_id = NULL,
          tenant_id = EXCLUDED.tenant_id
        WHERE ordenes_pendientes.estado_operacional = ANY($8::text[])
          AND ordenes_pendientes.tenant_id = $7
        `,
        [
          prepared.map((o) => o.otId),
          prepared.map((o) => o.cliente),
          prepared.map((o) => o.valorOc),
          prepared.map((o) => o.slaIso),
          prepared.map((o) => o.metadata),
          prepared.map((o) => o.montoTotal),
          tenantId,
          PRE_ROUTE_STATES,
        ]
      );
    }

    const clientesMap = new Map();
    for (const o of prepared) {
      if (!o.cliente) continue;
      clientesMap.set(o.cliente, o);
    }
    const clientesArr = Array.from(clientesMap.values());
    if (clientesArr.length > 0) {
      await client.query(
        `
        INSERT INTO clientes (nombre_cliente_raw, direccion_calle, lat, lng, tenant_id)
        SELECT nombre_cliente_raw, direccion_calle, lat, lng, $5::text
        FROM UNNEST($1::text[], $2::text[], $3::numeric[], $4::numeric[])
        AS t(nombre_cliente_raw, direccion_calle, lat, lng)
        ON CONFLICT (nombre_cliente_raw) DO UPDATE SET
          direccion_calle = COALESCE(EXCLUDED.direccion_calle, clientes.direccion_calle),
          lat = COALESCE(EXCLUDED.lat, clientes.lat),
          lng = COALESCE(EXCLUDED.lng, clientes.lng),
          tenant_id = COALESCE(EXCLUDED.tenant_id, clientes.tenant_id)
        `,
        [
          clientesArr.map((c) => c.cliente),
          clientesArr.map((c) => c.direccion),
          clientesArr.map((c) => c.lat),
          clientesArr.map((c) => c.lng),
          tenantId,
        ]
      );
    }

    return {
      upserted: resOrd.rowCount ?? prepared.length,
      clientes: clientesArr.length,
    };
  });
}

export const handleOrderIngestWebhook = withMonitoring(handleOrderIngestWebhookCore, {
  component: 'order-ingest-webhook',
});

// Export core for tests without monitoring wrapper side-effects
export { handleOrderIngestWebhookCore };
