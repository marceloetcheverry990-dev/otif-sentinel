# Runbook: High Error Rate Alert

**Tipo de alerta:** `high_error_rate`  
**Severidad:** ERROR (>5%) / CRITICAL (>10%)  
**Umbral:** Tasa de errores > 5% en ventana de 5 minutos  
**Deduplicación:** 15 minutos entre alertas del mismo tipo  
**ETA de resolución:** 5–10 minutos para diagnóstico · 10–30 minutos para resolución según causa

---

## Síntomas

```
🔴 ALERTA: ERROR
Tipo: high_error_rate
Componente: application
Valor actual: 8.33%
Umbral: 5%
Mensaje: Tasa de errores elevada: 8.33% en los últimos 5 minutos (umbral: 5%)
```

---

## Impacto

Variable según causa. Puede ir desde errores en un endpoint específico hasta fallo sistémico. El impacto en negocio depende del endpoint afectado.

---

## Diagnóstico

### Paso 1 — Ver errores recientes

```sql
SELECT error_type, error_message, severity, endpoint, trace_id, timestamp
FROM error_logs
WHERE timestamp > NOW() - INTERVAL '10 minutes'
ORDER BY timestamp DESC
LIMIT 20;
```

### Paso 2 — Identificar el endpoint con más errores

```sql
SELECT endpoint,
       COUNT(*) AS error_count,
       COUNT(DISTINCT error_fingerprint) AS tipos_distintos,
       MAX(timestamp) AS ultimo_error
FROM error_logs
WHERE timestamp > NOW() - INTERVAL '30 minutes'
  AND severity IN ('ERROR', 'CRITICAL')
GROUP BY endpoint
ORDER BY error_count DESC;
```

### Paso 3 — Agrupar por fingerprint para ver patrones

```sql
SELECT error_fingerprint,
       error_type,
       LEFT(error_message, 100) AS mensaje,
       COUNT(*) AS ocurrencias,
       MIN(timestamp) AS primera_vez,
       MAX(timestamp) AS ultima_vez
FROM error_logs
WHERE timestamp > NOW() - INTERVAL '1 hour'
GROUP BY error_fingerprint, error_type, LEFT(error_message, 100)
ORDER BY ocurrencias DESC
LIMIT 10;
```

### Paso 4 — Determinar si el error es nuevo o latente

```sql
SELECT error_fingerprint,
       COUNT(*) AS total_historico,
       MIN(timestamp) AS primera_aparicion
FROM error_logs
WHERE error_fingerprint = '<fingerprint del Paso 3>'
GROUP BY error_fingerprint;
```

`primera_aparicion` reciente → regresión por deploy.  
Lleva días → problema latente.

### Paso 5 — Dashboard visual

```
https://lead-rescue-pipeline.marceloetcheverry990.workers.dev/dashboard/monitoring
```
Credenciales: ver configuración interna del equipo (no publicar en este doc).

El panel "Recent Errors" muestra los últimos 10 errores con contexto completo.

### Paso 6 — Verificar circuit breakers

```sql
SELECT key, value, updated_at FROM system_flags WHERE key LIKE '%breaker%';
```

Si `value = 'OPEN'`, el sistema ya está manejando el fallo del servicio externo.

---

## Mitigación

**Caso A — Error en endpoint específico tras deploy**
- Identificar el cambio (`git log --oneline -10`)
- Si el error es crítico: revertir desde Cloudflare Dashboard → Workers → lead-rescue-pipeline → Deployments → seleccionar versión anterior → Rollback

**Caso B — Error de integración externa (Telegram, OpenAI)**
- Los circuit breakers deberían estar activos (ver Paso 6)
- Si `value = 'OPEN'`, el sistema está conteniendo el fallo — esperar auto-recovery
- Si el servicio externo se recuperó pero el breaker sigue abierto, ver runbook `circuit-breaker-open.md`

**Caso C — Error de validación de datos (ZodError, parsing)**
- `error_type` será `ZodError` o similar
- El problema es datos inválidos entrando desde un cliente o proveedor externo
- No requiere acción de código — identificar la fuente de los datos malformados

**Caso D — Errores de timeout o conexión a DB**
- Si `error_message` contiene `statement timeout` o `connection refused` → ver runbook `database-connectivity.md`

---

## Verificación post-resolución

```sql
-- Confirmar que la tasa bajó a < 5%:
SELECT
  COUNT(*) FILTER (WHERE severity IN ('ERROR','CRITICAL')) AS errores,
  COUNT(*) AS total,
  ROUND(COUNT(*) FILTER (WHERE severity IN ('ERROR','CRITICAL'))::numeric / NULLIF(COUNT(*),0) * 100, 2) AS tasa_pct
FROM error_logs
WHERE timestamp > NOW() - INTERVAL '5 minutes';
-- Esperado: tasa_pct < 5
```

---

## Escalación

- **10 min**: si no se identificó la causa con los pasos anteriores, revisar logs de Cloudflare Workers en https://dash.cloudflare.com
- **20 min**: si el error afecta el procesamiento de leads y no hay causa aparente, considerar redeploy a la versión anterior
- **Sin resolución tras rollback**: escalar al responsable técnico del sistema

---

## Criterio de cierre del incidente

El incidente se considera resuelto cuando:
1. La tasa de errores en los últimos 5 minutos es < 5% (verificar con la query de Verificación)
2. No llegan nuevas alertas `high_error_rate` en el siguiente ciclo de cron (2 min)
3. Los endpoints afectados responden normalmente
