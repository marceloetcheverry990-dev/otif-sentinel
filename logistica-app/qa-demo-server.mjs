import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const PORT = 8093;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const state = {
  token: 'demo-token-felipe',
  driver: {
    rut: '11111111-1',
    nombre: 'felipe jeriverto',
  },
  trip: {
    trip_id: 'TRIP-DEMO-FELIPE',
    estado: 'CAMION_ASIGNADO',
    paradas: [
      {
        id: 'OT-DEMO-1',
        nombre: 'Cliente Demo Centro',
        direccion: 'Av. Apoquindo 3000, Las Condes',
        lat: -33.4141,
        lng: -70.6012,
        orden: 1,
        estado_bd: 'PENDIENTE',
        pod_requirements: { foto: false, firma: false, scan: false, notas: false },
      },
      {
        id: 'OT-DEMO-2',
        nombre: 'Cliente Demo Norte',
        direccion: 'Av. Independencia 1234, Independencia',
        lat: -33.4187,
        lng: -70.6535,
        orden: 2,
        estado_bd: 'PENDIENTE',
        pod_requirements: { foto: false, firma: false, scan: false, notas: false },
      },
    ],
    misiones_rescate: [
      {
        id: 'RM-DEMO-1',
        source_trip_id: 'TRIP-BASE-ORIGEN',
        ot_ids: ['OT-DEMO-2'],
        delta_km: 1.8,
        status: 'DISPATCHED',
        created_at: new Date().toISOString(),
        mensaje: 'Misión de rescate: 1 parada desde TRIP-BASE-ORIGEN',
      },
    ],
  },
  chat: [
    {
      id: 'msg-1',
      tipo_evento: 'CHAT_TORRE',
      mensaje: 'Felipe, prueba de comunicación desde torre.',
      foto_url: null,
      created_at: new Date().toISOString(),
    },
  ],
  events: [],
};

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function currentRoutePayload(rut) {
  if (rut !== state.driver.rut) return { rut, viajes: [] };
  return {
    rut,
    viajes: [
      {
        trip_id: state.trip.trip_id,
        estado: state.trip.estado,
        paradas: state.trip.paradas,
        misiones_rescate: state.trip.misiones_rescate,
      },
    ],
    misiones_rescate: state.trip.misiones_rescate,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      if (req.method === 'POST' && url.pathname === '/api/choferes/login') {
        const body = await readBody(req);
        if (body?.tenant_id === 'empresa_base' && body?.rut === state.driver.rut && body?.pin === '1111') {
          return json(res, {
            success: true,
            token: state.token,
            driverName: state.driver.nombre,
            gpsInterval: 60,
            chofer: {
              id: 'demo-chofer-1',
              nombre: state.driver.nombre,
              patente: 'KV-JS-99',
              estado: 'DISPONIBLE',
              config: { ping_interval: 60 },
            },
          });
        }
        return json(res, { error: 'No autorizado: RUT o PIN incorrectos' }, 401);
      }

      if (req.method === 'GET' && url.pathname === '/api/app-chofer-rutas') {
        return json(res, currentRoutePayload(url.searchParams.get('rut')));
      }

      if (req.method === 'POST' && url.pathname === '/api/mobile-sync') {
        const body = await readBody(req);
        if (body?.payload?.estado === 'EN_RUTA') state.trip.estado = 'EN_RUTA';
        return json(res, { exito: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/chofer/evento') {
        const body = await readBody(req);
        state.events.push({ ...body, at: new Date().toISOString() });
        const stop = state.trip.paradas.find((p) => String(p.id) === String(body.stop_id));
        if (stop) {
          if (body.tipo_evento === 'LLEGADA') stop.estado_bd = 'EN_SITIO';
          if (body.tipo_evento === 'ENTREGA') stop.estado_bd = 'ENTREGADO';
          if (body.tipo_evento === 'PROBLEMA') stop.estado_bd = 'PROBLEMA';
        }
        return json(res, { exito: true });
      }

      if (req.method === 'GET' && url.pathname === '/api/chat') {
        return json(res, { exito: true, mensajes: state.chat });
      }

      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = await readBody(req);
        state.chat.push({
          id: `msg-${state.chat.length + 1}`,
          tipo_evento: 'CHAT_CHOFER',
          mensaje: body?.mensaje || '',
          foto_url: body?.foto_url || null,
          created_at: new Date().toISOString(),
        });
        return json(res, { exito: true });
      }

      if (
        req.method === 'POST' &&
        (url.pathname === '/api/upload-evidence' ||
          url.pathname === '/api/app-chofer-sync' ||
          url.pathname === '/api/gps/ping' ||
          url.pathname === '/api/choferes/logout')
      ) {
        return json(res, { exito: true, url: 'https://example.invalid/evidence/demo.jpg' });
      }

      return json(res, { error: `Ruta demo no implementada: ${req.method} ${url.pathname}` }, 404);
    } catch (error) {
      return json(res, { error: error.message || 'demo server error' }, 500);
    }
  }

  let filePath = path.join(DIST, url.pathname);
  if (url.pathname === '/' || !path.extname(url.pathname)) filePath = path.join(DIST, 'index.html');
  if (!serveFile(res, filePath)) {
    const fallback = path.join(DIST, 'index.html');
    if (!serveFile(res, fallback)) {
      res.writeHead(404);
      res.end('Not found');
    }
  }
});

server.listen(PORT, () => {
  console.log(`QA demo listo en http://localhost:${PORT}`);
});
