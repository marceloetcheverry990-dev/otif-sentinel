# Plan de acción — Auditoría crítica OTIF Sentinel

**Fecha:** 2026-07-25  
**Base:** evaluación Claude (Cowork) + verificación en código real del repo  
**Objetivo:** dejar el producto presentable, multi-tenant usable, y con datos limpios antes de seguir agregando features

---

## 0. Veredicto sobre la evaluación

| Hallazgo | ¿Confirmado en código? | Severidad |
|----------|------------------------|-----------|
| `confirmRescue` sin transacción (Supabase REST + `Promise.all` + luego `pg`) | **Sí** | Crítica |
| Cero RLS en migraciones | **Sí** | Alta (bloquea venta B2B) |
| Telegram mono-tenant (`SALES_TEAM_CHAT_ID` global) | **Sí** | Alta (bloquea 2º cliente) |
| GPS: app captura `timestamp` pero sync lo descarta; servidor usa `NOW()` | **Sí** (`syncStore.ts` + `gps.js`) | **Crítica** (corrompe Fase 0/1/3) |
| Revocación JWT en `Map` de isolate | **Sí** (`driver-auth.js`) | Alta si vendés trazabilidad |
| OpenAI reescribe score ya calculado en camino crítico | **Sí** (`ai.js`) | Media (costo/latencia) |
| URL hardcodeada `lead-rescue-pipeline.marcelo…` en app | **Sí** (5+ archivos) | Alta (credibilidad + ops) |
| CORS `*` | **Sí** | Baja hoy |
| Feature flags monitoreo rotos (doc §10) | **Sí** (documentado) | Baja |
| Fases 0–1 ya implementadas | **Sí** | N/A (actualizar roadmap) |
| Fase 2 POD HMAC “irrefutable” sobredimensionada / mal vendida | Acuerdo | Replantear |
| Fase 3 empírico = mejor producto | Acuerdo | Priorizar **después** de GPS ts |
| Oportunidad SII Res. 154 | Hipótesis fuerte | Validar en fuente oficial SII |

**Conclusión:** el revisor tiene razón en lo técnico. El cuello de botella no es “más Fase 2”, sino **datos GPS correctos + no romper en rescate + apariencia de producto real + alertas por tenant**. En paralelo: **pilotos comerciales** (Fase −1).

---

## 1. Principios del plan

1. **No empezar Fase 2/3** hasta arreglar timestamps GPS (2.4).  
2. **No mover carga real en rescate** sin transacción.  
3. **Separar track técnico y track comercial** (ambos obligatorios).  
4. Cada ítem tiene: criterio de hecho + esfuerzo estimado + dependencia.

---

## 2. Track comercial (Fase −1) — empieza YA, no es código

| # | Acción | Dueño | Criterio de hecho | Plazo |
|---|--------|-------|-------------------|-------|
| C1 | Lista de 10 jefes de despacho (papá / red) | Negocio | 10 nombres + contacto | 48 h |
| C2 | Preguntas concretas: # panne/mes, $ multas OTIF/año, dolor #1 | Negocio | Notas por contacto | 1 semana |
| C3 | 1 mañana en bodega observando (sin tocar laptop) | Negocio | Foto/notas del flujo real | 1 semana |
| C4 | Conseguir **3 pilotos** (gratis OK) | Negocio | 3 LOI / WhatsApp de compromiso | 3–4 semanas |
| C5 | Verificar Res. 154 en sitio SII (no blogs) | Negocio | Checklist campos vs datos OTIF | 3 días |

Si C2 dice “casi no hay multas OTIF”, **reapuntar el producto** antes de Fase 3.

---

## 3. Track técnico — orden de ejecución

### Sprint A — “Producto presentable” (3–4 días) ★ primero para afuera

