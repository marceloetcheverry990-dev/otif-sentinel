// src/helpers/operator-auth.js
// JWT helper para autenticación de operadores de Torre de Control.
// Dominio separado de driver-auth.js:
//   - Usa DASHBOARD_SECRET (no JWT_SECRET)
//   - Payload: { role: 'operator', tenant_id, sub, username, display_name, is_admin, exp }
//   - Expiración: 8 horas (turno operativo)
//
// verifyOperatorToken rechaza cualquier token que no tenga role === 'operator',
// incluyendo tokens de chofer válidos con JWT_SECRET — los secrets son distintos
// y las firmas no cruzan entre dominios.

import { CORS_HEADERS } from '../config.js';
import { HMAC_ALGO, importHmacKey, base64urlEncode, base64urlDecode } from './hmac.js';

// 8 horas — cubre un turno operativo completo sin forzar re-login.
export const OPERATOR_TOKEN_EXPIRY_SECONDS = 8 * 60 * 60;
export const OPERATOR_SESSION_COOKIE = '__Host-otif_operator_session';

function parseCookies(cookieHeader) {
  const cookies = new Map();
  for (const part of (cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export function createOperatorSessionCookie(token) {
  return [
    `${OPERATOR_SESSION_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${OPERATOR_TOKEN_EXPIRY_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

export function clearOperatorSessionCookie() {
  return [
    `${OPERATOR_SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

export function verifySameOrigin(request, { allowBearer = true } = {}) {
  const method = request.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return { ok: true };

  if (allowBearer && request.headers.get('Authorization')?.startsWith('Bearer ')) {
    return { ok: true };
  }

  const origin = request.headers.get('Origin');
  const expectedOrigin = new URL(request.url).origin;
  const fetchSite = request.headers.get('Sec-Fetch-Site');

  const reject = () => ({
    ok: false,
    response: new Response(
      JSON.stringify({ error: 'Origen no permitido', code: 'origen_invalido' }),
      {
        status: 403,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    ),
  });

  // Cross-site explícito → bloquear
  if (fetchSite === 'cross-site') return reject();

  // Origin presente y distinto → bloquear
  if (origin && origin !== expectedOrigin) return reject();

  // Origin correcto → ok
  if (origin === expectedOrigin) return { ok: true };

  // Sin Origin (algunos navegadores / fetch same-origin):
  // permitir solo same-origin, none (user-initiated) o ausencia del header.
  if (!origin && (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none')) {
    return { ok: true };
  }

  return reject();
}

export async function verifyOperatorTenant(request, authenticatedTenant) {
  if (!authenticatedTenant || typeof authenticatedTenant !== 'string') {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Sesión sin tenant', code: 'tenant_invalido' }),
        {
          status: 403,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        },
      ),
    };
  }

  const candidates = [];
  const url = new URL(request.url);
  for (const key of ['tenant_id', 'tenantId']) {
    const value = url.searchParams.get(key);
    if (value) candidates.push(value);
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
    const contentType = request.headers.get('Content-Type') || '';
    try {
      if (contentType.includes('application/json')) {
        const body = await request.clone().json();
        for (const key of ['tenant_id', 'tenantId']) {
          if (typeof body?.[key] === 'string') candidates.push(body[key]);
        }
      } else if (
        contentType.includes('multipart/form-data') ||
        contentType.includes('application/x-www-form-urlencoded')
      ) {
        const form = await request.clone().formData();
        for (const key of ['tenant_id', 'tenantId']) {
          const value = form.get(key);
          if (typeof value === 'string') candidates.push(value);
        }
      }
    } catch {
      // El handler de destino conserva la responsabilidad de validar su body.
    }
  }

  if (candidates.some((tenant) => tenant !== authenticatedTenant)) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Tenant no autorizado', code: 'tenant_incorrecto' }),
        {
          status: 403,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        },
      ),
    };
  }

  return { ok: true };
}

function operatorAuthFailure(request, body, status = 401) {
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');
  if ((status === 401 || status === 503) && acceptsHtml) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: '/login',
        'Cache-Control': 'no-store',
        'Set-Cookie': clearOperatorSessionCookie(),
      },
    });
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 401 || status === 503 ? { 'Set-Cookie': clearOperatorSessionCookie() } : {}),
    },
  });
}

