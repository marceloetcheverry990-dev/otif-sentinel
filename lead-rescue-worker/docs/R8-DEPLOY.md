# R8 — Deploy controlado

**Rama:** `repair/monorepo-security`  
**Última actualización:** 2026-07-26

## Estado R8.0 — DB / Hyperdrive

| Check | Resultado |
|-------|-----------|
| `GET /health` prod | **200** `status: healthy`, `database.connected` (2026-07-26) |
| Hyperdrive `8390e963…` | `aws-0-us-west-2.pooler.supabase.com:5432` user `postgres.cbjderarqvfwzrbqeqjv` |

## Estado R8.1 — Staging

| Check | Resultado |
|-------|-----------|
| Worker | `lead-rescue-pipeline-staging` |
| Version | `1410aa58-354a-4d4e-9dda-d074e1059f90` |
| `/health` | **200** connected |
| Colas | `leads-*-queue-staging` creadas y bindeadas |

## Estado R8.2 — Abuse + security

| Check | Resultado |
|-------|-----------|
| `npm run r8:abuse` vs staging | **11/11 PASS** (2026-07-26) |
| `npm run test:security` | **59/59 PASS** (2026-07-26) |

## Estado R8.5 — Canary prod

| Check | Resultado |
|-------|-----------|
| Rollback Version ID (pre-deploy) | `1a496296-a351-4006-8050-a90d8250b8a2` |
| New Version ID | `1176b4dc-c15d-40f1-9d6a-cc3ddbb5024d` |
| `/health` post-deploy | **200** healthy, DB connected |
| Access (control-tower / optimizar) | **302** (Access sigue activo) |

Rollback si hace falta:

```powershell
npx wrangler rollback
# o redeploy de 1a496296-a351-4006-8050-a90d8250b8a2
```

## Estado R8.6 — Cloudflare Access

**Access NO se retira.** Criterios incompletos: checklist móvil (R8.3) pendiente de ejecución en dispositivo. Contención R0 se mantiene a propósito.

Si `/health` vuelve a 503: verificar proyecto Supabase activo, password Hyperdrive alineada, y puerto pooler (session `5432` / transaction `6543`).

## Staging (R8.1)

| Item | Valor |
|------|--------|
| Worker | `lead-rescue-pipeline-staging` |
| URL | https://lead-rescue-pipeline-staging.marceloetcheverry990.workers.dev |
| Hyperdrive | **Mismo id prod hasta provisionar DB staging** (`SHARED_DATASTORE=true`). Crear Postgres nuevo + `npm run provision:staging-db` y cambiar `env.staging.hyperdrive`. |
| Colas | `leads-*-queue-staging` |
| Tenant monitoring | `staging_test` |
| R2 | `chat-photos` (mismo bucket; preferir prefijos/tenant de prueba) |

### Crear colas (una vez)

```powershell
cd lead-rescue-worker
npx wrangler queues create leads-ingestion-queue-staging
npx wrangler queues create leads-enrichment-queue-staging
npx wrangler queues create leads-delivery-queue-staging
```

### Secrets staging

Usar valores **distintos** a prod (`JWT_SECRET`, `DASHBOARD_SECRET`, `MONITORING_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`). Hyperdrive de staging debe apuntar a ese Postgres, no al de prod.

```powershell
# Desde .dev.vars (no commitear):
Get-Content .dev.vars | npx wrangler secret bulk --env staging

# O uno a uno:
npx wrangler secret put JWT_SECRET --env staging
npx wrangler secret put DASHBOARD_SECRET --env staging
npx wrangler secret put MONITORING_PASSWORD --env staging
npx wrangler secret put SUPABASE_URL --env staging
npx wrangler secret put SUPABASE_SERVICE_KEY --env staging
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
# …resto según necesidad (MAPBOX, ORDER_INGEST, PIN_PEPPER, etc.)
```

### Deploy staging

```powershell
# Preferible fuera de OneDrive si wrangler falla por path sync
npx wrangler deploy --env staging --dry-run
npx wrangler deploy --env staging
curl.exe -sS "https://lead-rescue-pipeline-staging.marceloetcheverry990.workers.dev/health"
```

Esperado: HTTP 200, `database.status: connected`.

### Rollback staging

```powershell
npx wrangler deployments list --env staging
npx wrangler rollback --env staging
```

## Abuse probes (R8.2)

```powershell
$env:R8_BASE_URL = "https://lead-rescue-pipeline-staging.marceloetcheverry990.workers.dev"
node scripts/r8-abuse-probes.mjs
npm run test:security
```

Fallos bloquean canary prod.

## Canary producción (R8.5)

1. Anotar Version ID actual: `npx wrangler deployments list` (primera versión = rollback).
2. `npx wrangler deploy --dry-run` luego `npx wrangler deploy` desde `repair/monorepo-security`.
3. Post: `/health` 200; Cloudflare Access sigue activo; smoke Torre + móvil.
4. Monitorear 15–30 min.

Rollback:

```powershell
npx wrangler rollback
# o redeploy de Version ID anotado
```

## Retirar Access (R8.6)

Solo si: health estable, R8.2 verde, smoke prod OK, checklist móvil hecha o riesgo aceptado por escrito. Entonces quitar apps Zero Trust de R0. **No antes.**

## Checklist móvil (R8.3)

Ver [R8-MOBILE-CHECKLIST.md](./R8-MOBILE-CHECKLIST.md).
