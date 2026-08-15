// src/api/choferes.js
import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';

export async function asignarChofer(request, env) {
  try {
    const body = await request.json();
    const { tenant_id, rut, patente } = body;

    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    if (!rut || !patente) {
      return new Response(
        JSON.stringify({ error: 'Bad Request: Se requieren rut y patente para la asignación' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch: fetch }
    });

    const { data: vehiculo, error: errorVehiculo } = await supabase
      .from('flota_vehiculos')
      .select('patente, estado')
      .eq('patente', patente)
      .eq('tenant_id', tenant_id) // Ownership Validation
      .single();

    if (errorVehiculo || !vehiculo) {
      return new Response(
        JSON.stringify({ error: `Conflicto de Integridad: El vehículo con patente ${patente} no existe en la flota.` }),
        { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const { error: errorUpdate } = await supabase
      .from('choferes')
      .update({ patente_asignada: patente })
      .eq('tenant_id', tenant_id)
      .eq('rut', rut);

    if (errorUpdate) throw new Error(`Fallo en actualización de base de datos: ${errorUpdate.message}`);

    return new Response(
      JSON.stringify({ success: true, message: `Vehículo ${patente} asignado correctamente al RUT ${rut}.` }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[asignarChofer] Error de ejecución:', error);
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', detalle: 'Error asignando patente al chofer' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}

export async function recalcularScoring(request, env) {
  try {
    const body = await request.json();
    const { tenant_id, rut } = body;

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