// ─── Validación del secreto de entorno ───────────────────────────────────────

function validateDashboardSecret(env) {
  if (!env?.DASHBOARD_SECRET || typeof env.DASHBOARD_SECRET !== 'string') {
    throw new Error(
      '[operator-auth] DASHBOARD_SECRET no está configurado en el entorno. ' +
      'Configurar con `wrangler secret put DASHBOARD_SECRET` en producción ' +
      'o agregarlo a .dev.vars para desarrollo local.'
    );
  }
  const byteLength = new TextEncoder().encode(env.DASHBOARD_SECRET).byteLength;
  if (byteLength < 32) {
    throw new Error(
      `[operator-auth] DASHBOARD_SECRET es demasiado corto (${byteLength} bytes). ` +
      'Mínimo requerido: 32 bytes. Generar con: openssl rand -base64 32'
    );
  }
}

// ─── signOperatorToken ────────────────────────────────────────────────────────

/**
 * Genera un JWT HS256 firmado con env.DASHBOARD_SECRET.
 *
 * @param {{ role: 'operator', tenant_id: string }} payload
 * @param {{ DASHBOARD_SECRET: string }} env - bindings del Worker
 * @returns {Promise<string>} token en formato "header.payload.signature"
 */
export async function signOperatorToken(payload, env) {
  validateDashboardSecret(env);
  const enc = new TextEncoder();

  const headerB64 = base64urlEncode(
    enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  );

  const exp = Math.floor(Date.now() / 1000) + OPERATOR_TOKEN_EXPIRY_SECONDS;
  const bodyB64 = base64urlEncode(
    enc.encode(JSON.stringify({ ...payload, exp }))
  );

  const signingInput = `${headerB64}.${bodyB64}`;

  const key = await importHmacKey(env.DASHBOARD_SECRET, ['sign']);
  const signatureBuffer = await crypto.subtle.sign(
    HMAC_ALGO,
    key,
    enc.encode(signingInput)
  );

  return `${signingInput}.${base64urlEncode(signatureBuffer)}`;
}

// ─── verifyOperatorToken ──────────────────────────────────────────────────────

/**
 * Verifica el JWT desde la cookie HttpOnly de sesión o, para clientes API,
 * desde el header "Authorization: Bearer <token>".
 * Retorna { ok: true, payload } o { ok: false, response: Response(401|403) }.
 *
 * Además de firma y expiración, verifica que payload.role === 'operator'.
 * Un token de chofer (firmado con JWT_SECRET) no pasa esta función porque
 * los secrets son distintos — la firma no valida con DASHBOARD_SECRET.
 * Si por alguna razón la firma valida pero el role es incorrecto, retorna 403.
 *
 * @param {Request} request
 * @param {{ DASHBOARD_SECRET: string }} env
 * @returns {Promise<{ ok: true, payload: object } | { ok: false, response: Response }>}
 */
