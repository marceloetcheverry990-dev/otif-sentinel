# Runbook: Queue Backlog Alert

**Tipo de alerta:** `high_queue_latency`  
**Severidad:** ERROR (>10min) / CRITICAL (>20min)  
**Umbral:** Latencia de procesamiento > 10 minutos  
**Deduplicación:** 15 minutos entre alertas del mismo tipo  
**ETA de resolución:** 5 minutos si es circuit breaker · 15 minutos si es backlog orgánico

---

## Síntomas

```
🔴 ALERTA: ERROR
Tipo: high_queue_latency
Componente: queue_leads-enrichment-queue
Valor actual: 15.32
Umbral: 10
Mensaje: Latencia de cola elevada (leads-enrichment-queue): 15.32 minutos (umbral: 10 min)
```

---

## Colas del sistema

| Cola | Binding | Propósito |
|------|---------|-----------|
| `leads-ingestion-queue` | `MAIN_QUEUE` | Entrada de leads desde WMS webhook |
| `leads-enrichment-queue` | `ENRICHMENT_QUEUE` | Enriquecimiento con IA (OpenAI) |
| `leads-delivery-queue` | `DELIVERY_QUEUE` | Entrega por Telegram a choferes |

Flujo: WMS → MAIN_QUEUE → ENRICHMENT_QUEUE → DELIVERY_QUEUE → Telegram

---

## Impacto

- **MAIN_QUEUE**: leads entrando sin procesar → retraso en asignación de choferes
- **ENRICHMENT_QUEUE**: enriquecimiento IA detenido → mensajes sin contexto completo
- **DELIVERY_QUEUE**: mensajes a choferes retrasados → SLA en riesgo

---

## Diagnóstico

### Paso 1 — Ver métricas de latencia recientes

```sql
SELECT dimension_tags->>'queue_name' AS cola,
       AVG(metric_value) AS latencia_avg_ms,
       ROUND(AVG(metric_value) / 60000, 2) AS latencia_min,
       MAX(timestamp) AS ultima_medicion
FROM metrics_summary
WHERE metric_name = 'queue.processing.latency'
  AND timestamp > NOW() - INTERVAL '30 minutes'
GROUP BY dimension_tags->>'queue_name'
ORDER BY latencia_avg_ms DESC;
```

### Paso 2 — Ver mensajes en Dead Letter Queue

```sql
SELECT event_type, reason, error_detail, died_at, ot_id
FROM dead_letter_events
WHERE died_at > NOW() - INTERVAL '1 hour'
ORDER BY died_at DESC
LIMIT 20;
```

Muchos mensajes recientes → procesamiento fallando, no solo lento.

### Paso 3 — Ver outbox pendiente

```sql
SELECT event_type,
       COUNT(*) AS pendientes,
       MIN(created_at) AS mas_antiguo,
       MAX(retry_count) AS max_reintentos
FROM outbox_events
WHERE processed_at IS NULL
GROUP BY event_type
ORDER BY pendientes DESC;
```

`max_reintentos` alto → mensajes fallando repetidamente.

### Paso 4 — Verificar circuit breakers

```sql
SELECT key, value, updated_at FROM system_flags WHERE key LIKE '%breaker%';
```

Si `openai_breaker = 'OPEN'` → ENRICHMENT_QUEUE se acumula.  
Si `telegram_breaker = 'OPEN'` → DELIVERY_QUEUE se acumula.

### Paso 5 — Ver errores de procesamiento en logs

```sql
SELECT error_type, error_message, endpoint, timestamp
FROM error_logs
WHERE timestamp > NOW() - INTERVAL '30 minutes'
  AND (endpoint LIKE '%queue%' OR error_type LIKE '%Queue%')
ORDER BY timestamp DESC
LIMIT 10;
```

---

## Mitigación

**Caso A — Circuit breaker de OpenAI abierto**
- Verificar estado de OpenAI: https://status.openai.com
- Si el servicio está disponible, cerrar el breaker manualmente:

> ⚠️ **ADVERTENCIA — escritura directa en producción:**  
> Este UPDATE afecta el comportamiento del worker inmediatamente.  
> Solo ejecutar si confirmaste que OpenAI está disponible (Paso 4 + status externo).  
> No ejecutar durante una ventana de fallo activo del servicio externo.

```sql
UPDATE system_flags SET value = 'CLOSED', updated_at = NOW() WHERE key = 'openai_breaker';
```

**Caso B — Circuit breaker de Telegram abierto**

> ⚠️ **Misma advertencia que Caso A.** Confirmar disponibilidad de Telegram antes de ejecutar.

```sql
UPDATE system_flags SET value = 'CLOSED', updated_at = NOW() WHERE key = 'telegram_breaker';
```

**Caso C — Mensajes acumulados en outbox**
- El job `runOutboxRecovery` corre cada 2 minutos — esperar 2-4 minutos para ver si se drena solo
- Mensajes con `retry_count >= 3` se mueven a DLQ automáticamente (ver runbook `dlq-overflow.md`)

**Caso D — Volumen alto orgánico**
- `max_batch_size: 50` por cola — el sistema procesa en batches de hasta 50 mensajes
- Si la latencia es alta pero decrece gradualmente → backlog orgánico, no requiere acción
- Si persiste más de 15 minutos sin mejorar → investigar causa raíz

---

## Verificación post-resolución

```sql
-- Confirmar que la latencia bajó:
SELECT ROUND(AVG(metric_value) / 60000, 2) AS latencia_min
FROM metrics_summary
WHERE metric_name = 'queue.processing.latency'
  AND timestamp > NOW() - INTERVAL '5 minutes';
-- Esperado: < 10

-- Confirmar outbox drenado:
SELECT COUNT(*) AS pendientes_sin_procesar
FROM outbox_events WHERE processed_at IS NULL;
-- Esperado: bajo y decreciendo
```

---

## Escalación

- **10 min**: si el circuit breaker no se cierra automáticamente y el servicio externo está disponible, cerrar manualmente con la advertencia del Caso A/B
- **20 min**: si la latencia sigue alta con outbox creciendo, puede haber un problema de infraestructura de Cloudflare Queues — revisar https://www.cloudflarestatus.com
- **Sin resolución**: escalar al responsable técnico con el output del Paso 1 y Paso 3

---

## Criterio de cierre del incidente

El incidente se considera resuelto cuando:
1. Latencia de cola < 10 minutos (verificar Paso 1)
2. `outbox_events` con `processed_at IS NULL` está estable o decreciendo
3. No llegan nuevas alertas `high_queue_latency` en los siguientes 2 ciclos de cron (4 min)
