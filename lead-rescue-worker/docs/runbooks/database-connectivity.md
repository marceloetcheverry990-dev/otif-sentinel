# Runbook: Database Connectivity Alert

**Tipo de alerta:** `database_connectivity`  
**Severidad:** CRITICAL  
**Umbral:** Latencia > 30 segundos o error de conexión  
**Deduplicación:** 15 minutos entre alertas del mismo tipo  
**ETA de resolución:** 5–15 minutos si es transitorio · 30–60 minutos si Supabase está caído

---

## Síntomas

Mensaje de Telegram:

```
🚨 ALERTA: CRITICAL
Tipo: database_connectivity
Componente: database
Mensaje: Error de conectividad a base de datos: connection refused
```

O bien:
```
Mensaje: Base de datos respondiendo lentamente: 31500ms (umbral: 30s)
```

---

## Impacto

CRÍTICO. Todos los endpoints que leen o escriben en DB fallarán. Incluye:
- Procesamiento de leads (WMS webhook)
- Actualización de estado de órdenes
- Dashboard de control
- Sistema de alertas (no puede guardar en `alert_history`)

---

## Diagnóstico

### Paso 1 — Verificar si el worker sigue respondiendo

```
GET https://lead-rescue-pipeline.marceloetcheverry990.workers.dev/health
```

Respuesta esperada:
```json
{"status":"healthy","components":{"database":{"status":"connected","latency_ms":45}}}
```

Si `latency_ms > 500` pero responde: carga puntual en Supabase.  
Si `status: disconnected`: error de conexión activo.

### Paso 2 — Verificar estado de Supabase

Ir a: https://supabase.com/dashboard/project/cbjderarqvfwzrbqeqjv

- **Database → Health**: errores o carga alta
- **Logs → Database**: errores recientes
- **Settings → Database → Connection Pooler**: estado del pooler

También verificar: https://status.supabase.com

### Paso 3 — Ver conexiones activas (requiere acceso a Supabase SQL Editor)

```sql
SELECT count(*) AS conexiones_activas,
       state,
       wait_event_type,
       wait_event
FROM pg_stat_activity
WHERE datname = 'postgres'
GROUP BY state, wait_event_type, wait_event
ORDER BY conexiones_activas DESC;
```

Muchas conexiones `idle in transaction` → posible leak de conexiones.

### Paso 4 — Ver errores de conexión en los logs del worker

```sql
SELECT timestamp, error_type, error_message, endpoint, trace_id
FROM error_logs
WHERE timestamp > NOW() - INTERVAL '30 minutes'
  AND error_message ILIKE '%connection%'
ORDER BY timestamp DESC
LIMIT 20;
```

### Paso 5 — Identificar queries lentas

```sql
SELECT pid, now() - query_start AS duracion, query, state
FROM pg_stat_activity
WHERE state != 'idle'
  AND query_start < NOW() - INTERVAL '5 seconds'
ORDER BY duracion DESC;
```

---

## Mitigación

**Caso A — Supabase caído o en mantenimiento**
- Esperar a que Supabase recupere el servicio
- El worker tiene degradación graceful: operaciones de monitoreo fallan silenciosamente; el worker sigue respondiendo para endpoints que no usan DB

**Caso B — Timeout por carga alta**
- El `statement_timeout = 1000ms` del sistema de monitoreo mata queries lentas automáticamente
- Si hay queries de larga duración identificadas en el Paso 5:

> ⚠️ **ADVERTENCIA — operación con impacto en producción:**  
> `SELECT pg_terminate_backend(pid)` termina una conexión activa de forma inmediata.  
> Si la conexión tenía una transacción en curso, esa transacción se revierte (ROLLBACK automático).  
> Ejecutar solo si la query está bloqueada hace varios minutos y el impacto del ROLLBACK es aceptable.  
> Confirmar con el equipo antes de ejecutar en horario pico.

```sql
-- Verificar primero qué query tiene ese pid:
SELECT pid, query, state, now() - query_start AS duracion
FROM pg_stat_activity WHERE pid = <pid_identificado>;

-- Solo si confirmás que es seguro terminarla:
SELECT pg_terminate_backend(<pid>);
```

**Caso C — Pool de conexiones agotado**
- `withDb` cierra conexiones en `finally` siempre — leak improbable en código nuevo
- Si hay `idle in transaction` persistentes, puede ser `processEnrichmentQueue` o `processDeliveryQueue` (en lista "no tocar")
- Reiniciar el worker desde Cloudflare Dashboard → Workers → lead-rescue-pipeline → Deployments → Redeploy

**Caso D — Error de autenticación / Hyperdrive**
- Ir a Cloudflare Dashboard → Workers → lead-rescue-pipeline → Settings → Bindings
- Verificar que `HYPERDRIVE` esté activo y apuntando al ID `8390e963773c4f8e82886e7da7358f70`

---

## Verificación post-resolución

```
GET https://lead-rescue-pipeline.marceloetcheverry990.workers.dev/health
```

Debe responder: `"database":{"status":"connected","latency_ms":<200}`.

```sql
-- Confirmar que nuevos errores de conexión dejaron de aparecer:
SELECT COUNT(*) FROM error_logs
WHERE timestamp > NOW() - INTERVAL '5 minutes'
  AND error_message ILIKE '%connection%';
-- Esperado: 0
```

---

## Escalación

- **5 min sin mejora**: verificar https://www.cloudflarestatus.com (posible incident en Hyperdrive)
- **15 min sin mejora**: contactar soporte de Supabase con el Project ID `cbjderarqvfwzrbqeqjv`
- **30 min sin mejora**: evaluar si el sistema puede operar en modo degradado (sin escrituras a DB) hasta resolución

---

## Criterio de cierre del incidente

El incidente se considera resuelto cuando:
1. `/health` responde `"status":"connected"` con `latency_ms < 200` durante al menos 3 checks consecutivos
2. No aparecen nuevos errores de conexión en `error_logs` en los últimos 5 minutos
3. La alerta de monitoreo no se vuelve a disparar en el siguiente ciclo de cron (2 min)
