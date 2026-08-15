# QA exploratorio — Torre + App/API (2026-07-25)

**Alcance:** probe API prod + revisión estática UI/app + login browser.  
**Bloqueo:** `/control-tower` y varios dashboards detrás de **Cloudflare Access** (no pude entrar a flota/modales sin tu sesión Access + password operador).  
**Código desplegado en esta sesión:** geocerca auto-LLEGADA, `withDb` local TX, 009 sin password; fix parcial poll Ruta Rápida.

---

## A) Entregado en código (antes del QA)

| Ítem | Estado |
|------|--------|
| Auto-LLEGADA geocerca 150 m en `/api/gps/ping` | Deploy `1324f85e…` |
| `withDb` tenant con `local:true` + TX + clear | Hecho |
| Mig 009 sin LOGIN/password en repo | Hecho (aplicar vos) |
| `window.actualizarViajesSilencioso` para Ruta Rápida | Fix aplicado (redeploy pendiente si no se hizo tras el fix) |

**Ops:** aplicar `009_travel_error_and_otif_app_role.sql` y crear login **fuera** del SQL.

---

## B) Hallazgos API / edge (prod live)

| # | Sev | Hallazgo | Evidencia |
|---|-----|----------|-----------|
| A1 | P1 | **CORS roto en preflight:** OPTIONS responde `Access-Control-Allow-Origin: null` (literal) si Origin no está en allowlist o config; responses reales siguen con `*` en muchos handlers | Probe OPTIONS `/api/depots`, `/api/operator/login` |
| A2 | P1 | **CF Access inconsistente:** protege `/control-tower`, dashboards, `/api/control-tower-viajes`, `/api/gps/live`, `/api/optimizar-rutas` pero **no** `/api/depots`, `/api/operators`, `/api/eta-accuracy/stats`, `/login` | 302 Access vs 401 Worker |
| A3 | P2 | `tenant_id` 403 **antes** de auth/HMAC en GPS ping, chofer login, webhooks | Body `{}` → “tenant_id es obligatorio” |
| A4 | P2 | `GET /` → 404 JSON con CORS `*` | Probe root |
| A5 | P2 | Path público es `/public-route/:id` no `/api/public-route/...` | 404 en path wrong |
| A6 | OK | Login operator: empty/partial/bad JSON/wrong pwd → 400/401 correctos | Probe |
| A7 | OK | Operator GETs sin token → 401 | Probe |

---

## C) Hallazgos Torre UI (estático + confirmado en código)

| # | Sev | Hallazgo | Repro |
|---|-----|----------|-------|
| T1 | **P0** | Tras cerrar **Ruta Rápida**, `setInterval(actualizarViajesSilencioso)` falla: la función no era global → **polling muerto** | Abrir modal RR → cerrar → flota deja de refrescar |
| T2 | **P0** | `safeTripId` = hex trip_id `.slice(0,24)` → colisión entre `SPOT-YYYYMMDD-001` y `-002` | Dos SPOT mismo día → DOM ids duplicados |
| T3 | P1 | XSS Lead Rescue banner: `trip_id`/`chofer`/errores en `innerHTML` sin escape | Payload alert malicioso |
| T4 | P1 | XSS/`javascript:` en `p.uri` “Ver Documento” | uri malicioso |
| T5 | P1 | Búsqueda se resetea cada poll 5s (reemplaza HTML sin reaplicar filtro) | Buscar → esperar 5s |
| T6 | P1 | Cache de mapa no invalida tras re-opt / editar dirección | Seleccionar viaje → editar → reabrir |
| T7 | P1 | Abort OSRM → mapa vacío sin fallback | Cambiar viajes rápido |
| T8 | P1 | SSR badges usan `estado` distinto a poll (`estado_operacional` / EN_SITIO) | Carga inicial con EN_SITIO |
| T9 | P1 | Contador tab Flota cuenta viajes ocultos (100% terminales) | Completar viaje |
| T10 | P1 | XSS tags backlog en poll | tag HTML en metadata |
| T11 | P1 | Modal compartir: `public_url` sin escape | API comprometida |
| T12 | P2 | Contador “Flota (N)” vs cards visibles inconsistente | mismo que T9 |