| ID | Problema | Acción | Hecho cuando |
|----|----------|--------|--------------|
| A1 | URL/marca `lead-rescue` + nombre personal | Dominio propio (ej. `api.otifsentinel.cl` / Workers custom domain). Renombrar branding visible. | Torre y app apuntan a dominio limpio |
| A2 | URL hardcodeada en app | `EXPO_PUBLIC_API_URL` (o equivalente) en todos: `syncStore`, `authStore`, `chatStore`, `evidence`, `HomeScreen` | Cero strings `marceloetcheverry990.workers.dev` en `logistica-app` |
| A3 | Naming colas/worker (deuda) | Plan de rename **diferido** (breaking). Por ahora: dominio + título UI “OTIF Sentinel”. Rename colas en ventana de mantenimiento. | UI/URL sin “lead-rescue” de cara al cliente |

### Sprint B — “Datos GPS confiables” (4–6 días) ★ bloqueante Fase 3

| ID | Problema | Acción | Hecho cuando |
|----|----------|--------|--------------|
| B1 | Timestamp descartado en sync | En `/tracking` enviar `timestamp` (ms del device) en `finalPayload` | Payload incluye `timestamp` |
| B2 | Servidor ignora client time | `gps.js` acepta `timestamp`/`recorded_at` client; validar rango (ej. no futuro >2 min, no más viejo que 24–48 h); usar para `gps_trail.recorded_at` y lógica de movimiento | Trail/DMS usan hora del evento, no hora de replay |
| B3 | `last_significant_move_at` en replay | Actualizar con **timestamp del ping**, no solo `NOW()` | Replay offline no “cura” un stuck falso ni inventa movimiento |
| B4 | Cola única GPS+eventos | Dos colas (o prioridad): telemetría vs eventos operativos (`ENTREGA`/`LLEGADA`) | ENTREGA no espera detrás de 200 pings |
| B5 | 4xx descarta POD en silencio | Reintentar 5xx; en 4xx de POD, marcar `failed` visible / no borrar sin log; métrica | No se pierde evidencia sin traza |
| B6 | Medición falsos positivos DMS | 1 semana con chofer real: contar `SIGNAL_LOST` vs panne real; ajustar umbrales | Ratio documentado; Telegram no se mutea |

**Tests:** unitarios de parse/rango timestamp; caso replay 40 min → N puntos en trail con horas distintas.

### Sprint C — “Rescate no parte la carga” (2–3 días) ★ crítico ops

| ID | Problema | Acción | Hecho cuando |
|----|----------|--------|--------------|
| C-tech1 | `confirmRescue` no atómico | Reescribir persistencia con `withDbTransaction` (solo Hyperdrive/`pg`): updates de OTs + `rescue_missions` + `fleet_alerts` en **una** TX | Fallo parcial hace rollback; nada a medias |
| C-tech2 | `Promise.all` REST | Eliminar path Supabase REST para mutaciones de rescate | Un solo client DB en confirm |
| C-tech3 | Test de fallo a mitad | Test/integration: simular error mid-TX | Estado final consistente |

### Sprint D — “Multi-tenant de verdad” (3–5 días)

| ID | Problema | Acción | Hecho cuando |
|----|----------|--------|--------------|
| D1 | Telegram global | Tabla `tenant_settings` (`telegram_ops_chat_id`, …); jobs/APIs leen por `tenant_id` | 2 tenants → 2 chats distintos |
| D2 | Fallback | Si tenant sin chat, log + skip (no spamear chat de otro) | Sin cross-talk |
| D3 | RLS | Migración: `ENABLE ROW LEVEL SECURITY` + policies por `tenant_id` en tablas sensibles; service role solo en Worker con claim/tenant chequeado | Al menos `ordenes_pendientes`, `flota_vehiculos`, `fleet_alerts`, `gps_trail`, `bitacora_viajes`, `choferes` |
| D4 | Auditoría queries | Grep/`eq('tenant_id')` checklist en handlers nuevos + test que falle sin tenant | Regla en PR / test |

