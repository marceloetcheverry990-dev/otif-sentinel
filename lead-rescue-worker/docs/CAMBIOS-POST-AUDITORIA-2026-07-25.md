# Cambios post-auditoría crítica — OTIF Sentinel

**Fecha del documento:** 2026-07-25  
**Alcance:** todo lo implementado **desde** que se envió la evaluación crítica (`OTIF_Sentinel_evaluacion_critica.md` / Claude Cowork) hasta F2 inclusive.  
**Plan maestro:** `docs/PLAN-ACCION-AUDITORIA-2026-07-25.md`  
**Repo:** `Laboratorio-B2B` (`lead-rescue-worker` + `logistica-app`)

> **Nota de alcance:** este documento cubre la **remediación de auditoría + F2/F3**.  
> Fase 0–1 (GPS trail, Dead Man, Lead Rescue, migración 006) ya existía o se había trabajado justo antes; aquí se menciona solo si el ítem de auditoría la tocó (timestamps GPS, Telegram, etc.).

---

## 1. Resumen ejecutivo

Se contrastó la evaluación con el código real, se escribió un plan priorizado y se implementaron casi todos los ítems técnicos bloqueantes:

| Sprint | Qué se arregló | Estado |
|--------|----------------|--------|
| **B** | Timestamps GPS (app + servidor + cola) | Hecho + deploy |
| **A2** | URL API configurable en app móvil | Hecho |
| **C** | `confirmRescue` transaccional | Hecho + deploy |
| **D1** | Telegram por tenant (`tenant_settings`) | Hecho (migración 007 aplicada) |
| **E1** | Revocación JWT chofer en KV | Hecho + deploy |
| **E2** | CORS allowlist | Hecho + deploy |
| **E3** | Flags de monitoreo leen `env` | Hecho + deploy |
| **F1** | OpenAI fuera del enrich crítico | Hecho + deploy |
| **D3** | RLS por `tenant_id` | **Parcial** (008 cosmético; ver addendum + mig 009) |
| **D4** | Checklist/tests disciplina tenant | Hecho |
| **F3** | Riesgo SLA empírico + badge Torre | Hecho + deploy |
| **F2** | Velocidad fallback calibrada | Hecho + deploy |

**Deploys Worker relevantes (prod):**
- Post E/F1: `e2e3b6b9-0774-4450-ade3-2fdab4b01ac8` (aprox.)
- Post F3: `5b3a29cf-50e0-4324-9295-b7c28ecf618f`
- Post F2: `f24cc756-7648-4e36-a76c-81f661d5cdb0`  
- URL: `https://lead-rescue-pipeline.marceloetcheverry990.workers.dev`

**Migraciones SQL que el operador aplicó en Supabase:**
1. `007_tenant_settings.sql` (+ insert opcional Telegram)
2. `008_rls_tenant_isolation.sql`

---

## 2. Por qué se hizo (contexto de la auditoría)

Hallazgos confirmados en código que motivaron el trabajo:

1. GPS: la app capturaba `timestamp` pero el sync lo descartaba; el servidor usaba `NOW()` → corrompe trail / Dead Man / Fase 3.
2. `confirmRescue` no era atómico (riesgo de partir carga entre viajes).
3. Telegram mono-tenant (`SALES_TEAM_CHAT_ID` global).
4. URL hardcodeada con nombre personal en la app.
5. Revoke JWT solo en `Map` de isolate (logout no global).
6. CORS `*`.
7. Feature flags de monitoreo documentados pero no cableados a `env`.
8. OpenAI reescribía score en camino crítico de enrich.
9. Cero RLS.
10. Producto diario faltante: riesgo SLA empírico (F3) y velocidad fija 35 km/h (F2).

---

## 3. Cambios por sprint (detalle técnico)

### 3.1 Sprint B — Timestamps GPS confiables

**Problema:** replay offline de GPS “curaba” camiones quietos o inventaba movimiento porque todo se guardaba con hora de recepción del servidor.