**Fix T1:** aplicado en working tree (`window.actualizarViajesSilencioso`).

---

## D) Hallazgos App chofer (estático)

| # | Sev | Hallazgo | Repro |
|---|-----|----------|-------|
| M1 | P1 | LLEGADA manual **sin lat/lng** en evento; UI optimista EN_SITIO aunque falle sync | Tap Llegada offline |
| M2 | P1 | Poll 45s puede **revertir** EN_SITIO optimista si cola no subió | LLEGADA offline → esperar poll |
| M3 | P1 | ENTREGA: UI avanza aunque `registrarEvento` falle; manda SALIDA igual | 4xx/offline en entrega |
| M4 | P1 | Items `failed` en cola sin UI de reintento; LLEGADA/PROBLEMA se borran tras MAX_RETRIES | Forzar 4xx |
| M5 | P2 | Doble-tap posible en botones de estado | Tap rápido |
| M6 | Info | Geocerca servidor mitiga M1/M2 **si GPS ping llega** cerca del destino; botón sigue siendo fallback |

---

## E) Lo que NO pude probar (necesito vos)

1. Login Cloudflare Access a `/control-tower`
2. Password de operador (`MONITORING_PASSWORD` / tower_operators)
3. Flujos: asignar chofer, optimizar, chat, rescate modal, mapa con datos reales
4. App Expo en device/emulator con PIN real

**Para continuar QA interactivo:** abrí Torre logueado (Access + operador) o pasame sesión/credenciales de staging (no prod secrets en chat si preferís staging).

---

## F) Prioridad de arreglo sugerida

| # | Ítem | Estado (2026-07-25 tarde) |
|---|------|---------------------------|
| 1 | T1 poll Ruta Rápida | **Hecho** (prod) |
| 2 | T2 safeTripId | **Hecho** (hex completo) |
| 3 | XSS T3/T4/T10/T11 | **Hecho** |
| 4 | T5 búsqueda / T9 Flota count | **Hecho** |
| 5 | App M1–M4 | **Hecho** (código local Expo; rebuild app) |
| 6 | CORS A1 preflight `null` | **Hecho** (403 sin ACAO) |
| 7 | CORS respuestas `*` vs allowlist | **Hecho** (`withCorsContext` + Proxy) |
| 8 | A3 GPS tenant antes de auth | **Hecho** (JWT primero) |
| 9 | Alinear CF Access a APIs operador | **Ops** — ver checklist abajo; Worker ya exige sesión en rutas operador |

### Checklist Cloudflare Access (pegar en Zero Trust → Applications)

Incluir en la **misma** aplicación/policy (o path rules equivalentes):

```
/control-tower*
/reporte*
/api/control-tower-viajes*
/api/gps/live*
/api/optimizar-rutas*
/api/reoptimizar-midday*
/api/sync-excel*
/api/depots*
/api/operators*
/api/eta-accuracy*
/api/lead-rescue*
/api/quick-route*
/api/fleet-alerts*
/dashboard/*
```

**Excluir** (deben quedar públicos / app chofer / webhooks):

```
/login
/health*
/api/operator/login
/api/choferes/*
/api/chofer/*
/api/app-chofer-*
/api/gps/ping
/api/webhooks/*
/public-route/*
```

Nota: aunque Access falle o no cubra un path, el Worker responde **401** con cookie de operador ausente (defensa en profundidad).

---

## G) Geocerca — cómo verificar

1. Chofer con viaje EN_RUTA, parada con coords  
2. GPS ping dentro de 150 m del destino  
3. Respuesta incluye `auto_llegada: { ot_id, dist_m }`  
4. OT → `EN_SITIO` + `hora_llegada_chofer` + bitácora `auto_geofence`  
5. ENTREGA posterior → `insertEtaMetric` + dwell ya no se saltan  

Migración 009 + Hyperdrive `otif_app` siguen siendo ops aparte.
