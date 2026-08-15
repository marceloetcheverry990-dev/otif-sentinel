// src/api/operators.js
// Gestión de operadores de Torre (admin) + /me.

import { CORS_HEADERS } from '../config.js';
import { withDb } from '../db.js';
import { writeAuditLog, operatorAuditContext } from '../helpers/audit-log.js';
import {
  createTowerOperator,
  ensureOperatorSchema,
  listTowerOperators,
} from '../helpers/tower-operators.js';

const jsonHeaders = () => ({ ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders() });
}

/** GET /api/operators/me */
export async function handleOperatorMe(request, env, operator) {
  return json({
    operator_id: operator.sub || null,
    username: operator.username || null,
    display_name: operator.display_name || operator.username || null,
    tenant_id: operator.tenant_id,
    is_admin: !!operator.is_admin,
    legacy: !!operator.legacy,
  });
}

/** GET /api/operators — solo admin */
export async function handleListOperators(request, env, operator) {
  if (!operator.is_admin) {
    return json({ error: 'Se requiere rol admin', code: 'forbidden' }, 403);
  }
  try {
    const rows = await withDb(env, async (client) => {
      await ensureOperatorSchema(client);
      return listTowerOperators(client, operator.tenant_id);
    });
    return json({ operators: rows });
  } catch (err) {
    console.error('[operators] list:', err.message);
    return json({ error: 'No se pudo listar operadores' }, 500);
  }
}

/** POST /api/operators — solo admin */
export async function handleCreateOperator(request, env, operator) {
  if (!operator.is_admin) {
    return json({ error: 'Se requiere rol admin', code: 'forbidden' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body JSON inválido' }, 400);
  }

  const username = body?.username;
  const password = body?.password;
  const display_name = body?.display_name;
  const email = body?.email;
  const is_admin = !!body?.is_admin;

  if (!username || !password) {
    return json({ error: 'username y password son requeridos' }, 400);
  }

  try {
    const created = await withDb(env, async (client) => {
      return createTowerOperator(client, env, {
        tenant_id: operator.tenant_id,
        username,
        password,
        display_name,
        email,
        is_admin,
      });
    });

    await writeAuditLog(env, {
      ...operatorAuditContext(operator, request),
      action: 'operator.create',
      outcome: 'success',
      resource_type: 'tower_operator',
      resource_id: created.operator_id,
      meta: { username: created.username, is_admin: created.is_admin },
    });

    return json({
      success: true,
      operator: {
        operator_id: created.operator_id,
        username: created.username,
        display_name: created.display_name,
        email: created.email,
        is_admin: created.is_admin,
        is_active: created.is_active,
      },
    }, 201);
  } catch (err) {
    const msg = err.message || 'Error al crear operador';
    const status = /duplicate|unique|ya existe/i.test(msg) ? 409 : 400;
    await writeAuditLog(env, {
      ...operatorAuditContext(operator, request),
      action: 'operator.create',
      outcome: 'failure',
      meta: { error: msg, username },
    });
    return json({ error: msg }, status);
  }
}