> Nota RLS: con service key el bypass sigue existiendo; RLS protege si alguna vez se usa anon key o hay fuga. Igual hay que **no olvidar** `tenant_id` en app. Ambos.

### Sprint E — “Auth / seguridad presentable” (2–3 días)

| ID | Problema | Acción | Hecho cuando |
|----|----------|--------|--------------|
| E1 | Revoke en memoria | JTI revocados en **KV** con TTL = exp del token (o DO) | Logout invalida en todos los isolates |
| E2 | CORS `*` | Allowlist orígenes (Torre dominio + Expo/dev) | Sin `*` en prod |
| E3 | Flags monitoreo | Cablear `getMonitoringConfig(env)` en `withMonitoring` (doc §10) | Flags env tienen efecto |

### Sprint F — “Quitar peso muerto / producto diario” (1–2 semanas)

| ID | Problema | Acción | Hecho cuando |
|----|----------|--------|--------------|
| F1 | OpenAI en enrich crítico | Sacarlo del path de ingest/enrich; score = reglas/matemática; LLM opcional solo chat Torre | Enrich sin dependencia OpenAI |
| F2 | Velocidad fija 35 km/h | Calibrar con `eta_accuracy_metrics` por zona/hora (aunque sea buckets simples) | Fallback deja de ser constante única |
| F3 | **Fase 3 empírica** (el producto) | Score pre-despacho con `stop_dwell_stats` + ETA bias; badge en Torre; soft reorder | “Este viaje quiebra SLA en Cliente X” usable |
| F4 | Fase 2 POD | **No** HMAC “irrefutable”. Si se hace: ePOD premium (PDF + hash público) **o** firma asimétrica + TSA. Prioridad **después** de F3 y pilotos | Solo si un piloto lo pide / SII lo exige |

### Sprint G — Oportunidad SII (condicional)

| ID | Acción | Hecho cuando |
|----|--------|--------------|
| G1 | Validar Res. 154 en SII oficial | Checklist campos |
| G2 | Gap analysis: qué falta (peso, comuna, hora salida bodega, etc.) | Lista de campos faltantes |
| G3 | Export “datos guía de despacho” / payload JSON por trip | Demo vendible Nov 2026 |
| G4 | Pitch legal-local | 1 página comercial |

Solo si G1 confirma; no construir sobre blog secundario.

---

## 4. Orden recomendado (vista timeline)

```text
Semana 0 (esta):
  C1–C3 comercial
  A1–A2 dominio + env URL app
  B1–B3 timestamps GPS (mínimo viable)

Semana 1:
  B4–B6 colas + medición DMS
  C-tech1–3 rescate transaccional
  D1–D2 Telegram por tenant

Semana 2:
  D3–D4 RLS + checklist tenant
  E1–E3 KV revoke + CORS + flags
  F1 OpenAI fuera del crítico

Semana 3–4:
  F3 Fase 3 empírica (producto diario)
  G1–G2 si SII valida
  C4 tres pilotos en paralelo

Después / bajo demanda:
  F4 POD bien hecho
  A3 rename colas
  G3–G4 export SII
```

**Pausar explícitamente:** Fase 2 HMAC “mini smart-contract”, más UI de Lead Rescue, packing 3D, ML en Workers.

---

## 5. Definition of Done global (antes de vender en serio)

- [ ] App sin URL personal hardcodeada; dominio propio en Torre  
- [ ] GPS offline replay conserva timestamps reales en trail/DMS  
- [ ] `confirmRescue` 100% transaccional  
- [ ] Alertas Telegram por tenant  
- [ ] RLS en tablas core (+ disciplina `tenant_id`)  
- [ ] Logout chofer revoca de verdad (KV)  
- [ ] OpenAI fuera del camino crítico de enrich  
- [ ] Al menos **1 piloto real** usando el sistema un día completo  
- [ ] Roadmap actualizado (0–1 = done; 3 = next product)

---

## 6. Qué haríamos “esta semana” si solo hay 3 días de código