export async function verifyOperatorToken(request, env) {
  try {
    validateDashboardSecret(env);
  } catch (err) {
    console.error('[operator-auth]', err.message);
    return {
      ok: false,
      response: operatorAuthFailure(
        request,
        {
          error: 'Servicio mal configurado: DASHBOARD_SECRET inválido o ausente (mín. 32 bytes)',
          code: 'dashboard_secret_invalido',
        },
        503,
      ),
    };
  }

  // ── 1. Extraer token de Bearer o cookie HttpOnly ──────────────────────────
  const authHeader = request.headers.get('Authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const cookieToken = parseCookies(request.headers.get('Cookie')).get(OPERATOR_SESSION_COOKIE);
  const token = bearerToken || cookieToken;

  if (!token) {
    return {
      ok: false,
      response: operatorAuthFailure(
        request,
        { error: 'No autorizado: token ausente', code: 'token_ausente' },
      ),
    };
  }

  // ── 2. Validar estructura ─────────────────────────────────────────────────
  const parts = token.split('.');
  if (parts.length !== 3) {
    return {
      ok: false,
      response: operatorAuthFailure(
        request,
        { error: 'No autorizado: token malformado', code: 'token_invalido' },
      ),
    };
  }

  try {
    // ── 3. Verificar firma (tiempo constante) ─────────────────────────────
    const signingInput = `${parts[0]}.${parts[1]}`;
    const key = await importHmacKey(env.DASHBOARD_SECRET, ['verify']);

    const isValid = await crypto.subtle.verify(
      HMAC_ALGO,
      key,
      base64urlDecode(parts[2]),
      new TextEncoder().encode(signingInput)
    );

    if (!isValid) {
      return {
        ok: false,
        response: operatorAuthFailure(
          request,
          { error: 'No autorizado: firma inválida', code: 'token_invalido' },
        ),
      };
    }

    // ── 4. Decodificar payload ────────────────────────────────────────────
    const payload = JSON.parse(
      new TextDecoder().decode(base64urlDecode(parts[1]))
    );

    // ── 5. Verificar expiración ───────────────────────────────────────────
    if (typeof payload.exp !== 'number') {
      return {
        ok: false,
        response: operatorAuthFailure(
          request,
          { error: 'No autorizado: token sin expiración', code: 'token_invalido' },
        ),
      };
    }

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return {
        ok: false,
        response: operatorAuthFailure(
          request,
          { error: 'No autorizado: token expirado', code: 'token_expirado' },
        ),
      };
    }

    // ── 6. Verificar role — 403 si es un token de otro dominio ───────────
    if (payload.role !== 'operator') {
      return {
        ok: false,
        response: operatorAuthFailure(
          request,
          {
            error: 'Prohibido: este token no es de operador',
            code: 'role_incorrecto',
          },
          403,
        ),
      };
    }

    return { ok: true, payload };

  } catch {
    return {
      ok: false,
      response: operatorAuthFailure(
        request,
        { error: 'No autorizado: token inválido', code: 'token_invalido' },
      ),
    };
  }
}

// ─── verifyCredentials (interna) ──────────────────────────────────────────────
// No exportada — solo la usa operator-login.js.
// Comparación de tiempo constante: ambas verificaciones HMAC siempre corren,
// nunca hay cortocircuito entre username y password.

/**
 * @param {string} username - Username recibido en el request
 * @param {string} password - Password recibido en el request
 * @param {{ DASHBOARD_SECRET: string, MONITORING_USERNAME: string, MONITORING_PASSWORD: string }} env
 * @returns {Promise<boolean>}
 */
export async function verifyCredentials(username, password, env) {
  const key = await importHmacKey(env.DASHBOARD_SECRET, ['sign', 'verify']);
  const enc = new TextEncoder();

  // Firmar los valores correctos con la misma clave
  const [macUsernameCorrect, macPasswordCorrect] = await Promise.all([
    crypto.subtle.sign(HMAC_ALGO, key, enc.encode(env.MONITORING_USERNAME)),
    crypto.subtle.sign(HMAC_ALGO, key, enc.encode(env.MONITORING_PASSWORD)),
  ]);

  // Verificar los valores recibidos — ambas siempre corren (Promise.all)
  const [usernameOk, passwordOk] = await Promise.all([
    crypto.subtle.verify(HMAC_ALGO, key, macUsernameCorrect, enc.encode(username)),
    crypto.subtle.verify(HMAC_ALGO, key, macPasswordCorrect, enc.encode(password)),
  ]);

  // Combinar DESPUÉS de que ambas comparaciones ya terminaron
  return usernameOk && passwordOk;
}
