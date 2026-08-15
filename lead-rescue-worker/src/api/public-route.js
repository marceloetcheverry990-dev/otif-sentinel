// src/api/public-route.js
// 🌐 API PÚBLICA PARA COMPARTIR RUTAS (RUTERRA-STYLE)
// Permite generar enlaces públicos seguros para tracking de rutas

import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { withDb } from '../db.js';
import { renderPublicRouteHTML } from '../public-route-ui.js';
import {
  buildClientesMap,
  normalizeClienteKey,
  resolveDestinoCoords,
} from '../helpers/destino-coords.js';

/**
 * Genera un token aleatorio seguro de 32 caracteres
 */
function generatePublicToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  for (let i = 0; i < 32; i++) {
    token += chars[array[i] % chars.length];
  }
  return token;
}

/**
 * POST /api/public-route/generate
 * Genera o reutiliza un token público para un trip_id
 * Requiere autenticación (tenant_id)
 */
export async function generatePublicRouteLink(request, env, operator = null) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  try {
    const body = await request.json();
    // Tenant siempre desde JWT de operador; no confiar en body.tenant_id
    const tenant_id = operator?.tenant_id || body.tenant_id;
    const { trip_id, created_by, expires_in_days } = body;

    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    if (!trip_id) {
      return new Response(
        JSON.stringify({ error: 'Falta trip_id' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false }
    });

    // Verificar si ya existe un enlace activo para este viaje
    const { data: existing } = await supabase
      .from('public_route_links')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('trip_id', trip_id)
      .eq('active', true)
      .maybeSingle();

    if (existing) {
      // Reutilizar token existente
      const publicUrl = `${new URL(request.url).origin}/public-route/${existing.public_token}`;
      return new Response(
        JSON.stringify({
          exito: true,
          reutilizado: true,
          public_token: existing.public_token,
          public_url: publicUrl,
          created_at: existing.created_at,
          expires_at: existing.expires_at
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Crear nuevo token
    const public_token = generatePublicToken();
    let expires_at = null;

    const days = Number(expires_in_days);
    if (Number.isFinite(days) && days > 0) {
      const now = new Date();
      now.setDate(now.getDate() + days);
      expires_at = now.toISOString();
    }

    const { data, error } = await supabase
      .from('public_route_links')
      .insert([{
        tenant_id,
        trip_id,
        public_token,
        expires_at,
        created_by: created_by || 'sistema',
        active: true
      }])
      .select()
      .single();

    if (error) throw error;

    const publicUrl = `${new URL(request.url).origin}/public-route/${public_token}`;

    return new Response(
      JSON.stringify({
        exito: true,
        reutilizado: false,
        public_token: data.public_token,
        public_url: publicUrl,
        created_at: data.created_at,
        expires_at: data.expires_at
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[Generate Public Route Error]:', error);
    return new Response(
      JSON.stringify({ error: 'Error al generar enlace público' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * GET /public-route/:token
 * Renderiza la página pública HTML para tracking de ruta
 * NO requiere autenticación (público)
 */
export async function getPublicRoute(request, env, token, ctx = null) {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false }
    });

    // Validar token
    const { data: link, error: linkError } = await supabase
      .from('public_route_links')
      .select('*')
      .eq('public_token', token)
      .eq('active', true)
      .maybeSingle();

    if (linkError || !link) {
      return new Response(
        `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Enlace no válido</title></head><body><h1>❌ Enlace no válido o expirado</h1></body></html>`,
        { status: 404, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }
      );
    }

    // Verificar expiración
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return new Response(
        `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Enlace expirado</title></head><body><h1>⏰ Este enlace ha expirado</h1></body></html>`,
        { status: 410, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }
      );
    }

    // J-3: incremento atómico en SQL + waitUntil
    const viewPromise = withDb(env, async (client) => {
      await client.query(
        `UPDATE public_route_links
         SET view_count = COALESCE(view_count, 0) + 1,
             last_viewed_at = NOW()
         WHERE id = $1`,
        [link.id]
      );
    }).catch((err) => console.error('[Update view count error]:', err));
    if (ctx?.waitUntil) ctx.waitUntil(viewPromise);
    else await viewPromise;

    // Obtener datos del viaje CON coordenadas del cliente / orden / metadata
    // lat/lng pueden no existir como columnas — viven en metadata / clientes
    let paradas = null;
    let paradasError = null;
    {
      const full = await supabase
        .from('ordenes_pendientes')
        .select(`
          ot_id,
          cliente,
          estado_operacional,
          stop_sequence,
          eta,
          hora_real,
          uri,
          lat,
          lng,
          metadata
        `)
        .eq('tenant_id', link.tenant_id)
        .eq('trip_id', link.trip_id)
        .order('stop_sequence', { ascending: true });
      if (full.error && /lat|lng|column/i.test(String(full.error.message || ''))) {
        const fallback = await supabase
          .from('ordenes_pendientes')
          .select(`
            ot_id,
            cliente,
            estado_operacional,
            stop_sequence,
            eta,
            hora_real,
            uri,
            metadata
          `)
          .eq('tenant_id', link.tenant_id)
          .eq('trip_id', link.trip_id)
          .order('stop_sequence', { ascending: true });
        paradas = fallback.data;
        paradasError = fallback.error;
      } else {
        paradas = full.data;
        paradasError = full.error;
      }
    }

    if (paradasError) throw paradasError;

    // Obtener coordenadas de los clientes - buscar por nombre_cliente_raw
    const clientesNombres = [...new Set((paradas || []).map(p => p.cliente).filter(Boolean))];
    console.log('[PUBLIC ROUTE] Clientes a buscar:', clientesNombres);
    
    const { data: coordenadas } = await supabase
      .from('clientes')
      .select('nombre_cliente_raw, lat, lng')
      .eq('tenant_id', link.tenant_id)
      .in('nombre_cliente_raw', clientesNombres.length ? clientesNombres : ['__none__']);

    console.log('[PUBLIC ROUTE] Coordenadas encontradas:', coordenadas?.length || 0, coordenadas);

    const coordenadasMap = buildClientesMap(coordenadas || []);

    // Filtrar SOLO estados visibles públicamente (excluir RECHAZADO, PROBLEMA, CANCELADO)
    const estadosExcluidos = ['RECHAZADO', 'PROBLEMA', 'CANCELADO_PLANILLA'];
    const paradasPublicas = (paradas || [])
      .filter(p => !estadosExcluidos.includes(p.estado_operacional))
      .map(p => {
        const cliente = coordenadasMap[normalizeClienteKey(p.cliente)] || null;
        const coords = resolveDestinoCoords(p, cliente);
        console.log(`[PUBLIC ROUTE] Cliente: ${p.cliente}, Coords:`, coords);
        return {
          cliente: p.cliente,
          estado: p.estado_operacional,
          stop_sequence: p.stop_sequence,
          eta: p.eta,
          hora_real: p.hora_real,
          lat: coords.lat,
          lng: coords.lng
        };
      });

    console.log('[PUBLIC ROUTE] Total paradas públicas:', paradasPublicas.length);
    console.log('[PUBLIC ROUTE] Paradas con coords:', paradasPublicas.filter(p => p.lat && p.lng).length);

    // Renderizar HTML público
    const html = renderPublicRouteHTML(link.trip_id, paradasPublicas, token);

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' }
    });

  } catch (error) {
    console.error('[Get Public Route Error]:', error);
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title></head><body><h1>⚠️ Error al cargar el tracking</h1></body></html>`,
      { status: 500, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }
    );
  }
}

/**
 * GET /api/public-route/:token/data
 * JSON API para polling (actualización automática cada 15s)
 * NO requiere autenticación (público)
 */
export async function getPublicRouteData(request, env, token) {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false }
    });

    // Validar token
    const { data: link, error: linkError } = await supabase
      .from('public_route_links')
      .select('*')
      .eq('public_token', token)
      .eq('active', true)
      .maybeSingle();

    if (linkError || !link) {
      return new Response(
        JSON.stringify({ error: 'Token inválido' }),
        { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Verificar expiración
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'Token expirado' }),
        { status: 410, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Obtener datos del viaje CON coordenadas (lat/lng opcionales según schema)
    let paradas = null;
    let paradasError = null;
    {
      const full = await supabase
        .from('ordenes_pendientes')
        .select('ot_id, cliente, estado_operacional, stop_sequence, eta, hora_real, uri, lat, lng, metadata')
        .eq('tenant_id', link.tenant_id)
        .eq('trip_id', link.trip_id)
        .order('stop_sequence', { ascending: true });
      if (full.error && /lat|lng|column/i.test(String(full.error.message || ''))) {
        const fallback = await supabase
          .from('ordenes_pendientes')
          .select('ot_id, cliente, estado_operacional, stop_sequence, eta, hora_real, uri, metadata')
          .eq('tenant_id', link.tenant_id)
          .eq('trip_id', link.trip_id)
          .order('stop_sequence', { ascending: true });
        paradas = fallback.data;
        paradasError = fallback.error;
      } else {
        paradas = full.data;
        paradasError = full.error;
      }
    }

    if (paradasError) throw paradasError;

    // Obtener coordenadas de los clientes - buscar por nombre_cliente_raw
    const clientesNombres = [...new Set((paradas || []).map(p => p.cliente).filter(Boolean))];
    const { data: coordenadas } = await supabase
      .from('clientes')
      .select('nombre_cliente_raw, lat, lng')
      .eq('tenant_id', link.tenant_id)
      .in('nombre_cliente_raw', clientesNombres.length ? clientesNombres : ['__none__']);

    const coordenadasMap = buildClientesMap(coordenadas || []);

    // Filtrar SOLO estados visibles públicamente
    const estadosExcluidos = ['RECHAZADO', 'PROBLEMA', 'CANCELADO_PLANILLA'];
    const paradasPublicas = (paradas || [])
      .filter(p => !estadosExcluidos.includes(p.estado_operacional))
      .map(p => {
        const cliente = coordenadasMap[normalizeClienteKey(p.cliente)] || null;
        const coords = resolveDestinoCoords(p, cliente);
        return {
          cliente: p.cliente,
          estado: p.estado_operacional,
          stop_sequence: p.stop_sequence,
          eta: p.eta,
          hora_real: p.hora_real,
          lat: coords.lat,
          lng: coords.lng
        };
      });

    const completadas = paradasPublicas.filter(p => p.estado === 'ENTREGADO').length;
    const total = paradasPublicas.length;

    return new Response(
      JSON.stringify({
        exito: true,
        trip_id: link.trip_id,
        completadas,
        total,
        paradas: paradasPublicas,
        timestamp: new Date().toISOString()
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[Get Public Route Data Error]:', error);
    return new Response(
      JSON.stringify({ error: 'Error al obtener datos' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}
