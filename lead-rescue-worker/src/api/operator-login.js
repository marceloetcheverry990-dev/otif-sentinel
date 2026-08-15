// src/api/operator-login.js
// Handler para POST /api/operator/login
// Autentica operadores individuales (DB) con bootstrap desde credencial de equipo.

import { CORS_HEADERS } from '../config.js';
import {
  clearOperatorSessionCookie,
  createOperatorSessionCookie,
  signOperatorToken,
  verifySameOrigin,
} from '../helpers/operator-auth.js';
import { authenticateTowerOperator } from '../helpers/tower-operators.js';
import { writeAuditLog } from '../helpers/audit-log.js';
import { checkRateLimit } from '../monitoring/rate-limiter.js';

const jsonHeaders = () => ({ ...CORS_HEADERS, 'Content-Type': 'application/json' });

function jsonRes(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders(), 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

/**
 * POST /api/operator/login
 * Body: { username: string, password: string }
 */
export async function handleOperatorLogin(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: jsonHeaders() });
  }

  const origin = verifySameOrigin(request, { allowBearer: false });
  if (!origin.ok) return origin.response;

  const ip = request.headers.get('CF-Connecting-IP')
          ?? request.headers.get('X-Forwarded-For')
          ?? 'unknown';

  const rateResult = checkRateLimit(ip, '/api/operator/login', 10, 900000);
  if (!rateResult.allowed) {
    return new Response(
      JSON.stringify({
        error: 'Demasiados intentos',
        code: 'rate_limit_excedido',
        retry_after_seconds: rateResult.retryAfter,
      }),
      {
        status: 429,
        headers: {
          ...jsonHeaders(),
          'Retry-After': String(rateResult.retryAfter),
        },
      }
    );
  }

  let username, password;
  try {
    const body = await request.json();
    username = body?.username;
    password = body?.password;
  } catch {
    return jsonRes({ error: 'Body JSON inválido' }, 400);
  }

  if (!username || !password) {
    return jsonRes({ error: 'Se requieren username y password', code: 'campos_faltantes' }, 400);
  }

  if (!env.DASHBOARD_SECRET || !env.MONITORING_TENANT_ID) {
    console.error('[operator-login] Faltan DASHBOARD_SECRET o MONITORING_TENANT_ID');
    return jsonRes({ error: 'Servicio no configurado', code: 'secrets_faltantes' }, 503);
  }

  const dashBytes = new TextEncoder().encode(env.DASHBOARD_SECRET).byteLength;
  if (dashBytes < 32) {
    console.error(`[operator-login] DASHBOARD_SECRET demasiado corto (${dashBytes} bytes)`);
    return jsonRes({
      error: 'DASHBOARD_SECRET de staging es demasiado corto (mín. 32 caracteres). No uses la password de login: generá una clave larga o copiá la de prod.',
      code: 'dashboard_secret_corto',
    }, 503);
  }

  // Credencial de equipo sigue siendo necesaria para bootstrap / fallback
  if (!env.MONITORING_USERNAME || !env.MONITORING_PASSWORD) {
    console.error('[operator-login] Faltan MONITORING_USERNAME / MONITORING_PASSWORD');
    return jsonRes({ error: 'Servicio no configurado', code: 'secrets_faltantes' }, 503);
  }

  let session;
  try {
    session = await authenticateTowerOperator(username, password, env);
  } catch (err) {
    console.error('[operator-login] Error autenticando:', err.message);
    const msg = String(err.message || '');
    if (msg.includes('at least') || msg.includes('demasiado corto') || msg.includes('DASHBOARD_SECRET')) {
      return jsonRes({
        error: 'DASHBOARD_SECRET inválido en staging. Debe tener al menos 32 bytes (no es la password de login).',
        code: 'dashboard_secret_invalido',
      }, 503);
    }
    return jsonRes({ error: 'Servicio no configurado', code: 'auth_exception' }, 503);
  }

  if (!session) {
    await writeAuditLog(env, {
      tenant_id: env.MONITORING_TENANT_ID,
      username: String(username).trim().toLowerCase(),
      action: 'operator.login',
      outcome: 'failure',
      meta: { reason: 'credenciales_invalidas' },
      ip: ip === 'unknown' ? null : ip,
    });
    return jsonRes({ error: 'Credenciales inválidas', code: 'credenciales_invalidas' }, 401);
  }

  try {
    const token = await signOperatorToken(
      {
        role: 'operator',
        tenant_id: session.tenant_id,
        sub: session.operator_id || undefined,
        username: session.username,
        display_name: session.display_name,
        is_admin: !!session.is_admin,
        legacy: !!session.legacy,
      },
      env
    );

    await writeAuditLog(env, {
      tenant_id: session.tenant_id,
      operator_id: session.operator_id,
      username: session.username,
      action: 'operator.login',
      outcome: 'success',
      meta: {
        bootstrapped: !!session.bootstrapped,
        legacy: !!session.legacy,
        is_admin: !!session.is_admin,
      },
      ip: ip === 'unknown' ? null : ip,
    });

    return jsonRes(
      {
        success: true,
        operator: {
          username: session.username,
          display_name: session.display_name,
          is_admin: !!session.is_admin,
        },
      },
      200,
      { 'Set-Cookie': createOperatorSessionCookie(token) },
    );
  } catch (err) {
    console.error('[operator-login] Error firmando token:', err.message);
    return jsonRes({ error: 'Servicio no configurado' }, 503);
  }
}

export async function handleOperatorLogout(request, env) {
  if (request.method !== 'POST') {
    return jsonRes({ error: 'Method Not Allowed' }, 405);
  }

  const origin = verifySameOrigin(request, { allowBearer: false });
  if (!origin.ok) return origin.response;

  // Intentar anotar quién cerró sesión (si hay cookie válida)
  try {
    const { verifyOperatorToken } = await import('../helpers/operator-auth.js');
    const auth = await verifyOperatorToken(request, env);
    if (auth.ok) {
      await writeAuditLog(env, {
        tenant_id: auth.payload.tenant_id,
        operator_id: auth.payload.sub || null,
        username: auth.payload.username || null,
        action: 'operator.logout',
        outcome: 'success',
        ip: request.headers.get('CF-Connecting-IP') || null,
      });
    }
  } catch (_) { /* ignore */ }

  return jsonRes(
    { success: true },
    200,
    { 'Set-Cookie': clearOperatorSessionCookie() },
  );
}
