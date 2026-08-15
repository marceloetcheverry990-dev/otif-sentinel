# Addendum — Respuesta a la crítica del informe (2026-07-25)

Este documento **corrige** afirmaciones del informe `CAMBIOS-POST-AUDITORIA` y describe el código que se cambió **después** de esa crítica.

## 1. Acuerdo con el revisor

| Crítica | Veredicto |
|---------|-----------|
| RLS tildado como “Hecho” era cosmético (BYPASSRLS) | **Correcto.** DoD mentía. |
| F2 metía dwell en velocidad si error usaba ENTREGA | **Correcto.** Riesgo real. |
| F3 sumaba bias + dwell sobre ETA ya calibrado | **Correcto.** Fatiga de alertas. |
| `tenant-discipline.test` es lint, no seguridad | **Correcto.** |
| CORS: preflight ≠ respuesta simple | **Correcto.** Parcialmente mitigado en control-tower-viajes. |
| Cuello de botella = piloto / dominio / datos | **Correcto.** No se “arregla” con más sprints de features. |

---

## 2. Qué se cambió en código tras la crítica

### 2.1 F2 / F3 — anti doble conteo

**Decisión explícita:**
- `dwell_p90` = tiempo **en sitio** (servicio)
- `error_viaje` / bias = desviación de **tránsito** (solo vs `hora_llegada_chofer`)
- **No son la misma cosa.**

| Archivo | Cambio |
|---------|--------|
| `helpers/travel-error.js` **nuevo** | `computeTravelErrorMinutos` (solo LLEGADA); `shouldApplyTravelBias`; `stripDwellFromError` |
| `helpers/eta-metric.js` | Si no hay LLEGADA → **skip** insert (no contaminar). Escribe `error_viaje_minutos` + `arrival_basis` |
| `helpers/speed-calibration.js` | Solo filas con `error_viaje_minutos` o `arrival_basis='llegada'` |
| `helpers/sla-risk.js` | `finish = eta + dwell`; bias de viaje **solo** si ETA provisional / OPTIMIZER_STATIC / NO_*_FALLBACK — **nunca** encima de `HAVERSINE_CASCADE`/`MAPBOX` |

### 2.2 RLS — estado honesto + path real

| Estado | Significado |
|--------|-------------|
| Migración **008** | Policies para `anon`/`authenticated`. **No protege** al Worker actual (service_role / postgres BYPASSRLS). |
| Migración **009** **nueva** | Columnas `error_viaje_*` + rol `otif_app` / `otif_app_login` **NOBYPASSRLS** + policies `TO otif_app` |
| `setTenantContext` | Ahora se pasa `tenantId` en withDb de: dashboard Torre, control-tower-viajes, gps ping/live, lead-rescue (candidatos/confirm/bitácora), SALIDA cascade |

**Protección real = 0 hasta que Hyperdrive use `otif_app_login`** (y se deje de depender de service key para lecturas tenant).  
Eso es ops/DB: cambiar password del rol + connection string Hyperdrive.

DoD actualizado: RLS = **Parcial / cosmético hasta Hyperdrive=otif_app**.

### 2.3 CORS

`getControlTowerViajesAPI` ahora usa `getCorsHeaders(request, env)` en la respuesta JSON (no solo OPTIONS).  
Quedan otros call sites con `CORS_HEADERS` estático — deuda explícita.

### 2.4 Tests

- `travel-error.test.js` nuevo
- `sla-risk.test.js` actualizado (no espera bias encima de HAVERSINE)
- Comentario honesto en `tenant-discipline.test.js`

---

## 3. SQL que falta aplicar

```
migrations/009_travel_error_and_otif_app_role.sql
```

**No crea LOGIN ni password** (corregido). Ops aparte:

```sql
CREATE ROLE otif_app_login LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '...secreto...';
GRANT otif_app TO otif_app_login;
```

Luego apuntar Hyperdrive a `otif_app_login`.

Verificar: `SET ROLE otif_app; SELECT set_config('app.current_tenant','empresa_base',true); SELECT count(*) FROM ordenes_pendientes;`  
Sin set_config → 0 filas.

### Fixes post-segunda crítica
- `withDb`: tenant en TX (`local:true`) + clear al salir (anti fuga pool Hyperdrive)
- Auto-LLEGADA geocerca en `/api/gps/ping` (`helpers/auto-llegada.js`, radio 150 m)

---

## 4. Bundle para auditoría línea-a-línea

```
docs/notas-ia/OTIF-Sentinel-bundle-post-critica-2026-07-25.md
```

Regenerar: `node scripts/build-audit-bundle.mjs`

---

## 5. Lo que este addendum NO resuelve (a propósito)

- Dominio propio (15 min ops — prioridad real para demos)
- Pilotos / chofer real (combustible de F2/F3)
- Staging environment
- Migrar todos los handlers de supabase-js service key a Hyperdrive+otif_app
- Commit git (pedir explícitamente si se quiere snapshot)

La crítica sobre “excelente en la dimensión que no es la restricción” se acepta. El código de F2/F3 ahora es menos mentiroso; el negocio sigue sin piloto.
