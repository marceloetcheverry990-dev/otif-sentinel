import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { signDriverToken } from '../helpers/driver-auth.js';
import {
  DRIVER_AUTH_LIMITS,
  enforceDriverAuthRateLimit,
} from '../helpers/driver-auth-rate-limit.js';
import { hashPin, isAccountActivated } from '../helpers/pin-kdf.js';

const jsonHeaders = () => ({ ...CORS_HEADERS, 'Content-Type': 'application/json' });

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders(), 'Cache-Control': 'no-store' },
  });
}

function timingSafeEqualString(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(String(a ?? ''));
  const bb = enc.encode(String(b ?? ''));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

export async function activateChofer(request, env) {
  try {
    const limited = enforceDriverAuthRateLimit(
      request,
      DRIVER_AUTH_LIMITS.activate.endpoint,
      DRIVER_AUTH_LIMITS.activate.limit,
      DRIVER_AUTH_LIMITS.activate.windowMs
    );
    if (limited) return limited;

    const { tenant_id, rut, pin, invite_code } = await request.json();

    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    if (!rut || !pin) {
      return json({ error: 'Faltan datos' }, 400);
    }

    if (!/^\d{4}$/.test(String(pin))) {
      return json({ error: 'El PIN debe ser de 4 dígitos' }, 400);
    }

    // Gate opcional: si CHOFER_INVITE_CODE está configurado, exige invite_code
    if (env.CHOFER_INVITE_CODE) {
      if (!timingSafeEqualString(invite_code, env.CHOFER_INVITE_CODE)) {
        return json({ error: 'No se pudo activar la cuenta' }, 400);
      }
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    const { data: existing, error: lookupError } = await supabase
      .from('choferes')
      .select('chofer_id, nombre_completo, gps_interval_seconds, pin')
      .eq('tenant_id', tenant_id)
      .eq('rut', rut)
      .maybeSingle();

    if (lookupError) {
      console.error('[activateChofer] lookup:', lookupError.message);
      return json({ error: 'No se pudo activar la cuenta' }, 500);
    }

    if (!existing) {
      // Respuesta uniforme: no revelar si el RUT existe
      return json({ error: 'No se pudo activar la cuenta' }, 400);
    }

    if (isAccountActivated(existing.pin)) {
      return json({ error: 'Esta cuenta ya está activada. Inicia sesión normalmente.' }, 400);
    }

    const pinHash = await hashPin(String(pin), env);

    // A-23: UPDATE atómico — solo si pin sigue vacío (cierra TOCTOU post-hashPin)
    const { data: chofer, error } = await supabase
      .from('choferes')
      .update({ pin: pinHash })
      .eq('tenant_id', tenant_id)
      .eq('rut', rut)
      .eq('chofer_id', existing.chofer_id)
      .or('pin.is.null,pin.eq.')
      .select('chofer_id, nombre_completo, gps_interval_seconds')
      .maybeSingle();

    if (error) {
      return json({ error: 'Error al activar la cuenta' }, 500);
    }
    if (!chofer) {
      return json({ error: 'Esta cuenta ya está activada. Inicia sesión normalmente.' }, 400);
    }

    return json({
      token: await signDriverToken({ chofer_id: chofer.chofer_id, rut, tenant_id }, env),
      driverName: chofer.nombre_completo,
      gpsInterval: chofer.gps_interval_seconds,
    });
  } catch (err) {
    console.error('[ACTIVATE_CHOFER]', err.message);
    return json({ error: 'Error interno' }, 500);
  }
}
