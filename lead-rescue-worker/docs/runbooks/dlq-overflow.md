# Runbook: DLQ Overflow Alert

**Tipo de alerta:** `dlq_overflow`  
**Severidad:** ERROR (>100 mensajes) / CRITICAL (>200 mensajes)  
**Umbral:** Más de 100 mensajes en `dead_letter_events` en la última hora  
**Deduplicación:** 15 minutos entre alertas del mismo tipo  
**ETA de resolución:** 15 minutos para diagnóstico · 15–30 minutos para reprocesamiento

---

## Síntomas

```
🔴 ALERTA: ERROR
Tipo: dlq_overflow
Componente: dead_letter_queue
Valor actual: 147
Umbral: 100
Mensaje: Dead Letter Queue desbordada: 147 mensajes en la última hora (umbral: 100)
```

---

## Qué es la DLQ

Cuando un mensaje falla el procesamiento 3 veces (`MAX_DELIVERY_ATTEMPTS = 3`), se mueve automáticamente a `dead_letter_events`. Los mensajes **no se pierden** — están esperando revisión y reprocesamiento manual.

---

## Impacto

Según el `event_type` de los mensajes afectados:
- `DELIVERY`: choferes no recibieron sus mensajes de entrega
- Otros tipos: actualizaciones de estado de OTs no aplicadas

---

## Diagnóstico

### Paso 1 — Ver qué tipos de mensajes fallaron

```sql
SELECT event_type,
       reason,
       COUNT(*) AS cantidad,
       MIN(died_at) AS primero,
       MAX(died_at) AS ultimo
FROM dead_letter_events
WHERE died_at > NOW() - INTERVAL '2 hours'
GROUP BY event_type, reason
ORDER BY cantidad DESC;
```

### Paso 2 — Ver el detalle de errores

```sql
SELECT ot_id, event_type, reason, error_detail, died_at
FROM dead_letter_events
WHERE died_at > NOW() - INTERVAL '1 hour'
ORDER BY died_at DESC
LIMIT 20;
```

### Paso 3 — Verificar si el problema sigue activo

```sql
SELECT COUNT(*) AS nuevos_ultimos_5min
FROM dead_letter_events
WHERE died_at > NOW() - INTERVAL '5 minutes';
```

Si sigue creciendo → la causa raíz no está resuelta. Resolver antes de reprocesar.

### Paso 4 — Identificar causa raíz por `error_detail`

| Patrón en `error_detail` | Causa probable | Runbook a seguir |
|--------------------------|----------------|-----------------|
| `connection refused` | DB caída | `database-connectivity.md` |
| `telegram` / `bot` | Telegram caído | `circuit-breaker-open.md` |
| `openai` / `OpenAI` | OpenAI caído | `circuit-breaker-open.md` |
| `ZodError` / `validation` | Datos inválidos en payload | Sin runbook — revisar fuente de datos |

---

## Mitigación

### Opción A — Reprocesar mensajes (causa raíz resuelta)

**Verificar primero con el Paso 3 que los mensajes nuevos dejaron de llegar antes de reprocesar.**

Ver los mensajes candidatos:
```sql
SELECT id, ot_id, event_type, died_at
FROM dead_letter_events
WHERE died_at > NOW() - INTERVAL '2 hours'
  AND event_type = 'DELIVERY'   -- valor real en producción
ORDER BY died_at ASC
LIMIT 20;
```

> ⚠️ **ADVERTENCIA — operación con impacto en producción:**  
> El INSERT siguiente vuelve a encolar mensajes para procesamiento.  
> Si la causa raíz no está resuelta, los mensajes volverán a fallar y terminarán nuevamente en DLQ,  
> generando ruido adicional en los logs y posibles alertas duplicadas.  
> **Solo ejecutar después de confirmar** que el servicio responsable del fallo está funcionando  
> (verificar con el runbook correspondiente a la causa raíz).  
> Ejecutar en lotes pequeños (10–20 mensajes) la primera vez para validar que el reprocesamiento funciona.

```sql
-- Reprocesar en lote pequeño (ajustar los IDs según el Paso anterior)
INSERT INTO outbox_events (ot_id, payload, event_type, retry_count, created_at)
SELECT ot_id, payload, 'SEND_TO_DELIVERY', 0, NOW()
FROM dead_letter_events
WHERE id IN (<lista de IDs seleccionados>)
ON CONFLICT DO NOTHING;
```

Nota: `SEND_TO_DELIVERY` es el `event_type` del outbox; `DELIVERY` es el `event_type` de la DLQ. Son valores distintos por diseño.

El `runOutboxRecovery` (corre cada 2 minutos) tomará automáticamente los mensajes reinsertados.

### Opción B — Descartar mensajes inválidos

Si los mensajes tienen datos corruptos o el OT ya no existe:

```sql
-- Verificar antes de descartar:
SELECT d.ot_id, o.estado_operacional
FROM dead_letter_events d
LEFT JOIN ordenes_pendientes o ON d.ot_id = o.ot_id
WHERE d.id IN (<IDs a evaluar>);
-- Si o.estado_operacional es NULL, el OT puede no existir
```

Los mensajes en DLQ se limpian automáticamente después de 90 días. No hacer DELETE directo a menos que sea explícitamente necesario.

### Opción C — Volumen post-incidente

Si el DLQ creció durante un incidente ya resuelto (DB caída, Telegram caído), los mensajes son de la ventana del incidente. Evaluar:
1. Relevancia de los OTs afectados (¿siguen activos?)
2. Decidir si reprocesar (Opción A) o dejar expirar (90 días)

---

## Verificación post-resolución

```sql
-- Confirmar que no llegan mensajes nuevos a DLQ:
SELECT COUNT(*) FROM dead_letter_events WHERE died_at > NOW() - INTERVAL '5 minutes';
-- Esperado: 0 o muy bajo

-- Si reprocesaste: confirmar que el outbox los tomó:
SELECT COUNT(*) FROM outbox_events WHERE processed_at IS NULL AND event_type = 'SEND_TO_DELIVERY';
-- Esperado: decreciendo
```

---

## Escalación

- **10 min**: si el DLQ sigue creciendo con la causa raíz identificada pero no resuelta → escalar al responsable del servicio externo afectado
- **20 min**: si no se puede identificar la causa raíz con los pasos anteriores → revisar logs de Cloudflare Workers y escalar al responsable técnico
- **OTs con SLA vencido**: si hay órdenes con tiempo crítico entre los mensajes fallidos, notificar manualmente a los choferes afectados mientras se resuelve el sistema

---

## Criterio de cierre del incidente

El incidente se considera resuelto cuando:
1. No llegan nuevos mensajes a DLQ en los últimos 5 minutos (Paso 3 devuelve 0)
2. Los mensajes reprocesados (si aplica) fueron tomados por el outbox y procesados
3. No llegan nuevas alertas `dlq_overflow` en los siguientes 2 ciclos de cron (4 min)
4. La causa raíz está documentada y resuelta
