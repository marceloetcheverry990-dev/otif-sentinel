# Configuration Reference — OTIF Sentinel

**Fuente de verdad de configuración del sistema lead-rescue-pipeline.**
**Última actualización:** 2026-06-14

---

## Índice

1. [Feature Flags — Monitoring](#1-feature-flags--monitoring)
2. [Alerting / Telegram](#2-alerting--telegram)
3. [Database / Hyperdrive](#3-database--hyperdrive)
4. [Queues](#4-queues)
5. [R2 Storage](#5-r2-storage)
6. [Dashboard](#6-dashboard)
7. [Cron Jobs](#7-cron-jobs)
8. [Umbrales operativos](#8-umbrales-operativos)
9. [Dependencias entre variables](#9-dependencias-entre-variables)
10. [Variables no funcionales o con issues conocidos](#10-variables-no-funcionales-o-con-issues-conocidos)
11. [Tabla resumen — todas las variables](#11-tabla-resumen--todas-las-variables)
12. [Lead Rescue / Dead Man's Switch (Fase 0–1)](#12-lead-rescue--dead-mans-switch-fase-01)

---

## 1. Feature Flags — Monitoring

Estas variables controlan qué subsistemas de monitoreo están activos.

> ⚠️ **Issue conocido:** `MONITORING_ENABLED`, `MONITORING_ERROR_TRACKING`, `MONITORING_METRICS`
> y `MONITORING_ALERTING` existen en `wrangler.jsonc` y son leídas por `getMonitoringConfig(env)`,
> pero el middleware `withMonitoring` lee el objeto estático `MONITORING_CONFIG.features.enabled`
> (hardcodeado a `true`) en lugar de llamar a `getMonitoringConfig(env)`.
> **Efecto práctico:** cambiar estas variables a `'false'` no desactiva el middleware.
> La lógica de desactivación está incompleta. Ver [Sección 10](#10-variables-no-funcionales-o-con-issues-conocidos).

---

### `MONITORING_ENABLED`

| Campo | Valor |
|-------|-------|
| **Ubicación** | `wrangler.jsonc` → `vars` |
| **Valor actual** | `"true"` |
| **Obligatoria** | No (default: true si no está) |
| **Impacto funcional** | Debería activar/desactivar todo el sistema de monitoreo. **Actualmente no funciona** — ver issue conocido arriba. |
| **Valores válidos** | `"true"` / `"false"` |
| **Valor por defecto** | `true` (si omitida) |
| **Riesgo de modificar** | Alto (cuando el bug esté corregido, cambiar a `"false"` desactivaría todo el monitoreo) |
| **Requiere deploy** | Sí |

---

### `MONITORING_ERROR_TRACKING`

| Campo | Valor |
|-------|-------|
| **Ubicación** | `wrangler.jsonc` → `vars` |
| **Valor actual** | `"true"` |
| **Obligatoria** | No |
| **Impacto funcional** | Controla si los errores se capturan y persisten en `error_logs`. **Actualmente no funciona** — mismo bug que `MONITORING_ENABLED`. |
| **Valores válidos** | `"true"` / `"false"` |
| **Valor por defecto** | `true` |
| **Riesgo de modificar** | Medio |
| **Requiere deploy** | Sí |

---

### `MONITORING_METRICS`

| Campo | Valor |
|-------|-------|
| **Ubicación** | `wrangler.jsonc` → `vars` |
| **Valor actual** | `"true"` |
| **Obligatoria** | No |
| **Impacto funcional** | Controla si se registran métricas en `metrics_summary`. **Actualmente no funciona** — mismo bug. |
| **Valores válidos** | `"true"` / `"false"` |
| **Valor por defecto** | `true` |
| **Riesgo de modificar** | Medio |
| **Requiere deploy** | Sí |

---

### `MONITORING_ALERTING`

| Campo | Valor |
|-------|-------|
| **Ubicación** | `wrangler.jsonc` → `vars` |
| **Valor actual** | `"true"` |
| **Obligatoria** | No |
| **Impacto funcional** | Controla si se envían alertas por Telegram. **Actualmente no funciona** — mismo bug. |
| **Valores válidos** | `"true"` / `"false"` |
| **Valor por defecto** | `true` |
| **Riesgo de modificar** | Medio |
| **Requiere deploy** | Sí |

---

### `MONITORING_SAMPLE_RATE`

| Campo | Valor |
|-------|-------|
| **Ubicación** | `wrangler.jsonc` → `vars` |
| **Valor actual** | `"0.1"` (10%) |
| **Obligatoria** | No |
| **Impacto funcional** | Fracción de requests exitosos que generan métricas. Los errores siempre se capturan al 100%. |
| **Valores válidos** | `"0.0"` a `"1.0"` (string numérico) |
| **Valor por defecto** | `0.1` |
| **Riesgo de modificar** | Bajo-Medio. Aumentar a `"1.0"` incrementa el volumen de escrituras en `metrics_summary` ~10x. |
| **Requiere deploy** | Sí |

---

## 2. Alerting / Telegram

### `TG_BOT_TOKEN`

| Campo | Valor |
|-------|-------|
| **Ubicación** | Cloudflare Secret (`.dev.vars` localmente) |
| **Valor actual** | Secret — no exponer |
| **Obligatoria** | Sí — sin esto no se envían alertas ni mensajes a choferes |
| **Impacto funcional** | Token del bot de Telegram. Usado por alertas de monitoreo y por el sistema de entrega de rutas. |
| **Valores válidos** | String con formato `<número>:<cadena_alfanumérica>` |
| **Valor por defecto** | Sin default — el sistema falla silenciosamente si no está configurado |
| **Riesgo de modificar** | Crítico. Cambiar el token sin actualizar el bot en Telegram rompe todas las notificaciones. |
| **Requiere deploy** | No (Secret — se actualiza sin redeploy) |

---

### `SALES_TEAM_CHAT_ID`

| Campo | Valor |
|-------|-------|
| **Ubicación** | `wrangler.jsonc` → `vars` |
| **Valor actual** | `-1003818832328` |
| **Obligatoria** | Sí — es el fallback cuando `MONITORING_CHAT_ID` no está configurado |
| **Impacto funcional** | ID del chat de Telegram donde se envían alertas operativas y mensajes a choferes |
| **Valores válidos** | String numérico (negativo para grupos) |
| **Valor por defecto** | Sin default |
| **Riesgo de modificar** | Alto. Cambiar redirige todas las notificaciones al chat nuevo. |
| **Requiere deploy** | Sí |

---

### `MONITORING_CHAT_ID` (no configurada actualmente)

| Campo | Valor |
|-------|-------|
| **Ubicación** | No está en `wrangler.jsonc` |
| **Valor actual** | No configurada |
| **Obligatoria** | No (fallback a `SALES_TEAM_CHAT_ID`) |
| **Impacto funcional** | Si se configura, las alertas de monitoreo se envían a este chat separado del chat de negocio |
| **Valores válidos** | String numérico (negativo para grupos) |
| **Valor por defecto** | No aplica — usa `SALES_TEAM_CHAT_ID` si no está |
| **Riesgo de modificar** | Bajo |
| **Requiere deploy** | Sí |

---

### `OPENAI_API_KEY`

| Campo | Valor |
|-------|-------|
| **Ubicación** | Cloudflare Secret (`.dev.vars` localmente) |
| **Valor actual** | Secret — no exponer |
| **Obligatoria** | Sí — sin esto el enriquecimiento IA falla |
| **Impacto funcional** | Clave de API de OpenAI para el módulo de enriquecimiento de leads |
| **Valores válidos** | String con formato `sk-proj-...` |
| **Valor por defecto** | Sin default |
| **Riesgo de modificar** | Crítico. Cambiar sin actualizar el secret rompe el enriquecimiento. |
| **Requiere deploy** | No (Secret) |

---

## 3. Database / Hyperdrive

### `HYPERDRIVE` (binding)

| Campo | Valor |
|-------|-------|
| **Ubicación** | `wrangler.jsonc` → `hyperdrive` → binding `HYPERDRIVE` |
| **ID de Hyperdrive** | Ver Cloudflare Dashboard → Workers → lead-rescue-pipeline → Settings → Bindings |
| **Obligatoria** | Sí — sin este binding todo el sistema falla |
| **Impacto funcional** | Pool de conexiones a PostgreSQL (Supabase). Toda operación de DB usa `env.HYPERDRIVE.connectionString`. |
| **Connection string local** | Definida en `.dev.vars` (no exponer en documentación pública) |
| **Riesgo de modificar** | Crítico. Cambiar el ID de Hyperdrive a uno inexistente rompe toda la DB. |
| **Requiere deploy** | Sí |

---

### `SUPABASE_URL`

| Campo | Valor |
|-------|-------|
| **Ubicación** | `.dev.vars` (solo desarrollo local) |
| **Valor actual** | `https://cbjderarqvfwzrbqeqjv.supabase.co` |
| **Obligatoria** | Solo en desarrollo local |
| **Impacto funcional** | URL base de la API REST de Supabase. No usado por el worker en producción (usa Hyperdrive). |
| **Requiere deploy** | No aplica (solo local) |

---

### `SUPABASE_SERVICE_ROLE_KEY`

| Campo | Valor |
|-------|-------|
| **Ubicación** | `.dev.vars` (solo desarrollo local) |
| **Valor actual** | Secret — no exponer |
| **Obligatoria** | Solo en desarrollo local |
| **Impacto funcional** | Clave de servicio de Supabase para operaciones admin. No usado en producción. |
| **Requiere deploy** | No aplica |

---

## 4. Queues

Configuradas en `wrangler.jsonc` → `queues`. No se modifican por variables de entorno.

| Queue | Binding | Cola en Cloudflare | max_batch_size | max_retries |
|-------|---------|-------------------|---------------|-------------|
| Ingestion | `MAIN_QUEUE` | `leads-ingestion-queue` | 50 | 1 |
| Enrichment | `ENRICHMENT_QUEUE` | `leads-enrichment-queue` | 50 | 1 |
| Delivery | `DELIVERY_QUEUE` | `leads-delivery-queue` | 50 | 1 |

**`max_retries: 1`** — La resiliencia se delega a la tabla `outbox_events` y al job
`runOutboxRecovery`, no a las colas nativas de Cloudflare.

**`MAX_DELIVERY_ATTEMPTS: 10`** (definido en `src/config.js`) — Un mensaje puede
reintentarse hasta 10 veces desde el outbox antes de moverse a DLQ.

---

## 5. R2 Storage

### `chat_photos` (binding)

| Campo | Valor |
|-------|-------|
| **Ubicación** | `wrangler.jsonc` → `r2_buckets` |
| **Bucket** | `chat-photos` |
| **Binding en código** | `env.chat_photos` |
| **Obligatoria** | Sí — el health check lo verifica |
| **Impacto funcional** | Bucket de almacenamiento de fotos del sistema de chat de choferes |
| **Riesgo de modificar** | Alto. Cambiar el bucket redirige todas las fotos. |
| **Requiere deploy** | Sí |

---

## 6. Dashboard

### `MONITORING_USERNAME`

| Campo | Valor |
|-------|-------|
| **Ubicación** | `wrangler.jsonc` → `vars` |
| **Valor actual** | `"admin"` |
| **Obligatoria** | Sí — sin esto el dashboard no puede autenticar |
| **Impacto funcional** | Usuario para HTTP Basic Auth del dashboard de monitoreo |
| **Valores válidos** | Cualquier string no vacío |
| **Valor por defecto** | Sin default |
| **Riesgo de modificar** | Bajo. Cambiar actualiza las credenciales del dashboard. |
| **Requiere deploy** | Sí |

---

### `MONITORING_PASSWORD`

| Campo | Valor |
|-------|-------|
| **Ubicación** | `wrangler.jsonc` → `vars` |
| **Valor actual** | `"REMOVED_SECRET"` (expuesta — considerar mover a Secret) |
| **Obligatoria** | Sí |
| **Impacto funcional** | Contraseña para HTTP Basic Auth del dashboard de monitoreo |
| **Valores válidos** | Cualquier string |
| **Valor por defecto** | Sin default |
| **Riesgo de modificar** | Bajo. Cambiar actualiza la contraseña del dashboard. |
| **Requiere deploy** | Sí |
| **Nota de seguridad** | Actualmente en `vars` (texto plano). Recomendado mover a Cloudflare Secret para producción. |

---

### `JWT_SECRET` (no configurada actualmente)

| Campo | Valor |
|-------|-------|
| **Ubicación** | No configurada |
| **Obligatoria** | Solo si se usa autenticación JWT (actualmente se usa HTTP Basic Auth) |
| **Impacto funcional** | Clave para verificar tokens JWT en el dashboard |
| **Riesgo de modificar** | Alto si está activa (invalida todos los tokens existentes) |
| **Requiere deploy** | No (Secret) |

---

### `PUBLIC_BASE_URL`

| Campo | Valor |
|-------|-------|
| **Ubicación** | `wrangler.jsonc` → `vars` |
| **Valor actual** | `"https://lead-rescue-pipeline.marceloetcheverry990.workers.dev"` |
| **Obligatoria** | No (usada en links del dashboard y alertas de Telegram) |
| **Impacto funcional** | URL base para generar links en mensajes de Telegram y el dashboard |
| **Riesgo de modificar** | Bajo |
| **Requiere deploy** | Sí |

---

## 7. Cron Jobs

Configurados en `wrangler.jsonc` → `triggers.crons`. El handler `scheduled(event, env, ctx)`
discrimina cuál cron disparó usando `event.cron`.

### Cron `*/2 * * * *` — Jobs operativos cada 2 minutos

| Campo | Valor |
|-------|-------|
| **Expresión** | `*/2 * * * *` |
| **Frecuencia** | Cada 2 minutos |
| **Jobs que ejecuta** | `runOutboxRecovery`, `alertarRiesgosCriticos`, `auditarFlotaEnVivo` (Dead Man's Switch), `evaluateAlerts` |
| **Guard en código** | Ejecuta cuando `event.cron !== '0 2 * * *'` (implícito — es el fallthrough) |
| **Impacto de modificar** | Cambiar la frecuencia afecta la velocidad de recuperación del outbox, alertas SLA y detección de camiones detenidos |
| **Requiere deploy** | Sí |

---

### Cron `0 2 * * *` — Retención diaria a las 02:00 UTC

| Campo | Valor |
|-------|-------|
| **Expresión** | `0 2 * * *` |
| **Frecuencia** | Diaria a las 02:00 UTC (23:00 hora Chile) |
| **Jobs que ejecuta** | `enforceRetentionPolicies` |
| **Guard en código** | `if (event.cron === '0 2 * * *') { ... return; }` — aislado del cron de 2 min |
| **Impacto funcional** | Borra registros viejos de `error_logs` (>90d), `alert_history` (>180d), `health_check_results` (>30d). Observa particiones de `metrics_summary` sin borrar. |
| **Nota de seguridad** | El DROP de particiones está **deshabilitado** — modo observación únicamente |
| **Requiere deploy** | Sí |

---

## 8. Umbrales operativos

Todos hardcodeados en `src/monitoring/config.js`. Requieren deploy para modificarse.

| Umbral | Variable | Valor actual | Rango recomendado |
|--------|----------|-------------|-------------------|
| Error rate máximo | `error_rate_threshold_percent` | **5%** | 3–10% |
| Ventana de error rate | `error_rate_window_minutes` | **5 min** | 3–15 min |
| Latencia p95 máxima | `response_time_p95_threshold_ms` | **3000 ms** | 1000–5000 ms |
| Ventana de latencia | `response_time_window_minutes` | **5 min** | 3–15 min |
| Latencia de cola máxima | `queue_latency_threshold_minutes` | **10 min** | 5–20 min |
| Circuit breaker abierto máximo | `circuit_breaker_open_threshold_minutes` | **10 min** | 5–15 min |
| DLQ overflow | `dlq_message_threshold` | **100 mensajes/hora** | 50–200 |
| R2 failure | `r2_failure_threshold_minutes` | **5 min** | 2–10 min |
| DB down | `database_down_threshold_seconds` | **30 s** | 15–60 s |
| Deduplicación de alertas | `alert_deduplication_window_minutes` | **15 min** | 10–30 min |
| Rate limit de alertas | `max_alerts_per_hour` | **10/hora por componente** | 5–20 |
| Health check DB timeout | `db_health_check_timeout_ms` | **200 ms** | 100–500 ms |
| Statement timeout (monitoreo) | hardcoded en `withDb` calls | **1000 ms** | 500–5000 ms |
| Statement timeout (retención) | hardcoded en `enforceRetentionPolicies` | **5000 ms** | 3000–30000 ms |
| Sampling requests exitosos | `MONITORING_SAMPLE_RATE` / `sampling.successful_requests` | **10%** | 5–100% |
| Retención `error_logs` | `retention.error_logs_days` | **90 días** | 30–365 |
| Retención `alert_history` | `retention.alert_history_days` | **180 días** | 90–365 |
| Retención `health_check_results` | `retention.health_check_results_days` | **30 días** | 7–90 |
| Retención `metrics_summary` | `retention.metrics_summary_days` | **365 días** | 180–730 |

---

## 9. Dependencias entre variables

```
TG_BOT_TOKEN ──────────────────────────────────────────── Alertas de monitoreo
     │                                                     Mensajes a choferes
     │
     └─► SALES_TEAM_CHAT_ID ──────────────────────────── Chat de destino (fallback)
         MONITORING_CHAT_ID (no configurada) ──────────── Chat de destino (primario)

HYPERDRIVE binding ────────────────────────────────────── Toda operación de DB
     │
     └─► MONITORING_* feature flags ──────────────────── Subsistemas de monitoreo
         (actualmente no funcionales por bug en withMonitoring)

MONITORING_USERNAME + MONITORING_PASSWORD ──────────────── Acceso al dashboard
     │
     └─► JWT_SECRET (no configurada) ──────────────────── Alternativa JWT al dashboard

MONITORING_SAMPLE_RATE ──────────────────────────────────── Volumen de métricas en DB

Cron */2 * * * * ──────────────────────────────────────── evaluateAlerts + outbox recovery
Cron 0 2 * * * ────────────────────────────────────────── enforceRetentionPolicies

MAIN_QUEUE + ENRICHMENT_QUEUE + DELIVERY_QUEUE ─────────── Pipeline de procesamiento
     │
     └─► CONFIG.MAX_DELIVERY_ATTEMPTS (10) ────────────── Reintentos antes de DLQ
         CONFIG.BATCH_SIZE (50) ─────────────────────────── Mensajes por ciclo
```

### Variables que dependen entre sí

| Si cambiás... | También revisar... |
|---------------|-------------------|
| `TG_BOT_TOKEN` | Verificar que el token pertenece al bot correcto con `getMe` |
| `SALES_TEAM_CHAT_ID` | Confirmar que el bot tiene permisos en el nuevo chat |
| `HYPERDRIVE` ID | Verificar que el nuevo binding apunta a la DB correcta |
| `MONITORING_SAMPLE_RATE` | Estimar el nuevo volumen de escrituras en `metrics_summary` |
| `MONITORING_PASSWORD` | Actualizar en todos los lugares donde se guarda la contraseña |

---

## 10. Variables no funcionales o con issues conocidos

### Issue 1 — `MONITORING_ENABLED` (RESUELTO 2026-07-25)

**Estado:** Resuelto. `withMonitoring` / `withQueueMonitoring` / `withScheduledMonitoring`
leen `getMonitoringConfig(env)` en runtime. `MONITORING_ENABLED=false` desactiva el wrap.
Los tests pueden seguir mutando `MONITORING_CONFIG.features.enabled = false`.

---

### Issue 2 — Retention de particiones `metrics_summary` en modo observación

**Variable:** comportamiento interno de `enforceRetentionPolicies`

**Estado:** El cron `0 2 * * *` ejecuta `enforceRetentionPolicies` diariamente.
Los DELETEs sobre `error_logs`, `alert_history` y `health_check_results` funcionan.
El DROP de particiones antiguas de `metrics_summary` está **deshabilitado** — el código
solo lista las candidatas y las logea con `[RETENTION_OBSERVE]`.

**Para habilitar DROP:** Modificar `src/monitoring/retention.js` para ejecutar
`DROP TABLE IF EXISTS metrics_summary_YYYY_MM` después de verificar la lista de
candidatas. Requiere evidencia previa del modo observación y aprobación explícita.

---

### Issue 3 — `MONITORING_PASSWORD` expuesta en texto plano en `wrangler.jsonc`

**Estado:** La contraseña del dashboard está en `vars` (visible en el repositorio).
**Recomendación:** Mover a Cloudflare Secret (`wrangler secret put MONITORING_PASSWORD`).
Requiere removerla de `vars` y volver a deployar.

---

## 11. Tabla resumen — todas las variables

| Variable | Ubicación | Crítica para producción | Estado |
|----------|-----------|------------------------|--------|
| `TG_BOT_TOKEN` | Secret | 🔴 Crítica | ✅ Activa |
| `HYPERDRIVE` binding | wrangler.jsonc | 🔴 Crítica | ✅ Activa |
| `MAIN_QUEUE` binding | wrangler.jsonc | 🔴 Crítica | ✅ Activa |
| `ENRICHMENT_QUEUE` binding | wrangler.jsonc | 🔴 Crítica | ✅ Activa |
| `DELIVERY_QUEUE` binding | wrangler.jsonc | 🔴 Crítica | ✅ Activa |
| `SALES_TEAM_CHAT_ID` | wrangler.jsonc → vars | 🔴 Crítica | ✅ Activa |
| `OPENAI_API_KEY` | Secret | 🔴 Crítica | ✅ Activa |
| `chat_photos` binding (R2) | wrangler.jsonc | 🟡 Alta | ✅ Activa |
| `MONITORING_USERNAME` | wrangler.jsonc → vars | 🟡 Alta | ✅ Activa |
| `MONITORING_PASSWORD` | wrangler.jsonc → vars | 🟡 Alta | ⚠️ En texto plano (ver Issue 3) |
| `PUBLIC_BASE_URL` | wrangler.jsonc → vars | 🟢 Baja | ✅ Activa |
| `MONITORING_ENABLED` | wrangler.jsonc → vars | 🟢 Baja | ⚠️ No funcional (ver Issue 1) |
| `MONITORING_ERROR_TRACKING` | wrangler.jsonc → vars | 🟢 Baja | ⚠️ No funcional (ver Issue 1) |
| `MONITORING_METRICS` | wrangler.jsonc → vars | 🟢 Baja | ⚠️ No funcional (ver Issue 1) |
| `MONITORING_ALERTING` | wrangler.jsonc → vars | 🟢 Baja | ⚠️ No funcional (ver Issue 1) |
| `MONITORING_SAMPLE_RATE` | wrangler.jsonc → vars | 🟢 Baja | ✅ Activa (`getMonitoringConfig` la lee) |
| `MONITORING_CHAT_ID` | No configurada | 🟢 Baja | ⚠️ Faltante (usa fallback a `SALES_TEAM_CHAT_ID`) |
| `JWT_SECRET` | No configurada | 🟢 Baja | ⚠️ Faltante (solo si se activa auth JWT) |
| `META_APP_SECRET` | Secret (.dev.vars) | 🟡 Alta | ✅ Solo desarrollo local |
| `ORDER_INGEST_SECRET` | Secret | 🟡 Alta | HMAC para `POST /api/webhooks/orders` (global) |
| `ORDER_INGEST_SECRETS` | Secret (JSON opcional) | 🟡 Alta | Mapa `{"tenant_id":"secret"}` por tenant |
| `SUPABASE_URL` | .dev.vars | 🟢 Baja | ✅ Solo desarrollo local |
| `SUPABASE_SERVICE_ROLE_KEY` | .dev.vars | 🟢 Baja | ✅ Solo desarrollo local |
| Cron `*/2 * * * *` | wrangler.jsonc triggers | 🔴 Crítica | ✅ Activo — jobs operativos |
| Cron `0 2 * * *` | wrangler.jsonc triggers | 🟡 Alta | ✅ Activo — retención diaria |
| Retention DROP partitions | retention.js (código) | 🟡 Alta | ⚠️ Deshabilitado (ver Issue 2) |

### Leyenda

- 🔴 **Crítica:** Si falla o está mal configurada, el sistema no funciona
- 🟡 **Alta:** Afecta funcionalidades importantes pero no detiene el sistema
- 🟢 **Baja:** Opcional o de bajo impacto operativo
- ✅ **Activa:** Funcionando correctamente
- ⚠️ **Advertencia:** Funciona con limitaciones o tiene issues conocidos

---

## 12. Multi-bodega, HazMat y ERP

### Multi-bodega (`depots`)

- Tabla `depots` (migración `005_depots.sql`): `depot_id`, `tenant_id`, `nombre`, `lat`, `lng`, `is_default`, `activo`.
- API: `GET /api/depots` (operador), `POST /api/depots` (solo admin).
- Torre de Control: selector **Bodega** (`#depotRuteo`) alimenta `depot_id` en `/api/optimizar-rutas`, `/api/reoptimizar-midday` y `/api/quick-route`.
- Si el tenant no tiene filas, se siembra automáticamente **Bodega Central** (Maipú).

### HazMat (ligero vía tags)

- Órdenes: columna/metadata `tags_requeridos` (ej. `["HAZMAT"]`).
- Webhook ingest: `requires_hazmat: true` agrega el tag `HAZMAT`; también acepta `tags_requeridos: ["HAZMAT", ...]`.
- Ruteo / re-opt: solo asigna a choferes cuyo JSON `tags` incluya los tags requeridos.
- Segregación HAZMAT/FOOD v1: no mezclar tags `HAZMAT` con `FOOD`/`ALIMENTO` en el mismo viaje (optimizer, midday, move-stop, Lead Rescue, ruta rápida).

### ERP / e-commerce

- Integración genérica: `POST /api/webhooks/orders` (HMAC + `X-Tenant-Id`).
- **Adaptadores nativos** (mapean el JSON de cada plataforma al mismo ingest):

| Plataforma | URL | Firma | Secret (env) |
|------------|-----|-------|--------------|
| Shopify | `POST /api/webhooks/shopify` | `X-Shopify-Hmac-Sha256` (base64) | `SHOPIFY_WEBHOOK_SECRET` o `PLATFORM_WEBHOOK_SECRETS["shopify:tenant"]` |
| WooCommerce | `POST /api/webhooks/woocommerce` | `X-WC-Webhook-Signature` (base64) | `WOOCOMMERCE_WEBHOOK_SECRET` |
| SAP (CPI/OData JSON) | `POST /api/webhooks/sap` | `X-Hub-Signature-256` | `SAP_WEBHOOK_SECRET` / `ORDER_INGEST_SECRET` |
| NetSuite | `POST /api/webhooks/netsuite` | `X-Hub-Signature-256` | `NETSUITE_WEBHOOK_SECRET` |
| POS genérico | `POST /api/webhooks/pos` | `X-Hub-Signature-256` | `POS_WEBHOOK_SECRET` |

- Siempre enviar `X-Tenant-Id` (o `?tenant=`).
- No son conectores OAuth que “entran” a tu SAP/Shopify: vos configurás el webhook **desde** esa plataforma hacia nuestra URL. El Worker lee y normaliza el pedido.
- Fallback: cualquier sistema puede seguir usando `/api/webhooks/orders` con el schema canónico.

---

## 12. Lead Rescue / Dead Man's Switch (Fase 0–1)

**Migración requerida:** `migrations/006_gps_trail_dwell_rescue.sql` (aplicar en Supabase/Postgres antes o junto al deploy).

### Qué hace

| Pieza | Descripción |
|-------|-------------|
| **GPS trail** | `gps_trail` — muestreo en cada ping (movimiento ≥50 m o heartbeat ~45 s). Retención 14 días. |
| **Dwell stats** | `stop_dwell_stats` — al ENTREGAR, guarda minutos en sitio (cliente × chofer × dow × hora). Base para riesgo empírico futuro. |
| **Dead Man's Switch** | Cron `auditarFlotaEnVivo` (cada 2 min). Si el camión no se mueve ≥15 min → alerta YELLOW; ≥40 min → RED. Excluye `EN_SITIO`. También detecta señal GPS perdida. |
| **Lead Rescue** | Torre: banner + modal. Top 2 camiones cercanos con cupo. Confirmación humana mueve paradas abiertas al viaje rescate. |

### Umbrales (`CONFIG.LEAD_RESCUE` en `src/config.js`)

| Clave | Default | Significado |
|-------|---------|-------------|
| `YELLOW_STUCK_MIN` | 15 | Minutos quieto → alerta amarilla |
| `RED_STUCK_MIN` | 40 | Minutos quieto → alerta roja + prioriza Telegram |
| `SIGNAL_LOST_MIN` | 15 | Sin pings GPS → `SIGNAL_LOST` |
| `MOVE_THRESHOLD_KM` | 0.05 | Movimiento “significativo” (50 m) |
| `GPS_TRAIL_MIN_INTERVAL_SEC` | 45 | Heartbeat de trail |
| `GPS_TRAIL_RETENTION_DAYS` | 14 | Borrado diario en `enforceRetentionPolicies` |
| `RESCUE_CANDIDATES` | 2 | Candidatos sugeridos en Torre |

### APIs (operador autenticado)

| Método | Path | Uso |
|--------|------|-----|
| GET | `/api/control-tower-viajes` | Incluye `fleet_alerts` abiertas |
| GET | `/api/lead-rescue/candidates?trip_id=` | Top camiones con cupo |
| POST | `/api/lead-rescue/confirm` | Body: `source_trip_id`, `rescue_trip_id`, `alert_id?`, `depot_id?` |
| POST | `/api/fleet-alerts/:id/dismiss` | Descarta alerta |

### App chofer

`GET /api/app-chofer-rutas` incluye `misiones_rescate` cuando hay una misión `DISPATCHED` hacia el viaje del chofer. Telegram notifica al confirmar.

### Notas operativas

- Rescate **no es automático**: el despachador confirma en Torre.
- Paradas `EN_SITIO` / `ENTREGADO` / `RECHAZADO` no se transfieren.
- Si la migración 006 no está aplicada, GPS y cron no rompen el sistema (degradan con logs).
