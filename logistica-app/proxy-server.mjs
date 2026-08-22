// proxy-server.mjs — sirve dist/ y hace proxy de /api/* al Worker de producción
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const API_TARGET = 'lead-rescue-pipeline-staging.marceloetcheverry990.workers.dev';
const PORT = 8092;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
};

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers para todas las respuestas
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenant-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Proxy /api/* al Worker
  if (url.pathname.startsWith('/api/')) {
    const options = {
      hostname: API_TARGET,
      port: 443,
      path: url.pathname + url.search,
      method: req.method,
      headers: { ...req.headers, host: API_TARGET },
    };
    delete options.headers['content-length']; // evita mismatch

    const proxy = https.request(options, (apiRes) => {
      const headers = { ...apiRes.headers };
      headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(apiRes.statusCode, headers);
      apiRes.pipe(res);
    });
    proxy.on('error', (e) => {
      console.error('Proxy error:', e.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'Proxy error: ' + e.message }));
    });
    req.pipe(proxy);
    return;
  }

  // Archivos estáticos
  let filePath = path.join(DIST, url.pathname);
  if (url.pathname === '/' || !path.extname(url.pathname)) {
    filePath = path.join(DIST, 'index.html');
  }

  if (!serveFile(res, filePath)) {
    // SPA fallback
    const fallback = path.join(DIST, 'index.html');
    if (!serveFile(res, fallback)) {
      res.writeHead(404);
      res.end('Not found');
    }
  }
});

server.listen(PORT, () => {
  console.log(`Proxy listo en http://localhost:${PORT}`);
  console.log(`API -> https://${API_TARGET}`);
});
