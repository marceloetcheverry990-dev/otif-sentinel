# OTIF Sentinel

TMS logístico last-mile: Torre de Control en tiempo real, app de choferes y emisión de guías de despacho electrónicas (Chile Res. 154).

Monorepo de producto — backend en Cloudflare Workers + app móvil Expo.

## Qué resuelve

- **Torre de Control:** flota en vivo, SLA/ETA, reoptimización, Lead Rescue (rescate de carga entre viajes).
- **App chofer:** eventos LLEGADA → ENTREGA (POD) → SALIDA, GPS, sync offline-first.
- **DTE / Res. 154:** emisión de guía en la primera `SALIDA`, multi-tenant, retry operador, token cifrado at-rest.
- **Ops:** Hyperdrive → Postgres/Supabase, colas, monitoreo, auth operador (cookies HttpOnly) y chofer (JWT).

## Estructura

| Carpeta | Rol |
|---|---|
| `lead-rescue-worker/` | API + Torre (Cloudflare Worker) |
| `logistica-app/` | App móvil (Expo / React Native) |
| `.kiro/specs/` | Specs de producto / ingeniería |

## Stack

Cloudflare Workers · Hyperdrive · Postgres · Supabase · Vitest · Expo · TypeScript

## Cómo correr (dev)

```powershell
# Worker
cd lead-rescue-worker
copy .dev.vars.example .dev.vars   # completar localmente; no commitear
npm ci
npx wrangler deploy --dry-run

# App
cd ..\logistica-app
npm ci
npx tsc --noEmit
```

Secretos reales van en Cloudflare Secrets (`wrangler secret put …`), nunca en el repo.

## Documentación útil

- Plan guías Res. 154: `lead-rescue-worker/docs/plan-guia-despacho-res154.md`
- Deploy / secretos: `lead-rescue-worker/docs/deployment-guide.md`

## Nota de seguridad

Este repositorio público se publicó con historial limpio (snapshot). Las credenciales de producción viven solo en Cloudflare Secrets y variables locales no versionadas.
