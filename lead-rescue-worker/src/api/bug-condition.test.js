// src/api/bug-condition.test.js
// Wave 4 — T9: Tests exploratorios de bug condition
//
// Propósito: documentar que los bugs descritos en Requirements 1.1–1.8 del
// bugfix.md ya no existen en el código con el fix aplicado (Wave 3).
// Cada test lleva una referencia al requirement que verifica y una descripción
// de cuál era el comportamiento buggy original.
//
// Estructura:
//  - Escenario A: activate y login emitían token fake o nulo (Req 1.1, 1.2)
//  - Escenario B: endpoints operativos no verificaban token (Req 1.3–1.5, 1.7, 1.8)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activateChofer } from './app-chofer-activate.js';
import { loginChofer } from './app-chofer-login.js';
import { getChoferRutas } from './app-chofer-rutas.js';
import { handleGPSPing } from './gps.js';
import { handleChoferEvento } from './app-chofer-evento.js';
import { syncChoferEvent } from './app-chofer-sync.js';

// ─── Env con JWT_SECRET ───────────────────────────────────────────────────────
const TEST_ENV = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_SERVICE_KEY: 'mock-key',
  JWT_SECRET: 'test-secret-32-bytes-minimum-len!!',
};

// ─── Mock de @supabase/supabase-js ────────────────────────────────────────────
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
        not: () => builder,
        in: () => builder,
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

// ─── Mock de withDb ───────────────────────────────────────────────────────────
let pgClientMock = {};
vi.mock('../db.js', () => ({
  withDb: async (_env, callback) => callback(pgClientMock),
}));

// ─── Mock de insertEtaMetric ──────────────────────────────────────────────────
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

// =============================================================================
// Escenario A — Emisores de token (Req 1.1, 1.2)
// Bug original: activate emitía jwt_simulado_*, login no emitía token alguno.
// =============================================================================