#### Archivos nuevos
| Archivo | Rol |
|---------|-----|
| `src/helpers/gps-timestamp.js` | Parsea `timestamp` / `recorded_at` (ms o ISO); valida rango (no futuro >2 min, no más viejo que ventana); normaliza a ISO. |
| `src/helpers/gps-timestamp.test.js` | Tests unitarios de parse/rango. |

#### Archivos modificados
| Archivo | Antes → Después | Por qué |
|---------|-----------------|---------|
| `src/api/gps.js` | Usaba `NOW()` / hora servidor para trail y `ultima_actualizacion` / `last_significant_move_at`. → Acepta timestamp del cliente vía helper; trail y movimiento significativo usan **hora del evento**. | DMS y trail dejan de mentir con sync diferido. |
| `logistica-app/src/store/syncStore.ts` | No enviaba `timestamp` en payload GPS; eventos y tracking mezclados; POD 4xx se podía perder en silencio. → Envía `timestamp`; prioriza `/chofer/evento` sobre `/tracking`; ENTREGA 4xx → estado `failed` visible; pasa `codigo_escaneado` / coords en eventos. | B1 + B4 + B5 del plan. |

**Criterio de hecho:** un replay de 40 min escribe N puntos con horas distintas; un stuck no se “cura” al llegar el batch.

---

### 3.2 Sprint A2 — URL API configurable (app)

**Problema:** strings hardcodeadas `lead-rescue-pipeline.marceloetcheverry990.workers.dev` en varios módulos → mala credibilidad + ops frágil.

#### Archivos nuevos
| Archivo | Rol |
|---------|-----|
| `logistica-app/src/config/api.ts` | Centraliza `EXPO_PUBLIC_API_URL` con fallback legacy. |
| `logistica-app/.env.example` | Documenta la variable. |

#### Archivos modificados
| Archivo | Cambio |
|---------|--------|
| `syncStore.ts`, `authStore.ts`, `chatStore.ts`, `services/evidence.ts`, `HomeScreen.tsx` | Dejan de hardcodear URL; consumen el config. |

**Pendiente ops:** setear `EXPO_PUBLIC_API_URL` en builds reales (el fallback legacy sigue por compatibilidad).  
**Pendiente producto:** A1 dominio propio (no hecho en este bloque).

---

### 3.3 Sprint C — `confirmRescue` transaccional

**Problema:** updates de OTs + misión + alerta podían quedar a medias (Supabase REST + `Promise.all` + PG).

#### Archivos modificados
| Archivo | Antes → Después | Por qué |
|---------|-----------------|---------|
| `src/api/lead-rescue.js` → `confirmRescue` | Lecturas OK; escrituras no atómicas. → Lectura con `withDb`; **mutaciones en `withDbTransaction`**: órdenes + `rescue_missions` + `fleet_alerts` en una TX; bitácora best-effort post-commit. | Fallo a mitad hace rollback; no parte carga. |
| `src/db.js` | Ya tenía `withDbTransaction`; se reforzó uso. | Abstracción única para TX. |

---

### 3.4 Sprint D1 — Telegram por tenant

**Problema:** un solo `SALES_TEAM_CHAT_ID` → imposible segundo cliente sin cross-talk.

#### Migración nueva (aplicada)
```
migrations/007_tenant_settings.sql
```
Tabla `tenant_settings (tenant_id PK, telegram_ops_chat_id, created_at, updated_at)`.

#### Archivos nuevos
| Archivo | Rol |
|---------|-----|
| `src/helpers/tenant-settings.js` | `getTenantTelegramOpsChatId`, `sendTenantOpsTelegram` — lee settings; fallback opcional a global. |

#### Archivos modificados
| Archivo | Cambio |
|---------|--------|
| `src/jobs.js` (Dead Man / ops) | Telegram vía helper por `tenant_id`. |
| `src/api/lead-rescue.js` (y otros paths ops) | Misma vía tenant-aware. |

**Operador:** además del SQL, insert opcional para `empresa_base` con chat de Telegram.

