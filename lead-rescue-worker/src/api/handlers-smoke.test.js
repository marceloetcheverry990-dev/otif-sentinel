// src/api/handlers-smoke.test.js
// Smoke tests de camino feliz para getChoferRutas y handleGPSPing.
//
// Propósito: verificar que el refactor de try/catch (mover la apertura
// del try a la primera línea de la función) no alteró el comportamiento
// observable de los handlers en el camino feliz.
//
// Estos tests serán ampliados en T9 (bug condition) y T10 (fix checking).
// Por ahora cubren únicamente: request válido → respuesta 200 correcta,
// y los rechazos de validación que estaban presentes antes del refactor.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getChoferRutas } from './app-chofer-rutas.js';
import { handleGPSPing } from './gps.js';
import { signDriverToken } from '../helpers/driver-auth.js';

// ─── Env de test con JWT_SECRET ───────────────────────────────────────────────
// JWT_SECRET requerido por verifyDriverToken en todos los handlers post-Wave 3.
const TEST_ENV = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_SERVICE_KEY: 'mock-key',
  JWT_SECRET: 'test-secret-32-bytes-minimum-len!!',
};

// Payload estándar de un chofer de prueba — rut coincide con los requests de test
const CHOFER_PAYLOAD = {
  chofer_id: 'chofer-001',
  rut: '12345678-9',
  tenant_id: 'empresa_demo',
};

// Helper: generar token válido para el chofer de prueba
async function makeValidToken() {
  return signDriverToken(CHOFER_PAYLOAD, TEST_ENV);
}

// ─── Mock de @supabase/supabase-js ────────────────────────────────────────────
// Interceptamos createClient para devolver un cliente con queries controladas.
// La cadena .from().select().eq().eq().maybeSingle() se simula con un builder
// fluido que resuelve con los datos que cada test configure.

let supabaseMockImpl = {};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table) => {
      const impl = supabaseMockImpl[table];
      // Builder fluido: cada método devuelve `this` hasta el terminal
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        ilike: () => builder,
        limit: () => builder,
        order: () => builder,
        maybeSingle: async () => impl?.maybeSingle ?? { data: null, error: null },
        single: async () => impl?.single ?? { data: null, error: null },
        // Para queries que terminan en await directamente (e.g. .in())
        then: (resolve) => resolve(impl?.then ?? { data: [], error: null }),
      };
      return builder;
    },
  }),
}));

// ─── Mock de withDb (para handleGPSPing) ─────────────────────────────────────
// withDb recibe (env, callback) — en el mock ejecuta el callback con el
// pgClient mockeado directamente, sin abrir conexión real.

let pgClientMock = {};

vi.mock('../db.js', () => ({
  withDb: async (_env, callback) => callback(pgClientMock),
}));

