// src/monitoring/dashboard-operaciones.js
// Panel Operacional Logístico — Vista HTML para jefe de operaciones/transporte

import { verifyOperatorToken } from '../helpers/operator-auth.js';

/**
 * Render del Panel Operacional completo.
 *
 * Devuelve una página HTML autocontenida que:
 * - Muestra 5 KPI cards: OTIF%, Kg Hoy, Entregados, Atrasados, En Curso
 * - Sección dividida: Rendimiento por Ruta (izq) | Top Camionetas (der)
 * - Auto-refresca cada 60 segundos consumiendo /api/dashboard/operational
 * - Incluye navegación entre dashboards
 *
 * @param {Request} _request
 * @param {Env}     _env
 * @returns {Response}
 */
export async function renderDashboardOperaciones(request, env) {
  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth.response;

  // Construir el HTML como concatenación para evitar conflictos de template
  // literals anidados con el bundler (esbuild interpreta class="" como keyword JS
  // cuando está dentro de String.raw con interpolaciones internas).
  const css = `
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0a0f1e; --surface: rgba(30,41,59,0.85); --border: rgba(71,85,105,0.45);
      --text: #e2e8f0; --muted: #94a3b8; --green: #10b981; --yellow: #f59e0b;
      --red: #ef4444; --blue: #60a5fa; --indigo: #818cf8;
      --grad-a: linear-gradient(135deg,#ef4444 0%,#f59e0b 100%);
      --grad-b: linear-gradient(135deg,#10b981 0%,#06b6d4 100%);
      --grad-c: linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);
      --grad-surf: linear-gradient(135deg,rgba(30,41,59,0.85) 0%,rgba(51,65,85,0.6) 100%);
    }
    body { font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; padding:30px; }
    .header { display:flex; justify-content:space-between; align-items:center; padding:30px 40px; background:var(--grad-surf); border:1px solid var(--border); border-radius:20px; margin-bottom:40px; }
    .header-left h1 { font-size:36px; font-weight:900; background:linear-gradient(135deg,#10b981 0%,#06b6d4 50%,#6366f1 100%); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
    .header-left p { font-size:13px; color:var(--muted); margin-top:4px; }
    .header-right { display:flex; gap:12px; align-items:center; }
    .nav-btn { padding:10px 20px; border-radius:12px; font-size:13px; font-weight:700; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:6px; transition:all 0.3s; background:rgba(51,65,85,0.6); border:1px solid rgba(71,85,105,0.8); color:#cbd5e1; }
    .nav-btn.active { background:linear-gradient(135deg,#10b981 0%,#06b6d4 100%); border-color:#10b981; color:#fff; }
    .nav-btn:hover:not(.active) { background:rgba(71,85,105,0.6); border-color:rgba(100,116,139,0.7); transform:translateY(-2px); }
    .refresh-badge { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; }
    .pulse-dot { width:8px; height:8px; border-radius:50%; background:var(--green); animation:pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(1.4)} }
    .kpi-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:16px; margin-bottom:24px; }
    @media(max-width:1200px){.kpi-grid{grid-template-columns:repeat(3,1fr)}}
    @media(max-width:768px){.kpi-grid{grid-template-columns:repeat(2,1fr)}}
    .kpi-card { background:var(--grad-surf); border:1px solid var(--border); border-radius:18px; padding:22px 20px; position:relative; overflow:hidden; transition:transform 0.2s,border-color 0.2s; }
    .kpi-card:hover { transform:translateY(-2px); border-color:rgba(100,116,139,0.7); }
    .kpi-card::before { content:''; position:absolute; top:0; left:0; right:0; height:3px; border-radius:18px 18px 0 0; }
    .kpi-card.c-green::before  { background:var(--grad-b); }
    .kpi-card.c-orange::before { background:var(--grad-a); }
    .kpi-card.c-red::before    { background:linear-gradient(135deg,#ef4444,#dc2626); }
    .kpi-card.c-blue::before   { background:linear-gradient(135deg,#3b82f6,#6366f1); }
    .kpi-card.c-indigo::before { background:var(--grad-c); }
    .kpi-icon { font-size:26px; margin-bottom:10px; }
    .kpi-label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin-bottom:6px; }
    .kpi-value { font-size:38px; font-weight:900; line-height:1; margin-bottom:6px; }
    .kpi-card.c-green  .kpi-value { background:var(--grad-b); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
    .kpi-card.c-orange .kpi-value { background:var(--grad-a); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
    .kpi-card.c-red    .kpi-value { color:var(--red); }
    .kpi-card.c-blue   .kpi-value { color:var(--blue); }
    .kpi-card.c-indigo .kpi-value { color:var(--indigo); }
    .kpi-unit { font-size:15px; font-weight:600; }
    .kpi-sub  { font-size:12px; color:var(--muted); margin-top:4px; }
    .body-grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
    @media(max-width:1100px){.body-grid{grid-template-columns:1fr}}
    .card { background:var(--grad-surf); border:1px solid var(--border); border-radius:18px; padding:24px; }
    .card-title { font-size:16px; font-weight:800; color:var(--text); margin-bottom:18px; padding-bottom:14px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:8px; }
    .route-table,.truck-table { width:100%; border-collapse:collapse; font-size:13px; }
    .route-table th,.truck-table th { text-align:left; color:var(--muted); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; padding:0 8px 10px; }
    .route-table th:not(:first-child),.truck-table th:not(:first-child) { text-align:right; }
    .route-table td,.truck-table td { padding:10px 8px; border-top:1px solid rgba(71,85,105,0.2); vertical-align:middle; }
    .route-table td:not(:first-child),.truck-table td:not(:first-child) { text-align:right; }
    .route-table tr:hover td,.truck-table tr:hover td { background:rgba(255,255,255,0.03); }
    .zona-name { font-weight:700; color:var(--text); }
    .zona-sub  { font-size:11px; color:var(--muted); margin-top:1px; }
    .otif-cell { display:flex; align-items:center; gap:8px; justify-content:flex-end; }
    .otif-bar-wrap { width:52px; height:6px; background:rgba(71,85,105,0.35); border-radius:3px; overflow:hidden; }
    .otif-bar-fill { height:100%; border-radius:3px; transition:width .4s; }
    .otif-value { font-weight:700; font-size:13px; min-width:44px; text-align:right; }
    .rank-badge { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:6px; font-size:11px; font-weight:800; margin-right:6px; }
    .r1{background:rgba(251,191,36,.2);color:#fbbf24}
    .r2{background:rgba(148,163,184,.15);color:#94a3b8}
    .r3{background:rgba(180,120,60,.2);color:#cd7c2f}
    .rn{background:rgba(71,85,105,.3);color:var(--muted)}
    .kg-hoy   { font-weight:800; color:var(--text); }
    .kg-semana { color:var(--blue); }
    .kg-mes    { color:var(--muted); }
    .top-truck td { background:rgba(16,185,129,.05); }
    .top-truck .kg-hoy { color:var(--green); }
    .empty-state { text-align:center; color:var(--muted); padding:40px 20px; font-size:14px; }
    .empty-state .icon { font-size:32px; margin-bottom:10px; }
    .footer { text-align:center; color:#475569; font-size:12px; margin-top:24px; padding:12px; background:rgba(255,255,255,0.02); border-radius:10px; }
    .footer span { color:var(--muted); }
    .skeleton { background:linear-gradient(90deg,rgba(71,85,105,.3) 25%,rgba(100,116,139,.2) 50%,rgba(71,85,105,.3) 75%); background-size:200% 100%; animation:shimmer 1.5s infinite; border-radius:6px; height:1em; }
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  `;

  const js = `
    function fmt(n, dec) {
      if (n === null || n === undefined) return '<span style="color:#64748b">S/D</span>';
      return Number(n).toLocaleString('es-CL', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
    }
    function fmtKg(n) {
      if (n === null || n === undefined) return '<span style="color:#64748b">-</span>';
      var v = Number(n);
      if (v >= 1000) return (v / 1000).toLocaleString('es-CL', { minimumFractionDigits:1, maximumFractionDigits:1 }) + ' t';
      return v.toLocaleString('es-CL') + ' kg';
    }
    function otifColor(pct) {
      if (pct === null) return '#64748b';
      if (pct >= 97) return '#10b981';
      if (pct >= 92) return '#f59e0b';
      return '#ef4444';
    }
    function otifBg(pct) {
      if (pct === null) return 'rgba(100,116,139,.35)';
      if (pct >= 97) return 'linear-gradient(90deg,#10b981,#06b6d4)';
      if (pct >= 92) return 'linear-gradient(90deg,#f59e0b,#ef4444)';
      return 'linear-gradient(90deg,#ef4444,#dc2626)';
    }

    function renderKpis(kpis) {
      var otifVal, otifSub;
      if (kpis.otif_pct !== null && kpis.otif_pct !== undefined) {
        otifVal = fmt(kpis.otif_pct, 1) + '<span class="kpi-unit">%</span>';
        otifSub = kpis.otif_pct >= 97 ? '\u2705 Excelente' : kpis.otif_pct >= 92 ? '\u26A0\uFE0F Revisar' : '\uD83D\uDD34 Cr\u00EDtico';
      } else {
        otifVal = '<span style="color:#64748b;font-size:28px">S/D</span>';
        otifSub = 'Sin entregas cerradas a\u00FAn';
      }
      document.getElementById('kpiGrid').innerHTML =
        '<div class="kpi-card c-green">' +
          '<div class="kpi-icon">\uD83D\uDCE6</div>' +
          '<div class="kpi-label">OTIF Hoy</div>' +
          '<div class="kpi-value">' + otifVal + '</div>' +
          '<div class="kpi-sub">' + otifSub + '</div>' +
        '</div>' +
        '<div class="kpi-card c-orange">' +
          '<div class="kpi-icon">\u2696\uFE0F</div>' +
          '<div class="kpi-label">Kg Transportados Hoy</div>' +
          '<div class="kpi-value">' + fmt(kpis.kg_totales) + '<span class="kpi-unit"> kg</span></div>' +
          '<div class="kpi-sub">Carga del d\u00EDa</div>' +
        '</div>' +
        '<div class="kpi-card c-blue">' +
          '<div class="kpi-icon">\u2705</div>' +
          '<div class="kpi-label">Pedidos Entregados</div>' +
          '<div class="kpi-value">' + fmt(kpis.pedidos_entregados) + '</div>' +
          '<div class="kpi-sub">Completados hoy</div>' +
        '</div>' +
        '<div class="kpi-card c-red">' +
          '<div class="kpi-icon">\uD83D\uDEA8</div>' +
          '<div class="kpi-label">Atrasados (Tiempo Real)</div>' +
          '<div class="kpi-value">' + fmt(kpis.pedidos_atrasados) + '</div>' +
          '<div class="kpi-sub">Entregados tarde + SLA vencido</div>' +
        '</div>' +
        '<div class="kpi-card c-indigo">' +
          '<div class="kpi-icon">\uD83D\uDE9B</div>' +
          '<div class="kpi-label">En Curso Ahora</div>' +
          '<div class="kpi-value">' + fmt(kpis.pedidos_en_curso) + '</div>' +
          '<div class="kpi-sub">Despachos activos</div>' +
        '</div>';
    }

    function renderRutas(rutas) {
      if (!rutas || rutas.length === 0) {
        document.getElementById('rutasContainer').innerHTML =
          '<div class="empty-state"><div class="icon">\uD83D\uDCCD</div><p>Sin datos de ruta para hoy</p></div>';
        return;
      }
      var rows = '';
      for (var i = 0; i < rutas.length; i++) {
        var r = rutas[i];
        var pct = r.otif_pct;
        var color = otifColor(pct);
        var bg = otifBg(pct);
        var barWidth = pct !== null ? Math.min(Math.round(pct), 100) : 0;
        var pctStr = pct !== null ? fmt(pct, 1) + '%' : 'S/D';
        rows +=
          '<tr>' +
            '<td><div class="zona-name">' + r.zona + '</div><div class="zona-sub">' + fmt(r.total_pedidos) + ' pedidos</div></td>' +
            '<td>' + fmtKg(r.kg_totales) + '</td>' +
            '<td><div class="otif-cell"><div class="otif-bar-wrap"><div class="otif-bar-fill" style="width:' + barWidth + '%;background:' + bg + '"></div></div><span class="otif-value" style="color:' + color + '">' + pctStr + '</span></div></td>' +
          '</tr>';
      }
      document.getElementById('rutasContainer').innerHTML =
        '<table class="route-table">' +
          '<thead><tr><th>Ruta / Zona</th><th>Kg Totales</th><th>OTIF%</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>';
    }

    function renderCamionetas(camionetas) {
      if (!camionetas || camionetas.length === 0) {
        document.getElementById('camionetasContainer').innerHTML =
          '<div class="empty-state"><div class="icon">\uD83D\uDE9B</div><p>Sin datos de camionetas para este mes</p></div>';
        return;
      }
      var rows = '';
      for (var i = 0; i < camionetas.length; i++) {
        var c = camionetas[i];
        var rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : 'rn';
        var topClass  = i === 0 ? 'top-truck' : '';
        rows +=
          '<tr class="' + topClass + '">' +
            '<td><span class="rank-badge ' + rankClass + '">' + (i+1) + '</span><strong>' + (c.camioneta || c.camioneta_id || '-') + '</strong></td>' +
            '<td><span class="kg-hoy">' + fmtKg(c.kg_hoy) + '</span></td>' +
            '<td><span class="kg-semana">' + fmtKg(c.kg_semana) + '</span></td>' +
            '<td><span class="kg-mes">' + fmtKg(c.kg_mes) + '</span></td>' +
          '</tr>';
      }
      document.getElementById('camionetasContainer').innerHTML =
        '<table class="truck-table">' +
          '<thead><tr><th>Camioneta</th><th>Hoy</th><th>Semana</th><th>Mes</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>';
    }

    var countdownInterval = null;
    function iniciarCountdown() {
      if (countdownInterval) clearInterval(countdownInterval);
      var secs = 60;
      countdownInterval = setInterval(function() {
        secs--;
        var el = document.getElementById('countdown');
        if (el) el.textContent = secs;
        if (secs <= 0) clearInterval(countdownInterval);
      }, 1000);
    }

    async function cargarDatos() {
      try {
        var res = await fetch('/api/dashboard/operational', { credentials: 'same-origin' });
        if (res.status === 401) {
          document.getElementById('kpiGrid').innerHTML =
            '<div style="grid-column:1/-1;text-align:center;color:#ef4444;padding:40px">\uD83D\uDD12 Autenticaci\u00F3n requerida</div>';
          return;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        renderKpis(data.kpis || {});
        renderRutas(data.por_ruta || []);
        renderCamionetas(data.por_camioneta || []);
        var now = new Date(data.timestamp || Date.now());
        var horaStr = now.toLocaleTimeString('es-CL', { timeZone:'America/Santiago', hour:'2-digit', minute:'2-digit', second:'2-digit' });
        document.getElementById('lastUpdate').textContent = 'Actualizado ' + horaStr;
        var fechaStr = now.toLocaleDateString('es-CL', { timeZone:'America/Santiago', weekday:'long', year:'numeric', month:'long', day:'numeric' });
        document.getElementById('footer').innerHTML =
          'Datos al ' + fechaStr + ' &nbsp;&middot;&nbsp; <span>Pr\u00F3xima actualizaci\u00F3n en <span id="countdown">60</span>s</span>';
        iniciarCountdown();
      } catch(err) {
        console.error('[PANEL_OPERACIONAL]', err.message);
        document.getElementById('lastUpdate').textContent = '\u26A0\uFE0F Error al cargar';
      }
    }

    cargarDatos();
    setInterval(cargarDatos, 60000);
  `;

  const skeletonCards =
    '<div class="kpi-card c-green"><div class="skeleton" style="height:80px"></div></div>' +
    '<div class="kpi-card c-orange"><div class="skeleton" style="height:80px"></div></div>' +
    '<div class="kpi-card c-blue"><div class="skeleton" style="height:80px"></div></div>' +
    '<div class="kpi-card c-red"><div class="skeleton" style="height:80px"></div></div>' +
    '<div class="kpi-card c-indigo"><div class="skeleton" style="height:80px"></div></div>';

  const html =
    '<!DOCTYPE html>' +
    '<html lang="es">' +
    '<head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>Panel Operacional \u2014 OTIF Sentinel</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">' +
    '<style>' + css + '</style>' +
    '</head>' +
    '<body>' +
    '<header class="header">' +
      '<div class="header-left">' +
        '<h1>\uD83D\uDE9B Panel Operacional Log\u00EDstico</h1>' +
        '<p>OTIF Sentinel \u2014 M\u00E9tricas de transporte en tiempo real</p>' +
      '</div>' +
      '<div class="header-right">' +
        '<div class="refresh-badge">' +
          '<div class="pulse-dot"></div>' +
          '<span id="lastUpdate">Cargando...</span>' +
        '</div>' +
        '<a href="/dashboard/operaciones" class="nav-btn active">\uD83D\uDE9B Operaciones</a>' +
        '<a href="/dashboard/executive"   class="nav-btn">\uD83D\uDCBC Ejecutivo</a>' +
        '<a href="/dashboard/monitoring"  class="nav-btn">\uD83D\uDD27 T\u00E9cnico</a>' +
      '</div>' +
    '</header>' +
    '<section class="kpi-grid" id="kpiGrid">' + skeletonCards + '</section>' +
    '<div class="body-grid">' +
      '<div class="card">' +
        '<div class="card-title">\uD83D\uDCCD Rendimiento por Ruta \u2014 Hoy</div>' +
        '<div id="rutasContainer"><div class="empty-state"><div class="skeleton" style="height:160px"></div></div></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-title">\uD83C\uDFC6 Top Camionetas por Carga</div>' +
        '<div id="camionetasContainer"><div class="empty-state"><div class="skeleton" style="height:160px"></div></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="footer" id="footer">Actualizaci\u00F3n autom\u00E1tica cada 60 segundos &nbsp;&middot;&nbsp; <span>Zona horaria: America/Santiago</span></div>' +
    '<script>' + js + '<\/script>' +
    '</body>' +
    '</html>';

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