---

### 3.5 Sprint E1 — Revocación JWT chofer en KV

**Problema:** revoke en `Map` de memoria → solo el isolate que hizo logout veía el token inválido.

#### Config
| Archivo | Cambio |
|---------|--------|
| `wrangler.jsonc` | Binding KV `DRIVER_REVOKED_JTI` (id `6ee132b2ac2548bebd5dfae76dc65003`). |

#### Archivos modificados
| Archivo | Antes → Después | Por qué |
|---------|-----------------|---------|
| `src/helpers/driver-auth.js` | Revoke sync en memoria. → Revoke/check **async** en KV + memoria; TTL ≈ exp del token. | Logout válido en todos los isolates. |
| `src/api/app-chofer-logout.js` | No esperaba revoke durable. → `await` revoke. | Garantiza persistencia. |

---

### 3.6 Sprint E2 — CORS allowlist

**Problema:** `Access-Control-Allow-Origin: *` en prod.

#### Archivos modificados
| Archivo | Antes → Después | Por qué |
|---------|-----------------|---------|
| `src/config.js` | `CORS_HEADERS` estático con `*`. → `resolveCorsOrigin` / `getCorsHeaders(request, env)` + var `CORS_ALLOWED_ORIGINS`. | Orígenes explícitos (Torre + dev). |
| `src/index.js` | OPTIONS con headers fijos. → Usa `getCorsHeaders`. | Preflight alineado. |
| `wrangler.jsonc` | — | Var `CORS_ALLOWED_ORIGINS`. |

**Deuda restante:** muchas responses JSON todavía pegan `CORS_HEADERS` estático; el preflight/helpers principales ya están allowlist. Migración total de call sites = trabajo pendiente menor.

---

### 3.7 Sprint E3 — Flags de monitoreo

**Problema:** `getMonitoringConfig(env)` documentado pero `withMonitoring` no lo usaba en runtime.

#### Archivos modificados
| Archivo | Antes → Después | Por qué |
|---------|-----------------|---------|
| `src/monitoring/middleware.js` | Flag estático / wrap condicional engañoso. → `isMonitoringEnabled` vía `getMonitoringConfig(env)` en runtime; wrap siempre, skip instrumentación si off. | Vars env tienen efecto real. |
| `src/monitoring/middleware.test.js` | Esperaba handler idéntico si disabled. → Espera skip de instrumentación; `afterEach` resetea flag. | 14/14 tests verdes. |

---

### 3.8 Sprint F1 — OpenAI fuera del camino crítico

**Problema:** enrich reescribía score ya calculado con LLM → costo, latencia, dependencia.

#### Archivos modificados
| Archivo | Antes → Después | Por qué |
|---------|-----------------|---------|
| `src/ai.js` | Podía llamar OpenAI en enrich. → Score determinístico salvo `OPENAI_ENRICH_ENABLED=true` + API key. | Enrich no depende de OpenAI. |
| `wrangler.jsonc` | — | `OPENAI_ENRICH_ENABLED=false` por defecto. |
| `docs/configuration.md` | Issue flags marcado resuelto / documentado. | Ops clara. |

---

### 3.9 Sprint D3 — RLS multi-tenant

**Problema:** cero Row Level Security; riesgo si se usa anon key o hay fuga.

#### Migración nueva (aplicada)
```
migrations/008_rls_tenant_isolation.sql
migrations/008_rollback.sql
```

**Comportamiento:**
- Función `public.app_current_tenant()` lee `app.current_tenant` o claim JWT `tenant_id`.
- `ENABLE` + `FORCE ROW LEVEL SECURITY` en:
  - `ordenes_pendientes`, `flota_vehiculos`, `choferes`, `bitacora_viajes`
  - `gps_trail`, `stop_dwell_stats`, `fleet_alerts`, `rescue_missions`
  - `tenant_settings`, `depots`