// ─── Helper: construir Request GET con query params ───────────────────────────
function makeGetRequest(path, params = {}, token = null) {
  const url = new URL(`https://worker.test${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return new Request(url.toString(), { method: 'GET', headers });
}

// ─── Helper: construir Request POST con JSON body ─────────────────────────────
function makePostRequest(path, body, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// =============================================================================
// getChoferRutas — smoke tests
// =============================================================================

describe('getChoferRutas - smoke tests post-refactor', () => {
  beforeEach(() => {
    supabaseMockImpl = {};
  });

  it('devuelve 403 cuando falta tenant_id (requireTenantId sigue siendo el primer check)', async () => {
    const request = makeGetRequest('/api/app-chofer-rutas', { rut: '12345678-9' });
    const response = await getChoferRutas(request, TEST_ENV);
    expect(response.status).toBe(403);
  });

  it('devuelve 400 cuando falta rut', async () => {
    // Sin rut y sin token: verifyDriverToken devuelve 401.
    // Sin rut pero con token: el chequeo explícito de rut (antes del JWT) devuelve 400.
    // Este test verifica el caso sin token — el 400 se emite antes de llegar a verifyDriverToken.
    const request = makeGetRequest('/api/app-chofer-rutas', { tenant_id: 'empresa_demo' });
    const response = await getChoferRutas(request, TEST_ENV);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('rut_ausente');
  });

  it('devuelve 200 con viajes:[] cuando el chofer no tiene patente asignada', async () => {
    const token = await makeValidToken();
    supabaseMockImpl['choferes'] = {
      maybeSingle: { data: { patente_asignada: null, gps_interval_seconds: 30 }, error: null },
    };

    const request = makeGetRequest('/api/app-chofer-rutas', {
      tenant_id: 'empresa_demo',
      rut: '12345678-9',
    }, token);
    const response = await getChoferRutas(request, TEST_ENV);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rut).toBe('12345678-9');
    expect(body.viajes).toEqual([]);
  });

  it('devuelve 200 con viajes:[] cuando el vehiculo no tiene trip_id_actual', async () => {
    const token = await makeValidToken();
    supabaseMockImpl['choferes'] = {
      maybeSingle: { data: { patente_asignada: 'ABCD12', gps_interval_seconds: 30 }, error: null },
    };
    supabaseMockImpl['flota_vehiculos'] = {
      maybeSingle: { data: { trip_id_actual: null, estado: 'DISPONIBLE' }, error: null },
    };

    const request = makeGetRequest('/api/app-chofer-rutas', {
      tenant_id: 'empresa_demo',
      rut: '12345678-9',
    }, token);
    const response = await getChoferRutas(request, TEST_ENV);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.viajes).toEqual([]);
  });

  it('camino feliz: devuelve 200 con trip_id y paradas ensambladas', async () => {
    const token = await makeValidToken();
    supabaseMockImpl['choferes'] = {
      maybeSingle: { data: { patente_asignada: 'ABCD12', gps_interval_seconds: 30 }, error: null },
    };
    supabaseMockImpl['flota_vehiculos'] = {
      maybeSingle: { data: { trip_id_actual: 'VIAJE-001', estado: 'EN_RUTA' }, error: null },
    };
    supabaseMockImpl['ordenes_pendientes'] = {
      // El builder termina con await — usamos .then para la query con .order()
      then: {
        data: [
          { ot_id: 'OT-001', cliente: 'Cencosud', stop_sequence: 1, estado_operacional: 'PENDIENTE' },
        ],
        error: null,
      },
    };
    supabaseMockImpl['clientes'] = {
      then: {
        data: [
          {
            nombre_cliente_raw: 'Cencosud',
            direccion_calle: 'Av. Providencia 1234',
            lat: -33.43,
            lng: -70.61,
          },
        ],
        error: null,
      },
    };

    const request = makeGetRequest('/api/app-chofer-rutas', {
      tenant_id: 'empresa_demo',
      rut: '12345678-9',
    }, token);
    const response = await getChoferRutas(request, TEST_ENV);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rut).toBe('12345678-9');
    expect(body.viajes).toHaveLength(1);
    expect(body.viajes[0].trip_id).toBe('VIAJE-001');
    expect(body.viajes[0].paradas).toHaveLength(1);
    expect(body.viajes[0].paradas[0].id).toBe('OT-001');
    expect(body.viajes[0].paradas[0].direccion).toBe('Av. Providencia 1234');
    expect(body.viajes[0].paradas[0].lat).toBe(-33.43);
    expect(body.viajes[0].paradas[0].lng).toBe(-70.61);
    expect(body.viajes[0].paradas[0].coords_source).toBe('cliente');
  });

  it('usa metadata.lat_destino cuando no hay fila en clientes', async () => {
    const token = await makeValidToken();
    supabaseMockImpl['choferes'] = {
      maybeSingle: { data: { patente_asignada: 'ABCD12', gps_interval_seconds: 30 }, error: null },
    };
    supabaseMockImpl['flota_vehiculos'] = {
      maybeSingle: { data: { trip_id_actual: 'SPOT-001', estado: 'CAMION_ASIGNADO' }, error: null },
    };
    supabaseMockImpl['ordenes_pendientes'] = {
      then: {
        data: [
          {
            ot_id: 'SPOT-001-01',
            cliente: 'Casa Peñaflor',
            stop_sequence: 1,
            estado_operacional: 'CAMION_ASIGNADO',
            metadata: { lat_destino: -33.6103, lng_destino: -70.8874, direccion_entrega: 'Cordillera 2610' },
          },
        ],
        error: null,
      },
    };
    supabaseMockImpl['clientes'] = {
      then: { data: [], error: null },
      maybeSingle: { data: null, error: null },
    };

    const request = makeGetRequest('/api/app-chofer-rutas', {
      tenant_id: 'empresa_demo',
      rut: '12345678-9',
    }, token);
    const response = await getChoferRutas(request, TEST_ENV);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.viajes[0].paradas[0].lat).toBeCloseTo(-33.6103);
    expect(body.viajes[0].paradas[0].lng).toBeCloseTo(-70.8874);
    expect(body.viajes[0].paradas[0].direccion).toBe('Cordillera 2610');
    expect(body.viajes[0].paradas[0].coords_source).toBe('metadata');
  });
});

// =============================================================================
// handleGPSPing — smoke tests
// =============================================================================

describe('handleGPSPing - smoke tests post-refactor', () => {
  beforeEach(() => {
    pgClientMock = {
      query: vi.fn(),
    };
  });

  it('devuelve 405 para métodos distintos de POST', async () => {
    const request = new Request('https://worker.test/api/gps/ping', { method: 'GET' });
    const response = await handleGPSPing(request, TEST_ENV);
    expect(response.status).toBe(405);
  });

  it('devuelve 403 cuando falta tenant_id (requireTenantId sigue siendo el primer check tras el parse)', async () => {
    const request = makePostRequest('/api/gps/ping', {
      trip_id: 'VIAJE-001',
      lat: -33.43,
      lng: -70.61,
      // tenant_id ausente
    });
    const response = await handleGPSPing(request, TEST_ENV);
    expect(response.status).toBe(403);
  });

  it('devuelve 400 cuando faltan campos obligatorios del payload', async () => {
    const token = await makeValidToken();
    const request = makePostRequest('/api/gps/ping', {
      tenant_id: 'empresa_demo',
      lat: -33.43,
      lng: -70.61,
      // trip_id ausente
    }, token);
    const response = await handleGPSPing(request, TEST_ENV);
    expect(response.status).toBe(400);
  });

  it('devuelve 400 para coordenadas fuera de rango', async () => {
    const token = await makeValidToken();
    const request = makePostRequest('/api/gps/ping', {
      trip_id: 'VIAJE-001',
      tenant_id: 'empresa_demo',
      lat: 200,   // inválido
      lng: -70.61,
    }, token);
    const response = await handleGPSPing(request, TEST_ENV);
    expect(response.status).toBe(400);
  });

  it('devuelve 403 cuando el viaje no esta asignado al chofer del token', async () => {
    const token = await makeValidToken();
    // Query de autoría devuelve rowCount:0 — viaje no asignado al chofer
    pgClientMock.query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const request = makePostRequest('/api/gps/ping', {
      trip_id: 'VIAJE-AJENO',
      tenant_id: 'empresa_demo',
      lat: -33.43,
      lng: -70.61,
    }, token);
    const response = await handleGPSPing(request, TEST_ENV);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe('trip_not_assigned');
  });

  it('devuelve 404 cuando el viaje no existe en flota_vehiculos', async () => {
    const token = await makeValidToken();
    pgClientMock.query = vi.fn()
      // Primera query: autoría — el viaje SÍ está asignado al chofer
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      // Segunda query: SELECT de flota_vehiculos — viaje no encontrado
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const request = makePostRequest('/api/gps/ping', {
      trip_id: 'VIAJE-INEXISTENTE',
      tenant_id: 'empresa_demo',
      lat: -33.43,
      lng: -70.61,
    }, token);
    const response = await handleGPSPing(request, TEST_ENV);
    expect(response.status).toBe(404);
  });

  it('camino feliz: devuelve 200 con km_actuales cuando el ping es valido', async () => {
    const token = await makeValidToken();
    pgClientMock.query = vi.fn()
      // Primera query: autoría — viaje asignado al chofer del token
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      // Segunda query: SELECT de flota_vehiculos — posicion previa
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          ultima_lat: '-33.420',
          ultima_lng: '-70.600',
          km_recorridos_reales: '10.5',
          ultima_actualizacion: new Date(Date.now() - 60000).toISOString(), // hace 1 min
        }],
      })
      // Tercera query: UPDATE flota_vehiculos
      .mockResolvedValueOnce({ rowCount: 1 })
      // Cuarta query: UPDATE trip_metrics
      .mockResolvedValueOnce({ rowCount: 1 });

    const request = makePostRequest('/api/gps/ping', {
      trip_id: 'VIAJE-001',
      tenant_id: 'empresa_demo',
      lat: -33.430,  // ~1.1 km al sur respecto a -33.420
      lng: -70.610,
    }, token);
    const response = await handleGPSPing(request, TEST_ENV);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exito).toBe(true);
    // km_actuales debe ser mayor que el valor inicial (10.5)
    expect(body.km_actuales).toBeGreaterThan(10.5);
    // Verificar que se ejecutaron las 4 queries (autoría + SELECT + 2 UPDATEs)
    expect(pgClientMock.query).toHaveBeenCalledTimes(4);
  });
});
