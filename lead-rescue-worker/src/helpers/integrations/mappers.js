/**
 * Traductores: payload nativo de cada plataforma → items canónicos OrderIngest.
 * No autentican; solo mapean. Devuelven { orders, warnings }.
 */

function joinAddress(parts) {
  return parts
    .map((p) => (p == null ? '' : String(p).trim()))
    .filter(Boolean)
    .join(', ');
}

function moneyNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/**
 * Shopify Admin REST / webhook orders/create|updated
 * https://shopify.dev/docs/api/admin-rest/latest/resources/order
 */
export function mapShopifyPayload(payload) {
  const warnings = [];
  const order = payload?.order || payload;
  if (!order || typeof order !== 'object') {
    return { orders: [], warnings: ['payload_shopify_vacio'] };
  }

  const ship = order.shipping_address || order.billing_address || {};
  const cliente = firstNonEmpty(
    ship.name,
    [ship.first_name, ship.last_name].filter(Boolean).join(' '),
    order.customer && [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' '),
    order.email,
    'Shopify Customer'
  );
  const direccion = joinAddress([
    ship.address1,
    ship.address2,
    ship.city,
    ship.province || ship.province_code,
    ship.zip,
    ship.country || ship.country_code,
  ]);
  const ot_id = firstNonEmpty(
    order.name && String(order.name).replace(/^#/, ''),
    order.order_number && `SH-${order.order_number}`,
    order.id && `SH-${order.id}`
  );
  if (!ot_id) {
    warnings.push('shopify_sin_id');
    return { orders: [], warnings };
  }
  if (!direccion) warnings.push('shopify_sin_direccion');

  const lat = ship.latitude != null ? Number(ship.latitude) : undefined;
  const lng = ship.longitude != null ? Number(ship.longitude) : undefined;

  return {
    orders: [
      {
        ot_id: String(ot_id).slice(0, 120),
        cliente: String(cliente).slice(0, 120),
        direccion: direccion || undefined,
        lat: Number.isFinite(lat) ? lat : undefined,
        lng: Number.isFinite(lng) ? lng : undefined,
        valor_oc_clp: moneyNumber(order.total_price || order.current_total_price),
        monto_total: moneyNumber(order.total_price || order.current_total_price),
        fecha_hora_sla: order.processed_at || order.created_at || undefined,
        external_ref: order.id != null ? String(order.id) : undefined,
        telefono: firstNonEmpty(ship.phone, order.phone) || undefined,
        email: firstNonEmpty(order.email, order.customer?.email) || undefined,
      },
    ],
    warnings,
  };
}

/**
 * WooCommerce REST webhook order.created / order.updated
 */
export function mapWooCommercePayload(payload) {
  const warnings = [];
  const order = payload?.order || payload;
  if (!order || typeof order !== 'object') {
    return { orders: [], warnings: ['payload_woo_vacio'] };
  }

  const ship = order.shipping || order.billing || {};
  const cliente = firstNonEmpty(
    [ship.first_name, ship.last_name].filter(Boolean).join(' '),
    order.billing && [order.billing.first_name, order.billing.last_name].filter(Boolean).join(' '),
    order.billing?.company,
    'WooCommerce Customer'
  );
  const direccion = joinAddress([
    ship.address_1 || ship.address1,
    ship.address_2 || ship.address2,
    ship.city,
    ship.state,
    ship.postcode,
    ship.country,
  ]);
  const ot_id = firstNonEmpty(
    order.number && `WOO-${order.number}`,
    order.id && `WOO-${order.id}`
  );
  if (!ot_id) {
    warnings.push('woo_sin_id');
    return { orders: [], warnings };
  }
  if (!direccion) warnings.push('woo_sin_direccion');

  return {
    orders: [
      {
        ot_id: String(ot_id).slice(0, 120),
        cliente: String(cliente).slice(0, 120),
        direccion: direccion || undefined,
        valor_oc_clp: moneyNumber(order.total),
        monto_total: moneyNumber(order.total),
        fecha_hora_sla: order.date_created_gmt || order.date_created || undefined,
        external_ref: order.id != null ? String(order.id) : undefined,
        telefono: firstNonEmpty(ship.phone, order.billing?.phone) || undefined,
        email: firstNonEmpty(order.billing?.email, order.email) || undefined,
      },
    ],
    warnings,
  };
}

/**
 * SAP outbound (CPI / OData delivery o sales order simplificado).
 * Acepta varias formas comunes usadas en integraciones B2B.
 */
export function mapSapPayload(payload) {
  const warnings = [];
  const root = payload?.d || payload?.Delivery || payload?.SalesOrder || payload;
  if (!root || typeof root !== 'object') {
    return { orders: [], warnings: ['payload_sap_vacio'] };
  }

  // Batch: { deliveries: [...] } o { results: [...] }
  const list = Array.isArray(root.deliveries)
    ? root.deliveries
    : Array.isArray(root.results)
      ? root.results
      : Array.isArray(payload?.orders)
        ? payload.orders
        : [root];

  const orders = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const ot_id = firstNonEmpty(
      row.DeliveryDocument,
      row.Delivery,
      row.VBELN,
      row.SalesOrder,
      row.Vbeln,
      row.documentNumber,
      row.ot_id,
      row.id
    );
    const cliente = firstNonEmpty(
      row.SoldToPartyName,
      row.ShipToPartyName,
      row.NAME1,
      row.customerName,
      row.PartnerName,
      row.cliente,
      'SAP Customer'
    );
    const direccion = joinAddress([
      row.StreetName || row.STREET || row.street,
      row.HouseNumber || row.HOUSE_NUM1,
      row.CityName || row.CITY1 || row.city,
      row.PostalCode || row.POST_CODE1 || row.postalCode,
      row.Country || row.COUNTRY || row.country,
      row.ShippingAddress,
      row.direccion,
    ]);
    if (!ot_id) {
      warnings.push('sap_fila_sin_id');
      continue;
    }
    if (!direccion) warnings.push(`sap_sin_direccion:${ot_id}`);

    const lat = row.Latitude ?? row.lat;
    const lng = row.Longitude ?? row.lng;

    orders.push({
      ot_id: String(ot_id).slice(0, 120),
      cliente: String(cliente).slice(0, 120),
      direccion: direccion || undefined,
      lat: Number.isFinite(Number(lat)) ? Number(lat) : undefined,
      lng: Number.isFinite(Number(lng)) ? Number(lng) : undefined,
      valor_oc_clp: moneyNumber(row.NetAmount || row.NETWR || row.amount || row.valor_oc_clp),
      monto_total: moneyNumber(row.NetAmount || row.NETWR || row.amount || row.monto_total),
      fecha_hora_sla: row.DeliveryDate || row.RequestedDeliveryDate || row.fecha_hora_sla || undefined,
      external_ref: String(ot_id),
      telefono: row.PhoneNumber || row.telefono || undefined,
      email: row.Email || row.email || undefined,
      requires_hazmat: !!(row.DangerousGoods || row.hazmat || row.requires_hazmat),
      tags_requeridos: Array.isArray(row.tags_requeridos) ? row.tags_requeridos : undefined,
      depot_id: row.ShippingPoint || row.Plant || row.depot_id || undefined,
    });
  }

  if (!orders.length) warnings.push('sap_sin_ordenes');
  return { orders, warnings };
}

