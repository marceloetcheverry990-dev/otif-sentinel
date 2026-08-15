/**
 * Settings por tenant (sin canal Telegram).
 * Reservado para futuros settings ops (email, webhooks, etc.).
 */

import { withDb } from '../db.js';

/**
 * Lee un setting tipado del tenant. Hoy no hay consumidores activos post-Telegram.
 * @returns {Promise<object|null>}
 */
export async function getTenantSettings(env, tenantId) {
  const tid = String(tenantId || '').trim();
  if (!tid) return null;
  try {
    return await withDb(env, async (client) => {
      const r = await client.query(
        `SELECT * FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
        [tid]
      );
      return r.rows[0] || null;
    });
  } catch (e) {
    if (e.code !== '42P01') {
      console.warn('[TENANT_SETTINGS]', e.message);
    }
    return null;
  }
}
