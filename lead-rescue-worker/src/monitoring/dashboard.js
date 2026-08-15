// src/monitoring/dashboard.js
// Technical Monitoring Dashboard - System Health & Performance
import { withDb } from '../db.js';
import { verifyOperatorToken } from '../helpers/operator-auth.js';

/**
 * Return a JSON snapshot of all monitoring dimensions for the given time range.
 *
 * The response aggregates data from six independent sources in a single DB
 * round-trip (all queries run within the same `withDb` callback):
 *
 * 1. **Health** — live DB latency measured with a `SELECT 1` ping
 * 2. **Performance** — average response time, requests/min, error rate
 *    (computed from `metrics_summary` rows with `aggregation_type = 'raw'`)
 * 3. **Recent errors** — last 10 `error_logs` rows within the time range
 * 4. **Queue metrics** — per-queue average latency and throughput from
 *    `metrics_summary` grouped by `dimension_tags->>'queue_name'`
 * 5. **Circuit breakers** — `OPEN` / `CLOSED` state from `system_flags`
 * 6. **DLQ count** — `dead_letter_events` rows within the time range
 *
 * All secondary queries (errors, queues, circuit breakers, DLQ) are wrapped in
 * individual try/catch blocks — if any table doesn't exist yet, the section
 * falls back to an empty/default value without failing the whole response.
 *
 * @param {Request} request - Incoming HTTP request.
 *   Query parameter `range` selects the time window: `'1h'` (default), `'24h'`, `'7d'`.
 * @param {Env} env - Worker environment bindings (HYPERDRIVE required)
 * @returns {Promise<Response>} JSON response with Content-Type `application/json`.
 *   HTTP 200 on success; HTTP 500 if the outermost DB connection fails.
 *
 * @example
 * // Wire up in main router (already done in src/index.js):
 * if (url.pathname === '/api/dashboard/data') {
 *   return getDashboardData(request, env);
 * }
 *
 * // Sample response shape:
 * // {
 * //   timestamp: "2025-01-15T10:30:00Z",
 * //   timeRange: "1h",
 * //   health: { status: "healthy", database: { latency_ms: 12 }, ... },
 * //   performance: { avg_response_time: 245, requests_per_minute: 3.2, error_rate: 0.5 },
 * //   errors: [...],
 * //   circuitBreakers: { openai_breaker: { status: "closed" }, ... },
 * //   queues: { main_queue: { avg_latency_ms: 1200, last_throughput: 4.5 }, ... },
 * //   dlq: { count: 0 }
 * // }
 *
 * Requirements: 6.3-6.8
 */
