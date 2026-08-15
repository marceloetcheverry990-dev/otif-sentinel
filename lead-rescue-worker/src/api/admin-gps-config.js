import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';

export async function updateGPSInterval(request, env, operator = null) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  try {
    const body = await request.json();
    // Tenant siempre desde JWT de operador; no confiar en body.tenant_id
    const tenant_id = operator?.tenant_id || body.tenant_id;
    const { rut, nuevo_intervalo_segundos } = body;

    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    if (!rut || nuevo_intervalo_segundos === undefined || nuevo_intervalo_segundos === null || nuevo_intervalo_segundos === '') {
      return new Response(JSON.stringify({ error: 'Faltan parámetros' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }
    const intervalo = Number(nuevo_intervalo_segundos);
    if (!Number.isFinite(intervalo) || intervalo < 0) {
      return new Response(JSON.stringify({ error: 'Intervalo GPS inválido' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch: fetch }
    });

    // Ownership Validation: filtrar por tenant_id además del rut
    const { error } = await supabase
      .from('choferes')
      .update({ gps_interval_seconds: intervalo })
      .eq('tenant_id', tenant_id)
      .eq('rut', rut);

    if (error) throw error;

    return new Response(JSON.stringify({ exito: true, mensaje: 'Configuración GPS actualizada' }), { 
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[updateGPSInterval Error]:', error.message);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }
}