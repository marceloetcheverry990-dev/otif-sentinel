// src/helpers/audit-log.js
// Bitácora de acciones de operadores en Torre de Control.

import { withDb } from '../db.js';
import { ensureOperatorSchema } from './tower-operators.js';

/**
 * @param {object} env
 * @param {{
 *   tenant_id: string,
 *   operator_id?: string|null,
 *   username?: string|null,
 *   action: string,
 *   outcome?: 'success'|'failure'|'error',
 *   resource_type?: string|null,
 *   resource_id?: string|null,
 *   meta?: object,
 *   ip?: string|null,
 * }} entry
 */
export async function writeAuditLog(env, entry) {
  if (!entry?.tenant_id || !entry?.action) return;
  try {
    await withDb(env, async (client) => {
      await ensureOperatorSchema(client);
      await client.query(
        `INSERT INTO audit_log
           (tenant_id, operator_id, username, action, outcome, resource_type, resource_id, meta, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          entry.tenant_id,
          entry.operator_id || null,
          entry.username || null,
          String(entry.action).slice(0, 64),
          entry.outcome || 'success',
          entry.resource_type || null,
          entry.resource_id || null,
          JSON.stringify(entry.meta || {}),
          entry.ip || null,
        ]
      );
    }, { statementTimeout: 5000 });
  } catch (err) {
    console.error('[audit-log] no se pudo registrar:', err.message);
  }
}

export function operatorAuditContext(payload, request) {
  return {
    tenant_id: payload?.tenant_id,
    operator_id: payload?.sub || null,
    username: payload?.username || null,
    ip: request.headers.get('CF-Connecting-IP')
      || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
      || null,
  };
}