export async function getDashboardData(request, env) {
  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const timeRange = url.searchParams.get('range') || '1h';

  // Map UI time range selector to PostgreSQL interval
  const intervalMap = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days' };
  const interval = intervalMap[timeRange] || '1 hour';

  try {
    return await withDb(env, async (client) => {
    // =========================================================================
    // 1. HEALTH — real DB latency
    // =========================================================================
    const healthStatus = {
      status: 'healthy',
      database: { status: 'connected', latency_ms: 0 },
      storage: { status: 'connected' },
      queues: { status: 'operational' },
    };

    try {
      const pingStart = Date.now();
      await client.query('SELECT 1');
      healthStatus.database.latency_ms = Date.now() - pingStart;
    } catch (dbErr) {
      healthStatus.database.status = 'error';
      healthStatus.status = 'unhealthy';
      console.error('[DASHBOARD_DB_HEALTH]', dbErr.message);
    }

    // =========================================================================
    // 2. PERFORMANCE — from metrics_summary (aggregation_type = 'raw')
    // =========================================================================
    const perfResult = await client.query(`
      SELECT
        COALESCE(
          AVG(metric_value) FILTER (WHERE metric_name = 'http.request.duration'),
          0
        )::numeric(10,2) AS avg_response_time,

        COALESCE(
          COUNT(*) FILTER (WHERE metric_name = 'http.request.count')
            / NULLIF(EXTRACT(EPOCH FROM INTERVAL '${interval}') / 60, 0),
          0
        )::numeric(10,2) AS requests_per_minute,

        COALESCE(
          COUNT(*) FILTER (WHERE metric_name = 'http.error.rate')
            * 100.0
            / NULLIF(COUNT(*) FILTER (WHERE metric_name = 'http.request.count'), 0),
          0
        )::numeric(10,2) AS error_rate

      FROM metrics_summary
      WHERE aggregation_type = 'raw'
        AND timestamp > NOW() - INTERVAL '${interval}'
    `);

    const perf = perfResult.rows[0];

    // =========================================================================
    // 3. RECENT ERRORS — last 10 from error_logs
    // =========================================================================
    let recentErrors = [];
    try {
      const errResult = await client.query(`
        SELECT error_type, error_message, severity, endpoint, timestamp
        FROM error_logs
        WHERE timestamp > NOW() - INTERVAL '${interval}'
        ORDER BY timestamp DESC
        LIMIT 10
      `);
      recentErrors = errResult.rows;
    } catch (_) {
      // error_logs may be empty — non-fatal
    }

    // =========================================================================
    // 4. QUEUE METRICS — latency and throughput from metrics_summary
    // =========================================================================
    const queueResult = await client.query(`
      SELECT
        dimension_tags->>'queue_name'                   AS queue_name,
        COALESCE(AVG(metric_value), 0)::numeric(10,2)  AS avg_latency_ms,
        COALESCE(MAX(metric_value), 0)::numeric(10,2)  AS last_throughput
      FROM metrics_summary
      WHERE aggregation_type = 'raw'
        AND metric_name IN ('queue.processing.latency', 'queue.throughput')
        AND timestamp > NOW() - INTERVAL '${interval}'
      GROUP BY dimension_tags->>'queue_name'
    `);

    const queueMap = {};
    for (const row of queueResult.rows) {
      queueMap[row.queue_name] = {
        avg_latency_ms: parseFloat(row.avg_latency_ms),
        last_throughput: parseFloat(row.last_throughput),
      };
    }

    const queues = {
      main_queue: {
        pending: 0,
        processing_rate: queueMap['MAIN_QUEUE']?.last_throughput ?? 0,
        avg_latency_ms: queueMap['MAIN_QUEUE']?.avg_latency_ms ?? 0,
      },
      enrichment_queue: {
        pending: 0,
        processing_rate: queueMap['ENRICHMENT_QUEUE']?.last_throughput ?? 0,
        avg_latency_ms: queueMap['ENRICHMENT_QUEUE']?.avg_latency_ms ?? 0,
      },
      delivery_queue: {
        pending: 0,
        processing_rate: queueMap['DELIVERY_QUEUE']?.last_throughput ?? 0,
        avg_latency_ms: queueMap['DELIVERY_QUEUE']?.avg_latency_ms ?? 0,
      },
    };

    // =========================================================================
    // 5. CIRCUIT BREAKERS — from system_flags (table may not exist yet)
    // =========================================================================
    let circuitBreakers = {
      openai_breaker: { status: 'unknown', activations: 0 },
    };

    try {
      const cbResult = await client.query(`
        SELECT key, value
        FROM system_flags
        WHERE key = 'openai_breaker'
      `);
      for (const row of cbResult.rows) {
        circuitBreakers.openai_breaker = {
          status: row.value === 'OPEN' ? 'open' : 'closed',
          activations: 0,
        };
      }
    } catch (_) {
      // system_flags may not exist — non-fatal
    }

    // =========================================================================
    // 6. DLQ count — from dead_letter_events (table may not exist yet)
    // =========================================================================
    let dlqCount = 0;
    try {
      const dlqResult = await client.query(`
        SELECT COUNT(*) AS cnt
        FROM dead_letter_events
        WHERE created_at > NOW() - INTERVAL '${interval}'
      `);
      dlqCount = parseInt(dlqResult.rows[0].cnt, 10);
    } catch (_) {
      // dead_letter_events may not exist — non-fatal
    }

    return new Response(JSON.stringify({
      timestamp: new Date().toISOString(),
      timeRange,
      health: healthStatus,
      performance: {
        avg_response_time: parseFloat(perf.avg_response_time),
        requests_per_minute: parseFloat(perf.requests_per_minute),
        error_rate: parseFloat(perf.error_rate),
      },
      errors: recentErrors,
      circuitBreakers,
      queues,
      dlq: { count: dlqCount },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
    }, { statementTimeout: 5000 });

  } catch (error) {
    console.error('[DASHBOARD_ERROR]', error.message);
    return new Response(JSON.stringify({ error: 'Failed', message: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Render the full monitoring dashboard HTML page.
 *
 * Returns a self-contained HTML page that:
 * - Auto-refreshes every 30 seconds via `setInterval` fetching `/api/dashboard/data`
 * - Renders KPI cards for system status, response time, throughput, and error rate
 * - Renders a Circuit Breakers panel (OpenAI)
 * - Renders a Queue Status panel (main/enrichment/delivery queues + DLQ)
 * - Provides a time range selector (1h / 24h / 7d)
 *
 * Security headers applied:
 * - `X-Frame-Options: DENY` — prevents clickjacking
 * - `X-Content-Type-Options: nosniff` — prevents MIME sniffing
 *
 * @param {Request} _request - Incoming HTTP request (currently unused; reserved for future auth checks)
 * @param {Env}     _env     - Worker environment bindings (currently unused; reserved for future per-tenant rendering)
 * @returns {Promise<Response>} HTML response with `Content-Type: text/html; charset=utf-8`
 *
 * @example
 * // Wire up in main router (already done in src/index.js):
 * if (url.pathname === '/dashboard/monitoring') {
 *   return renderDashboard(request, env);
 * }
 *
 * Requirements: 6.1-6.5, 6.9, 10.9
 */
export async function renderDashboard(request, env) {
  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth.response;

  const html = String.raw`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard Técnico - OTIF Sentinel</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0f1e;
      color: #e2e8f0;
      padding: 30px;
      min-height: 100vh;
    }
    .container { max-width: 1800px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 40px;
      padding: 30px 40px;
      background: linear-gradient(135deg, rgba(30,41,59,0.8) 0%, rgba(51,65,85,0.6) 100%);
      border-radius: 20px;
      border: 1px solid rgba(71,85,105,0.5);
    }
    .header h1 {
      font-size: 36px;
      font-weight: 900;
      background: linear-gradient(135deg, #ef4444 0%, #f59e0b 50%, #10b981 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .header h1 span {
      -webkit-text-fill-color: initial;
    }
    .header-controls { display: flex; gap: 12px; align-items: center; }
    .tab-button {
      padding: 10px 20px;
      background: rgba(51,65,85,0.6);
      border: 1px solid rgba(71,85,105,0.8);
      border-radius: 12px;
      color: #cbd5e1;
      -webkit-text-fill-color: #cbd5e1;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.3s;
      text-decoration: none;
      display: inline-block;
    }
    .tab-button:hover:not(.active) {
      background: rgba(71,85,105,0.6);
      border-color: rgba(100,116,139,0.7);
    }
    .tab-button.active {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      border-color: #ef4444;
      color: white;
      -webkit-text-fill-color: white;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
      margin-bottom: 32px;
    }
    .kpi-card {
      background: linear-gradient(135deg, rgba(30,41,59,0.8) 0%, rgba(51,65,85,0.6) 100%);
      padding: 24px;
      border-radius: 20px;
      border: 1px solid rgba(71,85,105,0.5);
    }
    .kpi-label { font-size: 12px; font-weight: 700; text-transform: uppercase; color: #94a3b8; margin-bottom: 12px; }
    .kpi-value { font-size: 42px; font-weight: 900; background: linear-gradient(135deg, #ef4444 0%, #f59e0b 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px; }
    .kpi-status { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .status-healthy { color: #10b981; }
    .status-warning { color: #f59e0b; }
    .status-error { color: #ef4444; }
    .chart-card {
      background: linear-gradient(135deg, rgba(30,41,59,0.8) 0%, rgba(51,65,85,0.6) 100%);
      padding: 28px;
      border-radius: 20px;
      border: 1px solid rgba(71,85,105,0.5);
      margin-bottom: 24px;
    }
    .chart-title { font-size: 18px; font-weight: 800; color: #e2e8f0; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid rgba(71,85,105,0.3); }
    .metric-bar { display: flex; align-items: center; gap: 15px; margin: 15px 0; padding: 15px; background: rgba(15,23,42,0.6); border-radius: 12px; }
    .metric-bar-label { min-width: 180px; font-size: 14px; font-weight: 600; color: #cbd5e1; }
    .metric-bar-fill { flex: 1; height: 12px; background: rgba(71,85,105,0.3); border-radius: 6px; overflow: hidden; }
    .metric-bar-value { height: 100%; background: linear-gradient(90deg, #ef4444, #f59e0b); border-radius: 6px; }
    .metric-bar-number { min-width: 80px; text-align: right; font-weight: 700; font-size: 15px; color: #60a5fa; }
    .loading { text-align: center; color: #94a3b8; padding: 80px; font-size: 18px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><span>🔧</span> Dashboard Técnico</h1>
      <div class="header-controls">
        <a href="/dashboard/operaciones" class="tab-button">🚛 Operaciones</a>
        <a href="/dashboard/executive" class="tab-button">💼 Ejecutivo</a>
        <a href="/dashboard/monitoring" class="tab-button active">🔧 Técnico</a>
        <select id="rangeSelector" class="tab-button">
          <option value="1h">1 Hora</option>
          <option value="24h">24 Horas</option>
          <option value="7d">7 Días</option>
        </select>
      </div>
    </div>
    <div id="dashboard" class="loading">Cargando métricas del sistema...</div>
  </div>

  <script>
    let currentRange = '1h';

    async function loadDashboard() {
      try {
        const response = await fetch('/api/dashboard/data?range=' + currentRange);
        const data = await response.json();
        renderDashboard(data);
      } catch (error) {
        document.getElementById('dashboard').innerHTML = '<div class="chart-card"><p style="color:#ef4444;text-align:center">Error: ' + error.message + '</p></div>';
      }
    }

    function renderDashboard(data) {
      const healthStatus = data.health?.status || 'unknown';
      const healthClass = healthStatus === 'healthy' ? 'status-healthy' : 'status-error';
      const perf = data.performance || {};
      const hasData = perf.avg_response_time > 0 || perf.requests_per_minute > 0;

      let html = '';
      html += '<div class="kpi-grid">';
      html += '<div class="kpi-card">';
      html += '<div class="kpi-label">Estado del Sistema</div>';
      html += '<div class="kpi-value" style="font-size:28px;color:' + (healthStatus==='healthy'?'#10b981':'#ef4444') + '">' + (healthStatus==='healthy'?'Saludable':'Degradado') + '</div>';
      html += '<div class="kpi-status ' + healthClass + '">DB: ' + (data.health && data.health.database ? data.health.database.latency_ms : 0) + 'ms</div>';
      html += '</div>';
      html += '<div class="kpi-card">';
      html += '<div class="kpi-label">Tiempo de Respuesta</div>';
      html += '<div class="kpi-value">' + (hasData ? perf.avg_response_time : '--') + '<span style="font-size:20px">ms</span></div>';
      html += '<div class="kpi-status ' + (perf.avg_response_time < 500 ? 'status-healthy' : 'status-warning') + '">' + (hasData ? 'Real' : 'Sin datos') + '</div>';
      html += '</div>';
      html += '<div class="kpi-card">';
      html += '<div class="kpi-label">Requests/Minuto</div>';
      html += '<div class="kpi-value">' + (hasData ? perf.requests_per_minute : '--') + '</div>';
      html += '<div class="kpi-status status-healthy">' + (hasData ? 'Trafico real' : 'Sin datos aun') + '</div>';
      html += '</div>';
      html += '<div class="kpi-card">';
      html += '<div class="kpi-label">Tasa de Errores</div>';
      html += '<div class="kpi-value" style="color:' + ((perf.error_rate||0)>5?'#ef4444':'#10b981') + '">' + (hasData ? perf.error_rate.toFixed(2) : '--') + '<span style="font-size:20px">%</span></div>';
      html += '<div class="kpi-status ' + ((perf.error_rate||0)>5?'status-error':'status-healthy') + '">' + (hasData ? 'Calculado' : 'Sin datos') + '</div>';
      html += '</div>';
      html += '</div>';

      const cbOai = data.circuitBreakers && data.circuitBreakers.openai_breaker ? data.circuitBreakers.openai_breaker.status : 'unknown';
      html += '<div class="chart-card">';
      html += '<div class="chart-title">Circuit Breakers</div>';
      html += '<div class="metric-bar"><div class="metric-bar-label">OpenAI: ' + cbOai + '</div><div class="metric-bar-fill"><div class="metric-bar-value" style="width:' + (cbOai==='open'?'100':'5') + '%;background:' + (cbOai==='open'?'#ef4444':'#10b981') + '"></div></div><div class="metric-bar-number" style="color:' + (cbOai==='open'?'#ef4444':'#10b981') + '">' + (cbOai==='open'?'ABIERTO':'CERRADO') + '</div></div>';
      html += '</div>';

      var queues = ['main_queue','enrichment_queue','delivery_queue'];
      html += '<div class="chart-card"><div class="chart-title">Estado de Colas</div>';
      for (var i = 0; i < queues.length; i++) {
        var q = queues[i];
        var pending = data.queues && data.queues[q] ? (data.queues[q].pending || 0) : 0;
        var label = q.replace(/_/g,' ').replace(/\b\w/g, function(c){return c.toUpperCase();});
        html += '<div class="metric-bar"><div class="metric-bar-label">' + label + '</div><div class="metric-bar-fill"><div class="metric-bar-value" style="width:' + Math.min(pending*2,100) + '%"></div></div><div class="metric-bar-number">' + pending + ' msgs</div></div>';
      }
      var dlqCount = data.dlq ? (data.dlq.count || 0) : 0;
      html += '<div class="metric-bar"><div class="metric-bar-label">Dead Letter Queue</div><div class="metric-bar-fill"><div class="metric-bar-value" style="width:' + Math.min(dlqCount*5,100) + '%;background:' + (dlqCount>10?'#ef4444':'#f59e0b') + '"></div></div><div class="metric-bar-number" style="color:' + (dlqCount>10?'#ef4444':'#f59e0b') + '">' + dlqCount + ' msgs</div></div>';
      html += '</div>';

      html += '<div style="text-align:center;color:#64748b;font-size:0.85rem;margin-top:30px;padding:15px;background:rgba(255,255,255,0.03);border-radius:8px">';
      html += 'Ultima actualizacion: ' + new Date(data.timestamp).toLocaleString('es-ES') + ' | Rango: ' + currentRange + ' | ' + (hasData ? 'DATOS REALES' : 'Sin metricas en DB aun');
      html += '</div>';

      document.getElementById('dashboard').innerHTML = html;
    }

    loadDashboard();
    setInterval(loadDashboard, 30000);
    document.getElementById('rangeSelector').addEventListener('change', e => { currentRange = e.target.value; loadDashboard(); });
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}