1. **B1+B2+B3** timestamps GPS  
2. **C-tech1** rescate en transacción  
3. **A2** `EXPO_PUBLIC_API_URL`  
4. **D1** `tenant_settings.telegram_ops_chat_id`  

Y en paralelo no-código: **C1+C2**.

Eso arregla lo que más puede mentir (datos), lo que más puede romper en el peor momento (rescate), lo que más humilla en una demo (URL), y lo que impide el segundo cliente (Telegram).

---

## 7. Mapa problema → archivo principal

| Problema | Archivos clave |
|----------|----------------|
| Timestamp GPS | `logistica-app/src/store/syncStore.ts`, `locationTask.ts`, `lead-rescue-worker/src/api/gps.js`, `helpers/gps-trail.js`, `jobs.js` |
| Rescate no TX | `src/api/lead-rescue.js`, `src/db.js` (`withDbTransaction`) |
| Telegram mono | `jobs.js`, `lead-rescue.js`, `quick-route.js`, `reoptimizar-midday.js`, `queues.js` + nueva `tenant_settings` |
| URL hardcode | `logistica-app/src/store/*`, `HomeScreen.tsx`, `services/*` |
| Revoke JWT | `src/helpers/driver-auth.js` + binding KV |
| OpenAI crítico | `src/ai.js`, `queues.js` / enrichment path |
| RLS | `migrations/007_rls_*.sql` |
| CORS / flags | `src/config.js`, `src/monitoring/*` |

---

## 8. Decisión de producto (actualizar mental model)

| Antes (roadmap viejo) | Ahora |
|----------------------|--------|
| Fase 2 POD crypto next | **No** (o mucho más tarde / bien hecho) |
| Lead Rescue = diferencial #1 | Feature de pitch; medir falsos positivos |
| Fase 3 después | **Producto #1 técnico** tras GPS fix |
| Solo código 6 semanas | **Código + 3 pilotos** o no hay negocio |

---

## 9. Progreso de implementación (2026-07-25)

| Ítem | Estado |
|------|--------|
| B1–B3 timestamps GPS (app + servidor + trail/DMS) | **Hecho** |
| B4 prioridad cola eventos vs GPS | **Hecho** |
| B5 POD 4xx no se borra en silencio | **Hecho** |
| A2 `EXPO_PUBLIC_API_URL` | **Hecho** (fallback legacy hasta setear env) |
| C `confirmRescue` transaccional | **Hecho** |
| D1 `tenant_settings` + Telegram por tenant | **Hecho** (migración 007; fallback a global si no hay fila) |
| E1 Revoke JWT en KV | **Hecho** (`DRIVER_REVOKED_JTI`) |
| E2 CORS allowlist | **Hecho** (`CORS_ALLOWED_ORIGINS` + `getCorsHeaders`) |
| E3 Flags monitoreo | **Hecho** (`getMonitoringConfig(env)` en middleware) |
| F1 OpenAI fuera del crítico | **Hecho** (`OPENAI_ENRICH_ENABLED=false` por defecto) |
| D3 RLS tablas core | **Parcial / cosmético** (008 policies; Worker sigue en BYPASSRLS). Path real: mig **009** `otif_app` + Hyperdrive debe usar ese rol |
| D4 checklist tenant_id | **Lint + fail-closed** (no prueba `.eq('tenant_id')` por query) |
| F3 Fase 3 empírica | **Hecho + corregido** (dwell ≠ bias viaje; no doble conteo con F2) |
| F2 Velocidad calibrada | **Hecho + corregido** (solo `error_viaje` vs LLEGADA) |
| G SII | Pendiente |
| Piloto / dominio / staging | **Pendiente** (restricción real; no es más código de features) |

**Operador:** aplicar **009** + cambiar Hyperdrive a `otif_app_login`. Ver `ADDENDUM-CRITICA-RLS-F2F3-2026-07-25.md`.