/**
 * NetSuite sales order / fulfillment (SuiteScript o REST webhook).
 */
export function mapNetSuitePayload(payload) {
  const warnings = [];
  const root = payload?.record || payload?.salesOrder || payload;
  if (!root || typeof root !== 'object') {
    return { orders: [], warnings: ['payload_netsuite_vacio'] };
  }

  const list = Array.isArray(root.items) && root.tranId == null && !root.id
    ? root.items
    : Array.isArray(payload?.orders)
      ? payload.orders
      : [root];

  const orders = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const ship = row.shippingAddress || row.shipAddress || row.billingAddress || {};
    const ot_id = firstNonEmpty(row.tranId, row.tranid, row.orderId, row.id, row.ot_id);
    const cliente = firstNonEmpty(
      row.entity?.name,
      row.entityName,
      typeof row.entity === 'string' ? row.entity : null,
      ship.addressee,
      ship.attention,
      row.customerName,
      'NetSuite Customer'
    );
    const direccion = joinAddress([
      ship.addr1 || ship.address1 || row.shipAddr1,
      ship.addr2 || ship.address2,
      ship.city,
      ship.state,
      ship.zip || ship.zipCode,
      ship.country,
      row.shippingAddressText,
    ]);
    if (!ot_id) {
      warnings.push('netsuite_fila_sin_id');
      continue;
    }
    if (!direccion) warnings.push(`netsuite_sin_direccion:${ot_id}`);

    orders.push({
      ot_id: String(ot_id).slice(0, 120),
      cliente: String(cliente).slice(0, 120),
      direccion: direccion || undefined,
      valor_oc_clp: moneyNumber(row.total || row.amount || row.foreignTotal),
      monto_total: moneyNumber(row.total || row.amount || row.foreignTotal),
      fecha_hora_sla: row.shipDate || row.trandate || row.createdDate || undefined,
      external_ref: row.id != null ? String(row.id) : String(ot_id),
      telefono: ship.addrPhone || row.phone || undefined,
      email: ship.email || row.email || undefined,
    });
  }

  if (!orders.length) warnings.push('netsuite_sin_ordenes');
  return { orders, warnings };
}

