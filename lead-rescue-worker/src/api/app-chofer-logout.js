import { CORS_HEADERS } from '../config.js';
import { revokeDriverJti, verifyDriverToken } from '../helpers/driver-auth.js';

const jsonHeaders = () => ({ ...CORS_HEADERS, 'Content-Type': 'application/json' });

/**
 * POST /api/choferes/logout
 * Revoca el jti del Bearer token hasta su exp.
 */
export async function logoutChofer(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: jsonHeaders(),
    });
  }

  const auth = await verifyDriverToken(request, env);
  if (!auth.ok) return auth.response;

  if (auth.payload.jti && typeof auth.payload.exp === 'number') {
    const revoked = await revokeDriverJti(auth.payload.jti, auth.payload.exp, env);
    // M-6: si hay KV y el put falló, no mentir con success
    if (!revoked.ok || revoked.reason === 'kv_put_failed') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'No se pudo revocar la sesión de forma duradera',
          code: revoked.reason || 'revoke_failed',
        }),
        { status: 503, headers: { ...jsonHeaders(), 'Cache-Control': 'no-store' } }
      );
    }
    if (revoked.reason === 'kv_unavailable') {
      console.error('[LOGOUT] DRIVER_REVOKED_JTI no configurado — revocación solo en memoria');
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...jsonHeaders(), 'Cache-Control': 'no-store' },
  });
}
