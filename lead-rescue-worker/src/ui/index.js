// src/ui/index.js
// Punto de entrada de la Torre de Control. Orquesta los módulos y ensambla el HTML.
// Mantiene la misma firma de función que el monolito original src/ui.js.

import { APP_CONFIG } from './server/appConfig.js';
import {
  money as _money,
  safeParseJSON,
  buildSafeHelpers,
  calcularRiesgosSla,
  sortViajesSeguros,
  formatearParadas,
  buildJsonBlobs,
} from './server/calculosViaje.js';

import { DASHBOARD_STYLES } from './templates/styles.js';
import { renderLayout } from './templates/layout.js';
import { renderAiWidget } from './templates/aiWidget.js';
import { MODAL_RUTA_RAPIDA } from './templates/modalRutaRapida.js';
import { MODAL_EDITAR_DIRECCION } from './templates/modalEditarDireccion.js';
import { MODAL_RECALCULAR_RUTEO } from './templates/modalRecalcularRuteo.js';

import { TELEMETRY_CHAT_SCRIPT } from './client/telemetriaYChat.js';
import { MAPA_FLOTA_SCRIPT } from './client/mapaYFlota.js';
import { POLLING_EVENTOS_SCRIPT } from './client/pollingYEventos.js';
import { RUTA_RAPIDA_SCRIPT } from './client/rutaRapida.js';

export function renderControlTowerDashboard(
  ordenes,
  perfiles,
  moneyFormatterUser,
  escapeHTMLParam,
  lastSyncDate,
  viajesActivos = [],
  listaChoferes = [],
  tenantId = null,
  operatorSession = null,
  depotOpts = null,
) {
  // --- Datos defensivos ---
  const viajesSeguros  = viajesActivos || [];
  const ordenesSeguras = ordenes || [];
  const perfilesSeguros = perfiles || [];
  const depotsSeguros = (depotOpts && depotOpts.depots) || [];
  const bodegaOverride = depotOpts && depotOpts.bodega;

  // --- Funciones de sanitización (con override de backticks) ---
  const { escapeHTML, safeVal } = buildSafeHelpers(escapeHTMLParam);

  // --- Función de dinero con formatter inyectado ---
  const money = (val) => _money(val, moneyFormatterUser);

  // --- Órdenes pendientes (sin viaje asignado) ---
  const ordenesPendientes = ordenesSeguras.filter(o =>
    (!o.trip_id || o.trip_id === '') &&
    (
      o.estado_operacional === APP_CONFIG.ESTADOS.PENDIENTE ||
      o.estado_operacional === 'PENDIENTE_RUTEO' ||
      o.estado_operacional === 'PENDIENTE_CARGA'
    )
  ).sort((a, b) => String(a.ot_id || '').localeCompare(String(b.ot_id || ''), 'es', { numeric: true }));

  // --- Cálculos financieros y SLA ---
  const { riesgosSla, totalDineroEnCalle, totalDineroRiesgo, totalParadasAbiertas } =
    calcularRiesgosSla(viajesSeguros);

  const totalParadas = totalParadasAbiertas || 0;
  const otifProyectado = totalParadas > 0
    ? Math.max(0, Math.round(((totalParadas - riesgosSla.length) / totalParadas) * 100))
    : 100;

  // --- Ordenamiento y formateo de paradas ---
  sortViajesSeguros(viajesSeguros);
  formatearParadas(viajesSeguros);

  // --- JSON blobs para los script tags ---
  const runtimeConfig = {
    ...APP_CONFIG,
    BODEGA: bodegaOverride || APP_CONFIG.BODEGA,
    tenant_id: tenantId,
    operator: operatorSession || null,
    depots: depotsSeguros,
    dte_live: !!(depotOpts && depotOpts.dte_live),
  };
  const { safeOrdenesJson, safeViajesJson, safeConfigJson, rawChoferesJson } =
    buildJsonBlobs(ordenesSeguras, viajesSeguros, runtimeConfig, listaChoferes, lastSyncDate);

  // --- Widget de IA (condicional) ---
  const aiWidgetHtml = renderAiWidget(riesgosSla, escapeHTML);

  // --- HTML del body dinámico ---
  const bodyHtml = renderLayout({
    money,
    escapeHTML,
    safeParseJSON,
    viajesSeguros,
    ordenesPendientes,
    perfilesSeguros,
    depotsSeguros,
    listaChoferes,
    totalDineroEnCalle,
    totalDineroRiesgo,
    otifProyectado,
    safeOrdenesJson,
    safeViajesJson,
    safeConfigJson,
    rawChoferesJson,
    aiWidgetHtml,
    operatorSession,
  });

  // --- Ensamblar el HTML completo ---
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Torre de Control - OTIF Sentinel</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
      <noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"></noscript>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <style>${DASHBOARD_STYLES.replace(/\r\n/g, '\n')}
      </style>
    </head>
${bodyHtml}
        <div id="chatOffcanvas" class="chat-panel">
        <div class="chat-header">
          <div>
            <h3 style="font-size: 1rem; margin: 0;">💬 Chat Operacional</h3>
            <span id="chatTripTitle" style="font-size: 0.75rem; color: #cbd5e1;">Selecciona un viaje</span>
          </div>
          <button class="chat-close" onclick="cerrarChat()">&times;</button>
        </div>
        <div id="chatMessages" class="chat-messages">
          <div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; margin-top: 2rem;">
            Abre el chat de un viaje para ver el historial.
          </div>
        </div>
        <div class="chat-input-area">
          <input type="hidden" id="chatCurrentTrip">
          <input type="hidden" id="chatCurrentRut">
          <input type="text" id="chatInput" class="chat-input" placeholder="Escribe a la ruta...">
          <button id="btnSendChat" class="btn-send">Enviar</button>
        </div>
      </div>  

      <script>
        (function () {
          var logoutBtn = document.getElementById('operatorLogout');
          if (logoutBtn) {
            logoutBtn.addEventListener('click', async function () {
              await fetch('/api/operator/logout', {
                method: 'POST',
                credentials: 'same-origin'
              }).catch(function () {});
              window.location.href = '/login';
            });
          }
        })();
        ${TELEMETRY_CHAT_SCRIPT.replace(/\r\n/g, '\n')}
        ${MAPA_FLOTA_SCRIPT.replace(/\r\n/g, '\n')}
        ${POLLING_EVENTOS_SCRIPT.replace(/\r\n/g, '\n')}
        ${RUTA_RAPIDA_SCRIPT.replace(/\r\n/g, '\n')}
      </script>

      ${MODAL_RUTA_RAPIDA.trim()}

      ${MODAL_EDITAR_DIRECCION.trim()}

      ${MODAL_RECALCULAR_RUTEO.trim()}

    </body>
    </html>
  `;
}