describe('T9 - Escenario A: emisores de token', () => {
  beforeEach(() => {
    supabaseMockImpl = {};
  });

  // Req 1.1 — activate ahora emite JWT real (no fake)
  it('[Req 1.1] activate emite un token JWT real con 3 partes (no jwt_simulado_*)', async () => {
    supabaseMockImpl['choferes'] = {
      // R3: el lookup usa maybeSingle y exige cuenta sin activar (pin vacío)
      maybeSingle: {
        data: { chofer_id: 'c-001', nombre_completo: 'Juan Chofer', gps_interval_seconds: 30, pin: null },
        error: null,
      },
      single: {
        data: { chofer_id: 'c-001', nombre_completo: 'Juan Chofer', gps_interval_seconds: 30 },
        error: null,
      },
    };

    const request = makePostRequest('/api/choferes/activate', {
      tenant_id: 'empresa_demo',
      rut: '12345678-9',
      pin: '1234',
    });

    const response = await activateChofer(request, TEST_ENV);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.token).toBeDefined();

    // Bug original: token era "jwt_simulado_<timestamp>" — una sola parte sin puntos
    expect(body.token).not.toMatch(/^jwt_simulado_/);

    // Fix: el token tiene exactamente 3 partes separadas por punto (estructura JWT)
    const parts = body.token.split('.');
    expect(parts).toHaveLength(3);

    // La firma es verificable con el secreto del entorno
    const { verifyDriverToken } = await import('../helpers/driver-auth.js');
    const verifyReq = new Request('https://worker.test/', {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    const result = await verifyDriverToken(verifyReq, TEST_ENV);
    expect(result.ok).toBe(true);
    expect(result.payload.rut).toBe('12345678-9');
    expect(result.payload.tenant_id).toBe('empresa_demo');
  });

  // Req 1.2 — login ahora emite token (antes no emitía ninguno)
  it('[Req 1.2] login emite un token JWT real junto a los datos del chofer', async () => {
    supabaseMockImpl['choferes'] = {
      // R3: login usa maybeSingle y verifica el PIN almacenado (legacy plaintext acá)
      maybeSingle: {
        data: {
          chofer_id: 'c-001',
          nombre_completo: 'Juan Chofer',
          patente_asignada: 'ABCD12',
          estado: 'DISPONIBLE',
          gps_interval_seconds: 30,
          pin: '1234',
        },
        error: null,
      },
    };

    const request = makePostRequest('/api/choferes/login', {
      tenant_id: 'empresa_demo',
      rut: '12345678-9',
      pin: '1234',
    });

    const response = await loginChofer(request, TEST_ENV);
    expect(response.status).toBe(200);

    const body = await response.json();

    // Bug original: la respuesta no tenía campo token en absoluto
    expect(body.token).toBeDefined();
    expect(body.token.split('.')).toHaveLength(3);

    // Los campos del chofer siguen presentes (preservation)
    expect(body.success).toBe(true);
    expect(body.chofer.id).toBe('c-001');
    expect(body.chofer.nombre).toBe('Juan Chofer');
    expect(body.chofer.patente).toBe('ABCD12');
    expect(body.chofer.config.ping_interval).toBe(30);
  });
});

// =============================================================================
// Escenario B — Endpoints sin verificación (Req 1.3–1.5, 1.7, 1.8)
// Bug original: ningún endpoint verificaba el token — aceptaban cualquier request.
// Fix: todos rechazan con 401 si no hay token, con 403 si el token no coincide.
// =============================================================================

describe('T9 - Escenario B: endpoints sin token son rechazados', () => {
  beforeEach(() => {
    supabaseMockImpl = {};
    pgClientMock = { query: vi.fn() };
  });

  // Req 1.3 + 1.4 — rutas rechaza sin token
  it('[Req 1.3, 1.4] GET /api/app-chofer-rutas rechaza con 401 sin Authorization header', async () => {
    // Bug original: devolvía 200 con las rutas del chofer sin ningún token
    const request = makeGetRequest('/api/app-chofer-rutas', {
      tenant_id: 'empresa_demo',
      rut: '12345678-9',
    });
    // Sin token en el request
    const response = await getChoferRutas(request, TEST_ENV);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.code).toBe('token_ausente');
  });

  // Req 1.3 + 1.4 — rutas rechaza con token de otro chofer (403)
  it('[Req 1.4] GET /api/app-chofer-rutas rechaza con 403 si el rut del token no coincide', async () => {
    const { signDriverToken } = await import('../helpers/driver-auth.js');
    // Token de otro chofer — rut diferente
    const tokenOtroChofer = await signDriverToken(
      { chofer_id: 'c-otro', rut: '99999999-9', tenant_id: 'empresa_demo' },
      TEST_ENV
    );

    const request = makeGetRequest('/api/app-chofer-rutas', {
      tenant_id: 'empresa_demo',
      rut: '12345678-9', // rut real del request
    }, tokenOtroChofer);

    const response = await getChoferRutas(request, TEST_ENV);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe('rut_mismatch');
  });

  // Req 1.3 + 1.5 — GPS ping rechaza sin token
  it('[Req 1.3, 1.5] POST /api/gps/ping rechaza con 401 sin Authorization header', async () => {
    // Bug original: aceptaba coordenadas GPS sin ningún token, corrompiendo trip_metrics
    const request = makePostRequest('/api/gps/ping', {
      trip_id: 'VIAJE-001',
      tenant_id: 'empresa_demo',
      lat: -33.43,
      lng: -70.61,
    });
    // Sin token
    const response = await handleGPSPing(request, TEST_ENV);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.code).toBe('token_ausente');
  });

  // Req 1.5 — GPS ping rechaza con token de tenant diferente
  it('[Req 1.5] POST /api/gps/ping rechaza con 403 si el tenant del token no coincide', async () => {
    const { signDriverToken } = await import('../helpers/driver-auth.js');
    const tokenOtroTenant = await signDriverToken(
      { chofer_id: 'c-001', rut: '12345678-9', tenant_id: 'otro_tenant' },
      TEST_ENV
    );

    const request = makePostRequest('/api/gps/ping', {
      trip_id: 'VIAJE-001',
      tenant_id: 'empresa_demo', // tenant diferente al del token
      lat: -33.43,
      lng: -70.61,
    }, {}, tokenOtroTenant);

    const response = await handleGPSPing(request, TEST_ENV);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe('tenant_mismatch');
  });

  // Req 1.3 + 1.7 — evento rechaza sin token
  it('[Req 1.3, 1.7] POST /api/chofer/evento rechaza con 401 sin Authorization header', async () => {
    // Bug original: registraba LLEGADA/ENTREGA/SALIDA sin verificar que el solicitante
    // fuera el chofer asignado — cualquiera con trip_id + stop_id podía registrar eventos
    const request = makePostRequest(
      '/api/chofer/evento',
      { trip_id: 'VIAJE-001', stop_id: 'OT-001', tipo_evento: 'LLEGADA' },
      { tenant_id: 'empresa_demo' }
    );
    // Sin token
    const response = await handleChoferEvento(request, TEST_ENV);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.code).toBe('token_ausente');
  });

  // Req 1.7 — evento rechaza con token de chofer no asignado al viaje
  it('[Req 1.7] POST /api/chofer/evento rechaza con 403 si el chofer no esta asignado al viaje', async () => {
    const { signDriverToken } = await import('../helpers/driver-auth.js');
    const token = await signDriverToken(
      { chofer_id: 'c-001', rut: '12345678-9', tenant_id: 'empresa_demo' },
      TEST_ENV
    );

    // Supabase: el viaje está asignado a OTRO chofer.
    // R4: la query filtra por rut_chofer_asignado en SQL, por lo que un viaje
    // ajeno se ve como "0 filas" desde la perspectiva del Worker.
    supabaseMockImpl['flota_vehiculos'] = {
      maybeSingle: { data: null, error: null },
    };

    const request = makePostRequest(
      '/api/chofer/evento',
      { trip_id: 'VIAJE-001', stop_id: 'OT-001', tipo_evento: 'LLEGADA' },
      { tenant_id: 'empresa_demo' },
      token
    );

    const response = await handleChoferEvento(request, TEST_ENV);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe('trip_not_assigned');
  });

  // Req 1.3 + 1.8 — sync rechaza sin token
  it('[Req 1.3, 1.8] POST /api/app-chofer-sync rechaza con 401 sin Authorization header', async () => {
    // Bug original: modificaba estados de órdenes con solo tenant_id + rut en el body
    const request = makePostRequest('/api/app-chofer-sync', {
      tenant_id: 'empresa_demo',
      rut: '12345678-9',
      stopId: 'OT-001',
      status: 'COMPLETADA',
    });
    // Sin token
    const response = await syncChoferEvent(request, TEST_ENV);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.code).toBe('token_ausente');
  });

  // Req 1.8 — sync rechaza con token de rut diferente al del body
  it('[Req 1.8] POST /api/app-chofer-sync rechaza con 403 si rut del token no coincide con body', async () => {
    const { signDriverToken } = await import('../helpers/driver-auth.js');
    const token = await signDriverToken(
      { chofer_id: 'c-001', rut: '12345678-9', tenant_id: 'empresa_demo' },
      TEST_ENV
    );

    const request = makePostRequest('/api/app-chofer-sync', {
      tenant_id: 'empresa_demo',
      rut: '99999999-9', // rut diferente al del token
      stopId: 'OT-001',
      status: 'COMPLETADA',
    }, {}, token);

    const response = await syncChoferEvent(request, TEST_ENV);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe('rut_mismatch');
  });
});
