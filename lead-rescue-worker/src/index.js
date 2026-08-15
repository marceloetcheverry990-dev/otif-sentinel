/**
 * OTIF SENTINEL - SUPPLY CHAIN CONTINGENCY ENGINE
 * V8.0.0 - APEX RELEASE (Modular Architecture)
 * * Archivo Principal (Orquestador / Router)
 * Su Ãºnica funciÃ³n es recibir peticiones web y mandarlas al archivo correcto.
 */

// ============================================================================
// ðŸ“¦ 1. IMPORTACIONES DE CONFIGURACIÃ“N Y TAREAS EN SEGUNDO PLANO (CORE)
// ============================================================================
import { handleGPSPing, getLiveFleet } from './api/gps.js';
import { CONFIG, CORS_HEADERS, getCorsHeaders, isCorsOriginAllowed, requireTenantId, withCorsContext } from './config.js';
import { processIngestionQueue, processEnrichmentQueue, processDeliveryQueue } from './queues.js';
import { runOutboxRecovery, alertarRiesgosCriticos, auditarFlotaEnVivo } from './jobs.js';
import { processCustomerNotificationOutbox } from './helpers/customer-notify.js';
import { reorderTripStops, moveTripStop } from './api/trip-manual.js';
import { checkChoferRut } from './api/app-chofer-check.js';
import { activateChofer } from './api/app-chofer-activate.js';

// ============================================================================
// ðŸŒ 2. IMPORTACIONES DE RUTAS Y CONTROLADORES (API)
// ============================================================================
import { handleWMSWebhook } from './api/wms.js';
import { handleOrderIngestWebhook } from './api/order-ingest-webhook.js';
import {
  handleShopifyOrderWebhook,
  handleWooCommerceOrderWebhook,
  handleSapOrderWebhook,
  handleNetSuiteOrderWebhook,
  handlePosOrderWebhook,
} from './api/platform-ingest-webhook.js';
import { optimizarRutas } from './api/optimizer.js';
import { reoptimizarMidday } from './api/reoptimizar-midday.js';
import { syncExcel } from './api/sync.js';
import { renderReporte, renderControlTower, getControlTowerViajesAPI } from './api/dashboard.js';
import {
  getRescueCandidates,
  confirmRescue,
  dismissFleetAlert,
} from './api/lead-rescue.js';

// ============================================================================
// ðŸ” MONITORING SYSTEM IMPORTS (Stability & Observability)
// ============================================================================
import { handleHealthCheck } from './monitoring/health.js';
import { initializeMonitoring, withMonitoring } from './monitoring/index.js';
import { evaluateAlerts } from './monitoring/alerts.js';
import { getDashboardData, renderDashboard } from './monitoring/dashboard.js';
import { getExecutiveDashboardData } from './api/dashboard-executive.js';
import { renderExecutiveDashboard } from './monitoring/dashboard-executive.js';
import { enforceRetentionPolicies } from './monitoring/retention.js';
import { handleMonitoringHealth } from './monitoring/meta-health.js';

// Limpieza de Staff Dev: Se removiÃ³ 'asignarChofer' de aquÃ­ para evitar colisiones.
import { recalcularScoring } from './api/choferes.js'; 
import { updateGPSInterval } from './api/admin-gps-config.js';
import {
  adminQaDriverToken,
  adminQaSeedFleetGps,
  adminFlushNotifications,
  adminQaOtScanToken,
  adminQaSchemaStatus,
  adminQaApplySchema,
  adminQaDteSettings,
  adminQaCleanup,
} from './api/admin-qa.js';

