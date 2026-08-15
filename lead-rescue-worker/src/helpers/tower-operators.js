// src/helpers/tower-operators.js
// Operadores individuales de Torre (tabla tower_operators).

import { hashPin, verifyPin } from './pin-kdf.js';
import { verifyCredentials } from './operator-auth.js';
import { withDb } from '../db.js';

let schemaReady = false;

export function passwordEnv(env) {
  return { PIN_PEPPER: env.DASHBOARD_SECRET, JWT_SECRET: env.DASHBOARD_SECRET };
}

export async function ensureOperatorSchema(client) {
  if (schemaReady) return;
  await client.query(`
    CREATE TABLE IF NOT EXISTS tower_operators (
      operator_id    VARCHAR(36)   PRIMARY KEY,
      tenant_id      VARCHAR(64)   NOT NULL,
      username       VARCHAR(64)   NOT NULL,
      display_name   VARCHAR(128),
      email          VARCHAR(255),
      password_hash  TEXT          NOT NULL,
      is_admin       BOOLEAN       NOT NULL DEFAULT FALSE,
      is_active      BOOLEAN       NOT NULL DEFAULT TRUE,
      last_login_at  TIMESTAMPTZ,
      created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_tower_operators_tenant_username UNIQUE (tenant_id, username)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id             BIGSERIAL     PRIMARY KEY,
      tenant_id      VARCHAR(64)   NOT NULL,
      operator_id    VARCHAR(36),
      username       VARCHAR(64),
      action         VARCHAR(64)   NOT NULL,
      outcome        VARCHAR(16)   NOT NULL DEFAULT 'success',
      resource_type  VARCHAR(64),
      resource_id    VARCHAR(128),
      meta           JSONB         NOT NULL DEFAULT '{}'::jsonb,
      ip             VARCHAR(64),
      created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tower_operators_tenant_active
      ON tower_operators (tenant_id, is_active)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created
      ON audit_log (tenant_id, created_at DESC)
  `);
  schemaReady = true;
}

/**
 * @returns {Promise<object|null>} sesión de operador autenticada
 */
