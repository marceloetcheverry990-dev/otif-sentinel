/**
 * benchmark-middleware.mjs
 * Mide el overhead de withMonitoring() sobre un handler desnudo.
 *
 * Metodología:
 *   - Baseline: handler desnudo (simula /health sin middleware)
 *   - Monitored: mismo handler envuelto en withMonitoring()
 *   - 50 iteraciones de warmup descartadas
 *   - 500 iteraciones medidas para cada serie
 *   - Mismo Request/ctx mock en ambas series
 *   - console.log silenciado durante las mediciones para no sesgar tiempos
 *
 * Ejecutar:
 *   node benchmark-middleware.mjs
 */

import { performance } from 'perf_hooks';

// ─── Silenciar logs del middleware durante el benchmark ───────────────────────
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
function silenceLogs() {
  console.log = () => {};
  console.error = () => {};
}
function restoreLogs() {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

/**
 * Mock del Request de Cloudflare Workers
 * Replica los headers y método que usa handleHealthCheck / withMonitoring
 */
function makeMockRequest() {
  return new Request('http://localhost:8787/health', {
    method: 'GET',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'benchmark/1.0',
      'x-tenant-id': 'test-tenant',
      'cf-connecting-ip': '127.0.0.1',
    },
  });
}

/**
 * Mock del env de Workers
 * withMonitoring no accede a env directamente (solo lo pasa al handler y a recordMetric).
 * recordMetric está dentro de ctx.waitUntil → no bloquea el path crítico.
 */
const mockEnv = {
  MONITORING_ENABLED: 'true',
  MONITORING_ERROR_TRACKING: 'true',
  MONITORING_METRICS: 'true',
  MONITORING_ALERTING: 'true',
  MONITORING_SAMPLE_RATE: '0.1',
  HYPERDRIVE: null, // withDb fallará silenciosamente — está en waitUntil
};

/**
 * Mock de ctx.waitUntil — registra la promesa pero no la ejecuta sincrónicamente.
 * El benchmark mide solo el path síncrono del middleware (lo que bloquea la respuesta).
 */
function makeMockCtx() {
  return {
    waitUntil: (_promise) => { /* no-op: no ejecutamos async DB */ },
    passThroughOnException: () => {},
  };
}

// ─── Handler desnudo (baseline) ───────────────────────────────────────────────

/**
 * Simula un handler minimal tipo /health — retorna JSON estático.
 * No tiene dependencias externas para aislar el overhead puro del middleware.
 */
async function baselineHandler(_request, _env, _ctx) {
  return new Response(
    JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

// ─── Estadísticas ─────────────────────────────────────────────────────────────

function calcStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    mean:  sum / n,
    p50:   sorted[Math.floor(n * 0.50)],
    p95:   sorted[Math.floor(n * 0.95)],
    p99:   sorted[Math.floor(n * 0.99)],
    min:   sorted[0],
    max:   sorted[n - 1],
    n,
  };
}

function fmt(v) { return v.toFixed(4) + ' ms'; }

function printStats(label, stats) {
  originalConsoleLog(`\n  ${label}`);
  originalConsoleLog(`    mean : ${fmt(stats.mean)}`);
  originalConsoleLog(`    p50  : ${fmt(stats.p50)}`);
  originalConsoleLog(`    p95  : ${fmt(stats.p95)}`);
  originalConsoleLog(`    p99  : ${fmt(stats.p99)}`);
  originalConsoleLog(`    min  : ${fmt(stats.min)}   max: ${fmt(stats.max)}   n=${stats.n}`);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runSeries(handler, label, warmup, iterations) {
  const samples = [];

  // Warmup — descartado
  for (let i = 0; i < warmup; i++) {
    const req = makeMockRequest();
    const ctx = makeMockCtx();
    await handler(req, mockEnv, ctx);
  }

  // Medición real
  for (let i = 0; i < iterations; i++) {
    const req = makeMockRequest();
    const ctx = makeMockCtx();

    const t0 = performance.now();
    await handler(req, mockEnv, ctx);
    const t1 = performance.now();

    samples.push(t1 - t0);
  }

  return samples;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const WARMUP = 50;
  const ITERATIONS = 500;

  originalConsoleLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  originalConsoleLog(' Benchmark: withMonitoring() overhead');
  originalConsoleLog(`  warmup=${WARMUP}  iterations=${ITERATIONS}`);
  originalConsoleLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Importar withMonitoring dinámicamente (requiere que el módulo resuelva sus imports)
  let withMonitoring;
  try {
    const mod = await import('./src/monitoring/middleware.js');
    withMonitoring = mod.withMonitoring;
  } catch (err) {
    originalConsoleLog('\n❌ No se pudo importar middleware.js:');
    originalConsoleLog('  ' + err.message);
    process.exit(1);
  }

  const monitoredHandler = withMonitoring(baselineHandler, { component: 'benchmark' });

  // ── Serie A: baseline ──
  originalConsoleLog('\n[1/2] Midiendo baseline (handler desnudo)...');
  silenceLogs();
  const baselineSamples = await runSeries(baselineHandler, 'baseline', WARMUP, ITERATIONS);
  restoreLogs();

  // ── Serie B: monitored ──
  originalConsoleLog('[2/2] Midiendo monitored (withMonitoring)...');
  silenceLogs();
  const monitoredSamples = await runSeries(monitoredHandler, 'monitored', WARMUP, ITERATIONS);
  restoreLogs();

  // ── Estadísticas ──
  const baseline  = calcStats(baselineSamples);
  const monitored = calcStats(monitoredSamples);

  originalConsoleLog('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  originalConsoleLog(' RESULTADOS');
  originalConsoleLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  printStats('Baseline  (monitoring=OFF — handler desnudo)', baseline);
  printStats('Monitored (monitoring=ON  — withMonitoring)',  monitored);

  // ── Overhead ──
  const overheadMean = ((monitored.mean - baseline.mean) / baseline.mean) * 100;
  const overheadP50  = ((monitored.p50  - baseline.p50)  / baseline.p50)  * 100;
  const overheadP95  = ((monitored.p95  - baseline.p95)  / baseline.p95)  * 100;
  const overheadP99  = ((monitored.p99  - baseline.p99)  / baseline.p99)  * 100;

  originalConsoleLog('\n  Overhead (monitored vs baseline)');
  originalConsoleLog(`    mean : ${overheadMean >= 0 ? '+' : ''}${overheadMean.toFixed(2)}%`);
  originalConsoleLog(`    p50  : ${overheadP50  >= 0 ? '+' : ''}${overheadP50.toFixed(2)}%`);
  originalConsoleLog(`    p95  : ${overheadP95  >= 0 ? '+' : ''}${overheadP95.toFixed(2)}%  ← criterio`);
  originalConsoleLog(`    p99  : ${overheadP99  >= 0 ? '+' : ''}${overheadP99.toFixed(2)}%`);

  // ── Criterio ──
  const THRESHOLD = 5.0;
  const passed = overheadP95 < THRESHOLD;

  originalConsoleLog('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (passed) {
    originalConsoleLog(` ✅ PASS — p95 overhead: +${overheadP95.toFixed(2)}% (threshold: ${THRESHOLD}%)`);
  } else {
    originalConsoleLog(` ❌ FAIL — p95 overhead: +${overheadP95.toFixed(2)}% (threshold: ${THRESHOLD}%)`);
  }
  originalConsoleLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  restoreLogs();
  originalConsoleLog('Error fatal:', err);
  process.exit(1);
});