// ---> NUEVAS IMPORTACIONES: APP MÃ“VIL Y TORRE DE CONTROL <---
import { handleMobileSync } from './api/mobile-sync.js';
import { getChoferRutas } from './api/app-chofer-rutas.js';
import { handleChat } from './api/chat.js';
import { handleUploadEvidence } from './api/upload-evidence.js';
import { loginChofer } from './api/app-chofer-login.js';
import { logoutChofer } from './api/app-chofer-logout.js';
import { syncChoferEvent } from './api/app-chofer-sync.js';
import { handleAsignarChofer } from './api/asignar-chofer.js'; // Controlador definitivo
import { handleChoferEvento } from './api/app-chofer-evento.js'; // MÃ¡quina de estados operativos
import { generatePublicRouteLink, getPublicRoute, getPublicRouteData } from './api/public-route.js'; // Portal pÃºblico
import { createQuickRoute, updateQuickRouteStop, exportQuickRoutesCSV, updateQuickRouteAddress, cancelQuickRoute } from './api/quick-route.js'; // Ruta RÃ¡pida / EspontÃ¡nea
import { handleGeocodeSuggest, handleGeocodeResolve } from './api/geocode.js'; // Geocoding con NÂ° de casa
import { handleEtaAccuracyStats } from './api/eta-accuracy.js'; // ETA Accuracy Metrics
import { getOperationalDashboardData } from './api/dashboard-operational.js'; // Panel Operacional
import { renderDashboardOperaciones } from './monitoring/dashboard-operaciones.js'; // Panel Operacional HTML
import { handleOperatorLogin, handleOperatorLogout } from './api/operator-login.js'; // AutenticaciÃ³n Torre de Control
import { handleOperatorMe, handleListOperators, handleCreateOperator } from './api/operators.js';
import { handleLoginPage } from './api/login-page.js'; // PÃ¡gina HTML de login
import { handleListDepots, handleCreateDepot } from './api/depots.js';
import { listGuiasDespacho, retryGuiasDespacho } from './api/guias-despacho.js';
import {
  verifyOperatorTenant,
  verifyOperatorToken,
  verifySameOrigin,
} from './helpers/operator-auth.js';
import { writeAuditLog, operatorAuditContext } from './helpers/audit-log.js';

// Regla #3: Cabeceras CORS estrictas y centralizadas â€” importadas desde config.js
// CORS_HEADERS es la Ãºnica fuente de verdad. No definir corsHeaders localmente en ningÃºn mÃ³dulo.

async function requireOperatorAccess(request, env, { mutation = false } = {}) {
  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth;

  if (mutation) {
    const origin = verifySameOrigin(request);
    if (!origin.ok) return origin;
  }

  const tenant = await verifyOperatorTenant(request, auth.payload.tenant_id);
  if (!tenant.ok) return tenant;

  return auth;
}

/**
 * Ejecuta una mutaciÃ³n de operador y deja rastro en audit_log.
 */
async function runOperatorMutation(request, env, ctx, action, handler) {
  const path = new URL(request.url).pathname;
  const started = Date.now();
  const access = await requireOperatorAccess(request, env, { mutation: true });
  if (!access.ok) {
    if (ctx && typeof ctx.waitUntil === 'function') {
      let errBody = {};
      try { errBody = await access.response.clone().json(); } catch (_) { /* ignore */ }
      ctx.waitUntil(writeAuditLog(env, {
        tenant_id: env.MONITORING_TENANT_ID || 'unknown',
        action,
        outcome: 'failure',
        meta: {
          status: access.response.status,
          path,
          code: errBody.code || null,
          error: errBody.error || 'access_denied',
          ms: Date.now() - started,
        },
        ip: request.headers.get('CF-Connecting-IP') || null,
      }));
    }
    return access.response;
  }

  try {
    const response = await handler(request, env, access.payload, ctx);
    const status = response?.status ?? 500;
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(writeAuditLog(env, {
        ...operatorAuditContext(access.payload, request),
        action,
        outcome: status < 400 ? 'success' : 'failure',
        meta: { status, path, ms: Date.now() - started },
      }));
    }
    return response;
  } catch (err) {
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(writeAuditLog(env, {
        ...operatorAuditContext(access.payload, request),
        action,
        outcome: 'error',
        meta: { path, error: err.message, ms: Date.now() - started },
      }));
    }
    throw err;
  }
}

