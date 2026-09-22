// src/api/app-chofer-login.js
import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { signDriverToken } from '../helpers/driver-auth.js';
import {
  DRIVER_AUTH_LIMITS,
  LOGIN_ACCOUNT_LIMIT,
  enforceDriverAuthRateLimit,
  enforceAccountRateLimit,
} from '../helpers/driver-auth-rate-limit.js';
import { hashPin, verifyPin } from '../helpers/pin-kdf.js';

const jsonHeaders = () => ({ ...CORS_HEADERS, 'Content-Type': 'application/json' });

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders(), 'Cache-Control': 'no-store' },
  });
}

export async function loginChofer(request, env) {
  try {
    const limited = await enforceDriverAuthRateLimit(
      request,
      env,
      DRIVER_AUTH_LIMITS.login.endpoint,
      DRIVER_AUTH_LIMITS.login.limit,
      DRIVER_AUTH_LIMITS.login.windowMs
    );
    if (limited) return limited;

    const body = await request.json();
    const { tenant_id, rut, pin } = body;

    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    if (!rut || !pin) {
      return json({ error: 'Bad Request: Se requieren credenciales (rut, pin)' }, 400);
    }

    // Límite por cuenta (independiente de IP) — un atacante rotando de IP
    // no debe poder seguir probando PINs contra el mismo rut sin límite.
    const acctLimited = await enforceAccountRateLimit(
      env,
      DRIVER_AUTH_LIMITS.login.endpoint,
      tenant_id,
      rut,
      LOGIN_ACCOUNT_LIMIT.limit,
      LOGIN_ACCOUNT_LIMIT.windowMs
    );
    if (acctLimited) return acctLimited;

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch },
    });

    const { data: chofer, error: authError } = await supabase
      .from('choferes')
      .select('chofer_id, nombre_completo, patente_asignada, estado, gps_interval_seconds, pin')
      .eq('tenant_id', tenant_id)
      .eq('rut', rut)
      .maybeSingle();

    if (authError || !chofer) {
      return json({ error: 'No autorizado: RUT o PIN incorrectos' }, 401);
    }

    const verified = await verifyPin(String(pin), chofer.pin, env);
    if (!verified.ok) {
      return json({ error: 'No autorizado: RUT o PIN incorrectos' }, 401);
    }

    if (verified.needsUpgrade) {
      try {
        const upgraded = await hashPin(String(pin), env);
        await supabase
          .from('choferes')
          .update({ pin: upgraded })
          .eq('chofer_id', chofer.chofer_id)
          .eq('tenant_id', tenant_id);
      } catch (upgradeErr) {
        console.error('[loginChofer] PIN upgrade failed:', upgradeErr?.message || upgradeErr);
      }
    }

    const token = await signDriverToken(
      { chofer_id: chofer.chofer_id, rut, tenant_id },
      env
    );

    return json({
      success: true,
      token,
      // Campos que consume logistica-app (authStore)
      driverName: chofer.nombre_completo,
      gpsInterval: chofer.gps_interval_seconds || 30,
      chofer: {
        id: chofer.chofer_id,
        nombre: chofer.nombre_completo,
        patente: chofer.patente_asignada,
        estado: chofer.estado,
        config: { ping_interval: chofer.gps_interval_seconds || 30 },
      },
    });
  } catch (error) {
    console.error('[loginChofer] Error interno:', error);
    return json({ error: 'Internal Server Error' }, 500);
  }
}
