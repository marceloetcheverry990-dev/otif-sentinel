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
Componente: openai_breaker
Valor actual: 12.50
Umbral: 10
Mensaje: Circuit breaker abierto por mucho tiempo (openai_breaker): 12 minutos (umbral: 10 min)
```

---

## Circuit breakers del sistema

| Breaker | Servicio | Impacto cuando está OPEN |
|---------|----------|--------------------------|
| `openai_breaker` | OpenAI API | El enriquecimiento IA se detiene |

---

## Impacto

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
  AND error_message ILIKE '%openai%'
ORDER BY timestamp DESC
LIMIT 10;
```

### Paso 3 — Verificar disponibilidad del servicio externo

**OpenAI:** https://status.openai.com

---

## Mitigación

### Cerrar el breaker manualmente

> ⚠️ **ADVERTENCIA — escritura directa en producción con efecto inmediato:**  
> Este UPDATE hace que el worker retome los intentos de conexión al servicio externo de inmediato.  
> **No ejecutar si el servicio externo sigue caído** — el breaker se volvería a abrir en segundos  
> y se generarían errores adicionales que consumen cuota de la API.  
> Confirmar primero con el Paso 3 que el servicio externo responde correctamente.

```sql
-- Cerrar openai_breaker (solo si OpenAI está disponible)
UPDATE system_flags
SET value = 'CLOSED', updated_at = NOW()
WHERE key = 'openai_breaker';
```

---

## Verificación post-resolución

```sql
-- Confirmar que el breaker está CLOSED:
SELECT key, value, updated_at FROM system_flags WHERE key LIKE '%breaker%';
-- Esperado: value = 'CLOSED'
```

---

## Escalación

- **5 min**: si el servicio externo está disponible pero el breaker sigue generando errores tras cerrarlo manualmente, revisar logs de Cloudflare Workers en https://dash.cloudflare.com
- **15 min**: si OpenAI sigue caído, no hay acción técnica disponible — documentar el incidente y esperar la recuperación del servicio externo

---

## Criterio de cierre del incidente

El incidente se considera resuelto cuando:
1. Todos los breakers muestran `value = 'CLOSED'`
2. No llegan nuevas alertas `circuit_breaker_open` en los siguientes 10 minutos
3. OpenAI confirma disponibilidad en su status page
