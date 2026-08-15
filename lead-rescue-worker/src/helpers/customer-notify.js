/**
 * Notificaciones al cliente final (SMS Twilio + email Resend).
 * Outbox en customer_notifications; no tumba el flujo operativo.
 */

import { withDb } from '../db.js';
import { sendTwilioSms } from './providers/twilio-sms.js';
import { sendResendEmail } from './providers/resend-email.js';

const EVENT_COPY = {
  DESPACHADO: {
    sms: (b, brand) =>
      `${brand}: tu pedido ${b.ot_id} ya salió a ruta.${b.trackingUrl ? ` Seguimiento: ${b.trackingUrl}` : ''}`,
    subject: (b, brand) => `${brand}: pedido ${b.ot_id} despachado`,
    html: (b, brand) =>
      `<p>Hola${b.cliente ? ` ${escapeHtml(b.cliente)}` : ''},</p>` +
      `<p>Tu pedido <b>${escapeHtml(b.ot_id)}</b> ya está en camino con ${escapeHtml(brand)}.</p>` +
      (b.trackingUrl ? `<p><a href="${escapeHtml(b.trackingUrl)}">Ver seguimiento</a></p>` : ''),
  },
  ETA_15MIN: {
    sms: (b, brand) =>
      `${brand}: tu pedido ${b.ot_id} llega en ~15 min.${b.trackingUrl ? ` ${b.trackingUrl}` : ''}`,
    subject: (b, brand) => `${brand}: tu pedido llega pronto`,
    html: (b, brand) =>
      `<p>Tu pedido <b>${escapeHtml(b.ot_id)}</b> llegará en aproximadamente 15 minutos.</p>` +
      (b.trackingUrl ? `<p><a href="${escapeHtml(b.trackingUrl)}">Ver mapa</a></p>` : ''),
  },
  ENTREGADO: {
    sms: (b, brand) =>
      `${brand}: pedido ${b.ot_id} entregado.${b.trackingUrl ? ` Comprobante: ${b.trackingUrl}` : ''}`,
    subject: (b, brand) => `${brand}: pedido ${b.ot_id} entregado`,
    html: (b, brand) =>
      `<p>Tu pedido <b>${escapeHtml(b.ot_id)}</b> fue entregado.</p>` +
      (b.hasPhoto ? `<p>Quedó registrada evidencia fotográfica de la entrega.</p>` : '') +
      (b.trackingUrl ? `<p><a href="${escapeHtml(b.trackingUrl)}">Ver detalle</a></p>` : ''),
  },
};

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadTenantNotifySettings(env, tenantId) {
  try {
    return await withDb(env, async (client) => {
      const r = await client.query(
        `SELECT notify_sms_enabled, notify_email_enabled, brand_name
         FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
      );
      return r.rows[0] || null;
    });
  } catch (e) {
    if (e.code !== '42P01' && !String(e.message || '').includes('notify_sms')) {
      console.warn('[CUSTOMER_NOTIFY_SETTINGS]', e.message);
    }
    return null;
  }
}

async function loadOrderContact(env, tenantId, otId) {
  return withDb(env, async (client) => {
    const r = await client.query(
      `SELECT ot_id, trip_id, cliente, evidencia_url, metadata
       FROM ordenes_pendientes
       WHERE tenant_id = $1 AND ot_id = $2 LIMIT 1`,
      [tenantId, otId]
    );
    return r.rows[0] || null;
  });
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Encola SMS/email según contacto y flags del tenant.
 * @returns {Promise<{ enqueued: number }>}
 */
export async function enqueueCustomerNotify(env, {
  tenantId,
  otId,
  tripId = null,
  eventType,
  trackingUrl = null,
  hasPhoto = false,
} = {}) {
  if (!tenantId || !otId || !EVENT_COPY[eventType]) {
    return { enqueued: 0 };
  }

  let order;
  try {
    order = await loadOrderContact(env, tenantId, otId);
  } catch (e) {
    console.warn('[CUSTOMER_NOTIFY_LOAD]', e.message);
    return { enqueued: 0 };
  }
  if (!order) return { enqueued: 0 };

  const meta = parseMeta(order.metadata);
  const phone = meta.telefono_contacto || meta.telefono || null;
  const email = meta.email_contacto || meta.email || null;
  const settings = await loadTenantNotifySettings(env, tenantId);
  const smsOn = settings?.notify_sms_enabled !== false;
  const emailOn = settings?.notify_email_enabled !== false;
  const brand = settings?.brand_name || 'OTIF Sentinel';

  const payload = {
    ot_id: otId,
    trip_id: tripId || order.trip_id || null,
    cliente: order.cliente || null,
    trackingUrl,
    hasPhoto: Boolean(hasPhoto || order.evidencia_url),
    brand,
  };

  const channels = [];
  if (smsOn && phone) channels.push({ channel: 'sms', to: String(phone) });
  if (emailOn && email) channels.push({ channel: 'email', to: String(email) });
  if (!channels.length) return { enqueued: 0 };

  let enqueued = 0;
  try {
    await withDb(env, async (client) => {
      // Evitar duplicados PENDING/SENT. FAILED sí se reintenta (reset a PENDING).
      const already = await client.query(
        `SELECT id, channel, status FROM customer_notifications
         WHERE tenant_id = $1 AND ot_id = $2 AND event_type = $3
           AND status IN ('PENDING', 'SENT', 'FAILED')`,
        [tenantId, otId, eventType]
      );
      const doneChannels = new Set();
      for (const row of already.rows || []) {
        if (row.status === 'PENDING' || row.status === 'SENT') {
          doneChannels.add(row.channel);
        } else if (row.status === 'FAILED') {
          const reset = await client.query(
            `UPDATE customer_notifications
             SET status = 'PENDING', error = NULL, provider_id = NULL, payload = $2::jsonb
             WHERE id = $1 AND status = 'FAILED'
             RETURNING id`,
            [row.id, JSON.stringify(payload)]
          );
          if (reset.rowCount) {
            doneChannels.add(row.channel);
            enqueued += 1;
          }
        }
      }

      for (const ch of channels) {
        if (doneChannels.has(ch.channel)) continue;
        try {
          const ins = await client.query(
            `INSERT INTO customer_notifications
               (tenant_id, ot_id, trip_id, event_type, channel, to_address, payload, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'PENDING')
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [
              tenantId,
              otId,
              payload.trip_id,
              eventType,
              ch.channel,
              ch.to,
              JSON.stringify(payload),
            ]
          );
          if (ins.rowCount) enqueued += 1;
        } catch (insErr) {
          // Unique index may not exist yet / conflict without ON CONFLICT target
          if (insErr.code === '42P01') throw insErr;
          console.warn('[CUSTOMER_NOTIFY_INSERT]', insErr.message);
        }
      }
    });
  } catch (e) {
    if (e.code === '42P01') {
      console.warn('[CUSTOMER_NOTIFY] tabla ausente — aplicar migración 012');
    } else {
      console.warn('[CUSTOMER_NOTIFY_ENQUEUE]', e.message);
    }
  }
  return { enqueued };
}

