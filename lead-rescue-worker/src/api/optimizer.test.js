import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSupabaseMemoria } from '../test-utils/supabase-memoria.js';

const S = { tables: {}, writes: [], urls: [] };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    const mem = createSupabaseMemoria(S.tables);
    S.writes = mem.writes;
    return mem.client;
  },
}));
vi.mock('../db.js', () => {
  const client = { query: async () => ({ rowCount: 1, rows: [{ key: 'lock' }] }) };
  return { withDb: async (_e, cb) => cb(client), withDbTransaction: async (_e, cb) => cb(client) };
});
vi.mock('../helpers/depots.js', () => ({
  resolveDepot: async () => ({ depot_id: 'd1', nombre: 'Bodega', lat: -33.5132, lng: -70.7672 }),
  depotToSolver: (d) => ({ lat: d.lat, lng: d.lng }),
}));

const { optimizarRutas, asignarViajesAChoferes } = await import('./optimizer.js');
const { calcularDistanciaKm } = await import('../helpers/vrp-solver.js');

const DEPOT = { lat: -33.5132, lng: -70.7672 };
const DIA = new Date('2026-09-23T14:00:00Z'); // 11:00 Chile
const legSec = (a, b) => (calcularDistanciaKm(a.lat, a.lng, b.lat, b.lng) * 1.3 / 40) * 3600;

function mapbox(url) {
  const u = String(url);
  S.urls.push(u);
  const pts = u.split('/driving')[1].split('/')[1].split('?')[0].split(';')
    .map((p) => p.split(',').map(Number)).map(([lng, lat]) => ({ lat, lng }));
  const legs = pts.slice(1).map((p, i) => ({ duration: legSec(pts[i], p), distance: 1000 }));
  return Promise.resolve(new Response(JSON.stringify({
    code: 'Ok',
    routes: [{ distance: 1000 * legs.length, duration: 1, legs, geometry: { coordinates: pts.map((p) => [p.lng, p.lat]) } }],
  })));
}

const orden = (i, o = {}) => ({
  ot_id: `OT${i}`, cliente: `C${i}`, tenant_id: 't', estado_operacional: 'PENDIENTE_RUTEO', trip_id: null,
  lat: -33.40 - (i % 4) * 0.03, lng: -70.60 - Math.floor(i / 4) * 0.04, volumen: 1, peso_kg: 0,
  fecha_hora_sla: new Date(DIA.getTime() + 9 * 3600000).toISOString(), tags_requeridos: [], metadata: {}, ...o,
});
const chofer = (i, o = {}) => ({
  chofer_id: `CH${i}`, tenant_id: 't', estado: 'DISPONIBLE', patente_asignada: `P${i}`,
  km_acumulados_semana: i, capacidad_volumen: 100, capacidad_peso: 99999, tags: [], ...o,
});

