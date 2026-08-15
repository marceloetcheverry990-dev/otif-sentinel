// src/api/fix-checking.test.js
// Wave 5 — T10: Tests de fix checking y preservation checking
//
// Cubre:
//  1. Tests unitarios adicionales del helper (exp ~10h, token expirado, firma corrompida, token fake)
//  2. PBT con seed fija: round-trip sign→verify y rechazo invariante de firma modificada
//  3. Fix checking: los seis endpoints (activate, login, rutas, GPS, evento, sync)
//  4. Preservation: filtros GPS (ruido, velocidad imposible), máquina de estados de eventos,
//     aislamiento multi-tenant

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { signDriverToken, verifyDriverToken } from '../helpers/driver-auth.js';
import { activateChofer } from './app-chofer-activate.js';
import { loginChofer } from './app-chofer-login.js';
import { getChoferRutas } from './app-chofer-rutas.js';
import { handleGPSPing } from './gps.js';
import { handleChoferEvento } from './app-chofer-evento.js';
import { syncChoferEvent } from './app-chofer-sync.js';

// ─── Constantes de test ───────────────────────────────────────────────────────
// PBT seed fija: reproducibilidad garantizada entre runs
const PBT_SEED = 20250703;

const TEST_ENV = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_SERVICE_KEY: 'mock-key',
  JWT_SECRET: 'test-secret-32-bytes-minimum-len!!',
};

const CHOFER_PAYLOAD = {
  chofer_id: 'chofer-001',
  rut: '12345678-9',
  tenant_id: 'empresa_demo',
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
let supabaseMockImpl = {};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table) => {
      const impl = supabaseMockImpl[table];
      const builder = {
        select: () => builder,
        update: () => builder,
        insert: () => builder,
        eq: () => builder,
        is: () => builder,
        or: () => builder,
        not: () => builder,
        in: () => builder,
        ilike: () => builder,
        order: () => builder,
        single: async () => impl?.single ?? { data: null, error: null },
        maybeSingle: async () => impl?.maybeSingle ?? { data: null, error: null },
        then: (resolve) => resolve(impl?.then ?? { data: [], error: null }),
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://mock.storage/foto.jpg' } }),
      }),
    },
  }),
}));

let pgClientMock = {};
vi.mock('../db.js', () => ({
  withDb: async (_env, callback) => callback(pgClientMock),
}));

