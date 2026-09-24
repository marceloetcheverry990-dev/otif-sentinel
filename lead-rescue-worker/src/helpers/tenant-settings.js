/**
 * Settings por tenant: avisos a clientes (SMS/email), marca, POD, DTE y WMS.
 */

import { withDb } from '../db.js';

/**
 * Fila de tenant_settings del tenant (null si no hay o la tabla no existe).
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