- Policy `tenant_isolation_all` para roles `anon` / `authenticated` (fail-closed si no hay tenant).
- Roles con `BYPASSRLS` (`service_role` / `postgres` en Supabase) **siguen viendo todo** → el Worker actual no se rompe.

#### Archivos modificados
| Archivo | Cambio | Por qué |
|---------|--------|---------|
| `src/db.js` | Nuevo `setTenantContext`; `withDb` / `withDbTransaction` aceptan `options.tenantId` → `set_config('app.current_tenant', …)`. | Para Hyperdrive con rol sin bypass en el futuro. |

---

### 3.10 Sprint D4 — Disciplina `tenant_id`

#### Archivo nuevo
| Archivo | Rol |
|---------|-----|
| `src/helpers/tenant-discipline.test.js` | (1) `requireTenantId` fail-closed; (2) checklist de 16 handlers sensibles que deben usar `requireTenantId` vía `import.meta.glob(?raw)`. |

**Handlers chequeados:** `gps`, `lead-rescue`, `dashboard`, `choferes`, `app-chofer-*`, `sync`, `mobile-sync`, `chat`, `quick-route`, `depots`, `eta-accuracy`, `reoptimizar-midday`.

---

### 3.11 Sprint F3 — Riesgo SLA empírico (producto diario)

**Problema:** no había score pre-despacho usable con dwell + bias ETA; Torre solo tenía riesgo “reloj” (ETA > SLA).

#### Archivos nuevos
| Archivo | Rol |
|---------|-----|
| `src/helpers/sla-risk.js` | `scoreStopSlaRisk`, `lookupDwellP90`, `lookupEtaBiasMin`, `loadSlaRiskLookups`, `enrichOrdersWithSlaRisk`, `attachSlaRiskToViajes`. |
| `src/helpers/sla-risk.test.js` | Casos OK / watch / risk / breach. |

**Fórmula (simple):**
```
service = dwell_p90 ?? 5 min
finish  = eta (+ travel provisional si no hay eta) + bias + service
slack   = SLA - finish
score 0–100 por bandas de slack (≥30 ok, 0–30 watch, −30 risk, <−30 breach)
```

#### Cableado
| Archivo | Cambio |
|---------|--------|
| `src/api/optimizer.js` | Antes de VRP: `enrichOrdersWithSlaRisk`; si score≥50 sube `peso_riesgo_ia` ≥ 0.8 → soft reorder. |
| `src/api/reoptimizar-midday.js` | Igual en leftovers → VRP. |
| `src/api/dashboard.js` | SSR + `/api/control-tower-viajes`: `attachSlaRiskToViajes`. |
| `src/ui/templates/layout.js` | Badge `⚠️ Quiebra SLA · {cliente}` si `sla_risk_score ≥ 50`. |
| `src/ui/client/pollingYEventos.js` | Mismo badge en refresh. |
| `src/ui/server/calculosViaje.js` | Sort prioriza score empírico. |

**Nota:** sin ≥3 muestras dwell / pocas métricas ETA, el score degrada a heurística; el badge “se enciende” con datos reales.

---

### 3.12 Sprint F2 — Velocidad fallback calibrada

**Problema:** constante 35 km/h en Haversine / VRP / midday ignoraba historial de error ETA.

#### Archivos nuevos
| Archivo | Rol |
|---------|-----|
| `src/helpers/speed-calibration.js` | `speedSampleFromMetric`, `lookupEffectiveSpeedKmh` / `getEffectiveSpeedKmh` (cache 10 min), `applyClimaToSpeed`. Cadena: chofer×hora → hora → tenant → bias → config 35. |
| `src/helpers/speed-calibration.test.js` | Unitarios + lookup mock. |

**Fórmula de muestra:** con `distancia_restante_km` y `error_minutos` (+ = tarde):
```
planned_h = dist / V0
actual_h  = max(planned_h + error/60, 0.05)
v_sample  = clamp(dist / actual_h, 8..80)
agregado  = mediana
```

