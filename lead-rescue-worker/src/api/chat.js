// src/api/chat.js
import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { verifyDriverToken } from '../helpers/driver-auth.js';
import { isTrustedEvidenceUrl } from '../helpers/evidence-upload.js';
import {
  verifyOperatorTenant,
  verifyOperatorToken,
  verifySameOrigin,
} from '../helpers/operator-auth.js';
import { assertDriverCanAccessTrip } from '../helpers/trip-ownership.js';
import { invalidateTowerPoll } from '../helpers/tower-poll-cache.js';

// Cache en memoria para mensajes (temporal hasta que se cree el índice)
const chatCache = new Map();
const CACHE_TTL = 10000; // 10 segundos
const CACHE_MAX = 200;

function pruneChatCache() {
  const now = Date.now();
  for (const [k, v] of chatCache) {
    if (now - v.timestamp >= CACHE_TTL) chatCache.delete(k);
  }
  while (chatCache.size > CACHE_MAX) {
    const first = chatCache.keys().next().value;
    chatCache.delete(first);
  }
}

/**
 * Resuelve tenant autenticado:
 * - Bearer driver JWT → tenant del chofer
 * - Else → cookie JWT de operador (misma lógica que requireOperatorAccess)
 * No se confía en tenant_id del query/body del cliente.
 */
async function resolveChatTenant(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const driver = await verifyDriverToken(request, env);
    if (driver.ok) {
      const tenantError = requireTenantId(driver.payload.tenant_id);
      if (tenantError) return { ok: false, response: tenantError };
      return {
        ok: true,
        tenant_id: driver.payload.tenant_id,
        role: 'driver',
        rut: driver.payload.rut,
        chofer_id: driver.payload.chofer_id || null,
      };
    }
    // Bearer presente pero no es driver válido: no caer a operador anónimo
    return driver;
  }

  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth;

  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());
  if (isMutation) {
    const origin = verifySameOrigin(request);
    if (!origin.ok) return origin;
  }

  const tenant = await verifyOperatorTenant(request, auth.payload.tenant_id);
  if (!tenant.ok) return tenant;

  const tenantError = requireTenantId(auth.payload.tenant_id);
  if (tenantError) return { ok: false, response: tenantError };
  return { ok: true, tenant_id: auth.payload.tenant_id, role: 'operator' };
}

export async function handleChat(request, env) {
  // El preflight OPTIONS ya es interceptado globalmente en index.js
  // Este guard es defensa en profundidad para llamadas directas al módulo
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  const auth = await resolveChatTenant(request, env);
  if (!auth.ok) return auth.response;
  const tenant_id = auth.tenant_id;

  const url = new URL(request.url);
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    global: { fetch: fetch }
  });

  try {
    if (request.method === 'GET') {
      const trip_id = url.searchParams.get('trip_id');

      if (!trip_id) {
        return new Response(JSON.stringify({ error: 'Faltan parámetros (trip_id)' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }

      if (auth.role === 'driver') {
        const tripErr = await assertDriverCanAccessTrip(supabase, {
          trip_id,
          tenant_id,
          rut: auth.rut,
          chofer_id: auth.chofer_id || null,
        });
        if (tripErr) return tripErr;
      }

      // Revisar cache primero
      const cacheKey = `${tenant_id}:${trip_id}`;
      const cached = chatCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return new Response(JSON.stringify({ exito: true, mensajes: cached.data, cached: true }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }

      // Timeout de 15 segundos para la query (aumentado temporalmente)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      try {
        const { data, error } = await supabase
          .from('bitacora_viajes')
          .select('id, tipo_evento, mensaje, foto_url, evidencia_url, created_at')
          .eq('tenant_id', tenant_id)
          .eq('trip_id', trip_id)
          .in('tipo_evento', ['CHAT_CHOFER', 'CHAT_TORRE'])
          .order('created_at', { ascending: false })
          .limit(50)
          .abortSignal(controller.signal);

        clearTimeout(timeoutId);

        if (error) throw error;

        // Normalizar: usar foto_url si existe, sino evidencia_url
        const mensajes = (data || []).map(m => ({
          id: m.id,
          tipo_evento: m.tipo_evento,
          mensaje: m.mensaje,
          foto_url: m.foto_url || m.evidencia_url || null,
          created_at: m.created_at
        })).reverse();

        pruneChatCache();
        chatCache.set(cacheKey, { data: mensajes, timestamp: Date.now() });

        return new Response(JSON.stringify({ exito: true, mensajes }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          // A-12: timeout ≠ vacío silencioso
          if (cached) {
            return new Response(JSON.stringify({ exito: true, mensajes: cached.data, stale: true }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ error: 'Timeout al cargar chat', code: 'chat_timeout' }), {
            status: 504, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
        throw err;
      }
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const { trip_id, rut_chofer, emisor, mensaje, foto_url, photo, media_url } = body;

      if (!trip_id || !emisor || !mensaje) {
        return new Response(JSON.stringify({ error: 'Faltan datos críticos para enviar el mensaje' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }

      if (auth.role === 'driver') {
        const tripErr = await assertDriverCanAccessTrip(supabase, {
          trip_id,
          tenant_id,
          rut: auth.rut,
          chofer_id: auth.chofer_id || null,
        });
        if (tripErr) return tripErr;
      }

      // Operadores → TORRE; choferes siempre CHAT_CHOFER (no spoof de TORRE)
      const tipo_evento = auth.role === 'operator' ? 'CHAT_TORRE' : 'CHAT_CHOFER';

      // Normalización del contrato de imagen: foto_url, photo o media_url
      const imagen_url = foto_url || photo || media_url || null;
      if (imagen_url && !isTrustedEvidenceUrl(imagen_url, env, tenant_id)) {
        return new Response(
          JSON.stringify({ error: 'URL de media no confiable', code: 'untrusted_media_url' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      // Preparar el objeto de inserción base
      const insertData = {
        tenant_id: tenant_id,
        trip_id: trip_id,
        rut_chofer: auth.role === 'driver' ? (auth.rut || rut_chofer || 'N/A') : (rut_chofer || 'N/A'),
        tipo_evento: tipo_evento,
        mensaje: mensaje,
        leido: false
      };

      // Guardar en AMBAS columnas para compatibilidad
      if (imagen_url) {
        insertData.foto_url = imagen_url;
        insertData.evidencia_url = imagen_url;
      }

      const { error } = await supabase
        .from('bitacora_viajes')
        .insert([insertData]);

      if (error) throw error;

      // M-15: invalidar cache del trip tras POST
      chatCache.delete(`${tenant_id}:${trip_id}`);
      invalidateTowerPoll(tenant_id);

      return new Response(JSON.stringify({ exito: true }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    return new Response(
      JSON.stringify({ error: 'Method Not Allowed' }),
      { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[Chat API Error]:', error.message);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}
