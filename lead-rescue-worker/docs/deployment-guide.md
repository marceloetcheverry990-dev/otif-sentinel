# Deployment Guide — OTIF Sentinel

**Sistema:** lead-rescue-pipeline
**Worker:** https://lead-rescue-pipeline.marceloetcheverry990.workers.dev
**Versión actual:** 8.0.0
**Última actualización:** 2026-07-26

> **R8 (deploy controlado):** ver [`R8-DEPLOY.md`](./R8-DEPLOY.md) — staging  
> `lead-rescue-pipeline-staging`, abuse probes, canary y criterios para retirar Access.

---

## Índice

1. [Pre-requisitos](#1-pre-requisitos)
2. [Fases de deployment](#2-fases-de-deployment)
3. [Fase 1 — Schema de base de datos](#3-fase-1--schema-de-base-de-datos)
4. [Fase 2 — Deployment del worker](#4-fase-2--deployment-del-worker)
5. [Fase 3 — Verificación post-deployment](#5-fase-3--verificación-post-deployment)
6. [Rollback](#6-rollback)
7. [Checklist completo](#7-checklist-completo)
8. [Notas de seguridad](#8-notas-de-seguridad)
9. [Staging (R8)](#9-staging-r8)

---

## 1. Pre-requisitos

### Herramientas

```bash
node --version   # Node.js 18+
npx wrangler --version   # Wrangler 4.x
```

### Autenticación con Cloudflare

```bash
npx wrangler whoami
# Si no está autenticado:
npx wrangler login
```

### Variables de entorno locales (solo desarrollo)

Copiar `.dev.vars.example` a `.dev.vars` en la raíz de `lead-rescue-worker` y
reemplazar los placeholders localmente. La conexión local de Hyperdrive se
configura aparte en la sesión del shell:

```powershell
$env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="<connection-string>"
```

Variables mínimas de autenticación en `.dev.vars`:

```
JWT_SECRET=<clave aleatoria de al menos 32 bytes>
DASHBOARD_SECRET=<clave diferente de al menos 32 bytes>
MONITORING_PASSWORD=<contraseña fuerte y única>
```

> ⚠️ Nunca commitear `.dev.vars`, cadenas de conexión ni valores reales. La
> plantilla completa está en `.dev.vars.example`.

---

## 2. Fases de deployment

El sistema tiene tres componentes que se deben deployar en orden:

```
Fase 1: Schema DB (migraciones SQL en Supabase)
   ↓
Fase 2: Worker (npx wrangler deploy)
   ↓
Fase 3: Verificación (endpoints + consultas SQL)
```

Un deployment nuevo en un ambiente limpio requiere las tres fases.
Un redeploy de código (sin cambios de schema) solo requiere Fase 2 + 3.

---

## 3. Fase 1 — Schema de base de datos

### Migraciones disponibles

| Archivo | Descripción | Estado |
|---------|-------------|--------|
| `migrations/001_monitoring_schema.sql` | Crea tablas de monitoreo | ✅ Aplicada en producción |
| `migrations/001_rollback.sql` | Revierte la migración 001 | Solo usar en emergencia |
| `migrations/002_add_raw_aggregation_type.sql` | Agrega `raw` al CHECK de `aggregation_type` | ✅ Aplicada en producción |
| `migrations/002_rollback.sql` | Revierte la migración 002 | Solo usar en emergencia |
| `migrations/003_eta_accuracy_metrics.sql` | Tabla de métricas de precisión ETA | ✅ Aplicada en producción |

### Aplicar una migración nueva

Ejecutar en Supabase SQL Editor (https://supabase.com/dashboard):

```sql
-- Ejemplo: aplicar 001_monitoring_schema.sql
-- 1. Abrir el archivo localmente
-- 2. Copiar el contenido
-- 3. Pegar en el SQL Editor del proyecto y ejecutar
```

### Verificar que las migraciones están aplicadas

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'error_logs', 'metrics_summary', 'alert_history',
    'health_check_results', 'eta_accuracy_metrics', 'dead_letter_events', 'system_flags'
  )
ORDER BY table_name;
-- Esperado: 7 filas
```

### Crear partición mensual de `metrics_summary` (mantenimiento)

La migración 001 crea particiones para los 4 meses siguientes al momento de aplicación.
Crear manualmente la próxima partición si se acerca el fin del período:

```sql
DO $$
DECLARE
  target_start DATE := DATE_TRUNC('month', CURRENT_DATE + INTERVAL '4 months');
  target_end   DATE := target_start + INTERVAL '1 month';
  pname        TEXT := 'metrics_summary_' || TO_CHAR(target_start, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = pname) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF metrics_summary FOR VALUES FROM (%L) TO (%L)',
      pname, target_start, target_end
    );
    RAISE NOTICE 'Partición creada: %', pname;
  ELSE
    RAISE NOTICE 'Partición ya existe: %', pname;
  END IF;
END $$;
```

---

## 4. Fase 2 — Deployment del worker

### Build y deploy

```bash
cd lead-rescue-worker

# Verificar que el build compila sin errores
npx wrangler deploy --dry-run --outdir dist-check

# Si el dry-run pasa, deployar a producción
npx wrangler deploy
```

**Output esperado:**
```
Total Upload: ~2680 KiB / gzip: ~520 KiB
Worker Startup Time: ~43 ms
Uploaded lead-rescue-pipeline (X sec)
Deployed lead-rescue-pipeline triggers (X sec)
  https://lead-rescue-pipeline.marceloetcheverry990.workers.dev
  schedule: */2 * * * *
  schedule: 0 2 * * *
Current Version ID: <uuid>
```

Verificar que aparecen **dos** crons: `*/2 * * * *` y `0 2 * * *`.

### Configurar Secrets (primera vez o rotación)

Los secrets se configuran separado del código y no requieren redeploy posterior:

```bash
# Token del bot de Telegram (obligatorio)
npx wrangler secret put TG_BOT_TOKEN

# Clave de OpenAI (obligatorio)
npx wrangler secret put OPENAI_API_KEY

# Secret de Meta (si aplica)
npx wrangler secret put META_APP_SECRET

# Chat ID separado para alertas de monitoreo (opcional)
npx wrangler secret put MONITORING_CHAT_ID
```

> ⚠️ Cada comando pide el valor interactivamente. No pegar valores en el shell directamente
> para evitar que queden en el historial de comandos.

### Pendiente de seguridad — mover `MONITORING_PASSWORD` a Secret, configurar `JWT_SECRET` y `DASHBOARD_SECRET`

```bash
# JWT_SECRET: clave HMAC-SHA256 para firma de tokens de autenticación de choferes.
# Generar un valor seguro con:
#   openssl rand -base64 32
# Luego configurar como secret:
npx wrangler secret put JWT_SECRET

# DASHBOARD_SECRET: clave HMAC-SHA256 para firma de tokens de operadores de Torre de Control.
# Secreto separado de JWT_SECRET — nunca usar el mismo valor para ambos.
# Generar con:
#   openssl rand -base64 32
# Configurar como secret:
npx wrangler secret put DASHBOARD_SECRET

# MONITORING_TENANT_ID: ya está configurado en wrangler.jsonc como variable de texto plano
# (valor "empresa_base"). No es un secret — es el identificador del tenant, no una credencial.

# MONITORING_PASSWORD: contraseña de acceso a dashboards de monitoreo.
# Ejecutar después de agregar el secret:
npx wrangler secret put MONITORING_PASSWORD

# Luego remover de wrangler.jsonc:
# Eliminar la línea "MONITORING_PASSWORD": "REMOVED_SECRET" de vars
# Redeploy:
npx wrangler deploy
```

> ⚠️ `JWT_SECRET` debe tener **mínimo 32 bytes** (256 bits). El helper `driver-auth.js`
> rechazará el deployment si el secreto es demasiado corto.
> ⚠️ Nunca usar el mismo valor de `JWT_SECRET` de `.dev.vars` en producción.

---

## 5. Fase 3 — Verificación post-deployment

### V1 — Worker vivo

```
GET https://lead-rescue-pipeline.marceloetcheverry990.workers.dev/health
```

Esperado: HTTP 200 con `"status":"healthy"`, `database.status:"connected"`, `latency_ms < 200`.

### V2 — Sistema de monitoreo activo

```
GET https://lead-rescue-pipeline.marceloetcheverry990.workers.dev/health/monitoring
```

Esperado: HTTP 200 con `"status":"healthy"` o `"degraded"` (degraded es aceptable si no hay
tráfico reciente).

### V3 — Dashboard accesible

```
GET https://lead-rescue-pipeline.marceloetcheverry990.workers.dev/dashboard/monitoring
```

Esperado: HTTP 200 con la página HTML del dashboard (requiere autenticación).

### V4 — Crons registrados en Cloudflare

Verificar en Cloudflare Dashboard → Workers → lead-rescue-pipeline → Triggers:
- `*/2 * * * *` presente
- `0 2 * * *` presente

### V5 — DB con datos de monitoreo

```sql
SELECT table_name, COUNT(*) AS filas
FROM information_schema.tables t
LEFT JOIN LATERAL (
  SELECT COUNT(*) FROM information_schema.columns c
  WHERE c.table_name = t.table_name
) _ ON true
WHERE t.table_schema = 'public'
  AND t.table_name IN ('error_logs','metrics_summary','alert_history','health_check_results')
GROUP BY t.table_name;
```

Todas las tablas deben existir (0 filas es aceptable en un deployment nuevo).

### V6 — Verificar que evaluateAlerts corre

Esperar 2–4 minutos después del deploy y verificar:

```sql
-- Si hay alertas generadas, el cron está corriendo
SELECT COUNT(*) FROM alert_history WHERE timestamp > NOW() - INTERVAL '10 minutes';

-- Alternativa: ver si hay métricas recientes
SELECT MAX(timestamp) AS ultima FROM metrics_summary;
```

---

## 6. Rollback

### Rollback de código (sin cambios de schema)

```bash
# Ir a Cloudflare Dashboard → Workers → lead-rescue-pipeline → Deployments
# Seleccionar la versión anterior → Rollback

# O via CLI (si se conoce el Version ID anterior):
npx wrangler rollback <version-id>
```

### Rollback de schema (destructivo — solo en emergencia)

> ⚠️ **ADVERTENCIA: Elimina todos los datos de monitoreo de forma irreversible.**
> Ejecutar solo si el sistema de monitoreo causa un problema crítico que no puede resolverse
> por otro medio. Hacer backup primero.

```sql
-- Backup opcional antes del rollback:
CREATE TABLE error_logs_backup AS SELECT * FROM error_logs;
CREATE TABLE alert_history_backup AS SELECT * FROM alert_history;

-- Ejecutar rollback (contenido de migrations/001_rollback.sql):
-- DROP TABLE IF EXISTS error_logs CASCADE;
-- DROP TABLE IF EXISTS metrics_summary CASCADE; -- (incluye todas las particiones)
-- DROP TABLE IF EXISTS alert_history CASCADE;
-- DROP TABLE IF EXISTS health_check_results CASCADE;
```

### Procedimiento de rollback seguro

1. **Deshabilitar crons** temporalmente en Cloudflare Dashboard (o deployar con triggers vacíos)
2. Esperar 2 minutos para que terminen las operaciones en vuelo
3. Verificar que no hay queries activas:
   ```sql
   SELECT COUNT(*) FROM pg_stat_activity
   WHERE query LIKE '%error_logs%' OR query LIKE '%metrics_summary%';
   -- Esperado: 0
   ```
4. Ejecutar el rollback de schema
5. Hacer rollback de código a la versión anterior al monitoreo
6. Verificar que el worker funciona sin el monitoreo

---

## 7. Checklist completo

### Primer deployment (ambiente limpio)

- [ ] Node.js 18+ instalado
- [ ] `npx wrangler login` ejecutado y autenticado
- [ ] `.dev.vars` creado con todos los secrets para desarrollo local
- [ ] **Fase 1:** Migraciones aplicadas en Supabase
  - [ ] `001_monitoring_schema.sql` aplicada
  - [ ] `002_add_raw_aggregation_type.sql` aplicada
  - [ ] `003_eta_accuracy_metrics.sql` aplicada
  - [ ] Verificar 7 tablas existentes con la query de V5
- [ ] **Fase 2:** Worker deployado
  - [ ] `npx wrangler deploy --dry-run` pasó sin errores
  - [ ] `npx wrangler deploy` exitoso
  - [ ] Secrets configurados (`TG_BOT_TOKEN`, `OPENAI_API_KEY`)
  - [ ] Dos crons visibles en el output del deploy
- [ ] **Fase 3:** Verificación post-deployment
  - [ ] V1 `/health` → HTTP 200, `status: healthy`
  - [ ] V2 `/health/monitoring` → HTTP 200
  - [ ] V3 `/dashboard/monitoring` → Carga el dashboard
  - [ ] V4 Crons `*/2` y `0 2` en Cloudflare Dashboard
  - [ ] V5 Tablas de monitoreo existentes en DB
  - [ ] V6 `evaluateAlerts` corriendo (esperar 4 min)

### Redeploy de código (actualización)

- [ ] `npx wrangler deploy --dry-run` pasó
- [ ] `npx wrangler deploy` exitoso
- [ ] V1 `/health` → HTTP 200 post-deploy
- [ ] V2 `/health/monitoring` → HTTP 200
- [ ] Verificar que el Version ID cambió en el output

### Pendientes de seguridad (backlog)

- [ ] Configurar `JWT_SECRET` como Secret de Wrangler (`wrangler secret put JWT_SECRET`) — mínimo 32 bytes, generar con `openssl rand -base64 32`
- [ ] Mover `MONITORING_PASSWORD` de `vars` a Secret (Issue 3)
- [ ] Corregir el bug de integración de `MONITORING_ENABLED` (Issue 1)
- [ ] Habilitar DROP de particiones en `enforceRetentionPolicies` tras validar evidencia de observación (Issue 2)

---

## 8. Notas de seguridad

**Variables expuestas en `wrangler.jsonc` (texto plano):**
- `MONITORING_PASSWORD` — mover a Secret en el próximo ciclo de mantenimiento
- `MONITORING_USERNAME` — de bajo riesgo, puede quedarse en vars

**Secrets correctamente configurados (no en repositorio):**
- `TG_BOT_TOKEN`
- `OPENAI_API_KEY`
- `META_APP_SECRET`
- `JWT_SECRET` — pendiente de configurar en producción (ver sección Fase 2)

**Issues conocidos que afectan seguridad/operación:**
1. `MONITORING_ENABLED=false` no desactiva el middleware — ver `docs/configuration.md` Issue 1
2. Retention de particiones en modo observación — ver `docs/configuration.md` Issue 2
3. `MONITORING_PASSWORD` en texto plano en vars — ver `docs/configuration.md` Issue 3

**Rotación de secrets:**
Al rotar `TG_BOT_TOKEN` o `OPENAI_API_KEY`, ejecutar `npx wrangler secret put <NOMBRE>` con el
nuevo valor. No requiere redeploy — el worker lo toma en el siguiente request.

---

## 9. Staging (R8)

Worker separado: `lead-rescue-pipeline-staging` (`env.staging` en `wrangler.jsonc`).

```powershell
npx wrangler deploy --env staging --dry-run
npx wrangler deploy --env staging
curl.exe -sS "https://lead-rescue-pipeline-staging.marceloetcheverry990.workers.dev/health"
npm run r8:abuse   # o R8_BASE_URL=... node scripts/r8-abuse-probes.mjs
```

Detalle, rollback y criterios Access: [`R8-DEPLOY.md`](./R8-DEPLOY.md).  
Checklist móvil: [`R8-MOBILE-CHECKLIST.md`](./R8-MOBILE-CHECKLIST.md).