#### Cableado
| Archivo | Antes → Después |
|---------|-----------------|
| `src/api/app-chofer-evento.js` (SALIDA cascade) | `vel = 35` fijo → `getEffectiveSpeedKmh(pgClient, {tenant, chofer})`; metadata guarda `velocidad_kmh` / `velocidad_source`. |
| `src/api/optimizer.js` | `velocidadPromedioKmH = 35` + switch clima → base calibrada + `applyClimaToSpeed`. |
| `src/api/reoptimizar-midday.js` | Igual. |
| `src/helpers/lead-rescue.js` | `delta_km/35` → `velocidadKmH` param. |
| `src/api/lead-rescue.js` | Pasa velocidad calibrada a ranking. |

Clima (LLUVIA/NIEBLA) se aplica como factor relativo (25/35, 15/35) sobre la base calibrada, no como reemplazo absoluto de 35.

---

## 4. Inventario de archivos clave (post-auditoría)

### Nuevos (auditoría / F2 / F3 / RLS)
```
lead-rescue-worker/docs/PLAN-ACCION-AUDITORIA-2026-07-25.md
lead-rescue-worker/docs/CAMBIOS-POST-AUDITORIA-2026-07-25.md   ← este archivo
lead-rescue-worker/migrations/007_tenant_settings.sql
lead-rescue-worker/migrations/008_rls_tenant_isolation.sql
lead-rescue-worker/migrations/008_rollback.sql
lead-rescue-worker/src/helpers/gps-timestamp.js (+ .test.js)
lead-rescue-worker/src/helpers/tenant-settings.js
lead-rescue-worker/src/helpers/sla-risk.js (+ .test.js)
lead-rescue-worker/src/helpers/speed-calibration.js (+ .test.js)
lead-rescue-worker/src/helpers/tenant-discipline.test.js
logistica-app/src/config/api.ts
logistica-app/.env.example
```

### Modificados más relevantes
```
# Worker
src/api/gps.js
src/api/lead-rescue.js
src/api/dashboard.js
src/api/optimizer.js
src/api/reoptimizar-midday.js
src/api/app-chofer-evento.js
src/api/app-chofer-logout.js
src/ai.js
src/config.js
src/db.js
src/index.js
src/jobs.js
src/helpers/driver-auth.js
src/helpers/lead-rescue.js
src/monitoring/middleware.js (+ .test.js)
src/ui/templates/layout.js
src/ui/client/pollingYEventos.js
src/ui/server/calculosViaje.js
wrangler.jsonc
docs/configuration.md

# App
logistica-app/src/store/syncStore.ts
logistica-app/src/store/authStore.ts
logistica-app/src/store/chatStore.ts
logistica-app/src/services/evidence.ts
logistica-app/src/screens/HomeScreen.tsx
```

---

## 5. Variables / bindings nuevos en Cloudflare

| Nombre | Tipo | Uso |
|--------|------|-----|
| `DRIVER_REVOKED_JTI` | KV | JTIs revocados de choferes |
| `CORS_ALLOWED_ORIGINS` | var | Allowlist CORS (coma-separada) |
| `OPENAI_ENRICH_ENABLED` | var | `false` por defecto |
| `EXPO_PUBLIC_API_URL` | env app | URL API (build Expo) |

---

## 6. SQL que el operador debió / debe tener aplicado

| # | Archivo | Propósito | Estado |
|---|---------|-----------|--------|
| 006 | `006_gps_trail_dwell_rescue.sql` | Trail, dwell, alerts, rescue (Fase 0–1) | Aplicada (sesión anterior) |
| 007 | `007_tenant_settings.sql` | Telegram por tenant | **Aplicada** |
| 008 | `008_rls_tenant_isolation.sql` | RLS | **Aplicada** |

Insert opcional 007 (ejemplo):
```sql
INSERT INTO tenant_settings (tenant_id, telegram_ops_chat_id)
VALUES ('empresa_base', '<CHAT_ID>')
ON CONFLICT (tenant_id) DO UPDATE
SET telegram_ops_chat_id = EXCLUDED.telegram_ops_chat_id,
    updated_at = NOW();
```