/**
 * POS genérico (Square-like / retail JSON).
 * Shape: { order_id|id, customer_name, address|fulfillment, total_money|total, ... }
 */
export function mapPosPayload(payload) {
  const warnings = [];
  const root = payload?.order || payload?.ticket || payload;
  if (!root || typeof root !== 'object') {
    return { orders: [], warnings: ['payload_pos_vacio'] };
  }

  const list = Array.isArray(root.orders)
    ? root.orders
    : Array.isArray(payload?.orders)
      ? payload.orders
      : [root];

  const orders = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const ful = row.fulfillments?.[0]?.shipment_details?.recipient
      || row.fulfillment
      || row.delivery
      || {};
    const addr = ful.address || row.address || row.shipping_address || {};
    const ot_id = firstNonEmpty(
      row.order_id,
      row.ticket_number && `POS-${row.ticket_number}`,
      row.id,
      row.ot_id
    );
    const cliente = firstNonEmpty(
      ful.display_name,
      row.customer_name,
      row.customer?.name,
      [addr.first_name, addr.last_name].filter(Boolean).join(' '),
      'POS Customer'
    );
    const direccion = joinAddress([
      addr.address_line_1 || addr.address1 || addr.line1,
      addr.address_line_2 || addr.address2,
      addr.locality || addr.city,
      addr.administrative_district_level_1 || addr.state,
      addr.postal_code || addr.zip,
      addr.country,
      typeof row.address === 'string' ? row.address : null,
      row.direccion,
    ]);
    if (!ot_id) {
      warnings.push('pos_fila_sin_id');
      continue;
    }
    if (!direccion) warnings.push(`pos_sin_direccion:${ot_id}`);

    const total =
      row.total_money?.amount != null
        ? Number(row.total_money.amount) / (row.total_money.currency === 'CLP' ? 1 : 100)
        : moneyNumber(row.total || row.amount || row.valor_oc_clp);

    orders.push({
      ot_id: String(ot_id).slice(0, 120),
      cliente: String(cliente).slice(0, 120),
      direccion: direccion || undefined,
      lat: Number.isFinite(Number(addr.latitude ?? row.lat)) ? Number(addr.latitude ?? row.lat) : undefined,
      lng: Number.isFinite(Number(addr.longitude ?? row.lng)) ? Number(addr.longitude ?? row.lng) : undefined,
      valor_oc_clp: total,
      monto_total: total,
      fecha_hora_sla: row.fulfillment_at || row.created_at || row.closed_at || undefined,
      external_ref: String(ot_id),
      telefono: ful.phone_number || row.phone || undefined,
      email: ful.email || row.email || row.customer_email || undefined,
    });
  }

  if (!orders.length) warnings.push('pos_sin_ordenes');
  return { orders, warnings };
}

export const PLATFORM_MAPPERS = {
  shopify: mapShopifyPayload,
  woocommerce: mapWooCommercePayload,
  sap: mapSapPayload,
  netsuite: mapNetSuitePayload,
  pos: mapPosPayload,
};
