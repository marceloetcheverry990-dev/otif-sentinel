// src/api/mobile-sync.js
import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { verifyDriverToken } from '../helpers/driver-auth.js';
import {
  assertDriverOwnsTrip,
  requireMatchingTenant,
} from '../helpers/trip-ownership.js';

export async function handleMobileSync(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const res = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });

  try {
    const auth = await verifyDriverToken(request, env);
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const { path, payload, tenant_id, rut } = body;

    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    const mismatch = requireMatchingTenant(auth.payload, tenant_id);
    if (mismatch) return mismatch;

    if (!rut) {
      return res({ error: 'Bad Request: Missing rut' }, 400);
    }

    if (auth.payload.rut !== rut) {
      return res({ error: 'Prohibido: el token no corresponde al rut del body', code: 'rut_mismatch' }, 403);
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch },
    });

    const { data: chofer, error: choferError } = await supabase
      .from('choferes')
      .select('patente_asignada')
      .eq('tenant_id', tenant_id)
      .eq('rut', rut)
      .single();

    if (choferError || !chofer || !chofer.patente_asignada) {
      return res({ error: 'Chofer no válido o sin vehículo asignado' }, 404);
    }

    if (path === '/viajes/estado') {
      if (!payload?.estado || !payload?.trip_id) {
        return res({ error: 'Payload inválido: falta estado o trip_id' }, 400);
      }

      // M-9: whitelist — el chofer no puede marcarse DISPONIBLE a mitad de ruta
      const ESTADOS_FLOTA = new Set(['EN_RUTA', 'CAMION_ASIGNADO', 'EN_SITIO', 'DETENIDO']);
      const estadoNorm = String(payload.estado).toUpperCase().trim();
      if (!ESTADOS_FLOTA.has(estadoNorm)) {
        return res({ error: 'estado inválido', code: 'invalid_fleet_state', allowed: [...ESTADOS_FLOTA] }, 400);
      }

      const tripErr = await assertDriverOwnsTrip(supabase, {
        trip_id: payload.trip_id,
        tenant_id,
        rut,
      });
      if (tripErr) return tripErr;

      const { error: updateError } = await supabase
        .from('flota_vehiculos')
        .update({ estado: estadoNorm })
        .eq('tenant_id', tenant_id)
        .eq('patente', chofer.patente_asignada)
        .eq('trip_id_actual', payload.trip_id)
        .eq('rut_chofer_asignado', rut);

      if (updateError) throw updateError;
    } else if (path === '/entregas/sync') {
      return res({ error: 'Deprecated endpoint. Use /app-chofer-sync' }, 410);
    } else {
      return res({ error: 'Path de sincronización no soportado' }, 400);
    }

    return res({ success: true });
  } catch (err) {
    console.error('[MOBILE_SYNC]', err.message);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}
