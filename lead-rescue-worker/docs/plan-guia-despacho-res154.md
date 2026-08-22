# Plan: Guías de despacho Res. 154 (OTIF Sentinel)

**Deadline:** 1 de noviembre de 2026 · **Hoy:** remediación auditoría S0–S5  
**Fuentes:** Res. Ex. SII N°154/2025, Res. Ex. N°52/2026, `auditoria-res154-otif.md`

---

## Quién es el cliente (S0 comercial)

El **sujeto obligado a emitir** la guía es el **dueño de los bienes**, no el fletero.

| Quién | Obligación | Sanción típica |
|---|---|---|
| Dueño de la carga | Emitir la guía | Art. 97 N°10 — 50% a 500% del monto |
| Conductor | Portar / no trasladar sin guía | Art. 97 N°17 |

**Segmento:** distribuidoras y empresas con flota propia que mueven mercadería propia (bebidas, gas, construcción, alimentos, farma, retail regional, agroinsumos). Son emisor + operador de flota.

**Fletero puro:** no es el emisor. OTIF puede servirle como proveedor de datos (hora real de salida, patente, chofer, origen/destino) al dueño de la carga — módulo/pitch distinto, no Fase 1.

El modelo de datos (`ordenes_pendientes` con OC/cliente) ya asume tenant = vendedor/dueño.

---

## Tesis operativa

| Pieza | Rol |
|---|---|
| Emisión guía al **partir** (evento `SALIDA`, hora del **device**) | **Cuña de venta** (octubre) |
| Torre + GPS + POD + chat + tracking público | **Foso** (ya construido) |
| Jornada Art. 25 bis / Res. 38 | **Congelado hasta 2027** |

Trigger oficial: hora de emisión = hora de **inicio del traslado** → primera `SALIDA` del `trip_id`, con `evento_ts_device` validado.

Proveedor DTE: **SimpleAPI o Lioren** (nunca BaseAPI). Siempre detrás de `EmisorDTE`.
Lioren: HTTP `POST {LIOREN_BASE_URL}{LIOREN_DTE_PATH}` (default `https://www.lioren.cl/api/dtes`) con Bearer `dte_api_token` / `LIOREN_TOKEN`.

---

## Decisiones cerradas

1. **Una guía por OT** del viaje al disparar la primera `SALIDA` (transbordo multi-vehículo = Fase 2 / S8).
2. **Idempotencia:** lock `EMITTING`, lookup por `referenciaExterna`, no reemitir ciego tras timeout.
3. **Stub:** estado `STUB` **sin folio**; prohibido en prod salvo `DTE_ALLOW_STUB=true`.
4. **Origen** = depot del tenant (origen efectivo GPS = Fase 2 / S6).
5. **Destino** = dirección + comuna reales del cliente (sin fallback al nombre).
6. **Emisor DTE por tenant** (`tenant_settings.dte_*`); env global solo con `DTE_ALLOW_GLOBAL_IDENTITY=true`.
7. **Retry** reutiliza `fecha_emision` / `MIN(SALIDA.created_at)`, nunca `new Date()`; cola = `guias_despacho` (no OTs abiertas).

---

## Fases

### Fase A–D (hecho + auditoría S0–S5)
- [x] Migración `014` + `015_res154_audit_fixes`
- [x] EmisorDTE stub/SimpleAPI + hook primera SALIDA
- [x] APIs list/retry + badge Torre
- [x] Sync CSV campos Res.154
- [x] S1 device ts + `server_received_at`
- [x] S2 retry fecha original
- [x] S3 lock EMITTING + lookup referencia
- [x] S4 stub sin folio + guard prod
- [x] S5 destino real
- [x] S0 columnas DTE en `tenant_settings`

### Auditoría v2 (R1 / R2 / S11)
- [x] **R1** retry desde `guias_despacho` (`mode: 'retry'`) — funciona con OTs ya ENTREGADO
- [x] **R2** sin fallback silencioso a env; flag `DTE_ALLOW_GLOBAL_IDENTITY`
- [x] **S11** normalize + match cliente; ERROR accionable si no hay / ambiguo

### Fase 2 (S6–S10, R3, S9)
- [x] Origen efectivo (depot del viaje / GPS SALIDA) — S6
- [x] Fecha llegada / ETA en payload — S7
- [x] Unique por vehículo/traslado — S8 (`uq_guias_despacho_traslado`)
- [x] Mapa IndTraslado vs Anexo 2.5 — S10 (VENTA=1, INTERNO=5, OTRO=6, DEV=7)
- [x] R3: `ts_source` + `REVIEW` si clamp; retry confirma
- [x] OTs agregadas post-SALIDA — S9 (`ensureGuiaForLateOt` en move-stop + rescate)

### Después
- [x] R4: cifrar `dte_api_token` (`enc$v1$…`, AES-GCM; API `/api/admin/qa/dte-settings`)

---

## Mapeo campo → fuente

| Res. 154 | Fuente en OTIF |
|---|---|
| Hora emisión / inicio traslado | `evento_ts_device` → `bitacora_viajes.created_at` (primera SALIDA); audit `server_received_at` |
| Emisor RUT / razón social | `tenant_settings.dte_*` (env solo si `DTE_ALLOW_GLOBAL_IDENTITY`) |
| Conductor + patente | `choferes` / `flota_vehiculos` |
| Origen | `depots.direccion` + `comuna` |
| Destino | `clientes.direccion_calle` + `comuna` (obligatorio) |
| Folio / track | `guias_despacho` solo si `EMITIDA` |

---

## Secrets / env

```
DTE_PROVIDER=stub|simpleapi|lioren
DTE_AMBIENTE=certificacion|produccion
DTE_ALLOW_STUB=true   # solo staging/piloto; no en prod con clientes reales
DTE_ALLOW_GLOBAL_IDENTITY=true  # solo single-tenant/dev
SIMPLEAPI_TOKEN=       # no usar en multi-tenant sin el flag de arriba
SIMPLEAPI_LOOKUP_PATH=   # opcional: GET por referenciaExterna
DTE_RUT_EMISOR=
DTE_RAZON_SOCIAL=
ENVIRONMENT=production   # activa guard anti-stub
```

Configurar por tenant (obligatorio con SimpleAPI multi-tenant) — preferir API (cifra el token):

```js
await fetch('/api/admin/qa/dte-settings', {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    dte_provider: 'simpleapi',
    dte_rut_emisor: '76.XXXXXX-X',
    dte_razon_social: 'Distribuidora Ejemplo SpA',
    dte_ambiente: 'certificacion',
    dte_api_token: '...', // se guarda como enc$v1$…
  }),
});
// Si ya hay token plaintext: { reencrypt_existing: true }
```

Clave: `DTE_TOKEN_ENCRYPTION_KEY` (opcional) o `DASHBOARD_SECRET` (≥32 chars).

---

## Fuera de alcance hasta nov+1

- Art. 25 bis (conducción / espera / descanso)
- Certificación Res. 38
- Implementar firma SII propia
- BaseAPI
