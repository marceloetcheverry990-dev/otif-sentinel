# Guía de Troubleshooting — OTIF Sentinel

**Sistema:** lead-rescue-pipeline
**Worker:** https://lead-rescue-pipeline.marceloetcheverry990.workers.dev
**Dashboard:** `/dashboard/monitoring` (credenciales: ver configuración interna del equipo)
**Meta-health:** `/health/monitoring`
**Última actualización:** 2026-06-14

---

## Índice

1. [Diagnóstico rápido (5 minutos)](#1-diagnóstico-rápido-5-minutos)
2. [Worker responde 503 / `/health` unhealthy](#2-worker-responde-503--health-unhealthy)
3. [`/health/monitoring` responde degraded](#3-healthmonitoring-responde-degraded)
4. [No llegan alertas de Telegram](#4-no-llegan-alertas-de-telegram)
5. [Error rate elevado](#5-error-rate-elevado)
6. [Circuit breaker abierto](#6-circuit-breaker-abierto)
7. [Cola acumulada / backlog](#7-cola-acumulada--backlog)
8. [DLQ creciendo](#8-dlq-creciendo)
9. [Dashboard sin datos](#9-dashboard-sin-datos--dashboard-loading-errors)
   - 9a. [Dashboard loading errors (HTTP 401 / 500 / pantalla en blanco)](#9a-dashboard-loading-errors-http-401--500--pantalla-en-blanco)
10. [Métricas dejan de registrarse (missing metrics)](#10-métricas-dejan-de-registrarse-missing-metrics)
11. [Alertas no aparecen en alert_history](#11-alertas-no-aparecen-en-alert_history)
12. [Problemas de conectividad DB](#12-problemas-de-conectividad-db)
13. [Performance degradada](#13-performance-degradada)
14. [Degradación graceful y mecanismos de fallback](#14-degradación-graceful-y-mecanismos-de-fallback)
    - 14.1 [Fallback de escrituras de monitoring a console.log](#141-fallback-de-escrituras-de-monitoring-a-consolelog)
    - 14.2 [Fallback de alertas de Telegram](#142-fallback-de-alertas-de-telegram)
    - 14.3 [Degradación de health check con latencia alta](#143-degradación-de-health-check-con-latencia-alta)
    - 14.4 [Sampling en métricas de bajo tráfico](#144-sampling-en-métricas-de-bajo-tráfico)
15. [Circuit breaker del sistema de monitoreo](#15-circuit-breaker-del-sistema-de-monitoreo)
    - 15.1 [Comportamiento del circuit breaker de monitoreo](#151-comportamiento-del-circuit-breaker-de-monitoreo)
    - 15.2 [Detectar que el circuit breaker de monitoreo está abierto](#152-detectar-que-el-circuit-breaker-de-monitoreo-está-abierto)
    - 15.3 [Recuperación del circuit breaker de monitoreo](#153-recuperación-del-circuit-breaker-de-monitoreo)
    - 15.4 [Activación y recuperación de circuit breakers de servicios externos](#154-activación-y-recuperación-de-circuit-breakers-de-servicios-externos)
16. [Queries SQL de ejemplo para análisis](#16-queries-sql-de-ejemplo-para-análisis)
    - 16.1 [Cálculo de tasa de errores](#161-cálculo-de-tasa-de-errores)
    - 16.2 [Identificación de queries lentas](#162-identificación-de-queries-lentas)
    - 16.3 [Extracción de métricas por tenant](#163-extracción-de-métricas-por-tenant)
    - 16.4 [Análisis del historial de alertas](#164-análisis-del-historial-de-alertas)
    - 16.5 [Queries de salud general del sistema de monitoreo](#165-queries-de-salud-general-del-sistema-de-monitoreo)
17. [Checklist: verificar salud del sistema de monitoreo](#17-checklist-verificar-salud-del-sistema-de-monitoreo)
18. [Escalación y soporte](#18-escalación-y-soporte)

---

## 1. Diagnóstico rápido (5 minutos)

Ejecutá estas 5 verificaciones en orden antes de profundizar en cualquier síntoma:

**V1 — ¿Está vivo el worker?**
```
GET /health
```
Esperado: `{"status":"healthy","components":{"database":{"status":"connected",...}}}`

**V2 — ¿El sistema de monitoreo está activo?**
```
GET /health/monitoring
```
Esperado: `{"status":"healthy","components":{"metrics_pipeline":{"status":"healthy",...}}}`

**V3 — ¿Hay errores recientes?**
```sql
SELECT severity, COUNT(*) FROM error_logs
WHERE timestamp > NOW() - INTERVAL '10 minutes'
GROUP BY severity ORDER BY count DESC;
```

**V4 — ¿Los circuit breakers están cerrados?**
```sql
SELECT key, value, updated_at FROM system_flags WHERE key LIKE '%breaker%';
```
Esperado: `value = 'CLOSED'` en todos.

**V5 — ¿El outbox está drenado?**
```sql
SELECT COUNT(*) AS pendientes FROM outbox_events WHERE processed_at IS NULL;
```
Esperado: bajo y estable (< 50 en condiciones normales).

---

## 2. Worker responde 503 / `/health` unhealthy

**Tiempo estimado:** 5–20 minutos

**Síntoma:** `/health` retorna HTTP 503 con `"status":"unhealthy"`, o endpoints del worker retornan error 5xx.

**Posibles causas:**
- DB desconectada o latencia > 200ms (timeout del health check)
- R2 storage inaccesible
- Binding de Hyperdrive inactivo en Cloudflare

**Diagnóstico:**

Leer el body completo de `/health`:
```json
{
  "components": {
    "database": { "status": "disconnected", "error": "connection refused" },
    "storage":  { "status": "inaccessible" },
    "queues":   { "status": "unavailable" }
  }
}
```
El componente con status distinto a `connected/accessible/available` indica el problema.

**Nota importante:** Un 503 con `database: disconnected` puede ser un falso positivo —
el health check tiene solo 200ms de timeout para la DB. Verificar nuevamente 1 minuto después.

**Mitigación:**
- DB: ver [Sección 12](#12-problemas-de-conectividad-db) y runbook [`database-connectivity.md`](runbooks/database-connectivity.md)
- R2: verificar binding `chat_photos` en Cloudflare Dashboard → Workers → Bindings
- Worker crasheado: Cloudflare Dashboard → Deployments → Redeploy

**Criterio de resolución:** `/health` responde HTTP 200 con `"status":"healthy"` en 3 checks consecutivos.

---

## 3. `/health/monitoring` responde degraded

**Tiempo estimado:** 2–5 minutos

**Síntoma:** `GET /health/monitoring` retorna `"status":"degraded"` con `metrics_pipeline.status = "degraded"`.

**Posibles causas:**
- No hay requests llegando al worker en los últimos 30 minutos (comportamiento normal si no hay tráfico)
- `recordMetric` fallando silenciosamente por error de DB

**Diagnóstico:**

```sql
SELECT MAX(timestamp) AS ultima_escritura,
       ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(timestamp)))/60, 1) AS minutos_sin_escritura
FROM metrics_summary;
```

- `minutos > 30` + sin tráfico real → esperado, no es incidente
- `minutos > 30` + hay tráfico → pipeline de métricas roto, ver [Sección 10](#10-métricas-dejan-de-registrarse)

**Criterio de resolución:** `/health/monitoring` retorna `metrics_pipeline.status = "healthy"` con
`minutes_since_last_write < 30`.

---

## 4. No llegan alertas de Telegram

**Tiempo estimado:** 5–10 minutos

**Síntoma:** Se esperaba una alerta (condición excede umbral) pero no llegó ningún mensaje al chat.

**Posibles causas:**
- La condición no superó el umbral realmente
- Alerta deduplicada (dentro de la ventana de 15 min — comportamiento correcto)
- Fallo en entrega a Telegram (token inválido, chat ID incorrecto)
- `evaluateAlerts()` fallando silenciosamente

**Diagnóstico:**

```sql
-- Paso 1: ¿Hay registros en alert_history?
SELECT alert_type, severity, delivery_status, delivery_error, timestamp
FROM alert_history
WHERE timestamp > NOW() - INTERVAL '30 minutes'
ORDER BY timestamp DESC;
```

| Resultado | Diagnóstico |
|-----------|-------------|
| Sin filas | `evaluateAlerts` no detectó condición o no corrió |
| Filas con `delivery_status = 'failed'` | Fallo en entrega a Telegram |
| Filas con `delivery_status = 'sent'` | Alerta enviada — revisar el chat correcto |

```sql
-- Paso 2: ¿La condición se cumplió realmente?
SELECT ROUND(
  COUNT(*) FILTER (WHERE severity IN ('ERROR','CRITICAL'))::numeric / NULLIF(COUNT(*),0) * 100, 2
) AS tasa_error_pct
FROM error_logs WHERE timestamp > NOW() - INTERVAL '5 minutes';
-- Si < 5, la alerta correctamente no se envió
```

```sql
-- Paso 3: Si delivery_status = 'failed', ver el error:
SELECT delivery_error FROM alert_history
WHERE delivery_status = 'failed' ORDER BY timestamp DESC LIMIT 3;
```

**Mitigación:**
- `delivery_status = 'failed'` con error de Telegram API: verificar que `TG_BOT_TOKEN` sea válido
  en Cloudflare Dashboard → Workers → Settings → Variables
- Sin filas y condición cumplida: puede haber un bug en `evaluateAlerts` — revisar
  logs del worker en Cloudflare Dashboard

**Criterio de resolución:** Alerta recibida en Telegram dentro de los 2 minutos del próximo
ciclo de cron cuando la condición sigue activa. `alert_history` muestra `delivery_status = 'sent'`.

---

## 5. Error rate elevado

**Tiempo estimado:** 5–30 minutos
→ Runbook completo: [`runbooks/high-error-rate.md`](runbooks/high-error-rate.md)

**Síntoma:** Alerta `high_error_rate` en Telegram, o el cálculo manual supera 5%.

**Queries clave:**
```sql
-- Endpoints con más errores
SELECT endpoint, COUNT(*) AS total, MAX(timestamp) AS ultimo
FROM error_logs
WHERE timestamp > NOW() - INTERVAL '30 minutes'
  AND severity IN ('ERROR','CRITICAL')
GROUP BY endpoint ORDER BY total DESC;

-- Errores agrupados por fingerprint
SELECT error_fingerprint, error_type, COUNT(*) AS ocurrencias,
       LEFT(error_message, 80) AS mensaje
FROM error_logs WHERE timestamp > NOW() - INTERVAL '1 hour'
GROUP BY error_fingerprint, error_type, LEFT(error_message, 80)
ORDER BY ocurrencias DESC LIMIT 10;
```

**Criterio de resolución:** Tasa de errores < 5% en los últimos 5 minutos.

---

## 6. Circuit breaker abierto

**Tiempo estimado:** 5 min (servicio disponible) / 30+ min (servicio caído)
→ Runbook completo: [`runbooks/circuit-breaker-open.md`](runbooks/circuit-breaker-open.md)

**Síntoma:** Alerta `circuit_breaker_open`, mensajes de choferes no se envían, o enriquecimiento IA detenido.

**Query clave:**
```sql
SELECT key, value, updated_at,
       ROUND(EXTRACT(EPOCH FROM (NOW() - updated_at))/60, 1) AS minutos_en_estado
FROM system_flags WHERE key LIKE '%breaker%';
```

> ⚠️ El UPDATE para cerrar manualmente solo debe ejecutarse si el servicio externo está disponible.
> Ver advertencia completa en el runbook.

**Criterio de resolución:** Todos los breakers con `value = 'CLOSED'` y outbox drenando.

---

## 7. Cola acumulada / backlog

**Tiempo estimado:** 5–15 minutos
→ Runbook completo: [`runbooks/queue-backlog.md`](runbooks/queue-backlog.md)

**Síntoma:** Alerta `high_queue_latency`, choferes reciben mensajes con retraso notable.

**Queries clave:**
```sql
-- Outbox pendiente por tipo
SELECT event_type, COUNT(*) AS pendientes, MIN(created_at) AS mas_antiguo
FROM outbox_events WHERE processed_at IS NULL GROUP BY event_type;

-- Latencia de colas
SELECT dimension_tags->>'queue_name' AS cola,
       ROUND(AVG(metric_value)/60000, 2) AS latencia_min
FROM metrics_summary WHERE metric_name = 'queue.processing.latency'
  AND timestamp > NOW() - INTERVAL '15 minutes'
GROUP BY 1;
```

**Criterio de resolución:** Latencia < 10 min, outbox estable o decreciendo.

---

## 8. DLQ creciendo

**Tiempo estimado:** 15–30 minutos
→ Runbook completo: [`runbooks/dlq-overflow.md`](runbooks/dlq-overflow.md)

**Síntoma:** Alerta `dlq_overflow`, o más de 100 mensajes nuevos en `dead_letter_events` en 1 hora.

**Queries clave:**
```sql
-- Volumen y tipos
SELECT event_type, reason, COUNT(*) AS cantidad
FROM dead_letter_events WHERE died_at > NOW() - INTERVAL '1 hour'
GROUP BY event_type, reason ORDER BY cantidad DESC;

-- ¿Sigue creciendo?
SELECT COUNT(*) FROM dead_letter_events WHERE died_at > NOW() - INTERVAL '5 minutes';
```

> ⚠️ No reprocesar mensajes hasta confirmar que la causa raíz está resuelta.
> Ver advertencia completa en el runbook.

**Criterio de resolución:** 0 mensajes nuevos en DLQ en los últimos 5 minutos.

---

## 9. Dashboard sin datos

**Tiempo estimado:** 5 minutos

**Síntoma:** `/dashboard/monitoring` carga pero no muestra métricas, errores o alertas,
o muestra datos desactualizados.

**Posibles causas:**
- Las tablas están vacías (sistema nuevo o sin tráfico reciente)
- Error de autenticación (credenciales incorrectas → el dashboard retorna 401)
- El time range selector está en un rango sin datos

**Diagnóstico:**
```sql
SELECT 'metrics_summary' AS tabla, COUNT(*) AS total, MAX(timestamp) AS ultimo
FROM metrics_summary
UNION ALL
SELECT 'error_logs', COUNT(*), MAX(timestamp) FROM error_logs
UNION ALL
SELECT 'alert_history', COUNT(*), MAX(timestamp) FROM alert_history;
```

**Pasos:**
1. Si las tablas tienen datos pero el dashboard no muestra → verificar que el time range
   selector incluye el período correcto (default: última 1 hora)
2. Si el dashboard retorna 401 → credenciales incorrectas (ver configuración interna del equipo)
3. Si las tablas están vacías → sistema sin tráfico; generar tráfico con un request a `/health`
   y esperar 1-2 minutos

**Endpoints a revisar:**
- `GET /api/dashboard/data` — retorna el JSON que alimenta el dashboard (requiere autenticación)

**Criterio de resolución:** El dashboard muestra datos actualizados en la sección
"Performance Metrics" y "Queue Status".

---

## 10. Métricas dejan de registrarse

**Tiempo estimado:** 5–10 minutos

**Síntoma:** `metrics_summary` no tiene filas nuevas en los últimos 30 minutos
a pesar de que hay tráfico hacia el worker.

**Posibles causas:**
- `recordMetric` falla silenciosamente por error de DB (el error no bloquea el request)
- El sampling del 10% hace que muchos requests no generen métricas (comportamiento correcto)
- `MONITORING_METRICS=false` en la configuración (no debería ocurrir)

**Diagnóstico:**
```sql
-- ¿Cuándo fue la última métrica?
SELECT metric_name, MAX(timestamp) AS ultima, COUNT(*) AS total_hoy
FROM metrics_summary
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY metric_name ORDER BY ultima DESC;
```

```sql
-- ¿Hay errores de métricas en error_logs?
SELECT error_message, timestamp FROM error_logs
WHERE error_message LIKE '%METRICS_ERROR%'
   OR error_message LIKE '%metric%'
ORDER BY timestamp DESC LIMIT 10;
```

**Nota sobre sampling:** `recordMetric` muestrea al 10% para requests exitosos y al 100%
para errores. En períodos de bajo tráfico (< 10 requests) puede no haber métricas — es esperado.

**Verificar configuración:**
```
GET /health/monitoring
→ components.metrics_pipeline.last_write
```
Si `last_write` es null → ninguna métrica fue escrita en las últimas 24h.

**Mitigación:**
- Si hay errores de DB silenciosos: ver [Sección 12](#12-problemas-de-conectividad-db)
- Si el sampling es la causa: hacer 20+ requests a `/health` y verificar nuevamente

**Criterio de resolución:** `metrics_summary` recibe nuevas filas dentro de los 5 minutos
posteriores a tráfico hacia el worker.

---

## 11. Alertas no aparecen en `alert_history`

**Tiempo estimado:** 5 minutos

**Síntoma:** Se esperaba que `evaluateAlerts` generara una alerta pero `alert_history` sigue vacía.

**Posibles causas:**
- La condición evaluada no superó el umbral
- La alerta fue deduplicada (estado in-memory del worker — se pierde entre invocaciones)
- `storeAlertHistory` falló silenciosamente por error de DB
- El cron no está corriendo

**Diagnóstico:**

```sql
-- ¿Hay alguna alerta reciente?
SELECT * FROM alert_history ORDER BY timestamp DESC LIMIT 5;
```

```sql
-- ¿El cron de evaluación está activo? Verificar última ejecución indirecta:
-- Si hay métricas recientes, el cron */2 corre
SELECT MAX(timestamp) AS ultimo_cron_indirecto FROM metrics_summary
WHERE timestamp > NOW() - INTERVAL '10 minutes';
```

**Verificar umbrales actuales:**

| Alerta | Umbral configurado |
|--------|--------------------|
| `database_connectivity` | Latencia > 30s o error de conexión |
| `high_error_rate` | Tasa > 5% en ventana de 5 min |
| `high_response_time` | p95 > 3000ms en ventana de 5 min |
| `high_queue_latency` | Latencia > 10 min |
| `circuit_breaker_open` | OPEN > 10 min |
| `dlq_overflow` | > 100 mensajes en 1 hora |

Si ninguna condición supera estos valores, el comportamiento es correcto — no hay alertas.

**Mitigación:**
- Si el cron no corre: verificar en Cloudflare Dashboard → Workers → Triggers → Cron
  que `*/2 * * * *` aparece listado
- Si `storeAlertHistory` falla: ver [Sección 12](#12-problemas-de-conectividad-db)

**Criterio de resolución:** `alert_history` recibe una nueva fila dentro de los 2 minutos
posteriores a una condición que supera el umbral.

---

## 12. Problemas de conectividad DB

**Tiempo estimado:** 5–60 minutos
→ Runbook completo: [`runbooks/database-connectivity.md`](runbooks/database-connectivity.md)

**Síntoma:** `/health` muestra `database: disconnected`, errores con `connection refused` en logs,
o múltiples secciones de esta guía fallan simultáneamente.

**Queries clave (en Supabase SQL Editor):**
```sql
-- Conexiones activas
SELECT count(*) AS total, state FROM pg_stat_activity
WHERE datname = 'postgres' GROUP BY state ORDER BY total DESC;

-- Queries lentas
SELECT pid, now() - query_start AS duracion, LEFT(query,80) AS query, state
FROM pg_stat_activity WHERE state != 'idle'
  AND query_start < NOW() - INTERVAL '5 seconds'
ORDER BY duracion DESC;
```

**Endpoints a revisar:**
- `GET /health` → `components.database`
- Supabase Dashboard: https://supabase.com/dashboard/project/cbjderarqvfwzrbqeqjv
- Status: https://status.supabase.com

**Criterio de resolución:** `/health` responde `database: connected` con `latency_ms < 200`
durante 3 checks consecutivos.

---

## 9a. Dashboard loading errors (HTTP 401 / 500 / pantalla en blanco)

**Tiempo estimado:** 2–10 minutos

**Síntoma:** El navegador muestra pantalla en blanco, error HTTP 401 o 500 al abrir `/dashboard/monitoring`.

**Causas y soluciones:**

| Error observado | Causa probable | Acción |
|-----------------|---------------|--------|
| HTTP 401 con `WWW-Authenticate` | Credenciales incorrectas / JWT expirado | Verificar `MONITORING_USERNAME`, `MONITORING_PASSWORD` o renovar JWT |
| HTTP 500 | Error inesperado en `renderDashboard()` | Ver Cloudflare Dashboard → Workers → Logs |
| Pantalla en blanco | Chart.js no carga desde CDN (CSP bloqueado o sin internet) | Revisar Content Security Policy en respuesta; usar conexión sin proxy |
| Error CORS en `/api/dashboard/data` | Dominio no autorizado en CORS_HEADERS | Verificar configuración de `CORS_HEADERS` en `config.js` |
| "No data available" en métricas | Tables vacías o time range sin datos | Ver [Sección 9](#9-dashboard-sin-datos--dashboard-loading-errors) |

**Verificar autenticación manualmente:**
```bash
# JWT
curl -H "Authorization: Bearer <token>" https://lead-rescue-pipeline.marceloetcheverry990.workers.dev/api/dashboard/data

# Basic Auth
curl -u "usuario:contraseña" https://lead-rescue-pipeline.marceloetcheverry990.workers.dev/api/dashboard/data
```
Esperado: JSON con `health`, `metrics`, `errors`, `alerts`.

**Criterio de resolución:** Dashboard carga con HTTP 200 y muestra secciones de métricas.

---

## 13. Performance degradada

**Tiempo estimado:** 10–30 minutos
→ Ver también: [`runbooks/high-error-rate.md`](runbooks/high-error-rate.md)

**Síntoma:** Alerta `high_response_time`, usuarios reportan lentitud, o p95 > 3000ms.

**Posibles causas:**
- Queries DB lentas (sin índice, tabla grande, lock contention)
- Batch de métricas en proceso de escritura bloqueando conexión
- OpenAI o Telegram API respondiendo lento (impacta enrichment y delivery queues)
- Worker en modo de alta carga: muchas requests concurrentes

**Diagnóstico paso a paso:**

**Paso 1 — ¿El problema es DB?**
```sql
-- Queries actualmente corriendo > 2 segundos
SELECT pid,
       ROUND(EXTRACT(EPOCH FROM (NOW() - query_start))::numeric, 2) AS secs,
       LEFT(query, 100) AS query,
       state,
       wait_event_type,
       wait_event
FROM pg_stat_activity
WHERE state != 'idle'
  AND query_start < NOW() - INTERVAL '2 seconds'
ORDER BY secs DESC;
```

```sql
-- ¿Cuáles son los endpoints más lentos según métricas?
SELECT
  dimension_tags->>'endpoint' AS endpoint,
  ROUND(AVG(metric_value)::numeric, 0) AS avg_ms,
  ROUND(MAX(metric_value)::numeric, 0) AS max_ms,
  COUNT(*) AS n
FROM metrics_summary
WHERE metric_name = 'http.request.duration'
  AND timestamp > NOW() - INTERVAL '30 minutes'
GROUP BY endpoint
ORDER BY avg_ms DESC
LIMIT 10;
```

**Paso 2 — ¿Hay contención de conexiones?**
```sql
SELECT state, COUNT(*) AS total
FROM pg_stat_activity
WHERE datname = 'postgres'
GROUP BY state
ORDER BY total DESC;
```
Si `active` > 15 o `idle in transaction` > 0 por más de 30s → posible leak de conexiones o queries sin commit.

**Paso 3 — ¿El circuit breaker está influyendo?**
```sql
SELECT key, value, updated_at
FROM system_flags WHERE key LIKE '%breaker%';
```
Si `openai_breaker = 'OPEN'` → enriquecimiento IA saltado, puede ser intencional.
Si `tg_breaker_% = 'OPEN'` → delivery Telegram saltado, mensajes se acumulan.

**Paso 4 — Verificar métricas p95 recientes:**
```sql
SELECT
  metric_name,
  ROUND(metric_value::numeric, 0) AS value_ms,
  aggregation_type,
  timestamp
FROM metrics_summary
WHERE metric_name = 'http.request.duration'
  AND aggregation_type IN ('p95', 'p99')
  AND timestamp > NOW() - INTERVAL '1 hour'
ORDER BY timestamp DESC
LIMIT 20;
```

**Mitigación:**
- Queries lentas: identificar el query por PID y hacer `SELECT pg_cancel_backend(<pid>)` si está colgado
- Contención alta: verificar que Hyperdrive tenga pool size adecuado (ver `wrangler.jsonc`)
- Carga de worker: Cloudflare limita CPU a 50ms por request en plan gratuito;
  revisar si hay operaciones síncronas costosas en el path crítico

**Criterio de resolución:** p95 < 3000ms sostenido por 5 minutos. Alerta `high_response_time`
no vuelve a dispararse.

---

## 14. Degradación graceful y mecanismos de fallback

Esta sección documenta los comportamientos automáticos del sistema cuando componentes
falla — no requieren intervención manual a menos que la degradación sea prolongada.

### 14.1 Fallback de escrituras de monitoring a console.log

**Comportamiento:**
Cuando `recordMetric()`, `captureError()`, o `storeAlertHistory()` fallan por error de DB,
el sistema **no lanza excepción ni bloquea la request**. En cambio:

1. El error de monitoreo se registra con prefijo `[MONITORING_ERROR]` en console.
2. La operación de negocio (el request del usuario) continúa sin interrupción.
3. El dato de monitoreo se pierde para esa operación — se registra como dato perdido en el contador interno.

**Cuándo ocurre:**
- DB caída o con timeout > 1000ms
- Pool de conexiones agotado
- Circuit breaker de monitoreo abierto (ver [Sección 14.2](#142-circuit-breaker-del-sistema-de-monitoreo))

**Verificar que el fallback está activo:**
```
GET /health/monitoring
→ components.metrics_pipeline.status = "degraded"
→ errors: [{ "component": "metrics_pipeline", "error": "..." }]
```

Mientras el status sea "degraded" **el worker sigue procesando requests normalmente**;
solo se pierde observabilidad temporal.

### 14.2 Fallback de alertas de Telegram

**Comportamiento:**
Si `sendAlert()` falla (timeout, token inválido, rate limit de Telegram):
- `delivery_status` en `alert_history` queda como `'failed'`
- `delivery_error` almacena el mensaje de error
- El sistema no reintenta automáticamente (el próximo ciclo de cron evaluará la condición nuevamente)
- No se lanza excepción — el cron continúa con la siguiente alerta

**Verificar:**
```sql
SELECT alert_type, delivery_status, delivery_error, timestamp
FROM alert_history
WHERE delivery_status = 'failed'
ORDER BY timestamp DESC LIMIT 5;
```

### 14.3 Degradación de health check con latencia alta

**Comportamiento:**
El health check tiene un timeout de **200ms para la DB**. Si la DB responde en
201ms–1000ms, el endpoint retorna **HTTP 503** aunque la DB sea funcional.

Esto es un falso positivo conocido — el worker sigue procesando requests normalmente.

**Cómo distinguir degradación de fallo real:**
- 503 transitorio (aparece 1-2 veces, luego 200): latencia momentánea, no es incidente
- 503 sostenido (> 5 checks consecutivos): fallo real, activar runbook de [Sección 2](#2-worker-responde-503--health-unhealthy)

### 14.4 Sampling en métricas de bajo tráfico

**Comportamiento:**
`recordMetric()` aplica muestreo: **10% de requests exitosos** y **100% de errores**.
En períodos de bajo tráfico (< 10 requests en 5 minutos) puede no haber métricas —
esto es esperado y no indica fallo.

El dashboard mostrará "sin datos" para ese rango de tiempo. Verificar con:
```sql
SELECT COUNT(*) FROM metrics_summary
WHERE timestamp > NOW() - INTERVAL '5 minutes';
```
0 resultados con bajo tráfico es normal.

---

## 15. Circuit breaker del sistema de monitoreo

El sistema de monitoreo implementa su propio circuit breaker para proteger el worker
de fallos en cascada cuando la DB de monitoreo no está disponible.

### 15.1 Comportamiento del circuit breaker de monitoreo

**Implementación:** `src/monitoring/meta-health.js` + guards en `src/monitoring/metrics.js`
y `src/monitoring/errors.js`.

**Estados:**

| Estado | Descripción | Comportamiento |
|--------|-------------|----------------|
| `CLOSED` (normal) | DB de monitoreo responde | Escrituras normales a DB |
| `OPEN` (degradado) | 5 fallos consecutivos de DB | Solo `console.log`; no escribe a DB |
| Recuperación | Después de 60s en OPEN | Prueba 1 escritura; si exitosa → CLOSED |

**Umbral de activación:** 5 fallos consecutivos de operaciones de DB de monitoreo.
**Timeout de reset:** 60 segundos.

**Nota:** Este circuit breaker es diferente a `openai_breaker` y `tg_breaker` que residen
en `system_flags`. El circuit breaker de monitoreo es **in-memory** (no persiste en DB).

### 15.2 Detectar que el circuit breaker de monitoreo está abierto

```
GET /health/monitoring
```

Respuesta cuando circuit breaker de monitoreo está abierto:
```json
{
  "status": "degraded",
  "components": {
    "metrics_pipeline": {
      "status": "degraded",
      "reason": "No metric writes in the last 30 minutes"
    }
  },
  "errors": [
    { "component": "metrics_pipeline", "error": "circuit breaker open" }
  ]
}
```

Logs del worker (Cloudflare Dashboard → Workers → Logs):
```
[MONITORING_ERROR] DB write failed (attempt 5/5) — opening circuit breaker
[MONITORING_FALLBACK] Metrics fallback to console: { metric_name: "http.request.duration", ... }
```

### 15.3 Recuperación del circuit breaker de monitoreo

El circuit breaker **se recupera automáticamente** — no requiere intervención manual a menos que
la causa raíz (DB inaccesible) persista.

**Proceso de recuperación automático:**
1. Después de 60 segundos en estado OPEN, el breaker entra en estado **half-open**.
2. La siguiente operación de DB se intenta como prueba.
3. Si la DB responde OK → estado vuelve a CLOSED; escrituras se reanudan.
4. Si la DB sigue fallando → estado vuelve a OPEN; espera otros 60s.

**Forzar recuperación manual (solo si se confirmó que la DB está disponible):**

No existe endpoint de reset manual. Si la DB se recuperó pero el worker sigue en OPEN
(el contador de fallos persiste in-memory por la duración de vida del worker isolation),
el Cloudflare Worker se reiniciará naturalmente en la siguiente invocación desde cold start,
lo que reinicia el estado del circuit breaker.

Para forzar un cold start: **redeploy del worker** desde Cloudflare Dashboard o:
```bash
# Con wrangler (desde la raíz del proyecto)
npx wrangler deploy
```

### 15.4 Activación y recuperación de circuit breakers de servicios externos

Los circuit breakers `openai_breaker` y `tg_breaker_*` residen en `system_flags` (DB) y
su estado persiste entre reinicios del worker.

**Activación automática:**
- `openai_breaker`: se abre cuando OpenAI API falla repetidamente (lógica en `src/ai.js`)
- `tg_breaker_<chat_id>`: se abre cuando Telegram API falla repetidamente (lógica en delivery queue)

**Recuperación automática:** el breaker intenta reconectarse después del timeout configurado.

**Verificar estado:**
```sql
SELECT key, value, updated_at,
       ROUND(EXTRACT(EPOCH FROM (NOW() - updated_at))/60, 1) AS minutos_en_estado
FROM system_flags
WHERE key LIKE '%breaker%'
ORDER BY key;
```

**Cierre manual de emergency (solo si el servicio externo está confirmado disponible):**
```sql
-- ⚠️ EJECUTAR SOLO SI EL SERVICIO EXTERNO ESTÁ DISPONIBLE
-- Requiere confirmación del equipo de operaciones
UPDATE system_flags
SET value = 'CLOSED', updated_at = NOW()
WHERE key = 'openai_breaker';   -- o 'tg_breaker_<chat_id>'
```
→ Runbook completo: [`runbooks/circuit-breaker-open.md`](runbooks/circuit-breaker-open.md)

---

## 16. Queries SQL de ejemplo para análisis

Esta sección consolida queries útiles para análisis operacional recurrente.
Todas están diseñadas para ejecutarse desde el **Supabase SQL Editor** o cualquier cliente
PostgreSQL con acceso al proyecto `cbjderarqvfwzrbqeqjv`.

### 16.1 Cálculo de tasa de errores

```sql
-- Tasa de errores global en las últimas N horas
SELECT
  DATE_TRUNC('hour', timestamp) AS hora,
  COUNT(*) FILTER (WHERE severity IN ('ERROR','CRITICAL')) AS errores,
  COUNT(*) AS total,
  ROUND(
    COUNT(*) FILTER (WHERE severity IN ('ERROR','CRITICAL'))::numeric
    / NULLIF(COUNT(*), 0) * 100,
    2
  ) AS tasa_error_pct
FROM error_logs
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY hora
ORDER BY hora DESC;
```

```sql
-- Tasa de errores por endpoint (últimas 6 horas)
SELECT
  endpoint,
  COUNT(*) FILTER (WHERE severity IN ('ERROR','CRITICAL')) AS errores,
  COUNT(*) AS total,
  ROUND(
    COUNT(*) FILTER (WHERE severity IN ('ERROR','CRITICAL'))::numeric
    / NULLIF(COUNT(*), 0) * 100,
    2
  ) AS tasa_error_pct
FROM error_logs
WHERE timestamp > NOW() - INTERVAL '6 hours'
GROUP BY endpoint
ORDER BY tasa_error_pct DESC, total DESC;
```

### 16.2 Identificación de queries lentas

```sql
-- Queries lentas registradas como métricas (últimas 2 horas)
SELECT
  dimension_tags->>'query_type' AS tipo_query,
  ROUND(AVG(metric_value)::numeric, 0) AS avg_ms,
  ROUND(MAX(metric_value)::numeric, 0) AS max_ms,
  ROUND(
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY metric_value)::numeric, 0
  ) AS p95_ms,
  COUNT(*) AS n
FROM metrics_summary
WHERE metric_name = 'db.query.duration'
  AND timestamp > NOW() - INTERVAL '2 hours'
GROUP BY tipo_query
ORDER BY p95_ms DESC;
```

```sql
-- Queries actualmente en ejecución > 3 segundos (tiempo real en Supabase)
SELECT
  pid,
  ROUND(EXTRACT(EPOCH FROM (NOW() - query_start))::numeric, 1) AS secs_running,
  state,
  wait_event_type,
  LEFT(query, 120) AS query_preview
FROM pg_stat_activity
WHERE datname = 'postgres'
  AND state != 'idle'
  AND query_start < NOW() - INTERVAL '3 seconds'
ORDER BY secs_running DESC;
```

```sql
-- Top 10 queries más frecuentes y lentas (pg_stat_statements, si está habilitado)
SELECT
  LEFT(query, 100) AS query_preview,
  calls,
  ROUND(mean_exec_time::numeric, 2) AS avg_ms,
  ROUND(max_exec_time::numeric, 2) AS max_ms,
  ROUND(total_exec_time::numeric / 1000, 2) AS total_secs
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

### 16.3 Extracción de métricas por tenant

```sql
-- Errores por tenant (últimas 24 horas)
SELECT
  COALESCE(tenant_id, '(sin tenant)') AS tenant,
  severity,
  COUNT(*) AS total,
  MAX(timestamp) AS ultimo_error
FROM error_logs
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY tenant, severity
ORDER BY tenant, severity;
```

```sql
-- Métricas de performance por tenant (últimas 6 horas)
SELECT
  dimension_tags->>'tenant_id' AS tenant,
  metric_name,
  ROUND(AVG(metric_value)::numeric, 0) AS avg_value,
  ROUND(MAX(metric_value)::numeric, 0) AS max_value,
  COUNT(*) AS n
FROM metrics_summary
WHERE timestamp > NOW() - INTERVAL '6 hours'
  AND dimension_tags->>'tenant_id' IS NOT NULL
GROUP BY tenant, metric_name
ORDER BY tenant, metric_name;
```

```sql
-- Requests por tenant en la última hora
SELECT
  dimension_tags->>'tenant_id' AS tenant,
  COUNT(*) AS requests,
  ROUND(AVG(metric_value)::numeric, 0) AS avg_response_ms
FROM metrics_summary
WHERE metric_name = 'http.request.count'
  AND timestamp > NOW() - INTERVAL '1 hour'
GROUP BY tenant
ORDER BY requests DESC;
```

### 16.4 Análisis del historial de alertas

```sql
-- Alertas de las últimas 24 horas con estado de entrega
SELECT
  timestamp,
  alert_type,
  severity,
  component,
  metric_value,
  threshold_value,
  delivery_status,
  delivery_error,
  acknowledged_at
FROM alert_history
WHERE timestamp > NOW() - INTERVAL '24 hours'
ORDER BY timestamp DESC;
```

```sql
-- Resumen de alertas por tipo y severidad (últimos 7 días)
SELECT
  alert_type,
  severity,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE delivery_status = 'sent') AS entregadas,
  COUNT(*) FILTER (WHERE delivery_status = 'failed') AS fallidas,
  COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL) AS reconocidas,
  MAX(timestamp) AS ultima_ocurrencia
FROM alert_history
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY alert_type, severity
ORDER BY total DESC;
```

```sql
-- Alertas sin reconocer (pendientes de acción)
SELECT
  id,
  timestamp,
  alert_type,
  severity,
  component,
  message,
  delivery_status,
  ROUND(EXTRACT(EPOCH FROM (NOW() - timestamp))/60, 0) AS minutos_sin_accion
FROM alert_history
WHERE acknowledged_at IS NULL
  AND severity IN ('ERROR', 'CRITICAL')
  AND timestamp > NOW() - INTERVAL '24 hours'
ORDER BY timestamp ASC;
```

```sql
-- Tiempo promedio de resolución de alertas (MTTR)
SELECT
  alert_type,
  ROUND(
    AVG(EXTRACT(EPOCH FROM (acknowledged_at - timestamp))/60)::numeric, 1
  ) AS avg_minutos_resolucion,
  COUNT(*) AS total_resueltas
FROM alert_history
WHERE acknowledged_at IS NOT NULL
  AND timestamp > NOW() - INTERVAL '30 days'
GROUP BY alert_type
ORDER BY avg_minutos_resolucion DESC;
```

### 16.5 Queries de salud general del sistema de monitoreo

```sql
-- Resumen del estado de las tablas de monitoreo
SELECT
  'error_logs'          AS tabla,
  COUNT(*)              AS total_filas,
  MAX(timestamp)        AS ultimo_registro,
  pg_size_pretty(pg_total_relation_size('error_logs')) AS tamaño
FROM error_logs
UNION ALL
SELECT
  'metrics_summary',
  COUNT(*),
  MAX(timestamp),
  pg_size_pretty(pg_total_relation_size('metrics_summary'))
FROM metrics_summary
UNION ALL
SELECT
  'alert_history',
  COUNT(*),
  MAX(timestamp),
  pg_size_pretty(pg_total_relation_size('alert_history'))
FROM alert_history
UNION ALL
SELECT
  'health_check_results',
  COUNT(*),
  MAX(timestamp),
  pg_size_pretty(pg_total_relation_size('health_check_results'))
FROM health_check_results;
```

```sql
-- Disponibilidad del sistema según health_check_results (últimas 24 horas)
SELECT
  COUNT(*) FILTER (WHERE overall_status = 'healthy')   AS checks_healthy,
  COUNT(*) FILTER (WHERE overall_status = 'degraded')  AS checks_degraded,
  COUNT(*) FILTER (WHERE overall_status = 'unhealthy') AS checks_unhealthy,
  COUNT(*)                                              AS total_checks,
  ROUND(
    COUNT(*) FILTER (WHERE overall_status = 'healthy')::numeric
    / NULLIF(COUNT(*), 0) * 100, 2
  ) AS uptime_pct
FROM health_check_results
WHERE timestamp > NOW() - INTERVAL '24 hours';
```

---

## 17. Checklist: verificar salud del sistema de monitoreo

Usar este checklist después de un deploy, un incidente, o en revisiones operacionales
periódicas (recomendado: semanal).

### ✅ Verificación básica (< 5 minutos)

- [ ] **Worker activo:** `GET /health` → HTTP 200 con `"status":"healthy"`
- [ ] **DB conectada:** `components.database.status = "connected"` y `latency_ms < 200`
- [ ] **R2 accesible:** `components.storage.status = "accessible"`
- [ ] **Queues disponibles:** `components.queues.status = "available"`
- [ ] **Monitoreo activo:** `GET /health/monitoring` → HTTP 200 con `"status":"healthy"` o `"degraded"` (no error 500)
- [ ] **Pipeline de métricas:** `components.metrics_pipeline.minutes_since_last_write < 30`
  (si hay tráfico activo)
- [ ] **Circuit breakers cerrados:**
  ```sql
  SELECT key, value FROM system_flags WHERE key LIKE '%breaker%';
  ```
  Todos deben tener `value = 'CLOSED'`

### ✅ Verificación de alertas (< 5 minutos)

- [ ] **Sin alertas críticas no resueltas:**
  ```sql
  SELECT COUNT(*) FROM alert_history
  WHERE severity = 'CRITICAL'
    AND acknowledged_at IS NULL
    AND timestamp > NOW() - INTERVAL '24 hours';
  ```
  Esperado: 0
- [ ] **Pipeline de alertas operativo:** al menos 1 alerta enviada correctamente en los
  últimos 7 días (o sin condiciones que deberían haber generado alertas)
  ```sql
  SELECT COUNT(*) FROM alert_history
  WHERE delivery_status = 'sent'
    AND timestamp > NOW() - INTERVAL '7 days';
  ```
- [ ] **Sin alertas fallidas recurrentes:**
  ```sql
  SELECT alert_type, COUNT(*) FROM alert_history
  WHERE delivery_status = 'failed'
    AND timestamp > NOW() - INTERVAL '24 hours'
  GROUP BY alert_type;
  ```
  Esperado: 0 filas, o 1-2 fallos aislados (no patrones repetitivos)

### ✅ Verificación de datos (< 5 minutos)

- [ ] **Tasa de errores normal (< 5%):**
  ```sql
  SELECT ROUND(
    COUNT(*) FILTER (WHERE severity IN ('ERROR','CRITICAL'))::numeric
    / NULLIF(COUNT(*),0) * 100, 2
  ) AS tasa_pct
  FROM error_logs WHERE timestamp > NOW() - INTERVAL '1 hour';
  ```
- [ ] **Sin errores CRITICAL recientes:**
  ```sql
  SELECT COUNT(*) FROM error_logs
  WHERE severity = 'CRITICAL'
    AND timestamp > NOW() - INTERVAL '1 hour';
  ```
  Esperado: 0
- [ ] **Métricas recientes disponibles:**
  ```sql
  SELECT metric_name, MAX(timestamp) AS ultimo
  FROM metrics_summary
  WHERE timestamp > NOW() - INTERVAL '1 hour'
  GROUP BY metric_name;
  ```
  Esperado: al menos `http.request.duration` o `http.request.count` si hubo tráfico

### ✅ Verificación de retención (mensual)

- [ ] **Particiones de métricas creadas para el próximo mes:**
  ```sql
  SELECT relname FROM pg_class
  WHERE relname LIKE 'metrics_summary_%'
    AND relkind = 'r'
  ORDER BY relname DESC LIMIT 4;
  ```
  La más reciente debe ser el mes siguiente al actual.
- [ ] **Sin datos huérfanos fuera de retención:**
  ```sql
  SELECT COUNT(*) FROM error_logs
  WHERE timestamp < NOW() - INTERVAL '90 days';
  -- Esperado: 0 (cleanup diario activo)
  ```
- [ ] **Tamaño de tablas monitoreado:**
  ```sql
  SELECT
    tablename,
    pg_size_pretty(pg_total_relation_size('public.'||tablename)) AS tamaño
  FROM pg_tables
  WHERE tablename IN ('error_logs','metrics_summary','alert_history','health_check_results')
  ORDER BY pg_total_relation_size('public.'||tablename) DESC;
  ```
  Alerta si `metrics_summary` supera 500MB (ajustar según plan de Supabase).

### ✅ Verificación del dashboard (< 2 minutos)

- [ ] **Dashboard carga correctamente:** `GET /dashboard/monitoring` → HTTP 200 con HTML
- [ ] **Autenticación funciona:** credenciales válidas aceptadas, inválidas rechazadas (HTTP 401)
- [ ] **Data API responde:** `GET /api/dashboard/data` → JSON con `health`, `metrics`, `errors`
- [ ] **Auto-refresh activo:** la página se refresca automáticamente cada 30 segundos
  (verificar en DevTools → Network que hay un fetch periódico a `/api/dashboard/data`)

---

## 18. Escalación y soporte

### Criterios de escalación

| Condición | Acción |
|-----------|--------|
| Worker completamente caído (0% requests procesados) | Escalación inmediata — Cloudflare Dashboard o redeploy |
| DB inaccesible > 5 minutos | Abrir incidente en Supabase + notificar equipo |
| Circuit breaker de OpenAI abierto > 30 minutos | Verificar status.openai.com + revisar cuota API |
| DLQ > 500 mensajes acumulados | Escalación inmediata — posible pérdida de datos |
| Monitoreo degraded > 1 hora | Investigar causa raíz; el negocio opera pero sin visibilidad |

### Contactos y recursos

| Recurso | URL / Contacto |
|---------|----------------|
| Worker (production) | https://lead-rescue-pipeline.marceloetcheverry990.workers.dev |
| Dashboard de monitoreo | `<worker_url>/dashboard/monitoring` |
| Meta-health | `<worker_url>/health/monitoring` |
| Cloudflare Dashboard | https://dash.cloudflare.com |
| Supabase Dashboard | https://supabase.com/dashboard/project/cbjderarqvfwzrbqeqjv |
| Status Supabase | https://status.supabase.com |
| Status Cloudflare | https://www.cloudflarestatus.com |
| Logs del worker | Cloudflare Dashboard → Workers & Pages → lead-rescue-pipeline → Logs |

### Runbooks disponibles

| Incidente | Runbook |
|-----------|---------|
| DB inaccesible | [`docs/runbooks/database-connectivity.md`](runbooks/database-connectivity.md) |
| Tasa de errores alta | [`docs/runbooks/high-error-rate.md`](runbooks/high-error-rate.md) |
| Cola con backlog | [`docs/runbooks/queue-backlog.md`](runbooks/queue-backlog.md) |
| Circuit breaker abierto | [`docs/runbooks/circuit-breaker-open.md`](runbooks/circuit-breaker-open.md) |
| DLQ desbordada | [`docs/runbooks/dlq-overflow.md`](runbooks/dlq-overflow.md) |

---

*Última actualización: 2026-06-14 — Requirements: 12.6, 12.7*

---

## 13. Escalación y soporte

### Cuándo escalar

| Tiempo sin resolución | Acción |
|----------------------|--------|
| 5 min | Revisar status pages externas (Supabase, Cloudflare, Telegram, OpenAI) |
| 15 min | Contactar al responsable técnico del sistema |
| 30 min | Si afecta SLA de clientes, notificar al equipo de operaciones |
| 60 min | Evaluar modo de operación degradada (sin escrituras a DB, notificaciones manuales) |

### Status pages externas

| Servicio | URL |
|---------|-----|
| Cloudflare (Workers + Hyperdrive) | https://www.cloudflarestatus.com |
| Supabase | https://status.supabase.com |
| Telegram | https://downdetector.com/status/telegram |
| OpenAI | https://status.openai.com |

### Información para escalación

Al escalar, incluir:
- URL del incidente: qué endpoint falló y cuándo
- Output de `GET /health` y `GET /health/monitoring`
- Output de las queries V3, V4, V5 del [Diagnóstico rápido](#1-diagnóstico-rápido-5-minutos)
- Última alerta recibida en Telegram (si aplica)
- Último deploy conocido (`wrangler deploy` genera un `Version ID` en el output)

### Accesos necesarios para diagnóstico

| Sistema | Acceso requerido |
|---------|-----------------|
| Supabase SQL Editor | Dashboard de Supabase con el proyecto `cbjderarqvfwzrbqeqjv` |
| Cloudflare Workers | Dashboard de Cloudflare → Workers → lead-rescue-pipeline |
| Logs del worker | Cloudflare Dashboard → Workers → lead-rescue-pipeline → Logs |
| Variables de entorno | Cloudflare Dashboard → Workers → Settings → Variables |

### Issues conocidos (no son incidentes)

1. **`MONITORING_ENABLED=false` no desactiva el middleware** — bug de integración pendiente.
   `withMonitoring` lee el objeto estático de config, no las env vars. No tiene impacto operativo
   mientras el monitoreo deba estar activo.

2. **Retention de particiones en modo observación** — `enforceRetentionPolicies` lista particiones
   candidatas pero no ejecuta DROP. Decisión deliberada de seguridad para la primera versión.

3. **`/health` puede mostrar 503 transitorio** — el health check tiene 200ms de timeout para la DB.
   Bajo carga o latencia puntual de Supabase, puede fallar. Verificar nuevamente 1 minuto después
   antes de tratar como incidente.