async function correr({ ordenes, choferes, body = {} }) {
  S.tables = {
    ordenes_pendientes: ordenes,
    choferes,
    clientes: [],
    flota_vehiculos: [],
    perfiles_optimizacion: [{ perfil_id: 1, nombre_perfil: 'Equilibrado', modo: 'equilibrado', tenant_id: null }],
  };
  S.writes = [];
  S.urls = [];
  const req = new Request('https://x/api/optimizar-rutas', {
    method: 'POST',
    body: JSON.stringify({ perfil_id: 1, flota_disponible: choferes.length, clima: 'NORMAL', ...body }),
  });
  const res = await optimizarRutas(req, { SUPABASE_URL: 'x', SUPABASE_SERVICE_KEY: 'k', MAPBOX_TOKEN: 'pk' }, null, { tenant_id: 't' });
  return { data: await res.json(), status: res.status };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(DIA);
  vi.stubGlobal('fetch', vi.fn(mapbox));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('optimizarRutas', () => {
  it('no elige choferes sin patente: toma los N con patente (antes quedaban OTs sin asignar)', async () => {
    const ordenes = Array.from({ length: 12 }, (_, i) => orden(i, { volumen: 10 }));
    const choferes = [
      chofer(1, { patente_asignada: null, capacidad_volumen: 40 }),
      chofer(2, { patente_asignada: null, capacidad_volumen: 40 }),
      chofer(3, { capacidad_volumen: 40 }), chofer(4, { capacidad_volumen: 40 }), chofer(5, { capacidad_volumen: 40 }),
    ];
    const { data } = await correr({ ordenes, choferes, body: { flota_disponible: 3 } });
    expect(data.sin_asignar_ids).toEqual([]);
    expect(data.viajes_creados).toBe(3);
  });

  it('simulación: arma el plan pero no escribe nada en la BD', async () => {
    const { data } = await correr({ ordenes: [orden(1), orden(2)], choferes: [chofer(1)], body: { is_simulacion: true } });
    expect(S.writes).toHaveLength(0);
    expect(data.plan).toHaveLength(1);
    expect(data.plan[0].ot_ids.sort()).toEqual(['OT1', 'OT2']);
  });

  it('lluvia alarga los tramos de Mapbox ×1.4 en la ETA guardada', async () => {
    const etaPrimera = async (clima) => {
      await correr({ ordenes: [orden(5)], choferes: [chofer(1)], body: { clima } });
      const w = S.writes.find((x) => x.table === 'ordenes_pendientes' && x.op === 'update' && x.payload.eta);
      return (new Date(w.payload.eta).getTime() - DIA.getTime()) / 1000;
    };
    const base = legSec(DEPOT, orden(5));
    expect(await etaPrimera('NORMAL')).toBeCloseTo(base, 0);
    expect(await etaPrimera('LLUVIA')).toBeCloseTo(base * 1.4, 0);
  });

  it('checkbox "usar todos": apagado usa los camiones que hacen falta; marcado, los N', async () => {
    const ordenes = () => Array.from({ length: 12 }, (_, i) => orden(i));
    const choferes = [chofer(1), chofer(2), chofer(3)];
    const hasta = await correr({ ordenes: ordenes(), choferes });
    expect(hasta.data.viajes_creados).toBe(1);
    expect(hasta.data.resumen).toContain('1 de 3');
    const todos = await correr({ ordenes: ordenes(), choferes, body: { usar_todos: true } });
    expect(todos.data.viajes_creados).toBe(3);
  });

  it('ruteando de noche pide a Mapbox el tráfico de la hora de salida (08:00)', async () => {
    vi.setSystemTime(new Date('2026-09-24T01:30:00Z')); // 22:30 Chile
    await correr({ ordenes: [orden(1), orden(2)], choferes: [chofer(1)] });
    const conSalida = S.urls.find((u) => u.includes('depart_at='));
    expect(conSalida).toBeDefined();
    expect(decodeURIComponent(conSalida)).toContain('depart_at=2026-09-24T11:00:00Z'); // 08:00 Chile
  });
});

describe('asignarViajesAChoferes', () => {
  it('no le da el camión grande a un viaje chico si el grande solo cabe ahí', () => {
    const viajes = [{ nombre: 'chico', vol: 30 }, { nombre: 'grande', vol: 120 }];
    const choferes = [{ nombre: 'G', cap: 150 }, { nombre: 'C', cap: 50 }];
    const { asignados, sinChofer } = asignarViajesAChoferes(viajes, choferes, {
      puedeLlevar: (v, c) => v.vol <= c.cap,
      // El costo prefiere G para todo: el greedy viejo se lo daba al chico
      costo: (_v, c) => (c.nombre === 'G' ? 0 : 1),
    });
    expect(sinChofer).toEqual([]);
    const de = Object.fromEntries(asignados.map((a) => [viajes[a.viajeIdx].nombre, choferes[a.choferIdx].nombre]));
    expect(de).toEqual({ chico: 'C', grande: 'G' });
  });
});
