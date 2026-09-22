// src/api/erp.js
// API del ERP (módulo MM). Un solo punto de entrada para todas las transacciones:
//   GET  /api/erp/tx/:CODE?param=...   → tx.get  (solo lectura, withDb)
//   POST /api/erp/tx/:CODE  {json}     → tx.post (dentro de una transacción SQL: todo o nada)
//   GET  /api/erp/f4/:ayuda?q=...      → valores para la ayuda de búsqueda (F4)
// La autenticación (cookie de operador de la Torre) y el audit_log de las
// mutaciones los pone index.js antes de llegar acá.

import { CORS_HEADERS, requireTenantId } from '../config.js';
import { withDb, withDbTransaction } from '../db.js';
import { ErpError } from '../erp/core.js';
import { ensureErpSchema, erpSchemaListo } from '../erp/schema.js';
import { TRANSACCIONES, AYUDAS_F4 } from '../erp/registry.js';
import { invalidateTowerPoll } from '../helpers/tower-poll-cache.js';

const MAX_BODY_BYTES = 256 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function respuestaError(err, code) {
  if (err instanceof ErpError) {
    return json({ tipo: err.tipo, mensaje: err.message }, err.status);
  }
  if (err?.code === '23505') {
    return json({ tipo: 'E', mensaje: 'El registro ya existe (clave duplicada)' }, 409);
  }
  console.error('[ERP]', code, err?.code, err?.message);
  return json({ tipo: 'E', mensaje: 'Error interno del sistema. Intente nuevamente.' }, 500);
}

// El DDL corre en su propia conexión (fuera de la transacción de la mutación):
// un ALTER que falle por permisos abortaría la transacción entera de Postgres.
async function prepararEsquema(env, tenant_id) {
  if (erpSchemaListo()) return;
  await withDb(env, (client) => ensureErpSchema(client), { tenantId: tenant_id });
}

export async function handleErpApi(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const err = requireTenantId(tenant_id);
  if (err) return err;

  const url = new URL(request.url);
  const [, , , recurso, nombre] = url.pathname.split('/'); // ['', 'api', 'erp', recurso, nombre]

  if (recurso === 'f4') {
    const ayuda = AYUDAS_F4[nombre];
    if (!ayuda || request.method !== 'GET') return json({ tipo: 'E', mensaje: 'Ayuda de búsqueda no existe' }, 404);
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 64);
    try {
      await prepararEsquema(env, tenant_id);
      const valores = await withDb(env, (client) =>
        ayuda(client, tenant_id, q), { tenantId: tenant_id });
      return json({ valores });
    } catch (e) {
      return respuestaError(e, `F4:${nombre}`);
    }
  }

  if (recurso !== 'tx') return json({ tipo: 'E', mensaje: 'Recurso no existe' }, 404);

  const code = String(nombre || '').toUpperCase();
  const tx = TRANSACCIONES[code];
  if (!tx) return json({ tipo: 'E', mensaje: `La transacción ${code} no existe` }, 404);

  const ctx = { tenant_id, operator, env };

  try {
    await prepararEsquema(env, tenant_id);
    if (request.method === 'GET') {
      if (!tx.get) return json({ tipo: 'E', mensaje: `${code} no tiene consulta` }, 405);
      const params = Object.fromEntries(url.searchParams.entries());
      const data = await withDb(env, (client) =>
        tx.get({ ...ctx, client, params }), { tenantId: tenant_id });
      return json(data);
    }

    if (request.method === 'POST') {
      if (!tx.post) return json({ tipo: 'E', mensaje: `${code} no permite grabar` }, 405);
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return json({ tipo: 'E', mensaje: 'Solicitud demasiado grande' }, 413);
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json({ tipo: 'E', mensaje: 'JSON inválido' }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ tipo: 'E', mensaje: 'El cuerpo debe ser un objeto JSON' }, 400);
      }
      const data = await withDbTransaction(env, (client) =>
        tx.post({ ...ctx, client, body }), { tenantId: tenant_id });
      // Si la transacción cambió estados que ve la Torre (ej. MIGO liberó quiebres),
      // que el próximo poll no sirva la caché vieja.
      const { invalidarTorre, ...resto } = data || {};
      if (invalidarTorre) invalidateTowerPoll(tenant_id);
      return json({ tipo: 'S', ...resto });
    }

    return json({ tipo: 'E', mensaje: 'Método no permitido' }, 405);
  } catch (e) {
    return respuestaError(e, code);
  }
}
