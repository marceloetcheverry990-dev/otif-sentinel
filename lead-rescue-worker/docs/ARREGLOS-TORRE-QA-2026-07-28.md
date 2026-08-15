# Arreglos Torre de Control — QA 28 jul 2026

Staging: `https://lead-rescue-pipeline-staging.marceloetcheverry990.workers.dev`  
Versión al cierre: `1e5e5400-1309-426e-b6c7-a1e2635ad9fc`

## Resumen

Se recorrió la Torre de punta a punta (rutas rápidas, flota, mapa, ruteo) y los módulos que faltaban: Sync/Acepta, GPS, Lead Rescue, editar dirección, notificaciones, POD/firma y segregación HAZMAT/FOOD. Abajo: bugs encontrados, fix y verificación.

---

## 1. Sync Excel / Acepta

| Bug | Fix |
|-----|-----|
| Folio Acepta solo dejaba dígitos (`A-1001` → `1001`) y no matcheaba `OT_ID` del sync | `acepta-csv.js`: mismo sanitizer alfanumérico que `sync.js` |
| Errores de URL/CSV/host salían todos como 500 genérico | `sync.js`: 400 + `detalle` para errores de cliente; 500 solo para fallos internos |

**Archivos:** `src/helpers/acepta-csv.js`, `src/helpers/acepta-csv.test.js`, `src/api/sync.js`

**QA:** endpoint responde; sin URL → 400 “URL de Bodega…”. Sync E2E con fixture `/api/fixtures/bodega-sample.csv` + CSV Acepta (`QA-SYNC-1001`…): **200**, `procesadas: 3`, match alfanumérico OK.  
Nota: el sync cancela “fantasmas” pre-ruteo ausentes del CSV (en la prueba canceló 7 OTs SPOT/QA previas en `PENDIENTE_RUTEO`).

También: fixture embebido en el Worker (self-fetch fallaba por Access/loopback).

---

## 2. GPS live / intervalo

| Bug | Fix |
|-----|-----|
| (sin crash) Flota live vacía si nadie hizo ping | Comportamiento esperado |
| Intervalo por chofer | `POST /api/admin/config-gps` → **200** OK en staging |

**QA:** `GET /api/gps/live` → 200 `{ flota: [] }` (sin GPS activo). Config intervalo 60s → éxito.

---

## 3. Lead Rescue

| Bug | Fix |
|-----|-----|
| `SELECT lat, lng` en órdenes → 500 si no hay columnas | `loadOrdersForTrip` con SAVEPOINT + fallback metadata |
| GPS `0,0` se aceptaba como válido | Rechazo `no_gps` si lat/lng son 0,0 |
| Ranking ignoraba segregación HAZMAT/FOOD | `rankRescueCandidates` + `tagsConflict`; confirm también bloquea mezcla |
| Tags del viaje destino no entraban al ranking | Se unionan tags de órdenes abiertas del candidato |

**Archivos:** `src/api/lead-rescue.js`, `src/helpers/lead-rescue.js`

**QA:** candidatos sin flota GPS → 404 `trip_not_active` o `no_gps` (ya no 500 por schema).  
**QA E2E:** seed GPS flota → candidates OK → **confirm 200** (`mission_id: 2`).

---

## 4. Editar dirección (SPOT)

| Bug | Fix |
|-----|-----|
| UPDATE `lat/lng` sin SAVEPOINT podía abortar TX | SAVEPOINT + fallback solo metadata |
| `display_name` siempre null | Usa `coords.display` del geocoder |
| Geocode basura (país) aceptada en servidor | Misma política house/street que Ruta Rápida |

**Archivos:** `src/api/quick-route.js`

**QA:** `PUT /api/quick-route/address` sobre `SPOT-…-4A7F2FAE-02` → 200, coords Providencia 1650.

---

## 5. Notificaciones cliente (Twilio / Resend)

| Bug | Fix |
|-----|-----|
| Filas `FAILED` bloqueaban re-encolado para siempre | Al re-encolar, `FAILED` → `PENDING` con payload fresco |
| Flush outbox: `inconsistent types deduced for parameter $1` | Casts explícitos `$1::varchar` / `$1::text` / `$4::bigint` en UPDATE |

