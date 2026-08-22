// src/config.js//Este archivo centralizará todas las variables mágicas y esquemas de validación.
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

// ============================================================================
// 🔒 CORS CENTRALIZADO — Fuente única de verdad (Regla §3 del Tech Spec)
// Todos los módulos deben importar desde aquí. Prohibido definir corsHeaders local.
// ============================================================================
const CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS, PATCH";
const CORS_ALLOW_HEADERS =
  "Content-Type, Authorization, X-Hub-Signature-256, X-Tenant-Id, X-Shopify-Hmac-Sha256, X-Shopify-Topic, X-WC-Webhook-Signature, Idempotency-Key";

/** Contexto por request — hace que `{...CORS_HEADERS}` respete la allowlist. */
const corsAls = new AsyncLocalStorage();

export function withCorsContext(request, env, fn) {
  return corsAls.run({ request, env }, fn);
}

/**
 * CORS allowlist. Si CORS_ALLOWED_ORIGINS está vacío → "*" (lab).
 * Apps nativas sin Origin reciben el primer origen permitido (o *).
 * Origen presente pero no permitido → null (NO el string "null").
 */
export function resolveCorsOrigin(request, env) {
  const configured = String(env?.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!configured.length) return "*";

  const origin = request?.headers?.get?.("Origin");
  if (!origin) return configured[0];
  if (configured.includes(origin)) return origin;
  return null;
}

export function getCorsHeaders(request, env) {
  const origin = resolveCorsOrigin(request, env);
  const headers = {
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Vary": "Origin",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

/** true si el Origin del request está permitido (o no hay allowlist / no hay Origin). */
export function isCorsOriginAllowed(request, env) {
  const configured = String(env?.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!configured.length) return true;
  const origin = request?.headers?.get?.("Origin");
  if (!origin) return true;
  return configured.includes(origin);
}

function corsHeadersFromContext() {
  const store = corsAls.getStore();
  if (store?.request) return getCorsHeaders(store.request, store.env || {});
  // Fuera de request (tests/cron): métodos/headers sin ACAO si hay allowlist implícita
  return {
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Vary": "Origin",
  };
}

/**
 * Compat: se puede hacer `{...CORS_HEADERS}` en cualquier handler.
 * Dentro de `withCorsContext` refleja Origin allowlisteado (nunca el string "null").
 */
export const CORS_HEADERS = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === Symbol.toStringTag) return 'Object';
      return corsHeadersFromContext()[prop];
    },
    ownKeys() {
      return Reflect.ownKeys(corsHeadersFromContext());
    },
    getOwnPropertyDescriptor(_t, prop) {
      const h = corsHeadersFromContext();
      if (!Object.prototype.hasOwnProperty.call(h, prop)) return undefined;
      return { configurable: true, enumerable: true, writable: false, value: h[prop] };
    },
    has(_t, prop) {
      return Object.prototype.hasOwnProperty.call(corsHeadersFromContext(), prop);
    },
  }
);