---

## 7. Tests agregados / reparados

| Suite | Resultado típico |
|-------|------------------|
| `gps-timestamp.test.js` | Unitarios parse/rango |
| `middleware.test.js` | 14 passed (tras fix runtime-disable) |
| `tenant-discipline.test.js` | 19 passed |
| `sla-risk.test.js` | Bandas de score |
| `speed-calibration.test.js` | Muestras + lookup mock |
| `lead-rescue.test.js` | Ranking sigue OK con vel configurable |

---

## 8. Qué NO se hizo (explícito)

| Ítem | Motivo |
|------|--------|
| A1 Dominio propio + rebrand visible | Ops/DNS; no código puro |
| A3 Rename worker/colas `lead-rescue` | Breaking; diferido |
| CORS: reemplazar todos los `CORS_HEADERS` estáticos | Parcial (OPTIONS + helpers) |
| Revoke JWT operadores | Solo choferes (E1) |
| F4 POD HMAC / “crypto irrefutable” | Pausado por diseño (auditoría) |
| G SII Res. 154 | Condicional a validación oficial |
| Pilotos comerciales (C1–C4) | Track negocio, no código |
| B6 Medición falsos positivos DMS 1 semana | Requiere chofer real |
| Setear `EXPO_PUBLIC_API_URL` en CI/build prod | Acción de ops |

---

## 9. Definition of Done (checklist global)

| Criterio | Estado |
|----------|--------|
| GPS offline conserva timestamps | Hecho (código) |
| `confirmRescue` transaccional | Hecho |
| Telegram por tenant | Hecho |
| RLS tablas core | Parcial (cosmético hasta Hyperdrive=otif_app) |
| Logout chofer revoca (KV) | Hecho |
| OpenAI fuera de enrich crítico | Hecho |
| App sin URL hardcodeada | Parcial (env + fallback legacy) |
| Dominio propio Torre | Pendiente |
| ≥1 piloto real un día | Pendiente |
| F3 usable | Hecho (necesita datos históricos) |
| F2 calibración | Hecho (necesita métricas con `km_al_siguiente`) |

---

## 10. Cómo verificar rápido en prod

1. **GPS ts:** sync offline → filas en `gps_trail.recorded_at` ≠ todas iguales a “ahora”.  
2. **Rescue TX:** confirmar rescate; si falla mid-TX, no deben quedar OTs a medias.  
3. **Telegram tenant:** fila en `tenant_settings` → alertas al chat correcto.  
4. **Logout:** logout chofer → mismo JWT rechazado en otro isolate/request.  
5. **RLS:** con rol `anon` sin `app.current_tenant` → 0 filas (service role sigue OK).  
6. **F3:** viaje con dwell histórico y ETA apretada → badge “Quiebra SLA” en Torre.  
7. **F2:** tras varias ENTREGA con cascade Haversine, logs `[ETA_RECALC] … vel=XX(tenant|hour|…)` ≠ siempre 35.

---

## 11. Mapa mental “antes vs después”

| Tema | Antes (auditoría) | Después |
|------|-------------------|---------|
| GPS offline | Hora de recepción | Hora del dispositivo (validada) |
| Rescate | Riesgo partial update | Una TX PG |
| Telegram | Global | Por tenant (+ fallback) |
| JWT logout | Memoria isolate | KV |
| CORS | `*` | Allowlist (preflight) |
| Monitoreo flags | Papel | `env` real |
| Enrich AI | OpenAI en crítico | Off por defecto |
| Aislamiento DB | Solo app filters | RLS + filters |
| Riesgo SLA | Solo reloj ETA>SLA | Empírico dwell+bias + badge |
| Velocidad ETA | 35 fijo | Mediana histórica + clima |

---

*Documento generado para envío / revisión externa. Código en working tree del monorepo; varios cambios aún pueden no estar commiteados en git — pedir commit explícito si se necesita snapshot versionado.*