export async function authenticateTowerOperator(username, password, env) {
  const tenant_id = env.MONITORING_TENANT_ID;
  if (!tenant_id || !username || !password) return null;

  const user = String(username).trim().toLowerCase();
  const envUser = String(env.MONITORING_USERNAME || '').trim().toLowerCase();

  async function sessionFromRow(row, extra = {}) {
    return {
      operator_id: row.operator_id,
      tenant_id: row.tenant_id,
      username: row.username,
      display_name: row.display_name || row.username,
      email: row.email || null,
      is_admin: !!row.is_admin,
      legacy: false,
      ...extra,
    };
  }

  /** Credencial de equipo del Worker (MONITORING_*): re-sincroniza hash en DB. */
  async function tryTeamCredential(client, existingRow = null) {
    if (!envUser || user !== envUser) return null;
    if (!env.MONITORING_USERNAME || !env.MONITORING_PASSWORD || !env.DASHBOARD_SECRET) return null;
    const envOk = await verifyCredentials(env.MONITORING_USERNAME, password, env);
    if (!envOk) return null;

    const password_hash = await hashPin(password, passwordEnv(env));
    if (existingRow?.operator_id) {
      await client.query(
        `UPDATE tower_operators
         SET password_hash = $1, is_active = TRUE, last_login_at = NOW(), updated_at = NOW()
         WHERE operator_id = $2`,
        [password_hash, existingRow.operator_id]
      );
      return sessionFromRow(
        { ...existingRow, is_active: true },
        { bootstrapped: true, hash_resynced: true }
      );
    }

    const operator_id = crypto.randomUUID();
    const display_name = String(username).trim();
    await client.query(
      `INSERT INTO tower_operators
         (operator_id, tenant_id, username, display_name, password_hash, is_admin, is_active, last_login_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, NOW())
       ON CONFLICT (tenant_id, username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             is_active = TRUE,
             last_login_at = NOW(),
             updated_at = NOW()`,
      [operator_id, tenant_id, user, display_name, password_hash]
    );
    const again = await client.query(
      `SELECT operator_id, tenant_id, username, display_name, email, is_admin, is_active
       FROM tower_operators
       WHERE tenant_id = $1 AND LOWER(username) = $2
       LIMIT 1`,
      [tenant_id, user]
    );
    return sessionFromRow(again.rows[0], { bootstrapped: true });
  }

  try {
    return await withDb(env, async (client) => {
      await ensureOperatorSchema(client);

      const found = await client.query(
        `SELECT operator_id, tenant_id, username, display_name, email,
                password_hash, is_admin, is_active
         FROM tower_operators
         WHERE tenant_id = $1 AND LOWER(username) = $2
         LIMIT 1`,
        [tenant_id, user]
      );

      if (found.rowCount > 0) {
        const row = found.rows[0];
        if (!row.is_active) {
          // Equipo env puede reactivar al admin de bootstrap
          const revived = await tryTeamCredential(client, row);
          if (revived) return revived;
          return null;
        }

        const check = await verifyPin(password, row.password_hash, passwordEnv(env));
        if (check.ok) {
          if (check.needsUpgrade) {
            const upgraded = await hashPin(password, passwordEnv(env));
            await client.query(
              `UPDATE tower_operators
               SET password_hash = $1, updated_at = NOW()
               WHERE operator_id = $2`,
              [upgraded, row.operator_id]
            );
          }
          await client.query(
            `UPDATE tower_operators SET last_login_at = NOW(), updated_at = NOW()
             WHERE operator_id = $1`,
            [row.operator_id]
          );
          return sessionFromRow(row);
        }

        // Hash viejo / DASHBOARD_SECRET rotado: aceptar MONITORING_PASSWORD y re-sincronizar
        const resynced = await tryTeamCredential(client, row);
        if (resynced) return resynced;
        return null;
      }

      // Sin fila en este tenant: credencial de equipo → bootstrap
      const boot = await tryTeamCredential(client, null);
      if (boot) return boot;

      // Misma DB staging/prod: operador puede vivir en otro tenant (ej. empresa_base)
      const others = await client.query(
        `SELECT operator_id, tenant_id, username, display_name, email,
                password_hash, is_admin, is_active
         FROM tower_operators
         WHERE LOWER(username) = $1 AND is_active = TRUE AND tenant_id <> $2
         ORDER BY last_login_at DESC NULLS LAST
         LIMIT 5`,
        [user, tenant_id]
      );
      for (const row of others.rows || []) {
        const check = await verifyPin(password, row.password_hash, passwordEnv(env));
        if (!check.ok) continue;
        await client.query(
          `UPDATE tower_operators SET last_login_at = NOW(), updated_at = NOW()
           WHERE operator_id = $1`,
          [row.operator_id]
        );
        return sessionFromRow(row, { cross_tenant: true });
      }

      return null;
    }, { statementTimeout: 10000 });
  } catch (err) {
    console.warn('[tower-operators] DB auth falló, fallback env:', err.message);
    if (user !== envUser) return null;
    const envOk = await verifyCredentials(env.MONITORING_USERNAME, password, env);
    if (!envOk) return null;
    return {
      operator_id: null,
      tenant_id,
      username: user,
      display_name: user,
      email: null,
      is_admin: true,
      legacy: true,
    };
  }
}

export async function createTowerOperator(client, env, {
  tenant_id,
  username,
  password,
  display_name,
  email,
  is_admin = false,
}) {
  const user = String(username).trim().toLowerCase();
  if (!user || user.length < 2) throw new Error('username inválido');
  if (!password || String(password).length < 8) throw new Error('password mínimo 8 caracteres');

  await ensureOperatorSchema(client);
  const operator_id = crypto.randomUUID();
  const password_hash = await hashPin(password, passwordEnv(env));

  const res = await client.query(
    `INSERT INTO tower_operators
       (operator_id, tenant_id, username, display_name, email, password_hash, is_admin, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
     RETURNING operator_id, tenant_id, username, display_name, email, is_admin, is_active, created_at`,
    [
      operator_id,
      tenant_id,
      user,
      (display_name || user).trim(),
      email ? String(email).trim() : null,
      password_hash,
      !!is_admin,
    ]
  );
  return res.rows[0];
}

export async function listTowerOperators(client, tenant_id) {
  await ensureOperatorSchema(client);
  const res = await client.query(
    `SELECT operator_id, username, display_name, email, is_admin, is_active,
            last_login_at, created_at
     FROM tower_operators
     WHERE tenant_id = $1
     ORDER BY username ASC`,
    [tenant_id]
  );
  return res.rows;
}
