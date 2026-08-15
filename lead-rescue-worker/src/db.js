// src/db.js
// Interacciones genéricas con la base de datos PostgreSQL (via Hyperdrive).

import { Client } from 'pg';
import { CONFIG } from './config.js';

// ============================================================================
// HELPERS DE BAJO NIVEL
// ============================================================================

export async function safeRollback(client) {
  try { await client.query('ROLLBACK'); } catch (e) { console.warn("[DB_ROLLBACK_WARN]", e.message); }
}

/**
 * Fija app.current_tenant para políticas RLS (migración 008).
 * Preferí siempre local=true (TX) — set de sesión puede filtrar a conexiones
 * recicladas de Hyperdrive.
 */
export async function setTenantContext(client, tenantId, { local = true } = {}) {
  if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) return;
  await client.query('SELECT set_config($1, $2, $3)', [
    'app.current_tenant',
    tenantId.trim(),
    Boolean(local),
  ]);
}

async function clearTenantContext(client) {
  try {
    await client.query(`SELECT set_config('app.current_tenant', '', false)`);
  } catch { /* ignore */ }
}

// ============================================================================
// ABSTRACCIÓN DE ACCESO A DATOS
// ============================================================================

/**
 * Ejecuta una función con un cliente PostgreSQL gestionado automáticamente.
 *
 * Garantiza que:
 * - La conexión se abre antes de llamar a fn
 * - La conexión se cierra en el finally, incluso si fn lanza
 * - Si statementTimeout es provisto, ejecuta SET statement_timeout antes de fn
 * - Si tenantId es provisto, set_config('app.current_tenant') para RLS
 *
 * @param {Env}      env                    - Worker environment bindings (requiere HYPERDRIVE)
 * @param {Function} fn                     - Callback async que recibe el client: (client) => Promise<T>
 * @param {Object}   [options]              - Opciones opcionales
 * @param {number}   [options.statementTimeout] - Timeout en ms para SET statement_timeout (ej: 5000)
 * @param {string}   [options.tenantId]     - Tenant para RLS (app.current_tenant)
 * @returns {Promise<T>} - Valor retornado por fn
 *
 * @example
 * const rows = await withDb(env, client =>
 *   client.query('SELECT * FROM ordenes_pendientes WHERE tenant_id = $1', [tenantId])
 *     .then(r => r.rows)
 * );
 *
 * @example  // con timeout
 * const rows = await withDb(env, client =>
 *   client.query('SELECT COUNT(*) FROM metrics_summary').then(r => r.rows),
 *   { statementTimeout: 5000 }
 * );
 */
export async function withDb(env, fn, options = {}) {
  const client = new Client(CONFIG.DB_OPTS(env));
  let inTenantTx = false;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DB connection timeout')), 8000)
      ),
    ]);
    if (options.statementTimeout) {
      // statement_timeout de PG es en ms cuando se pasa un entero sin unidad
      await client.query(`SET statement_timeout = ${parseInt(options.statementTimeout, 10)}`);
    }
    // Tenant en TX local: no sobrevive al pool de Hyperdrive
    if (options.tenantId) {
      await client.query('BEGIN');
      inTenantTx = true;
      await setTenantContext(client, options.tenantId, { local: true });
    }
    const result = await fn(client);
    if (inTenantTx) {
      await client.query('COMMIT');
      inTenantTx = false;
    }
    return result;
  } catch (err) {
    if (inTenantTx) await safeRollback(client);
    throw err;
  } finally {
    await clearTenantContext(client);
    await client.end().catch(() => {});
  }
}

/**
 * Ejecuta una función dentro de una transacción PostgreSQL gestionada automáticamente.
 *
 * Garantiza que:
 * - La conexión se abre y BEGIN se emite antes de llamar a fn
 * - Si fn completa sin lanzar, se emite COMMIT
 * - Si fn lanza, se emite ROLLBACK via safeRollback y el error se re-lanza
 * - La conexión se cierra en el finally
 * - Si statementTimeout es provisto, se aplica antes del BEGIN
 * - Si tenantId es provisto, set_config local tras BEGIN
 *
 * @param {Env}      env                    - Worker environment bindings (requiere HYPERDRIVE)
 * @param {Function} fn                     - Callback async que recibe el client: (client) => Promise<T>
 * @param {Object}   [options]              - Opciones opcionales
 * @param {number}   [options.statementTimeout] - Timeout en ms para SET statement_timeout (ej: 5000)
 * @param {string}   [options.tenantId]     - Tenant para RLS (app.current_tenant)
 * @returns {Promise<T>} - Valor retornado por fn
 * @throws  Re-lanza cualquier error de fn luego del ROLLBACK
 *
 * @example
 * await withDbTransaction(env, async client => {
 *   await client.query('UPDATE ordenes_pendientes SET estado_operacional = $1 WHERE ot_id = $2', [estado, otId]);
 *   await client.query('INSERT INTO transaction_logs ...', [...params]);
 * });
 *
 * @example  // con timeout
 * await withDbTransaction(env, async client => {
 *   await client.query('INSERT INTO outbox_events ...', [...params]);
 * }, { statementTimeout: 5000 });
 */
export async function withDbTransaction(env, fn, options = {}) {
  const client = new Client(CONFIG.DB_OPTS(env));
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DB connection timeout')), 8000)
      ),
    ]);
    if (options.statementTimeout) {
      await client.query(`SET statement_timeout = ${parseInt(options.statementTimeout, 10)}`);
    }
    await client.query('BEGIN');
    if (options.tenantId) {
      await setTenantContext(client, options.tenantId, { local: true });
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    await clearTenantContext(client);
    await client.end().catch(() => {});
  }
}

export async function recordEventTx(client, otId, traceId, type, payload = {}) {
  return client.query(
    `INSERT INTO ot_events (ot_id, trace_id, event_type, payload) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [otId, traceId, type, JSON.stringify(payload)]
  );
}

export function classifyError(e, status) {
  const msg = String(e?.message || '');
  if (e?.name === 'AbortError' || msg.includes('timeout')) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'SERVER_ERROR';
  return 'UNKNOWN';
}