async function deliverOne(env, row) {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
  const brand = payload.brand || 'OTIF Sentinel';
  const copy = EVENT_COPY[row.event_type];
  if (!copy) return { ok: false, error: 'unknown_event' };

  if (row.channel === 'sms') {
    return sendTwilioSms(env, {
      to: row.to_address,
      body: copy.sms(payload, brand),
    });
  }
  if (row.channel === 'email') {
    return sendResendEmail(env, {
      to: row.to_address,
      subject: copy.subject(payload, brand),
      html: copy.html(payload, brand),
      text: copy.sms(payload, brand),
    });
  }
  return { ok: false, error: 'bad_channel' };
}

/**
 * Procesa pending (cron). Marca SKIPPED si falta provider; FAILED si error.
 */
export async function processCustomerNotificationOutbox(env, { limit = 40 } = {}) {
  const { withDbTransaction } = await import('../db.js');
  try {
    return await withDbTransaction(env, async (client) => {
      const r = await client.query(
        `SELECT id, tenant_id, ot_id, event_type, channel, to_address, payload, status
         FROM customer_notifications
         WHERE status = 'PENDING'
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit]
      );
      const rows = r.rows || [];
      const results = [];
      let processed = 0;

      for (const row of rows) {
        // deliverOne hace I/O externo; lo hacemos fuera del hold largo sería ideal,
        // pero para QA preferimos atomicidad simple por fila.
        const result = await deliverOne(env, row);
        const status = result.ok ? 'SENT' : result.skipped ? 'SKIPPED' : 'FAILED';
        await client.query(
          `UPDATE customer_notifications
           SET status = $1::varchar,
               provider_id = $2,
               error = $3,
               sent_at = CASE WHEN $1::text = 'SENT' THEN NOW() ELSE sent_at END
           WHERE id = $4::bigint`,
          [status, result.provider_id || null, result.error || result.detail || null, row.id]
        );
        processed += 1;
        results.push({
          id: row.id,
          channel: row.channel,
          to: row.to_address,
          status,
          error: result.error || null,
        });
      }

      return { processed, pending_seen: rows.length, results };
    }, { statementTimeout: 60000 });
  } catch (e) {
    if (e.code === '42P01') return { processed: 0, error: 'table_missing' };
    console.warn('[CUSTOMER_NOTIFY_SWEEP]', e.message);
    return { processed: 0, error: e.message };
  }
}
