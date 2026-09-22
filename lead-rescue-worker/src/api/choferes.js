// src/api/choferes.js
import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';

export async function recalcularScoring(request, env, operator = null) {
  try {
    const body = await request.json();
    const { rut } = body;
    // Tenant siempre desde el operador autenticado; nunca del body (C-7).
    const tenant_id = operator?.tenant_id;

    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    if (!rut) {
      return new Response(
        JSON.stringify({ error: 'Bad Request: Se requiere el rut del chofer' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch: fetch }
    });

    const { data: chofer, error: fetchError } = await supabase
      .from('choferes')
      .select('rut, skill_score')
      .eq('tenant_id', tenant_id)
      .eq('rut', rut)
      .single();

    if (fetchError || !chofer) {
      return new Response(
        JSON.stringify({ error: `Not Found: Chofer RUT ${rut} no encontrado en este tenant.` }),
        { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Scoring procesado', score_actual: chofer.skill_score || 0 }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[recalcularScoring] Error de ejecución:', error);
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', detalle: 'Error recalculando scoring' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}