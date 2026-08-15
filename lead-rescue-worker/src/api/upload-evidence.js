// src/api/upload-evidence.js
import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS } from '../config.js';
import { verifyDriverToken } from '../helpers/driver-auth.js';
import { verifyOperatorToken, verifySameOrigin } from '../helpers/operator-auth.js';
import { uploadEvidenceImage } from '../helpers/evidence-upload.js';
import { checkRateLimit } from '../monitoring/rate-limiter.js';

const jsonHeaders = () => ({ ...CORS_HEADERS, 'Content-Type': 'application/json' });

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || request.headers.get('X-Real-IP')
    || 'unknown'
  );
}

async function resolveUploader(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const driver = await verifyDriverToken(request, env);
    if (driver.ok) {
      return { ok: true, tenant_id: driver.payload.tenant_id, role: 'driver' };
    }
    return driver;
  }

  // verifyOperatorToken lanza si DASHBOARD_SECRET no está configurado —
  // en ese caso responder 401 (sin credenciales) en lugar de 500
  let op;
  try {
    op = await verifyOperatorToken(request, env);
  } catch {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'No autorizado', code: 'token_ausente' }),
        { status: 401, headers: jsonHeaders() }
      ),
    };
  }
  if (!op.ok) return op;
  const origin = verifySameOrigin(request);
  if (!origin.ok) return origin;
  return { ok: true, tenant_id: op.payload.tenant_id, role: 'operator' };
}

export async function handleUploadEvidence(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: jsonHeaders(),
    });
  }

  try {
    const auth = await resolveUploader(request, env);
    if (!auth.ok) return auth.response;

    const tenant_id = auth.tenant_id;

    // J-8: rate limit por IP (30/min) y por tenant (120/hora)
    const ipLimit = checkRateLimit(clientIp(request), '/api/upload-evidence', 30, 60_000);
    if (!ipLimit.allowed) {
      return new Response(
        JSON.stringify({ error: 'Demasiadas subidas. Intenta más tarde.', code: 'rate_limit_excedido' }),
        {
          status: 429,
          headers: { ...jsonHeaders(), 'Retry-After': String(ipLimit.retryAfter || 60), 'Cache-Control': 'no-store' },
        }
      );
    }
    const tenantLimit = checkRateLimit(tenant_id, 'upload-evidence-tenant', 120, 60 * 60_000);
    if (!tenantLimit.allowed) {
      return new Response(
        JSON.stringify({ error: 'Cuota de evidencias del tenant agotada', code: 'tenant_quota_excedida' }),
        {
          status: 429,
          headers: { ...jsonHeaders(), 'Retry-After': String(tenantLimit.retryAfter || 300), 'Cache-Control': 'no-store' },
        }
      );
    }

    const body = await request.json();
    const { photo } = body;

    // Ignorar tenant_id del body — solo el del token
    if (body.tenant_id && body.tenant_id !== tenant_id) {
      return new Response(
        JSON.stringify({ error: 'Prohibido: tenant_id del token no coincide', code: 'tenant_mismatch' }),
        { status: 403, headers: jsonHeaders() }
      );
    }

    if (!photo) {
      return new Response(JSON.stringify({ error: 'Falta el campo photo (base64)' }), {
        status: 400,
        headers: jsonHeaders(),
      });
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch },
    });

    const uploaded = await uploadEvidenceImage(supabase, {
      tenant_id,
      photo,
      prefix: 'chat',
    });

    if (!uploaded.ok) {
      return new Response(JSON.stringify({ error: uploaded.error }), {
        status: 400,
        headers: jsonHeaders(),
      });
    }

    return new Response(JSON.stringify({ url: uploaded.url }), {
      status: 200,
      headers: { ...jsonHeaders(), 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[UPLOAD_EVIDENCE_ERROR]', error.message);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: jsonHeaders(),
    });
  }
}
