# Go-live checklist — OTIF Sentinel

Estado piloto (2026-08-22). Marcar al completar.

## Core funcional (staging)

- [x] Flujo Torre ↔ chofer E2E (login, assign, LLEGADA/ENTREGA/SALIDA, chat)
- [x] Supabase RLS + advisors en cero (mig 017–022)
- [x] Poll Torre con cache + invalidación
- [x] POD piloto: **foto** (QR desconectado vía `POD_SCAN_ENABLED=false`)
- [x] Script `npm run regression:staging`
- [ ] R8.3 checklist móvil en dispositivo real (`docs/R8-MOBILE-CHECKLIST.md`)

## Infra / seguridad

- [ ] Postgres staging dedicado (`npm run provision:staging-db` + Hyperdrive propio)
- [ ] Secrets staging distintos a prod (JWT, DASHBOARD, service role)
- [ ] Cloudflare Access: retirar solo tras R8.3 verde
- [ ] Canary prod con commit actual + smoke post-deploy

## Integraciones prod

- [ ] DTE real (Lioren/SimpleAPI) — salir de stub
- [ ] Twilio/SMS (notificaciones cliente)
- [ ] Credenciales SimpleAPI + maestro clientes/depots

## Reactivar escaneo QR (cuando el piloto lo pida)

1. Worker: `POD_SCAN_ENABLED=true` en `wrangler.jsonc` (vars staging/prod)
2. App: `EXPO_PUBLIC_POD_SCAN_ENABLED=true` en build Expo/EAS
3. Redeploy Worker + rebuild app

El código de `ScanOtModal` y validación backend permanece; solo el flag lo conecta/desconecta.