// ============================================================================
// 🛡️ HELPER: Validación de tenant_id (Regla Multi-Tenant §3)
// Retorna un Response 403 si el tenant_id es inválido, null si es válido.
// Uso: const err = requireTenantId(tenant_id); if (err) return err;
// ============================================================================
export function requireTenantId(tenant_id) {
  if (!tenant_id || typeof tenant_id !== 'string' || tenant_id.trim() === '') {
    return new Response(
      JSON.stringify({ error: 'Forbidden: tenant_id es obligatorio' }),
      { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
  return null;
}

// ============================================================================
// 🌐 HELPER: Construir Response JSON con CORS incluido
// Uso: return jsonResponse({ exito: true }, 200);
// ============================================================================
export function jsonResponse(body, status = 200, requestOrEnv = null, env = null) {
  const cors =
    requestOrEnv && typeof requestOrEnv.headers?.get === "function"
      ? getCorsHeaders(requestOrEnv, env || {})
      : { ...CORS_HEADERS };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}

export const CONFIG = {
  DB_OPTS: (env) => ({
    connectionString: env.HYPERDRIVE.connectionString,
    keepAlive: false,
    // Evita cuelgues infinitos si Hyperdrive/Supabase no responde (login → Torre).
    connectionTimeoutMillis: 8000,
    query_timeout: 20000,
  }),
  NETWORK_TIMEOUT_MS: 15000,
  AI_TIMEOUT_MS: 20000,
  MAX_INGESTION_ATTEMPTS: 3,
  MAX_ENRICHMENT_ATTEMPTS: 5,
  MAX_DELIVERY_ATTEMPTS: 10,
  BATCH_SIZE: 50,
  MAIN_QUEUE: 'leads-ingestion-queue', 
  ENRICHMENT_QUEUE: 'leads-enrichment-queue',
  DELIVERY_QUEUE: 'leads-delivery-queue',
  // Velocidad promedio de fallback para cálculo de ETA cuando Mapbox no está disponible
  // Configurable aquí para ajustar por condiciones operativas (lluvia, tráfico, etc.)
  VELOCIDAD_FALLBACK_KMH: 35,

  /** Auto-LLEGADA por geocerca en /api/gps/ping (metros). */
  GEO_LLEGADA_RADIUS_M: 150,

  /** Fase 0/1 — GPS trail, Dead Man's Switch, Lead Rescue */
  LEAD_RESCUE: {
    YELLOW_STUCK_MIN: 15,
    RED_STUCK_MIN: 40,
    SIGNAL_LOST_MIN: 15,
    RECENT_PING_MAX_MIN: 5,
    STALE_ALERT_MAX_MIN: 12 * 60,
    MOVE_THRESHOLD_KM: 0.05,
    GPS_TRAIL_MIN_INTERVAL_SEC: 45,
    GPS_TRAIL_RETENTION_DAYS: 14,
    RESCUE_CANDIDATES: 2,
  },
};

export const SLA_CACHE = new Map();

export function cleanSLACache() {
  if (SLA_CACHE.size > 1000) {
    const now = Date.now();
    for (const [k, v] of SLA_CACHE) {
      if (v.expires <= now) SLA_CACHE.delete(k);
    }
    if (SLA_CACHE.size > 1000) SLA_CACHE.clear(); 
  }
}

export const WebhookSchema = z.object({
  ot_id: z.string().trim().max(120),
  produccion_estandar: z.coerce.number(),
  produccion_real: z.coerce.number(),
  horas_para_sla: z.coerce.number(),
  etapa: z.enum(["BODEGA", "PICKING", "PACKING", "CAMION_ASIGNADO", "EN_RUTA", "ENTREGADO"]).optional().default("BODEGA"),
  minutos_camion_esperando: z.coerce.number().optional().default(0),
  cliente: z.string().trim().max(120).optional().default("DEFAULT"),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional()
});

/** Pedido individual para POST /api/webhooks/orders (ERP / e-commerce). */
export const OrderIngestItemSchema = z.object({
  ot_id: z.string().trim().min(1).max(120),
  cliente: z.string().trim().min(1).max(120),
  direccion: z.string().trim().max(500).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  fecha_hora_sla: z.string().trim().max(64).optional(),
  valor_oc_clp: z.coerce.number().min(0).optional(),
  monto_total: z.coerce.number().min(0).optional(),
  external_ref: z.string().trim().max(120).optional(),
  telefono: z.string().trim().max(40).optional(),
  email: z.string().trim().max(255).optional(),
  peso_kg: z.coerce.number().min(0).optional(),
  ventana_inicio: z.string().trim().max(64).optional(),
  ventana_fin: z.string().trim().max(64).optional(),
  /** Tags de capacidad (ej. HAZMAT, FRIO). El ruteo solo asigna choferes con esos tags. */
  tags_requeridos: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  /** Atajo: si true, agrega tag HAZMAT a tags_requeridos. */
  requires_hazmat: z.boolean().optional(),
  /** Bodega preferida (metadata); el ruteo usa depot_id del operador si no se fija aquí. */
  depot_id: z.string().trim().max(64).optional(),
});

/** Payload batch para ingestión genérica de órdenes logísticas. */
export const OrderIngestPayloadSchema = z.object({
  tenant_id: z.string().trim().min(1).max(120),
  source: z.string().trim().min(1).max(64).optional().default('ERP'),
  idempotency_key: z.string().trim().max(128).optional(),
  orders: z.array(OrderIngestItemSchema).min(1).max(200),
});

export const AISchema = z.object({
  riesgo: z.enum(["BAJO", "MEDIO", "CRÍTICO", "CRÍTICO_MÁXIMO_CAMIÓN_ESPERANDO"]),
  risk_score: z.number().min(0).max(100),
  alerta_tactica: z.string(),
  accion_recomendada: z.string(),
  impacto_financiero: z.string() 
});