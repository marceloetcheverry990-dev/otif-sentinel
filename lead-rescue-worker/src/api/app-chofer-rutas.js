// src/api/app-chofer-rutas.js
import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { verifyDriverToken } from '../helpers/driver-auth.js';
import {
  buildClientesMap,
  normalizeClienteKey,
  resolveDestinoCoords,
  resolveDestinoDireccion,
} from '../helpers/destino-coords.js';
import { getTenantSettings } from '../helpers/tenant-settings.js';
import { resolvePodRequirements } from '../helpers/pod-requirements.js';

export async function getChoferRutas(request, env) {
  try {
    const url = new URL(request.url);
    const tenant_id = url.searchParams.get('tenant_id');
    const rut = url.searchParams.get('rut');

    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    // 400 explícito si falta el parámetro rut — antes de cualquier check de JWT,
    // para distinguirlo del 403 rut_mismatch (rut presente pero no coincide con el token)
    if (!rut) {
      return new Response(
        JSON.stringify({ error: 'Falta el parámetro rut', code: 'rut_ausente' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Verificación JWT: el token debe ser válido antes de devolver datos del chofer
    const auth = await verifyDriverToken(request, env);
    if (!auth.ok) return auth.response;

    // Tenant y rut solo desde el token (query no autoriza otro tenant/rut)
    if (auth.payload.tenant_id !== tenant_id) {
      return new Response(
        JSON.stringify({ error: 'Prohibido: tenant_id del token no coincide', code: 'tenant_mismatch' }),
        { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Verificación de autoría: el rut del token debe coincidir con el rut solicitado
    // (rut está presente aquí — el 400 de arriba ya lo garantiza)
    if (auth.payload.rut !== rut) {
      return new Response(
        JSON.stringify({ error: 'Prohibido: el token no corresponde al rut solicitado', code: 'rut_mismatch' }),
        { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch: fetch }
    });
    // 1. Buscamos el vehículo del chofer
    const { data: chofer } = await supabase
      .from('choferes')
      .select('patente_asignada, gps_interval_seconds')
      .eq('tenant_id', tenant_id)
      .eq('rut', rut)
      .maybeSingle();

    if (!chofer?.patente_asignada) return new Response(JSON.stringify({ rut, viajes: [] }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });

    // 2. Buscamos el viaje actual del vehículo (scoped por tenant + chofer)
    const { data: vehiculo } = await supabase
      .from('flota_vehiculos')
      .select('trip_id_actual, estado')
      .eq('patente', chofer.patente_asignada)
      .eq('tenant_id', tenant_id)
      .eq('rut_chofer_asignado', rut)
      .maybeSingle();

    if (!vehiculo?.trip_id_actual) return new Response(JSON.stringify({ rut, viajes: [] }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });

    const trip_id_actual = vehiculo.trip_id_actual;

    // 3. Obtenemos las órdenes pendientes (incluye lat/lng/metadata para pin exacto)
    const { data: ordenes, error: errOrdenes } = await supabase
      .from('ordenes_pendientes')
      .select('*')
      .eq('trip_id', trip_id_actual)
      .eq('tenant_id', tenant_id)
      .order('stop_sequence', { ascending: true, nullsFirst: false });

    if (errOrdenes) {
      console.error('[CHOFER_RUTAS]', errOrdenes.message);
      return new Response(JSON.stringify({ error: 'Error al cargar paradas', code: 'db_error' }), {
        status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    if (!ordenes || ordenes.length === 0) {
      return new Response(JSON.stringify({ 
        rut, viajes: [{ trip_id: trip_id_actual, estado: vehiculo.estado || 'EN_RUTA', paradas: [] }] 
      }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // 4. Cruce con clientes (case-insensitive). Fallback: buscar por tenant si .in exacto falla.
    const nombresClientes = [...new Set(ordenes.map(o => o.cliente).filter(Boolean))];
    let clientesByName = [];
    if (nombresClientes.length > 0) {
      const { data } = await supabase
        .from('clientes')
        .select('*')
        .eq('tenant_id', tenant_id)
        .in('nombre_cliente_raw', nombresClientes);
      clientesByName = data || [];

      // Si faltan por case mismatch, buscar con ilike (pocas paradas por viaje)
      const mapExact = buildClientesMap(clientesByName);
      const faltan = nombresClientes.filter((n) => !mapExact[normalizeClienteKey(n)]);
      for (const nombre of faltan) {
        // J-4: escapar wildcards de ILIKE
        const escaped = String(nombre).replace(/[%_\\]/g, '\\$&');
        const { data: hit } = await supabase
          .from('clientes')
          .select('*')
          .eq('tenant_id', tenant_id)
          .ilike('nombre_cliente_raw', escaped)
          .limit(1)
          .maybeSingle();
        if (hit) clientesByName.push(hit);
      }
    }

    const clientesMap = buildClientesMap(clientesByName);
    const tenantSettings = await getTenantSettings(env, tenant_id);

    // 5. Ensamblar los datos para la App — pin exacto: orden → metadata → cliente
    const paradas = ordenes.map((o, index) => {
      const infoCliente = clientesMap[normalizeClienteKey(o.cliente)] || {};
      const { lat, lng, source } = resolveDestinoCoords(o, infoCliente);
      const direccionReal = resolveDestinoDireccion(o, infoCliente);

      const meta =
        typeof o.metadata === 'string'
          ? (() => { try { return JSON.parse(o.metadata); } catch { return {}; } })()
          : (o.metadata || {});
      const pod_requirements = resolvePodRequirements({
        tenantSettings,
        orderMetadata: meta,
      });
      return {
        id: o.ot_id,
        nombre: o.cliente || 'Cliente sin nombre',
        direccion: direccionReal,
        lat,
        lng,
        coords_source: source,
        orden: o.stop_sequence || index + 1,
        estado_bd: o.estado_operacional || o.estado || 'PENDIENTE',
        // C-11: la app debe escanear este token (no el ot_id)
        scan_token: meta.scan_token || null,
        pod_requirements,
      };
    });

    // Misiones de rescate recientes asignadas a este viaje (Fase 1)
    let misiones_rescate = [];
    try {
      const { data: misiones } = await supabase
        .from('rescue_missions')
        .select('id, source_trip_id, ot_ids, delta_km, status, created_at')
        .eq('tenant_id', tenant_id)
        .eq('rescue_trip_id', trip_id_actual)
        .eq('status', 'DISPATCHED')
        .order('created_at', { ascending: false })
        .limit(5);
      misiones_rescate = (misiones || []).map((m) => ({
        id: m.id,
        source_trip_id: m.source_trip_id,
        ot_ids: m.ot_ids || [],
        delta_km: m.delta_km,
        status: m.status,
        created_at: m.created_at,
        mensaje: `Misión de rescate: ${Array.isArray(m.ot_ids) ? m.ot_ids.length : 0} parada(s) desde ${m.source_trip_id}`,
      }));
    } catch (_) {
      /* tabla ausente — ok */
    }

    const payload = {
      rut,
      viajes: [{
        trip_id: trip_id_actual,
        estado: vehiculo.estado || 'CAMION_ASIGNADO',
        paradas: paradas,
        misiones_rescate,
      }],
      misiones_rescate,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  
  } catch (error) {
    console.error('[getChoferRutas Error]:', error.message);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }
}