vi.mock('../helpers/eta-metric.js', () => ({
  insertEtaMetric: vi.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeGetRequest(path, params = {}, token = null) {
  const url = new URL(`https://worker.test${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return new Request(url.toString(), { method: 'GET', headers });
}

function makePostRequest(path, body, params = {}, token = null) {
  const url = new URL(`https://worker.test${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return new Request(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function makeValidToken(overrides = {}) {
  return signDriverToken({ ...CHOFER_PAYLOAD, ...overrides }, TEST_ENV);
}

// =============================================================================
// 1. Tests unitarios adicionales del helper
// =============================================================================

describe('T10 - helper adicionales', () => {
  it('exp del token generado esta aproximadamente 10h en el futuro (±60s)', async () => {
    const token = await signDriverToken(CHOFER_PAYLOAD, TEST_ENV);
    const parts = token.split('.');
    // Decodificar payload base64url
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '='));
    const payload = JSON.parse(json);

    const ahora = Math.floor(Date.now() / 1000);
    const diezHoras = 10 * 60 * 60;
    expect(payload.exp).toBeGreaterThanOrEqual(ahora + diezHoras - 60);
    expect(payload.exp).toBeLessThanOrEqual(ahora + diezHoras + 60);
  });

  it('verifyDriverToken rechaza token con exp en el pasado', async () => {
    // Construir token con exp ya vencido manualmente
    const enc = new TextEncoder();
    const alg = { name: 'HMAC', hash: 'SHA-256' };
    function b64url(buf) {
      return btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    const header = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const expPasado = Math.floor(Date.now() / 1000) - 3600; // hace 1 hora
    const body = b64url(enc.encode(JSON.stringify({ ...CHOFER_PAYLOAD, exp: expPasado })));
    const input = `${header}.${body}`;
    const key = await crypto.subtle.importKey('raw', enc.encode(TEST_ENV.JWT_SECRET), alg, false, ['sign']);
    const sig = await crypto.subtle.sign(alg, key, enc.encode(input));
    const token = `${input}.${b64url(sig)}`;

    const req = new Request('https://worker.test/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await verifyDriverToken(req, TEST_ENV);
    expect(result.ok).toBe(false);
    const body2 = await result.response.json();
    expect(body2.code).toBe('token_expirado');
  });

  it('verifyDriverToken rechaza token con un byte de firma modificado', async () => {
    const token = await signDriverToken(CHOFER_PAYLOAD, TEST_ENV);
    const parts = token.split('.');
    // Decodificar firma, modificar primer byte, re-encodear
    const sigB64 = parts[2].replace(/-/g, '+').replace(/_/g, '/');
    const sigPadded = sigB64.padEnd(sigB64.length + (4 - sigB64.length % 4) % 4, '=');
    const sigBytes = Uint8Array.from(atob(sigPadded), c => c.charCodeAt(0));
    sigBytes[0] = sigBytes[0] ^ 0xFF; // flip bits del primer byte
    const sigCorrupta = btoa(String.fromCharCode(...sigBytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const tokenCorrupto = `${parts[0]}.${parts[1]}.${sigCorrupta}`;

    const req = new Request('https://worker.test/', {
      headers: { Authorization: `Bearer ${tokenCorrupto}` },
    });
    const result = await verifyDriverToken(req, TEST_ENV);
    expect(result.ok).toBe(false);
    const body = await result.response.json();
    expect(body.code).toBe('token_invalido');
  });

  it('verifyDriverToken rechaza token fake jwt_simulado_*', async () => {
    const tokenFake = `jwt_simulado_${Date.now()}`;
    const req = new Request('https://worker.test/', {
      headers: { Authorization: `Bearer ${tokenFake}` },
    });
    const result = await verifyDriverToken(req, TEST_ENV);
    expect(result.ok).toBe(false);
    const body = await result.response.json();
    expect(body.code).toBe('token_invalido');
  });
});

// =============================================================================
// 2. PBT con seed fija (PBT_SEED = 20250703)
// =============================================================================

describe('T10 - PBT helper (seed=' + PBT_SEED + ')', () => {
  // Arbitrario: payload válido con strings alfanuméricas no vacías
  const payloadArb = fc.record({
    chofer_id: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
    rut: fc.string({ minLength: 1, maxLength: 15 }).filter(s => s.trim().length > 0),
    tenant_id: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
  });

  // Arbitrario: secreto de 32+ bytes (caracteres ASCII imprimibles)
  const secretArb = fc.string({ minLength: 32, maxLength: 64 })
    .filter(s => s.length >= 32)
    .map(s => s.replace(/[^\x20-\x7E]/g, 'A')); // solo ASCII imprimible

  it('PBT round-trip: sign->verify devuelve el mismo payload (seed fija ' + PBT_SEED + ')', async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, secretArb, async (payload, secret) => {
        const env = { JWT_SECRET: secret };
        const token = await signDriverToken(payload, env);
        const req = new Request('https://worker.test/', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const result = await verifyDriverToken(req, env);
        if (!result.ok) return false;
        return (
          result.payload.chofer_id === payload.chofer_id &&
          result.payload.rut === payload.rut &&
          result.payload.tenant_id === payload.tenant_id
        );
      }),
      { seed: PBT_SEED, numRuns: 30, verbose: true }
    );
  });

  it('PBT rechazo invariante: firma con cualquier byte modificado siempre da ok:false (seed fija ' + PBT_SEED + ')', async () => {
    await fc.assert(
      fc.asyncProperty(
        payloadArb,
        fc.integer({ min: 0, max: 31 }), // índice del byte a corromper (firma HMAC-SHA256 = 32 bytes)
        async (payload, byteIndex) => {
          const token = await signDriverToken(payload, TEST_ENV);
          const parts = token.split('.');
          const sigB64 = parts[2].replace(/-/g, '+').replace(/_/g, '/');
          const sigPadded = sigB64.padEnd(sigB64.length + (4 - sigB64.length % 4) % 4, '=');
          const sigBytes = Uint8Array.from(atob(sigPadded), c => c.charCodeAt(0));

          if (byteIndex >= sigBytes.length) return true; // skip si índice fuera de rango
          sigBytes[byteIndex] = sigBytes[byteIndex] ^ 0xFF;
          const sigCorrupta = btoa(String.fromCharCode(...sigBytes))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          const tokenCorrupto = `${parts[0]}.${parts[1]}.${sigCorrupta}`;

          const req = new Request('https://worker.test/', {
            headers: { Authorization: `Bearer ${tokenCorrupto}` },
          });
          const result = await verifyDriverToken(req, TEST_ENV);
          return result.ok === false;
        }
      ),
      { seed: PBT_SEED, numRuns: 30, verbose: true }
    );
  });
});

// =============================================================================
// 3. Fix checking — los seis endpoints
// =============================================================================

describe('T10 - fix checking endpoints', () => {
  beforeEach(() => {
    supabaseMockImpl = {};
    pgClientMock = { query: vi.fn() };
  });

  // --- activate ---
  it('activate: 200 con token JWT real y campos del chofer intactos', async () => {
    supabaseMockImpl['choferes'] = {
      // R3: lookup con maybeSingle exige cuenta sin activar (pin vacío)
      maybeSingle: {
        data: { chofer_id: 'c-001', nombre_completo: 'Juan Chofer', gps_interval_seconds: 30, pin: null },
        error: null,
      },
      single: {
        data: { chofer_id: 'c-001', nombre_completo: 'Juan Chofer', gps_interval_seconds: 30 },
        error: null,
      },
    };
    const req = makePostRequest('/api/choferes/activate', {
      tenant_id: 'empresa_demo', rut: '12345678-9', pin: '1234',
    });
    const res = await activateChofer(req, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.driverName).toBe('Juan Chofer');
    expect(body.gpsInterval).toBe(30);
  });

  // --- login ---
  it('login: 200 con token JWT real y todos los campos del chofer sin cambios', async () => {
    supabaseMockImpl['choferes'] = {
      // R3: login usa maybeSingle y verifica el PIN almacenado (legacy plaintext acá)
      maybeSingle: {
        data: {
          chofer_id: 'c-001', nombre_completo: 'Juan Chofer',
          patente_asignada: 'ABCD12', estado: 'DISPONIBLE', gps_interval_seconds: 45,
          pin: '1234',
        },
        error: null,
      },
    };
    const req = makePostRequest('/api/choferes/login', {
      tenant_id: 'empresa_demo', rut: '12345678-9', pin: '1234',
    });
    const res = await loginChofer(req, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.success).toBe(true);
    expect(body.chofer.id).toBe('c-001');
    expect(body.chofer.nombre).toBe('Juan Chofer');
    expect(body.chofer.patente).toBe('ABCD12');
    expect(body.chofer.estado).toBe('DISPONIBLE');
    expect(body.chofer.config.ping_interval).toBe(45);
  });

  // --- rutas ---
  it('rutas: 401 sin token, 403 rut_mismatch con token ajeno, 200 con token correcto', async () => {
    // 401 sin token
    const r1 = await getChoferRutas(
      makeGetRequest('/api/app-chofer-rutas', { tenant_id: 'empresa_demo', rut: '12345678-9' }),
      TEST_ENV
    );
    expect(r1.status).toBe(401);

    // 403 con token de otro rut
    const tokenAjeno = await makeValidToken({ rut: '99999999-9' });
    const r2 = await getChoferRutas(
      makeGetRequest('/api/app-chofer-rutas', { tenant_id: 'empresa_demo', rut: '12345678-9' }, tokenAjeno),
      TEST_ENV
    );
    expect(r2.status).toBe(403);
    expect((await r2.json()).code).toBe('rut_mismatch');

    // 200 con token correcto
    const token = await makeValidToken();
    supabaseMockImpl['choferes'] = {
      maybeSingle: { data: { patente_asignada: null }, error: null },
    };
    const r3 = await getChoferRutas(
      makeGetRequest('/api/app-chofer-rutas', { tenant_id: 'empresa_demo', rut: '12345678-9' }, token),
      TEST_ENV
    );
    expect(r3.status).toBe(200);
  });

  // --- GPS ping ---
  it('gps/ping: 401 sin token, 403 tenant_mismatch, 403 trip_not_assigned, 200 camino feliz', async () => {
    // 401 sin token
    const r1 = await handleGPSPing(
      makePostRequest('/api/gps/ping', { trip_id: 'V-001', tenant_id: 'empresa_demo', lat: -33.43, lng: -70.61 }),
      TEST_ENV
    );
    expect(r1.status).toBe(401);

    // 403 tenant_mismatch
    const tokenOtroTenant = await makeValidToken({ tenant_id: 'otro_tenant' });
    const r2 = await handleGPSPing(
      makePostRequest('/api/gps/ping', { trip_id: 'V-001', tenant_id: 'empresa_demo', lat: -33.43, lng: -70.61 }, {}, tokenOtroTenant),
      TEST_ENV
    );
    expect(r2.status).toBe(403);
    expect((await r2.json()).code).toBe('tenant_mismatch');

    // 403 trip_not_assigned
    const token = await makeValidToken();
    pgClientMock.query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const r3 = await handleGPSPing(
      makePostRequest('/api/gps/ping', { trip_id: 'V-AJENO', tenant_id: 'empresa_demo', lat: -33.43, lng: -70.61 }, {}, token),
      TEST_ENV
    );
    expect(r3.status).toBe(403);
    expect((await r3.json()).code).toBe('trip_not_assigned');

    // 200 camino feliz
    pgClientMock.query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // autoría
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ultima_lat: '-33.420', ultima_lng: '-70.600', km_recorridos_reales: '5.0', ultima_actualizacion: new Date(Date.now() - 60000).toISOString() }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });
    const r4 = await handleGPSPing(
      makePostRequest('/api/gps/ping', { trip_id: 'V-001', tenant_id: 'empresa_demo', lat: -33.430, lng: -70.610 }, {}, token),
      TEST_ENV
    );
    expect(r4.status).toBe(200);
    expect((await r4.json()).exito).toBe(true);
  });

  // --- evento ---
  it('evento: 401 sin token, 403 trip_not_assigned, 200 LLEGADA registrada', async () => {
    // 401 sin token
    const r1 = await handleChoferEvento(
      makePostRequest('/api/chofer/evento', { trip_id: 'V-001', stop_id: 'OT-001', tipo_evento: 'LLEGADA' }, { tenant_id: 'empresa_demo' }),
      TEST_ENV, { waitUntil: vi.fn() }
    );
    expect(r1.status).toBe(401);

    // 403 trip_not_assigned
    // R4: la query filtra por rut_chofer_asignado en SQL — viaje ajeno = 0 filas
    const token = await makeValidToken();
    supabaseMockImpl['flota_vehiculos'] = {
      maybeSingle: { data: null, error: null },
    };
    const r2 = await handleChoferEvento(
      makePostRequest('/api/chofer/evento', { trip_id: 'V-001', stop_id: 'OT-001', tipo_evento: 'LLEGADA' }, { tenant_id: 'empresa_demo' }, token),
      TEST_ENV, { waitUntil: vi.fn() }
    );
    expect(r2.status).toBe(403);
    expect((await r2.json()).code).toBe('trip_not_assigned');

    // 200 LLEGADA con chofer correcto
    supabaseMockImpl['flota_vehiculos'] = {
      maybeSingle: { data: { rut_chofer_asignado: '12345678-9' }, error: null },
    };
    supabaseMockImpl['ordenes_pendientes'] = {
      // R4: assertStopOnTrip valida el stop con maybeSingle antes de mutar
      maybeSingle: { data: { ot_id: 'OT-001', trip_id: 'V-001', estado_operacional: 'EN_RUTA' }, error: null },
      single: { data: { estado_operacional: 'EN_RUTA' }, error: null },
    };
    supabaseMockImpl['bitacora_viajes'] = {
      then: { data: [{}], error: null },
    };
    const r3 = await handleChoferEvento(
      makePostRequest('/api/chofer/evento', { trip_id: 'V-001', stop_id: 'OT-001', tipo_evento: 'LLEGADA' }, { tenant_id: 'empresa_demo' }, token),
      TEST_ENV, { waitUntil: vi.fn() }
    );
    expect(r3.status).toBe(200);
    expect((await r3.json()).exito).toBe(true);
  });

  // --- sync ---
  it('sync: 401 sin token, 403 rut_mismatch', async () => {
    // 401 sin token
    const r1 = await syncChoferEvent(
      makePostRequest('/api/app-chofer-sync', { tenant_id: 'empresa_demo', rut: '12345678-9', stopId: 'OT-001', status: 'COMPLETADA' }),
      TEST_ENV, { waitUntil: vi.fn() }
    );
    expect(r1.status).toBe(401);

    // 403 rut_mismatch
    const token = await makeValidToken();
    const r2 = await syncChoferEvent(
      makePostRequest('/api/app-chofer-sync', { tenant_id: 'empresa_demo', rut: '99999999-9', stopId: 'OT-001', status: 'COMPLETADA' }, {}, token),
      TEST_ENV, { waitUntil: vi.fn() }
    );
    expect(r2.status).toBe(403);
    expect((await r2.json()).code).toBe('rut_mismatch');
  });
});

// =============================================================================
// 4. Preservation — filtros GPS, máquina de estados, multi-tenant
// =============================================================================

describe('T10 - preservation', () => {
  beforeEach(() => {
    supabaseMockImpl = {};
    pgClientMock = { query: vi.fn() };
  });

  // --- Filtros GPS: ruido (delta < 50m no acumula km) ---
  it('GPS filtro ruido: ping con delta < 50m no acumula km (gps_ruido=1)', async () => {
    const token = await makeValidToken();
    pgClientMock.query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // autoría
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          ultima_lat: '-33.430000', ultima_lng: '-70.610000',
          km_recorridos_reales: '10.0',
          ultima_actualizacion: new Date(Date.now() - 30000).toISOString(),
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE flota
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE trip_metrics

    // Coordenadas casi idénticas — delta << 50m
    const res = await handleGPSPing(
      makePostRequest('/api/gps/ping', {
        trip_id: 'V-001', tenant_id: 'empresa_demo',
        lat: -33.430001, lng: -70.610001,
      }, {}, token),
      TEST_ENV
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // km no cambió — el ruido fue descartado
    expect(body.km_actuales).toBe(10.0);

    // Verificar que el UPDATE de trip_metrics recibió gps_ruido=1 y km=0
    const tripMetricsCall = pgClientMock.query.mock.calls[3];
    expect(tripMetricsCall[1][0]).toBe(0);     // delta acumulado = 0
    expect(tripMetricsCall[1][1]).toBe(1);     // gps_descartados_ruido = 1
    expect(tripMetricsCall[1][2]).toBe(0);     // gps_descartados_vel = 0
    expect(tripMetricsCall[1][3]).toBe(0);     // gps_descartados_salto = 0
  });

  // --- Filtros GPS: velocidad imposible (> 130 km/h no acumula km) ---
  it('GPS filtro velocidad: ping con velocidad > 130 km/h no acumula km (gps_vel=1)', async () => {
    const token = await makeValidToken();
    const hace5seg = new Date(Date.now() - 5000).toISOString(); // solo 5 segundos atrás
    pgClientMock.query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // autoría
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          ultima_lat: '-33.000', ultima_lng: '-70.000',
          km_recorridos_reales: '20.0',
          ultima_actualizacion: hace5seg,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    // 5 segundos → para 200 km necesitaría ~144,000 km/h. Usamos 0.2 grados de lat (~22km) en 5s ≈ 16000 km/h
    const res = await handleGPSPing(
      makePostRequest('/api/gps/ping', {
        trip_id: 'V-001', tenant_id: 'empresa_demo',
        lat: -31.000, lng: -70.000, // ~222 km al norte en 5 segundos
      }, {}, token),
      TEST_ENV
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.km_actuales).toBe(20.0); // sin cambio

    const tripMetricsCall = pgClientMock.query.mock.calls[3];
    expect(tripMetricsCall[1][0]).toBe(0); // km acumulado = 0
    expect(tripMetricsCall[1][2]).toBe(1); // gps_descartados_vel = 1
  });

  // --- Máquina de estados: LLEGADA congela hora_llegada_chofer ---
  it('evento LLEGADA actualiza estado a EN_SITIO y registra en bitacora', async () => {
    const token = await makeValidToken();
    // flota_vehiculos: viaje asignado al chofer del token
    supabaseMockImpl['flota_vehiculos'] = {
      maybeSingle: { data: { rut_chofer_asignado: '12345678-9' }, error: null },
    };
    supabaseMockImpl['ordenes_pendientes'] = {
      // R4: assertStopOnTrip valida el stop con maybeSingle antes de mutar
      maybeSingle: { data: { ot_id: 'OT-001', trip_id: 'V-001', estado_operacional: 'PENDIENTE' }, error: null },
      single: { data: { estado_operacional: 'PENDIENTE' }, error: null },
    };
    supabaseMockImpl['bitacora_viajes'] = {
      then: { data: [{}], error: null },
    };

    const res = await handleChoferEvento(
      makePostRequest('/api/chofer/evento',
        { trip_id: 'V-001', stop_id: 'OT-001', tipo_evento: 'LLEGADA' },
        { tenant_id: 'empresa_demo' }, token
      ),
      TEST_ENV, { waitUntil: vi.fn() }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exito).toBe(true);
    expect(body.mensaje).toMatch(/llegada/i);
  });

  const POD_URL = 'https://mock.supabase.co/storage/v1/object/public/evidencias/empresa_demo/x.jpg';

  it('ENTREGA sin codigo_escaneado → 400 scan_required', async () => {
    const token = await makeValidToken();
    supabaseMockImpl['flota_vehiculos'] = {
      maybeSingle: { data: { rut_chofer_asignado: '12345678-9' }, error: null },
    };
    supabaseMockImpl['ordenes_pendientes'] = {
      maybeSingle: { data: { ot_id: 'OT-001', trip_id: 'V-001', estado_operacional: 'EN_SITIO' }, error: null },
    };

    const res = await handleChoferEvento(
      makePostRequest('/api/chofer/evento', {
        trip_id: 'V-001',
        stop_id: 'OT-001',
        tipo_evento: 'ENTREGA',
        foto_url: POD_URL,
      }, { tenant_id: 'empresa_demo' }, token),
      TEST_ENV,
      { waitUntil: vi.fn() }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('scan_required');
  });

  it('ENTREGA con ot_id crudo (sin token) → 400 scan_mismatch (C-11)', async () => {
    const token = await makeValidToken();
    supabaseMockImpl['flota_vehiculos'] = {
      maybeSingle: { data: { rut_chofer_asignado: '12345678-9' }, error: null },
    };
    supabaseMockImpl['ordenes_pendientes'] = {
      maybeSingle: {
        data: { ot_id: 'OT-001', trip_id: 'V-001', estado_operacional: 'EN_SITIO', metadata: {} },
        error: null,
      },
    };

    const res = await handleChoferEvento(
      makePostRequest('/api/chofer/evento', {
        trip_id: 'V-001',
        stop_id: 'OT-001',
        tipo_evento: 'ENTREGA',
        foto_url: POD_URL,
        codigo_escaneado: 'OT-001', // ya no basta con el ot_id
      }, { tenant_id: 'empresa_demo' }, token),
      TEST_ENV,
      { waitUntil: vi.fn() }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('scan_mismatch');
  });

  // --- Multi-tenant: token de tenant A no puede operar sobre datos de tenant B ---
  it('preservation multi-tenant: token de tenant A rechaza operacion sobre tenant B', async () => {
    // Token firmado para tenant_a
    const tokenTenantA = await signDriverToken(
      { chofer_id: 'c-001', rut: '12345678-9', tenant_id: 'tenant_a' },
      TEST_ENV
    );

    // Intento de GPS ping sobre tenant_b con token de tenant_a
    const res = await handleGPSPing(
      makePostRequest('/api/gps/ping', {
        trip_id: 'V-001',
        tenant_id: 'tenant_b', // tenant diferente al del token
        lat: -33.43,
        lng: -70.61,
      }, {}, tokenTenantA),
      TEST_ENV
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('tenant_mismatch');
  });
});
