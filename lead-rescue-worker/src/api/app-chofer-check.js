import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';
import {
  DRIVER_AUTH_LIMITS,
  enforceDriverAuthRateLimit,
} from '../helpers/driver-auth-rate-limit.js';
import { isAccountActivated } from '../helpers/pin-kdf.js';

const jsonHeaders = () => ({ ...CORS_HEADERS, 'Content-Type': 'application/json' });

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders(), 'Cache-Control': 'no-store' },
  });
}

export async function checkChoferRut(request, env) {
  try {
    const limited = enforceDriverAuthRateLimit(
      request,
      DRIVER_AUTH_LIMITS.checkRut.endpoint,
      DRIVER_AUTH_LIMITS.checkRut.limit,
      DRIVER_AUTH_LIMITS.checkRut.windowMs
    );
    if (limited) return limited;

    const { tenant_id, rut } = await request.json();

    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    if (!rut) {
      return json({ error: 'Faltan datos' }, 400);
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    const { data: chofer, error } = await supabase
      .from('choferes')
      .select('pin')
      .eq('tenant_id', tenant_id)
      .eq('rut', rut)
      .maybeSingle();

    // M-1: respuesta uniforme — no oráculo 404/400/200
    const canActivate = !error && !!chofer && !isAccountActivated(chofer.pin);
    return json({ canActivate: !!canActivate });
  } catch (err) {
    console.error('[CHECK_RUT]', err.message);
    return json({ error: 'Error interno' }, 500);
  }
}