**Archivos:** `src/helpers/customer-notify.js`, `src/api/admin-qa.js` (`POST /api/admin/notifications/flush`)

**QA E2E:** SMS encolados a `+56963095914` (DESPACHADO/ENTREGADO). Tras el fix de tipos, flush marca `SKIPPED` + `twilio_not_configured` (pipeline OK). **Envío real bloqueado:** staging no tiene `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` (ni Resend).

---

## 6. POD / firma

| Bug | Fix |
|-----|-----|
| UPDATE con `firma_url` sin columna abortaba la TX (25P02) y el fallback no corría | SAVEPOINT + fallback metadata (migración 012 opcional) |

**Archivos:** `src/api/app-chofer-evento.js`

**QA E2E:** JWT chofer (admin QA) + evidencia + LLEGADA + ENTREGA con `scan_token` real → **“Entrega confirmada con POD.”** (`SPOT-20260728-180E4A26-01`).

---

## 7. Segregación HAZMAT / FOOD

| Bug | Fix |
|-----|-----|
| Ruta rápida podía mezclar HAZMAT+FOOD | Rechazo 400 `segregation` al crear |
| Tags no se persistían en la OT | `tags_requeridos` en metadata (+ columna si existe) |
| `move-stop` reportaba `tags` del chofer antes que segregación | Se evalúa `tagsConflict` primero |
| Lead Rescue podía proponer mezcla | Ranking + confirm filtran conflicto |

**Archivos:** `src/api/quick-route.js`, `src/api/trip-manual.js`, `src/helpers/lead-rescue.js`

**QA:** create HAZMAT+FOOD → 400. Move FOOD → viaje HAZMAT → **400 `segregation`**.

---

## Arreglos previos de la misma sesión (contexto)

Ya desplegados antes de este bloque:

- Torre JS roto por `\\n` en template (`pollingYEventos.js`)
- Ruta rápida / reorder / move-stop / reopt / optimizer: fallbacks schema `lat/lng/peso_kg`
- Enlace público 500 + polling `/api/public-route/:token/data`
- Geocode basura “Chile” rechazado en UI + helper
- Km/costo SPOT: `metadata.routing` + API flota expone `routing`
- Optimizer `NO_AVAILABLE_DRIVERS` → HTTP 409

---

## E2E cerrados (28 jul tarde)

| Módulo | Resultado |
|--------|-----------|
| Lead Rescue | GPS seed → candidates → **confirm 200** (`mission_id: 2`) |
| POD | Driver token + foto/firma/scan → entrega confirmada |
| Notificaciones | SMS real **SENT** a `+56963095914` (Twilio trial) |

APIs QA usadas: `POST /api/admin/qa/driver-token`, `seed-fleet-gps`, `ot-scan-token`, `notifications/flush`.

---

## Deuda / no cerrado

1. ~~**Datos staging:**~~ limpieza QA aplicada (`SPOT-20260728-*` cancelados, `TRIP-A..H` despegados).
2. ~~**Schema:**~~ migraciones **012 + 013** aplicadas (`lat`/`lng`/`tags_requeridos` + product gaps).
3. **Sync bodega:** pipeline listo (fixture HTTPS + Acepta). Cuando tengas export real, pegá su URL HTTPS en Torre → Sync (mismas columnas `OT_ID,CLIENTE,...`).
4. **Twilio prod:** secrets cargados en Worker prod (sigue trial: solo números verificados). Upgrade pay-as-you-go = opcional cuando quieras SMS a cualquier cliente.
5. **Git push:** este clone no tiene `remote origin` configurado — deploy prod ya hecho vía Wrangler.


---

## Cómo verificar rápido en staging

1. Login Torre → Sync sin URL → debe decir “URL de Bodega…” (400).
2. Pegar en URL Excel: `https://lead-rescue-pipeline-staging.marceloetcheverry990.workers.dev/api/fixtures/bodega-sample.csv` → Sync (opcional + Acepta CSV).
3. Ruta Rápida con 2 paradas tags HAZMAT+FOOD → debe rechazar.
4. Expandir SPOT → ✎ Editar dirección → geocode house.
5. Intervalo GPS del select del chofer → toast/OK.
6. Compartir ruta → abrir `/public-route/{token}` → mapa con paradas.