// ============================================================================
// ðŸš¦ 3. ENRUTADOR PRINCIPAL (EL SEMÃFORO DE LA APP)
// ============================================================================
export default {
  async fetch(request, env, ctx) {
    return withCorsContext(request, env, async () => {
    const url = new URL(request.url);

    // --- ESCUDO GLOBAL CORS (PREFLIGHT) ---
    if (request.method === "OPTIONS") {
      if (!isCorsOriginAllowed(request, env)) {
        return new Response(null, { status: 403, headers: { Vary: "Origin" } });
      }
      return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
    }

    // =========================================================================
    // ðŸ” MONITORING ENDPOINTS (Health Check & Dashboard)
    // =========================================================================
    // Health check endpoint - public, no authentication required
    // Used by load balancers and external monitoring tools
    if (request.method === "GET" && url.pathname === "/health") {
      return withMonitoring(handleHealthCheck, { component: 'health-check' })(request, env, ctx);
    }

    // Monitoring subsystem meta-health â€” informational, always HTTP 200
    if (request.method === "GET" && url.pathname === "/health/monitoring") {
      return handleMonitoringHealth(request, env);
    }
    
    // Monitoring dashboard - requires authentication
    // Task 7.4 - Dashboard HTML interface
    if (request.method === "GET" && url.pathname === "/dashboard/monitoring") {
      return renderDashboard(request, env);
    }
    
    // Monitoring dashboard data API - requires authentication
    // Task 7.4 - JSON API for dashboard data
    if (request.method === "GET" && url.pathname === "/api/dashboard/data") {
      return getDashboardData(request, env);
    }
    
    // Executive dashboard HTML - Business Intelligence
    if (request.method === "GET" && url.pathname === "/dashboard/executive") {
      return renderExecutiveDashboard(request, env);
    }
    
    // Executive dashboard data API - Business KPIs
    if (request.method === "GET" && url.pathname === "/api/dashboard/executive") {
      return getExecutiveDashboardData(request, env);
    }

    // Operational dashboard HTML - Logistics Operations Panel
    if (request.method === "GET" && url.pathname === "/dashboard/operaciones") {
      return renderDashboardOperaciones(request, env);
    }

    // Operational dashboard data API - Logistics KPIs (kg, OTIF, rutas, camionetas)
    if (request.method === "GET" && url.pathname === "/api/dashboard/operational") {
      return getOperationalDashboardData(request, env);
    }

    // â”€â”€ Login de operador Torre de Control â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (request.method === "GET" && url.pathname === "/login") {
      return handleLoginPage(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/operator/login") {
      return handleOperatorLogin(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/operator/logout") {
      return handleOperatorLogout(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/operators/me") {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return handleOperatorMe(request, env, access.payload);
    }
    if (request.method === "GET" && url.pathname === "/api/operators") {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return handleListOperators(request, env, access.payload);
    }
    if (request.method === "POST" && url.pathname === "/api/operators") {
      const access = await requireOperatorAccess(request, env, { mutation: true });
      if (!access.ok) return access.response;
      return handleCreateOperator(request, env, access.payload);
    }
    if (request.method === "GET" && url.pathname === "/api/depots") {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return handleListDepots(request, env, access.payload);
    }
    if (request.method === "GET" && url.pathname === "/api/guias-despacho") {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return listGuiasDespacho(request, env, access.payload);
    }
    if (request.method === "POST" && url.pathname === "/api/guias-despacho/retry") {
      const access = await requireOperatorAccess(request, env, { mutation: true });
      if (!access.ok) return access.response;
      return retryGuiasDespacho(request, env, access.payload);
    }
    if (request.method === "POST" && url.pathname === "/api/depots") {
      return runOperatorMutation(request, env, ctx, 'depots.create', (req, e, op) =>
        handleCreateDepot(req, e, op)
      );
    }

    // ---> NUEVAS RUTAS: APP MÃ“VIL (B2B) <---
    if (request.method === "POST" && url.pathname === "/api/choferes/login") return loginChofer(request, env, ctx);
    if (request.method === "POST" && url.pathname === "/api/choferes/logout") return logoutChofer(request, env);
    if (request.method === "POST" && url.pathname === "/api/app-chofer-sync") return syncChoferEvent(request, env, ctx);
    if (request.method === "POST" && url.pathname === "/api/chofer/evento") return handleChoferEvento(request, env, ctx);
    if (request.method === "GET"  && url.pathname === '/api/app-chofer-rutas') return await getChoferRutas(request, env);
    if (request.method === "POST" && url.pathname === "/api/choferes/check-rut") return checkChoferRut(request, env, ctx);
    if (request.method === "POST" && url.pathname === "/api/choferes/activate") return activateChofer(request, env, ctx);
    if (url.pathname.startsWith('/api/chat')) return handleChat(request, env);
    if (request.method === "POST" && url.pathname === "/api/upload-evidence") return handleUploadEvidence(request, env);
    if (url.pathname === '/api/mobile-sync' && request.method === 'POST') { return handleMobileSync(request, env);}
    
    // ---> RUTAS PÃšBLICAS: PORTAL DE TRACKING COMPARTIBLE <---
    if (request.method === "POST" && url.pathname === "/api/public-route/generate") {
      return runOperatorMutation(request, env, ctx, 'public_route.generate', (req, e, op) =>
        generatePublicRouteLink(req, e, op)
      );
    }
    if (request.method === "GET" && url.pathname.startsWith("/public-route/")) {
      const token = url.pathname.split("/public-route/")[1]?.split("/")[0];
      if (token && url.pathname.endsWith("/data")) return getPublicRouteData(request, env, token);
      if (token) return getPublicRoute(request, env, token, ctx);
    }
    // Alias con prefijo /api (el HTML público hace polling a /api/public-route/:token/data)
    if (request.method === "GET" && url.pathname.startsWith("/api/public-route/")) {
      const rest = url.pathname.split("/api/public-route/")[1] || "";
      const token = rest.split("/")[0];
      if (token && rest.endsWith("/data")) return getPublicRouteData(request, env, token);
    }
    
    // --- RUTAS GPS (Live Tracking) ---
    if (request.method === "POST" && url.pathname === "/api/admin/config-gps") {
      return runOperatorMutation(request, env, ctx, 'gps.config', (req, e, op) =>
        updateGPSInterval(req, e, op)
      );
    }
    if (request.method === "POST" && url.pathname === "/api/admin/qa/driver-token") {
      return runOperatorMutation(request, env, ctx, 'qa.driver_token', (req, e, op) =>
        adminQaDriverToken(req, e, op)
      );
    }
    if (request.method === "POST" && url.pathname === "/api/admin/qa/seed-fleet-gps") {
      return runOperatorMutation(request, env, ctx, 'qa.seed_gps', (req, e, op) =>
        adminQaSeedFleetGps(req, e, op)
      );
    }
    if (request.method === "POST" && url.pathname === "/api/admin/notifications/flush") {
      return runOperatorMutation(request, env, ctx, 'notifications.flush', (req, e, op) =>
        adminFlushNotifications(req, e, op)
      );
    }
    if (request.method === "POST" && url.pathname === "/api/admin/qa/ot-scan-token") {
      return runOperatorMutation(request, env, ctx, 'qa.ot_scan_token', (req, e, op) =>
        adminQaOtScanToken(req, e, op)
      );
    }
    if (request.method === "POST" && url.pathname === "/api/admin/qa/schema-status") {
      return runOperatorMutation(request, env, ctx, 'qa.schema_status', (req, e, op) =>
        adminQaSchemaStatus(req, e, op)
      );
    }
    if (request.method === "POST" && url.pathname === "/api/admin/qa/apply-schema") {
      return runOperatorMutation(request, env, ctx, 'qa.apply_schema', (req, e, op) =>
        adminQaApplySchema(req, e, op)
      );
    }
    if (url.pathname === "/api/admin/qa/dte-settings" && (request.method === "GET" || request.method === "POST")) {
      if (request.method === "GET") {
        const access = await requireOperatorAccess(request, env);
        if (!access.ok) return access.response;
        return adminQaDteSettings(request, env, access.payload);
      }
      return runOperatorMutation(request, env, ctx, 'qa.dte_settings', (req, e, op) =>
        adminQaDteSettings(req, e, op)
      );
    }
    if (request.method === "POST" && url.pathname === "/api/admin/qa/cleanup") {
      return runOperatorMutation(request, env, ctx, 'qa.cleanup', (req, e, op) =>
        adminQaCleanup(req, e, op)
      );
    }
    if (request.method === 'POST' && url.pathname === '/api/gps/ping') return handleGPSPing(request, env, ctx);
    if (request.method === 'GET'  && url.pathname === '/api/gps/live') {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return getLiveFleet(request, env, ctx);
    }
    // Alias bajo /api/gps/*: Cloudflare Access bypassea GPS (app móvil); la Torre
    // usa este path para asignar chofer sin chocar con el 302 de Access → Failed to fetch.
    if (request.method === 'POST' && url.pathname === '/api/gps/assign-driver') {
      return runOperatorMutation(request, env, ctx, 'trip.assign_driver', (req, e, op) =>
        handleAsignarChofer(req, e, op)
      );
    }
    if (request.method === 'POST' && url.pathname === '/api/trips/reorder') {
      return runOperatorMutation(request, env, ctx, 'trip.reorder', (req, e, op) =>
        reorderTripStops(req, e, op)
      );
    }
    if (request.method === 'POST' && url.pathname === '/api/trips/move-stop') {
      return runOperatorMutation(request, env, ctx, 'trip.move_stop', (req, e, op, c) =>
        moveTripStop(req, e, op, c)
      );
    }

    // --- Webhooks (Sistemas externos hablÃ¡ndonos) ---
    if (request.method === "POST" && url.pathname === "/wms-webhook") return handleWMSWebhook(request, env, ctx);
    if (request.method === "POST" && url.pathname === "/api/webhooks/orders") {
      return handleOrderIngestWebhook(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname === "/api/webhooks/shopify") {
      return handleShopifyOrderWebhook(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname === "/api/webhooks/woocommerce") {
      return handleWooCommerceOrderWebhook(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname === "/api/webhooks/sap") {
      return handleSapOrderWebhook(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname === "/api/webhooks/netsuite") {
      return handleNetSuiteOrderWebhook(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname === "/api/webhooks/pos") {
      return handlePosOrderWebhook(request, env, ctx);
    }

    // --- Dashboards (Pantallas visuales para el navegador) ---
    if (request.method === "GET" && url.pathname.startsWith("/reporte")) {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return renderReporte(request, env, ctx);
    }
    if (request.method === "GET" && url.pathname === "/control-tower") {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return renderControlTower(request, env, ctx);
    }
    if (request.method === "GET" && url.pathname === "/api/control-tower-viajes") {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return getControlTowerViajesAPI(request, env, ctx);
    }

    // --- API REST (Botones y acciones internas del sistema) ---
    if (request.method === "POST" && url.pathname === "/api/sync-excel") {
      return runOperatorMutation(request, env, ctx, 'sync.excel', (req, e, op) =>
        syncExcel(req, e, ctx, op)
      );
    }
    if (request.method === "POST" && url.pathname === "/api/optimizar-rutas") {
      return runOperatorMutation(request, env, ctx, 'routes.optimize', (req, e, op) =>
        optimizarRutas(req, e, ctx, op)
      );
    }
    if (request.method === "POST" && url.pathname === "/api/reoptimizar-midday") {
      return runOperatorMutation(request, env, ctx, 'routes.reoptimize_midday', (req, e, op) =>
        reoptimizarMidday(req, e, ctx, op)
      );
    }
    if (request.method === "GET" && url.pathname === "/api/lead-rescue/candidates") {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return getRescueCandidates(request, env, access.payload);
    }
    if (request.method === "POST" && url.pathname === "/api/lead-rescue/confirm") {
      return runOperatorMutation(request, env, ctx, 'fleet.lead_rescue', (req, e, op, c) =>
        confirmRescue(req, e, op, c)
      );
    }
    if (request.method === "POST" && /^\/api\/fleet-alerts\/\d+\/dismiss$/.test(url.pathname)) {
      return runOperatorMutation(request, env, ctx, 'fleet.alert_dismiss', (req, e, op) =>
        dismissFleetAlert(req, e, op)
      );
    }
    if (request.method === "POST" && url.pathname === "/api/recalcular-scoring") {
      return runOperatorMutation(request, env, ctx, 'scoring.recalc', (req, e, op) =>
        recalcularScoring(req, e, ctx)
      );
    }
    if (request.method === "GET" && url.pathname === "/api/fixtures/bodega-sample.csv") {
      // Público: el sync descarga server-side sin cookie de operador
      const csv = [
        'OT_ID,CLIENTE,VALOR_OC_CLP,LAT_DESTINO,LNG_DESTINO,FECHA_HORA_SLA,DIRECCION_DESTINO',
        'QA-SYNC-1001,Cliente Sync 1,15000,-33.4489,-70.6693,2026-07-29 18:00:00,"Avenida Libertador Bernardo OHiggins 100, Santiago, Chile"',
        'QA-SYNC-1002,Cliente Sync 2,22000,-33.4172,-70.6067,2026-07-29 19:00:00,"Avenida Apoquindo 3000, Las Condes, Santiago, Chile"',
        'QA-SYNC-1003,Cliente Sync 3,18000,-33.4265,-70.6150,2026-07-29 20:00:00,"Avenida Providencia 1200, Providencia, Santiago, Chile"',
      ].join('\n');
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/geocode/suggest") {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return handleGeocodeSuggest(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/geocode") {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return handleGeocodeResolve(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/quick-route") {
      return runOperatorMutation(request, env, ctx, 'quick_route.create', (req, e, op) =>
        createQuickRoute(req, e, op, ctx)
      );
    }
    if (request.method === "PATCH" && url.pathname === "/api/quick-route/stop") {
      return runOperatorMutation(request, env, ctx, 'quick_route.stop', (req, e, op) =>
        updateQuickRouteStop(req, e, op)
      );
    }
    if (request.method === "PUT" && url.pathname === "/api/quick-route/address") {
      return runOperatorMutation(request, env, ctx, 'quick_route.address', (req, e, op) =>
        updateQuickRouteAddress(req, e, op)
      );
    }
    if (request.method === "PUT" && url.pathname === "/api/quick-route/cancel") {
      return runOperatorMutation(request, env, ctx, 'quick_route.cancel', (req, e, op) =>
        cancelQuickRoute(req, e, op)
      );
    }
    if (request.method === "GET" && url.pathname === "/api/quick-route/export") {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return exportQuickRoutesCSV(request, env, access.payload);
    }
    if (request.method === "GET" && url.pathname === "/api/eta-accuracy/stats") {
      const access = await requireOperatorAccess(request, env);
      if (!access.ok) return access.response;
      return handleEtaAccuracyStats(request, env, access.payload);
    }
    
    // RUTA ARREGLADA: Apunta al controlador correcto que actualiza la base de datos sin crashear.
    if (request.method === "POST" && url.pathname === "/api/asignar-chofer") {
      return runOperatorMutation(request, env, ctx, 'trip.assign_driver', (req, e, op) =>
        handleAsignarChofer(req, e, op)
      );
    }

    // --- Fallback (Error 404) ---
    return new Response(JSON.stringify({ error: "Route not found", path: url.pathname }), { 
        status: 404, 
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
    });
    });
  },
  
  // ============================================================================
  // âš™ï¸ 4. CONSUMIDOR DE COLAS (EVENTOS EN SEGUNDO PLANO)
  // ============================================================================
  async queue(batch, env, ctx) {
    if (batch.queue === CONFIG.MAIN_QUEUE) await processIngestionQueue(batch, env, ctx);
    else if (batch.queue === CONFIG.ENRICHMENT_QUEUE) await processEnrichmentQueue(batch, env, ctx);
    else if (batch.queue === CONFIG.DELIVERY_QUEUE) await processDeliveryQueue(batch, env, ctx);
    else batch.ackAll();
  },

  // ============================================================================
  // â° 5. CRON JOBS (TAREAS AUTOMÃTICAS POR TIEMPO)
  // ============================================================================
  async scheduled(event, env, ctx) { 
    // â”€â”€ Cron diario 02:00 UTC â€” retenciÃ³n de datos de monitoreo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (event.cron === '0 2 * * *') {
      ctx.waitUntil(enforceRetentionPolicies(env));
      return; // aislado: no ejecutar los otros jobs en este trigger
    }

    // â”€â”€ Cron */2 â€” jobs operativos cada 2 minutos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    ctx.waitUntil(runOutboxRecovery(env)); 
    ctx.waitUntil(alertarRiesgosCriticos(env));
    ctx.waitUntil(auditarFlotaEnVivo(env));
    ctx.waitUntil(processCustomerNotificationOutbox(env));
    
    // =========================================================================
    // ðŸ” MONITORING: Alert evaluation (runs every 5 minutes)
    // Task 6.5 - Evaluates alert conditions and dispatches notifications
    // RE-ENABLED: Checks that query non-existent tables are now disabled
    // =========================================================================
    ctx.waitUntil(evaluateAlerts(env, ctx));
  }
};

//ðŸ›ï¸ DEPARTAMENTO 1: La Infraestructura (Los Cimientos)
//Estos archivos no hacen logÃ­stica, pero mantienen el servidor vivo y seguro.

//.dev.vars: La caja fuerte ðŸ”’. AquÃ­ guardas tus contraseÃ±as secretas (el token de Mapbox, la clave de Supabase). Nunca se sube a internet.
//.gitignore: El guardia de seguridad ðŸ›¡ï¸. Le dice al sistema quÃ© archivos NO debe subir al servidor (como la caja fuerte .dev.vars) para que no te roben las claves.
//config.js: El manual de la empresa ðŸ“–. Tiene configuraciones generales (como el APP_CONFIG que vimos en el frontend).
//db.js: El cable de red ðŸ”Œ. Es el archivo que establece la conexiÃ³n directa entre tu cÃ³digo y tu base de datos Supabase/PostgreSQL.
//index.js: El Recepcionista ðŸ¤µ. Recibe todas las peticiones de internet y dice: "Â¿Quieres optimizar? Ve a la carpeta API y habla con optimizer.js".

//ðŸ§  DEPARTAMENTO 2: El Cerebro Core (Carpeta src/)
//AquÃ­ estÃ¡n las herramientas y motores internos de la Torre de Control.

//maestro.js: El Director de Orquesta ðŸŽ¼. Coordina parser + optimizer y flujos batch.
//parser.js: El Traductor ðŸ“. Su trabajo es agarrar el archivo "Acepta" (Excel/CSV) feo y desordenado, y traducirlo a datos limpios que la base de datos pueda entender.
//queues.js: La Sala de Espera â³. Ingesta / enrich / cierre interno de outbox.
//jobs.js: El Reloj Despertador â°. Ejecuta tareas automÃ¡ticas en la madrugada sin que tÃº aprietes nada (ej: limpiar viajes viejos o sincronizar stock a las 3:00 AM).
//ai.js: Â¡El Copiloto IA! ðŸ¤–. AquÃ­ vive el cÃ³digo para conectar tu sistema con ChatGPT o Gemini.
//utils.js: La Caja de Herramientas ðŸ§°. Funciones chiquitas que todos usan (como formatear fechas, quitar acentos a un texto, etc.).
//ui.js: La Pantalla ðŸ“º. El archivo gigante que arreglamos hoy y que tu papÃ¡ ve en su monitor.

//ðŸšš DEPARTAMENTO 3: Los Operarios (Subcarpeta src/api/)
//Estos son los "empleados" que hacen el trabajo logÃ­stico real cuando el Recepcionista (index.js) se los pide.

//optimizer.js: El Genio MatemÃ¡tico ðŸ§®. Calcula kilÃ³metros, tiempos, diÃ©sel, lee el clima y arma las rutas.
//sync.js: El Digitador ðŸ”„. Agarra los datos del parser.js y los guarda en la base de datos Supabase.
//gps.js: El Radar ðŸ“¡. Recibe la ubicaciÃ³n de los celulares de los choferes en la calle y se la manda al mapa del ui.js.
//choferes.js: Recursos Humanos ðŸ‘·â€â™‚ï¸. Gestiona quiÃ©n estÃ¡ de turno, quÃ© tamaÃ±o de camiÃ³n tiene y quÃ© "tags" (habilidades) posee.
//dashboard.js: El Auditor Financiero ðŸ“Š. Suma toda la plata, calcula el OTIF y prepara los grÃ¡ficos de rendimiento.
//wms.js: El Jefe de Bodega ðŸ­ (Warehouse Management System). Se encarga de avisar quÃ© mercaderÃ­a estÃ¡ lista para cargar, control de inventario y andenes.