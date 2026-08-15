# Runbook: Circuit Breaker Open Alert

**Tipo de alerta:** `circuit_breaker_open`  
**Severidad:** ERROR  
**Umbral:** Circuit breaker en estado OPEN por más de 10 minutos  
**Deduplicación:** 15 minutos entre alertas del mismo tipo  
**ETA de resolución:** 5 minutos si el servicio externo está disponible · 30+ minutos si sigue caído

---

## Síntomas

```
🔴 ALERTA: ERROR
Tipo: circuit_breaker_open
Componente: telegram_breaker
Valor actual: 12.50
Umbral: 10
Mensaje: Circuit breaker abierto por mucho tiempo (telegram_breaker): 12 minutos (umbral: 10 min)
```

---

## Circuit breakers del sistema

| Breaker | Servicio | Impacto cuando está OPEN |
|---------|----------|--------------------------|
| `telegram_breaker` | Telegram Bot API | Los mensajes a choferes no se envían |
| `openai_breaker` | OpenAI API | El enriquecimiento IA se detiene |

---

## Impacto

**`telegram_breaker` OPEN:** Choferes no reciben rutas ni actualizaciones. El sistema procesa internamente pero la entrega final está bloqueada. Los mensajes se acumulan en el outbox.

**`openai_breaker` OPEN:** Leads entran al sistema pero no se enriquecen con IA. Se procesan con información base únicamente.

---

## Diagnóstico

### Paso 1 — Verificar estado actual de los breakers

```sql
SELECT key, value, updated_at,
       ROUND(EXTRACT(EPOCH FROM (NOW() - updated_at)) / 60, 1) AS minutos_en_estado
FROM system_flags
WHERE key LIKE '%breaker%'
ORDER BY updated_at DESC;
```

### Paso 2 — Ver cuándo y por qué se abrió

```sql
SELECT error_type, error_message, timestamp
FROM error_logs
WHERE timestamp > NOW() - INTERVAL '1 hour'
  AND (error_message ILIKE '%telegram%' OR error_message ILIKE '%openai%')
ORDER BY timestamp DESC
LIMIT 10;
```

### Paso 3 — Verificar disponibilidad del servicio externo

**Telegram:**
```bash
curl -s "https://api.telegram.org/bot<TG_BOT_TOKEN>/getMe"
```
Si responde `{"ok":true}` → Telegram disponible, el breaker puede cerrarse.

**OpenAI:** https://status.openai.com

### Paso 4 — Ver mensajes acumulados durante el período de breaker abierto

```sql
-- Mensajes de entrega pendientes en outbox (event_type real: SEND_TO_DELIVERY)
SELECT COUNT(*) AS pendientes, MAX(created_at) AS mas_reciente
FROM outbox_events
WHERE processed_at IS NULL
  AND event_type = 'SEND_TO_DELIVERY';
```

---

## Mitigación

### Cerrar el breaker manualmente

> ⚠️ **ADVERTENCIA — escritura directa en producción con efecto inmediato:**  
> Este UPDATE hace que el worker retome los intentos de conexión al servicio externo de inmediato.  
> **No ejecutar si el servicio externo sigue caído** — el breaker se volvería a abrir en segundos  
> y se generarían errores adicionales que consumen cuota de la API.  
> Confirmar primero con el Paso 3 que el servicio externo responde correctamente.

```sql
-- Cerrar telegram_breaker (solo si Telegram está disponible)
UPDATE system_flags
SET value = 'CLOSED', updated_at = NOW()
WHERE key = 'telegram_breaker';

-- Cerrar openai_breaker (solo si OpenAI está disponible)
UPDATE system_flags
SET value = 'CLOSED', updated_at = NOW()
WHERE key = 'openai_breaker';
```

### Después de cerrar el breaker

El `runOutboxRecovery` (corre cada 2 minutos) reintentará automáticamente los mensajes pendientes. No se requiere acción adicional. Verificar con el Paso 4 que el conteo de pendientes decrece.

---

## Verificación post-resolución

```sql
-- Confirmar que el breaker está CLOSED:
SELECT key, value, updated_at FROM system_flags WHERE key LIKE '%breaker%';
-- Esperado: value = 'CLOSED'

-- Confirmar que el outbox se está drenando:
SELECT COUNT(*) FROM outbox_events WHERE processed_at IS NULL AND event_type = 'SEND_TO_DELIVERY';
-- Esperado: decreciendo en cada consulta sucesiva
```

---

## Escalación

- **5 min**: si el servicio externo está disponible pero el breaker sigue generando errores tras cerrarlo manualmente, revisar logs de Cloudflare Workers en https://dash.cloudflare.com
- **15 min**: si Telegram o OpenAI siguen caídos, no hay acción técnica disponible — documentar el incidente y esperar la recuperación del servicio externo
- **Mensajes críticos no entregados**: si hay OTs con SLA vencido durante el período de breaker abierto, evaluar renotificación manual a los choferes afectados

---

## Criterio de cierre del incidente

El incidente se considera resuelto cuando:
1. Todos los breakers muestran `value = 'CLOSED'`
2. El outbox con `event_type = 'SEND_TO_DELIVERY'` tiene 0 pendientes o está decreciendo
3. No llegan nuevas alertas `circuit_breaker_open` en los siguientes 10 minutos
4. Los servicios externos confirman disponibilidad (Telegram `getMe` responde `{"ok":true}`)
