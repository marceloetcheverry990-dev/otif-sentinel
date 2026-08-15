// src/api/depots.js
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { withDb } from '../db.js';
import {
  ensureDefaultDepot,
  ensureDepotsSchema,
  listDepots,
  normalizeDepotRow,
} from '../helpers/depots.js';
import { verifyOperatorToken } from '../helpers/operator-auth.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function handleListDepots(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const err = requireTenantId(tenant_id);
  if (err) return err;
  const depots = await listDepots(env, tenant_id);
  return json({ exito: true, depots });
}

/** Admin: crear bodega adicional */
export async function handleCreateDepot(request, env, operator = null) {
  if (!operator?.is_admin) {
    return json({ error: 'Solo admin puede crear bodegas', code: 'admin_required' }, 403);
  }
  const tenant_id = operator.tenant_id;
  const err = requireTenantId(tenant_id);
  if (err) return err;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }

  const nombre = String(body.nombre || '').trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const is_default = !!body.is_default;
  const direccion = body.direccion != null ? String(body.direccion).trim() || null : null;
  const comuna = body.comuna != null ? String(body.comuna).trim() || null : null;
  if (!nombre || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json({ error: 'nombre, lat y lng son obligatorios' }, 400);
  }

  // C-7: siempre prefijar con tenant; ignorar body.depot_id ajeno
  const nombreSlug = nombre
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .slice(0, 48);
  const depot_id = `${tenant_id}-${nombreSlug}`.slice(0, 64);

  try {
    const row = await withDb(env, async (client) => {
      await ensureDepotsSchema(client);
      await ensureDefaultDepot(client, tenant_id);
      if (is_default) {
        await client.query(
          `UPDATE depots SET is_default = FALSE WHERE tenant_id = $1 AND is_default = TRUE`,
          [tenant_id]
        );
      }
      const res = await client.query(
        `INSERT INTO depots (depot_id, tenant_id, nombre, lat, lng, is_default, activo, direccion, comuna)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8)
         ON CONFLICT (depot_id) DO UPDATE SET
           nombre = EXCLUDED.nombre,
           lat = EXCLUDED.lat,
           lng = EXCLUDED.lng,
           is_default = EXCLUDED.is_default,
           activo = TRUE,
           direccion = COALESCE(EXCLUDED.direccion, depots.direccion),
           comuna = COALESCE(EXCLUDED.comuna, depots.comuna)
         WHERE depots.tenant_id = $2
         RETURNING depot_id, tenant_id, nombre, lat, lng, is_default, activo, direccion, comuna`,
        [depot_id, tenant_id, nombre, lat, lng, is_default, direccion, comuna]
      );
      if (!res.rows[0]) {
        throw new Error('No se pudo crear/actualizar depot: conflicto de ownership');
      }
      return normalizeDepotRow(res.rows[0]);
    });
    return json({ exito: true, depot: row });
  } catch (e) {
    console.error('[CREATE_DEPOT]', e.message);
    return json({ error: e.message }, 500);
  }
}

export async function requireOperatorForDepots(request, env) {
  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth;
  return { ok: true, payload: auth.payload };
}
