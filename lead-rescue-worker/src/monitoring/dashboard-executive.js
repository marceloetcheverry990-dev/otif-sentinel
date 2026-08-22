// src/monitoring/dashboard-executive.js
// Dashboard Ejecutivo - Interfaz HTML para Business Intelligence
// Visualización de KPIs de negocio y análisis operacional

import { verifyOperatorToken } from '../helpers/operator-auth.js';

/**
 * DASHBOARD EJECUTIVO - UI
 * 
 * Visualiza métricas de negocio:
 * - KPIs principales con comparativas mensuales
 * - Tendencias anuales de entregas
 * - Performance de choferes (top 10)
 * - Análisis de clientes (top 10)
 * - Análisis de pérdidas y multas
 * - Distribución horaria de entregas
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Renderizar dashboard ejecutivo HTML
 */
export async function renderExecutiveDashboard(request, env) {
  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth.response;

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OTIF Sentinel - Dashboard Ejecutivo</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0f1e;
      background-image: 
        radial-gradient(circle at 20% 50%, rgba(120, 119, 198, 0.05) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(96, 165, 250, 0.05) 0%, transparent 50%);
      color: #e2e8f0;
      padding: 30px;
      min-height: 100vh;
      position: relative;
      overflow-x: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-image: 
        radial-gradient(circle at 50% 50%, rgba(96, 165, 250, 0.03) 1px, transparent 1px);
      background-size: 50px 50px;
      animation: drift 60s linear infinite;
      pointer-events: none;
      z-index: 0;
    }

    @keyframes drift {
      from { transform: translate(0, 0); }
      to { transform: translate(50px, 50px); }
    }

    .container {
      max-width: 1800px;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }

    /* Header Premium */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 40px;
      padding: 30px 40px;
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.8) 0%, rgba(51, 65, 85, 0.6) 100%);
      backdrop-filter: blur(20px);
      border-radius: 20px;
      box-shadow: 
        0 20px 60px rgba(0, 0, 0, 0.5),
        inset 0 1px 0 rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(71, 85, 105, 0.5);
      position: relative;
      overflow: hidden;
    }

    .header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, #60a5fa, #a78bfa, transparent);
      animation: shimmer 3s infinite;
    }

    @keyframes shimmer {
      0%, 100% { opacity: 0.5; transform: translateX(-100%); }
      50% { opacity: 1; transform: translateX(100%); }
    }

    .header h1 {
      font-size: 36px;
      font-weight: 900;
      background: linear-gradient(135deg, #10b981 0%, #60a5fa 50%, #a78bfa 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      display: flex;
      align-items: center;
      gap: 15px;
      letter-spacing: -0.5px;
      filter: drop-shadow(0 0 20px rgba(16, 185, 129, 0.3));
    }

    .header h1 .icon {
      font-size: 42px;
      filter: drop-shadow(0 0 10px rgba(16, 185, 129, 0.5));
    }

    .header-controls {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .tab-button {
      padding: 10px 20px;
      background: rgba(51, 65, 85, 0.6);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(71, 85, 105, 0.8);
      border-radius: 12px;
      color: #cbd5e1;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      text-decoration: none;
      display: inline-block;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    .tab-button:hover:not(.active) {
      background: rgba(71, 85, 105, 0.9);
      border-color: rgba(100, 116, 139, 0.7);
      transform: translateY(-2px);
    }

    .tab-button.active {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      border-color: #10b981;
      color: white;
      box-shadow: 0 8px 24px rgba(16, 185, 129, 0.4);
    }

    .refresh-indicator {
      font-size: 13px;
      color: #94a3b8;
      font-weight: 600;
      padding: 8px 16px;
      background: rgba(15, 23, 42, 0.6);
      border-radius: 8px;
      border: 1px solid rgba(71, 85, 105, 0.3);
    }

    /* KPI Cards Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
      margin-bottom: 32px;
    }

    /* KPI Card Premium */
    .kpi-card {
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.8) 0%, rgba(51, 65, 85, 0.6) 100%);
      backdrop-filter: blur(20px);
      padding: 24px;
      border-radius: 20px;
      box-shadow: 
        0 20px 60px rgba(0, 0, 0, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(71, 85, 105, 0.5);
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }

    .kpi-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #10b981, #60a5fa);
      opacity: 0.8;
    }

    .kpi-card:hover {
      transform: translateY(-4px);
      box-shadow: 
        0 30px 80px rgba(0, 0, 0, 0.5),
        0 0 40px rgba(16, 185, 129, 0.2);
      border-color: rgba(16, 185, 129, 0.6);
    }

    .kpi-label {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: #94a3b8;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .kpi-value {
      font-size: 42px;
      font-weight: 900;
      background: linear-gradient(135deg, #10b981 0%, #60a5fa 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      filter: drop-shadow(0 0 10px rgba(16, 185, 129, 0.5));
      letter-spacing: -1px;
      margin-bottom: 8px;
    }

    .kpi-comparison {
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .kpi-comparison.positive {
      color: #10b981;
    }

    .kpi-comparison.negative {
      color: #ef4444;
    }

    .kpi-comparison.neutral {
      color: #94a3b8;
    }

    /* Chart Cards */
    .chart-card {
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.8) 0%, rgba(51, 65, 85, 0.6) 100%);
      backdrop-filter: blur(20px);
      padding: 28px;
      border-radius: 20px;
      box-shadow: 
        0 20px 60px rgba(0, 0, 0, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(71, 85, 105, 0.5);
      margin-bottom: 24px;
    }

    .chart-title {
      font-size: 18px;
      font-weight: 800;
      color: #e2e8f0;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding-bottom: 16px;
      border-bottom: 2px solid rgba(71, 85, 105, 0.3);
    }

    .chart-container {
      position: relative;
      height: 350px;
      margin-top: 20px;
      padding: 20px;
      background: rgba(15, 23, 42, 0.6);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      border: 1px solid rgba(71, 85, 105, 0.3);
    }

    /* Table Styles */
    .data-table {
      width: 100%;
      border-collapse: collapse;
    }

    .data-table th {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #94a3b8;
      text-align: left;
      padding: 12px 16px;
      border-bottom: 2px solid rgba(71, 85, 105, 0.4);
    }

    .data-table td {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(71, 85, 105, 0.2);
      color: #cbd5e1;
      font-size: 14px;
    }

    .data-table tr:hover {
      background: rgba(71, 85, 105, 0.2);
    }

    .rank-badge {
      display: inline-block;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
      font-weight: 700;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);
    }

    .rank-badge.gold {
      background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
      box-shadow: 0 4px 12px rgba(251, 191, 36, 0.4);
    }

    .rank-badge.silver {
      background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%);
      box-shadow: 0 4px 12px rgba(148, 163, 184, 0.4);
    }

    .rank-badge.bronze {
      background: linear-gradient(135deg, #fb923c 0%, #f97316 100%);
      box-shadow: 0 4px 12px rgba(251, 146, 60, 0.4);
    }

    /* Loading */
    .loading {
      text-align: center;
      color: #94a3b8;
      padding: 80px;
      font-size: 18px;
      font-weight: 600;
    }

    .loading::after {
      content: '';
      display: block;
      width: 60px;
      height: 60px;
      margin: 30px auto 0;
      border: 4px solid rgba(16, 185, 129, 0.2);
      border-top-color: #10b981;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Responsive */
    @media (max-width: 768px) {
      body {
        padding: 15px;
      }
      
      .header {
        flex-direction: column;
        gap: 20px;
        padding: 20px;
      }
      
      .header h1 {
        font-size: 24px;
      }
      
      .kpi-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><span class="icon">💼</span> Dashboard Ejecutivo</h1>
      <div class="header-controls">
        <a href="/dashboard/operaciones" class="tab-button">🚛 Operaciones</a>
        <a href="/dashboard/executive" class="tab-button active">💼 Ejecutivo</a>
        <a href="/dashboard/monitoring" class="tab-button">🔧 Técnico</a>
        <select id="periodSelector" class="tab-button" style="cursor: pointer;">
          <option value="all">📅 Todos los datos</option>
          <option value="today">📆 Hoy</option>
          <option value="week">📅 Esta semana</option>
          <option value="month">📅 Este mes</option>
          <option value="year">📅 Este año</option>
        </select>
        <div class="refresh-indicator" id="refreshIndicator">🔄 Auto-actualización: 30s</div>
      </div>
    </div>

    <div id="dashboard" class="loading">Cargando KPIs de negocio...</div>
  </div>

  <script>
    let refreshTimer = 30;
    let refreshInterval;
    let countdownInterval;
    let charts = {};

    // ── ETA_Dashboard_Section ─────────────────────────────────────────────────
    // Calcula los rangos de fecha según el período activo del selector
    function getPeriodDates(period) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const toDateStr = (d) => \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}\`;

      let desde = null;
      let hasta = null;

      if (period === 'today') {
        desde = toDateStr(now);
        hasta = toDateStr(now);
      } else if (period === 'week') {
        const d = new Date(now);
        d.setDate(d.getDate() - 6);
        desde = toDateStr(d);
        hasta = toDateStr(now);
      } else if (period === 'month') {
        desde = \`\${now.getFullYear()}-\${pad(now.getMonth() + 1)}-01\`;
        hasta = toDateStr(now);
      } else if (period === 'year') {
        desde = \`\${now.getFullYear()}-01-01\`;
        hasta = toDateStr(now);
      }
      // period === 'all' → sin filtro de fecha

      return { desde, hasta };
    }

    // Determina el color semáforo para pct_dentro_10min
    function getEtaSemaphoreColor(pct) {
      if (pct >= 80) return '#10b981'; // verde
      if (pct >= 60) return '#f59e0b'; // amarillo
      return '#ef4444';                // rojo
    }

    async function loadEtaStats(tenantId, period) {
      const { desde, hasta } = getPeriodDates(period);
      let url = \`/api/eta-accuracy/stats?tenant_id=\${encodeURIComponent(tenantId)}\`;
      if (desde) url += \`&desde=\${desde}\`;
      if (hasta) url += \`&hasta=\${hasta}\`;

      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) return null;
        return await res.json();
      } catch (_) {
        return null;
      }
    }

    function renderEtaSection(etaStats) {
      const noData = !etaStats || etaStats.total_registros === 0;

      const sinDatos = \`<span style="color:#64748b;font-size:28px;font-weight:700;">Sin datos aún</span>\`;

      const pctColor = noData ? '#64748b' : getEtaSemaphoreColor(etaStats.pct_dentro_10min ?? 0);
      const pctValue = noData
        ? sinDatos
        : \`<span style="color:\${pctColor};font-size:42px;font-weight:900;filter:drop-shadow(0 0 10px \${pctColor}80);">\${(etaStats.pct_dentro_10min ?? 0).toFixed(1)}%</span>\`;

      const fmtMin = (val) => noData
        ? sinDatos
        : \`<span style="font-size:42px;font-weight:900;background:linear-gradient(135deg,#60a5fa 0%,#a78bfa 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;filter:drop-shadow(0 0 10px rgba(96,165,250,0.5));letter-spacing:-1px;">\${val !== null && val !== undefined ? Number(val).toFixed(1) : '—'} min</span>\`;

      const totalLabel = noData
        ? \`<div style="font-size:12px;color:#475569;margin-top:8px;">Sin pares ETA / hora real (no usa el conteo de OTIF cerrado)</div>\`
        : \`<div style="font-size:12px;color:#64748b;margin-top:8px;">\${etaStats.total_registros.toLocaleString('es-CL')} registros</div>\`;

      return \`
        <!-- ETA_Dashboard_Section -->
        <div class="chart-card" style="margin-bottom:32px;">
          <div class="chart-title">🎯 Precisión de ETAs</div>
          <div class="kpi-grid" style="margin-bottom:0;">

            <div class="kpi-card">
              <div class="kpi-label">📏 Error ETA Promedio</div>
              <div class="kpi-value" style="font-size:inherit;">
                \${fmtMin(etaStats?.error_promedio_min)}
              </div>
              \${totalLabel}
            </div>

            <div class="kpi-card">
              <div class="kpi-label">📊 Mediana</div>
              <div class="kpi-value" style="font-size:inherit;">
                \${fmtMin(etaStats?.error_mediana_min)}
              </div>
              \${totalLabel}
            </div>

            <div class="kpi-card">
              <div class="kpi-label">📈 P90</div>
              <div class="kpi-value" style="font-size:inherit;">
                \${fmtMin(etaStats?.error_p90_min)}
              </div>
              \${totalLabel}
            </div>

            <div class="kpi-card">
              <div class="kpi-label">✅ % Entregas en ±10 min</div>
              <div class="kpi-value" style="font-size:inherit;">
                \${pctValue}
              </div>
              \${totalLabel}
            </div>

          </div>
        </div>
        <!-- /ETA_Dashboard_Section -->
      \`;
    }
    // ── /ETA_Dashboard_Section ────────────────────────────────────────────────

    async function loadDashboard() {
      const period = document.getElementById('periodSelector').value;
      
      try {
        const response = await fetch('/api/dashboard/executive?period=' + period);

        if (!response.ok) {
          throw new Error('Error al cargar datos ejecutivos');
        }

        const data = await response.json();

        // Obtener tenant_id de los datos del dashboard o usar valor por defecto
        const tenantId = data.tenantId || 'empresa_base';

        // Cargar métricas ETA en paralelo
        const etaStats = await loadEtaStats(tenantId, period);

        renderDashboard(data, etaStats);
      } catch (error) {
        document.getElementById('dashboard').innerHTML = \`
          <div class="chart-card">
            <p style="color: #ef4444; text-align: center;">❌ Error al cargar el dashboard: \${error.message}</p>
            <p style="color: #94a3b8; margin-top: 10px; font-size: 14px; text-align: center;">Por favor, verifica la conexión con la base de datos.</p>
          </div>
        \`;
      }
    }

    function renderDashboard(data, etaStats) {
      const kpis = data.kpis;
      
      // Formatear moneda chilena
      const formatCLP = (amount) => {
        return new Intl.NumberFormat('es-CL', {
          style: 'currency',
          currency: 'CLP',
          minimumFractionDigits: 0
        }).format(amount);
      };

      // Formatear porcentaje (null = no hay período anterior comparable)
      const vsLabel = kpis.comparison_caption || 'vs período anterior';
      const formatPercent = (value) => {
        if (value == null || Number.isNaN(Number(value))) return 'Sin comparación';
        const n = Number(value);
        const isPositive = n >= 0;
        return \`\${isPositive ? '↗' : '↘'} \${Math.abs(n).toFixed(1)}% \${vsLabel}\`;
      };

      const formatMoneyDelta = (actual, anterior) => {
        if (anterior == null || !kpis.comparable) return 'Sin comparación';
        return \`\${formatCLP(Number(actual) - Number(anterior))} \${vsLabel}\`;
      };

      // Determinar clase de comparación
      const getComparisonClass = (value, inverse = false) => {
        if (value == null || Number(value) === 0) return 'neutral';
        const isPositive = value > 0;
        if (inverse) return isPositive ? 'negative' : 'positive';
        return isPositive ? 'positive' : 'negative';
      };

      const dashboardHTML = \`
        \${renderEtaSection(etaStats)}

        <!-- KPIs Principales -->
        <div class="kpi-grid">
          <!-- OTIF cerrado (entregas ENTREGADO/RECHAZADO) — distinto del OTIF proyectado de la Torre -->
          <div class="kpi-card">
            <div class="kpi-label">🎯 OTIF cerrado</div>
            <div class="kpi-value">\${kpis.otif.actual.toFixed(1)}%</div>
            <div class="kpi-comparison \${getComparisonClass(kpis.otif.cambio)}">
              \${formatPercent(kpis.otif.cambio)}
            </div>
          </div>

          <!-- Entregas Exitosas -->
          <div class="kpi-card">
            <div class="kpi-label">✅ Entregas Exitosas</div>
            <div class="kpi-value">\${kpis.entregas.actual}</div>
            <div class="kpi-comparison \${getComparisonClass(kpis.entregas.crecimiento)}">
              \${formatPercent(kpis.entregas.crecimiento)}
            </div>
          </div>

          <!-- Ingresos -->
          <div class="kpi-card">
            <div class="kpi-label">💰 Ingresos del período</div>
            <div class="kpi-value" style="font-size: 32px;">\${formatCLP(kpis.ingresos.actual)}</div>
            <div class="kpi-comparison \${getComparisonClass(kpis.ingresos.crecimiento)}">
              \${formatPercent(kpis.ingresos.crecimiento)}
            </div>
          </div>

          <!-- Multas históricas (cerradas) -->
          <div class="kpi-card">
            <div class="kpi-label">⚠️ Multas históricas</div>
            <div class="kpi-value" style="font-size: 32px;">\${formatCLP(kpis.multas.actual)}</div>
            <div class="kpi-comparison \${getComparisonClass(kpis.comparable ? (kpis.multas.actual - kpis.multas.anterior) : null, true)}">
              \${formatMoneyDelta(kpis.multas.actual, kpis.multas.anterior)}
            </div>
          </div>

          <!-- Kilómetros Totales -->
          <div class="kpi-card">
            <div class="kpi-label">🚚 Kilómetros Recorridos</div>
            <div class="kpi-value">\${kpis.kilometros.totales.toFixed(0)}</div>
            <div class="kpi-comparison neutral">
              Promedio por ruta: \${kpis.kilometros.promedio.toFixed(1)} km
            </div>
          </div>
        </div>

        <!-- Tendencia Anual -->
        <div class="chart-card">
          <div class="chart-title">📈 Tendencia Anual de Entregas</div>
          <div class="chart-container">
            <canvas id="trendChart"></canvas>
          </div>
        </div>

        <!-- Top Choferes -->
        <div class="chart-card">
          <div class="chart-title">🏆 Top 10 Choferes por Desempeño</div>
          <table class="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Chofer</th>
                <th>Entregas</th>
                <th>OTIF</th>
                <th>Kilómetros</th>
                <th>Ingresos Generados</th>
              </tr>
            </thead>
            <tbody>
              \${data.topChoferes.map((chofer, index) => {
                const rankClass = index === 0 ? 'gold' : index === 1 ? 'silver' : index === 2 ? 'bronze' : '';
                return \`
                  <tr>
                    <td><div class="rank-badge \${rankClass}">\${index + 1}</div></td>
                    <td style="font-weight: 600;">\${chofer.nombre_completo}</td>
                    <td>\${chofer.entregas_exitosas} / \${chofer.total_entregas}</td>
                    <td style="color: \${chofer.otif_chofer >= 95 ? '#10b981' : chofer.otif_chofer >= 85 ? '#f59e0b' : '#ef4444'}; font-weight: 700;">\${chofer.otif_chofer || 0}%</td>
                    <td>\${chofer.km_recorridos ? parseFloat(chofer.km_recorridos).toFixed(0) : 0} km</td>
                    <td style="font-weight: 700; color: #10b981;">\${formatCLP(chofer.ingresos_generados || 0)}</td>
                  </tr>
                \`;
              }).join('')}
            </tbody>
          </table>
        </div>

        <!-- Top Clientes -->
        <div class="chart-card">
          <div class="chart-title">💼 Top 10 Clientes por Ingresos</div>
          <table class="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Cliente</th>
                <th>Entregas</th>
                <th>OTIF</th>
                <th>Ingresos</th>
                <th>Multas Potenciales</th>
              </tr>
            </thead>
            <tbody>
              \${data.topClientes.map((cliente, index) => {
                const rankClass = index === 0 ? 'gold' : index === 1 ? 'silver' : index === 2 ? 'bronze' : '';
                return \`
                  <tr>
                    <td><div class="rank-badge \${rankClass}">\${index + 1}</div></td>
                    <td style="font-weight: 600;">\${cliente.cliente}</td>
                    <td>\${cliente.entregas_exitosas} / \${cliente.total_entregas}</td>
                    <td style="color: \${cliente.otif_cliente >= 95 ? '#10b981' : cliente.otif_cliente >= 85 ? '#f59e0b' : '#ef4444'}; font-weight: 700;">\${cliente.otif_cliente}%</td>
                    <td style="font-weight: 700; color: #10b981;">\${formatCLP(cliente.ingresos || 0)}</td>
                    <td style="font-weight: 700; color: #ef4444;">\${formatCLP(cliente.multas_potenciales || 0)}</td>
                  </tr>
                \`;
              }).join('')}
            </tbody>
          </table>
        </div>

        <!-- Análisis de Pérdidas -->
        <div class="chart-card">
          <div class="chart-title">💸 Análisis de Pérdidas - Clientes con Mayor Impacto</div>
          <table class="data-table">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Total Rechazos</th>
                <th>Multas Estimadas</th>
                <th>Motivos Principales</th>
              </tr>
            </thead>
            <tbody>
              \${data.perdidas.length > 0 ? data.perdidas.map(perdida => \`
                <tr>
                  <td style="font-weight: 600;">\${perdida.cliente}</td>
                  <td style="color: #ef4444; font-weight: 700;">\${perdida.total_rechazos}</td>
                  <td style="color: #ef4444; font-weight: 700; font-size: 16px;">\${formatCLP(perdida.multas_estimadas || 0)}</td>
                  <td style="font-size: 12px; color: #94a3b8;">\${perdida.motivos_principales || 'N/A'}</td>
                </tr>
              \`).join('') : '<tr><td colspan="4" style="text-align: center; color: #10b981; padding: 40px;">✅ No hay pérdidas significativas este mes</td></tr>'}
            </tbody>
          </table>
        </div>

        <!-- Distribución Horaria -->
        <div class="chart-card">
          <div class="chart-title">🕐 Distribución Horaria de Entregas</div>
          <div class="chart-container">
            <canvas id="hourlyChart"></canvas>
          </div>
        </div>
      \`;

      document.getElementById('dashboard').innerHTML = dashboardHTML;
      document.getElementById('dashboard').classList.remove('loading');

      // Renderizar gráficos
      renderTrendChart(data.tendenciaAnual);
      renderHourlyChart(data.distribucionHoraria);
    }

    function renderTrendChart(tendenciaAnual) {
      const ctx = document.getElementById('trendChart');
      if (!ctx) return;

      // Destruir gráfico existente
      if (charts.trendChart) {
        charts.trendChart.destroy();
      }

      // Si no hay datos, mostrar mensaje
      if (!tendenciaAnual || tendenciaAnual.length === 0) {
        ctx.parentElement.innerHTML = '<div style="text-align:center;padding:60px;color:#94a3b8;font-size:15px;">Sin datos para el período seleccionado</div>';
        return;
      }

      // Extraer datos
      const labels = tendenciaAnual.map(item => item.mes_nombre || item.mes);
      const entregasExitosas = tendenciaAnual.map(item => parseInt(item.entregas_exitosas) || 0);
      const entregasRechazadas = tendenciaAnual.map(item => parseInt(item.entregas_rechazadas) || 0);

      // Usar barras solo cuando hay período específico (week/month/today), línea para año/all
      const chartType = tendenciaAnual.length <= 7 && tendenciaAnual.length > 0 && tendenciaAnual[0].mes?.includes('-') ? 'bar' : 'line';

      charts.trendChart = new Chart(ctx, {
        type: chartType,
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Entregas Exitosas',
              data: entregasExitosas,
              borderColor: '#10b981',
              backgroundColor: chartType === 'bar' ? 'rgba(16, 185, 129, 0.7)' : 'rgba(16, 185, 129, 0.15)',
              borderWidth: chartType === 'bar' ? 0 : 2,
              fill: chartType === 'line',
              tension: 0,
              pointRadius: 4,
              pointBackgroundColor: '#10b981',
              pointBorderColor: '#fff',
              pointBorderWidth: 2,
              pointHoverRadius: 7,
              borderRadius: chartType === 'bar' ? 8 : 0,
            },
            {
              label: 'Entregas Rechazadas',
              data: entregasRechazadas,
              borderColor: '#ef4444',
              backgroundColor: chartType === 'bar' ? 'rgba(239, 68, 68, 0.7)' : 'rgba(239, 68, 68, 0.15)',
              borderWidth: chartType === 'bar' ? 0 : 2,
              fill: chartType === 'line',
              tension: 0,
              pointRadius: 4,
              pointBackgroundColor: '#ef4444',
              pointBorderColor: '#fff',
              pointBorderWidth: 2,
              pointHoverRadius: 7,
              borderRadius: chartType === 'bar' ? 8 : 0,
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'top',
              labels: {
                color: '#e2e8f0',
                font: { size: 13, weight: '600' },
                padding: 15,
                usePointStyle: true
              }
            },
            tooltip: {
              backgroundColor: '#1e293b',
              titleColor: '#e2e8f0',
              bodyColor: '#cbd5e1',
              borderColor: '#475569',
              borderWidth: 1,
              padding: 12,
              displayColors: true
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                color: '#94a3b8',
                font: { size: 12 }
              },
              grid: {
                color: 'rgba(71, 85, 105, 0.3)',
                drawBorder: false
              }
            },
            x: {
              ticks: {
                color: '#94a3b8',
                font: { size: 12 }
              },
              grid: {
                color: 'rgba(71, 85, 105, 0.3)',
                drawBorder: false
              }
            }
          }
        }
      });
    }

    function renderHourlyChart(distribucionHoraria) {
      const ctx = document.getElementById('hourlyChart');
      if (!ctx) return;

      // Destruir gráfico existente
      if (charts.hourlyChart) {
        charts.hourlyChart.destroy();
      }

      // Crear array de 24 horas
      const hours = Array.from({ length: 24 }, (_, i) => i);
      const deliveries = hours.map(hour => {
        const found = distribucionHoraria.find(item => parseInt(item.hora) === hour);
        return found ? parseInt(found.entregas) : 0;
      });

      // Formatear etiquetas de hora
      const labels = hours.map(h => \`\${h.toString().padStart(2, '0')}:00\`);

      charts.hourlyChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: 'Entregas por Hora',
            data: deliveries,
            backgroundColor: deliveries.map(val => {
              // Gradiente de color según volumen
              const max = Math.max(...deliveries);
              const ratio = val / max;
              if (ratio > 0.7) return '#10b981';
              if (ratio > 0.4) return '#60a5fa';
              return '#64748b';
            }),
            borderRadius: 8,
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              backgroundColor: '#1e293b',
              titleColor: '#e2e8f0',
              bodyColor: '#cbd5e1',
              borderColor: '#475569',
              borderWidth: 1,
              padding: 12,
              callbacks: {
                label: function(context) {
                  return \`Entregas: \${context.parsed.y}\`;
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                color: '#94a3b8',
                font: { size: 12 },
                stepSize: 1
              },
              grid: {
                color: 'rgba(71, 85, 105, 0.3)',
                drawBorder: false
              }
            },
            x: {
              ticks: {
                color: '#94a3b8',
                font: { size: 11 }
              },
              grid: {
                display: false
              }
            }
          }
        }
      });
    }

    function startAutoRefresh() {
      // Limpiar intervalos existentes
      if (refreshInterval) clearInterval(refreshInterval);
      if (countdownInterval) clearInterval(countdownInterval);

      // Resetear timer
      refreshTimer = 30;

      // Refrescar dashboard cada 30 segundos
      refreshInterval = setInterval(() => {
        loadDashboard();
        refreshTimer = 30;
      }, 30000);

      // Actualizar contador cada segundo
      countdownInterval = setInterval(() => {
        refreshTimer--;
        document.getElementById('refreshIndicator').textContent = \`🔄 Auto-actualización: \${refreshTimer}s\`;
        if (refreshTimer <= 0) refreshTimer = 30;
      }, 1000);
    }

    // Inicializar
    loadDashboard();
    startAutoRefresh();
    
    // Event listener para cambio de período
    document.getElementById('periodSelector').addEventListener('change', () => {
      loadDashboard();
      refreshTimer = 30;
    });
  </script>
</body>
</html>
  `;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://lead-rescue-pipeline.marceloetcheverry990.workers.dev;",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      ...CORS_HEADERS,
    },
  });
}

export default {
  renderExecutiveDashboard,
};
