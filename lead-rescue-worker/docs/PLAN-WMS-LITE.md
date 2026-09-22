# Plan: OTIF Bodega (WMS-lite)

**Objetivo:** módulo de bodega **simple** que se conecta al TMS que ya existe (Torre + app chofer), sin construir un ERP completo ni un WMS enterprise.

**Principio:** empezar chico, datos limpios, APIs claras → escalar después sin reescribir.

---

## 1. Qué es y qué no es

| Sí (piloto) | No (por ahora) |
|-------------|----------------|
| Stock por SKU y por bodega | Contabilidad / facturación ERP |
| Alertas de stock mínimo | Robots, slotting avanzado, olas wave |
| Cola de procesos: Picking → Packing → Listo ruteo | Multi-país, compliance FDA, labor management |
| Bloquear ruteo si hay quiebre | Reemplazar SAP/Defontana |
| Integración con Torre + viajes OTIF | Reemplazar TMS |

**Frase para el negocio:**  
*“Antes de mandar el camión, sabemos si hay mercadería, quién la pickea y cuándo quedó lista.”*

---

## 2. Dónde encaja en el stack

```
[ ERP / ventas / Excel / webhook ]
              │
              ▼
     ┌─────────────────┐
     │  OTIF Bodega    │  ← NUEVO (WMS-lite)
     │  stock + picking│
     └────────┬────────┘
              │  OT "LISTA_PARA_RUTEO"
              ▼
     ┌─────────────────┐
     │  OTIF Sentinel  │  ← YA EXISTE (TMS)
     │  Torre + ruteo  │
     └────────┬────────┘
              ▼
     ┌─────────────────┐
     │  App chofer     │  ← YA EXISTE
     │  entrega + foto │
     └─────────────────┘
```

- **ERP** (externo o futuro): vende / genera pedido.
- **WMS-lite (este plan):** ejecuta bodega.
- **TMS (actual):** ejecuta calle / OTIF.

No hace falta un ERP propio para el piloto: basta sync CSV / webhook de pedidos como hoy.

---

## 3. Modelo de datos mínimo (escalable)

Pocas tablas, claves claras, `tenant_id` en todo (igual que el resto del monorepo).

### 3.1 `productos`
| Campo | Uso |
|-------|-----|
| `tenant_id`, `sku`, `nombre` | Catálogo |
| `unidad` | caja / unidad / kg |
| `activo` | soft-delete |

### 3.2 `inventario_bodega`
| Campo | Uso |
|-------|-----|
| `tenant_id`, `depot_id`, `sku` | Stock por bodega |
| `qty_disponible` | Lo que se puede reservar |
| `qty_reservada` | Comprometida a OTs en proceso |
| `qty_minima` | Umbral de alerta |
| `ubicacion` (texto libre) | “B-3-12” — sin bins complejos aún |

**Escalar después:** separar `ubicaciones` + `inventario_ubicacion` sin romper la API.

### 3.3 `movimientos_inventario`
Auditoría: entrada / salida / reserva / liberación / ajuste.  
Sirve para pelear “¿quién bajó el stock?” y para reportes.

### 3.4 Extender `ordenes_pendientes` (ya existe)
- Líneas de pedido: `orden_lineas` (`ot_id`, `sku`, `qty`, `qty_pickeada`)
- Estados de bodega (reusar / alinear):  
  `PENDIENTE_PICKING` → `PICKING` → `PACKING` → `LISTA_PARA_RUTEO` → (TMS) `CAMION_ASIGNADO` → `EN_RUTA` → …

**Regla de oro:** el optimizador de rutas **solo ve** OTs en `LISTA_PARA_RUTEO` (o equivalente). Así la bodega “abre la puerta” al camión.

---

## 4. Procesos del piloto (4 pantallas / flujos)

### A. Catálogo + stock
- Alta de SKU
- Stock inicial / ajuste
- Badge rojo si `qty_disponible < qty_minima`

### B. Pedido entra a bodega
1. Pedido llega (CSV / webhook / Torre)
2. Sistema intenta **reservar** stock (`qty_disponible → qty_reservada`)
3. Si falta → estado `QUIEBRE` + alerta (no pasa a ruteo)
4. Si OK → `PENDIENTE_PICKING`

### C. Picking / packing (simple)
- Lista de OTs por bodega
- Operario marca “pickeado” (cantidad OK)
- Luego “empacado / listo”
- Al confirmar packing → `LISTA_PARA_RUTEO` + stock reserva → salida definitiva

### D. Puente a Torre
- Torre muestra backlog “listas para ruteo”
- Optimizar / Ruta rápida / assign chofer = flujo actual

**Sin app nueva al inicio:** se puede hacer 100% en Torre (pestaña “Bodega”).  
App de bodega (scan) = fase 2, reutilizando Expo como la app chofer.

---

## 5. Alertas (lo que pidió tu padre)

| Alerta | Disparo | Acción |
|--------|---------|--------|
| Stock bajo | `disponible < minima` | Badge + lista en Torre |
| Quiebre al reservar | No alcanza para la OT | OT en `QUIEBRE`, no ruteable |
| Cola atrasada | OTs en picking > N horas | Aviso en panel bodega |
| Listo sin camión | `LISTA_PARA_RUTEO` sin trip | Torre prioriza esas OTs |

Empezar con **alertas en UI**. WhatsApp/Telegram después (ya tienen pipes de notificación).

---

## 6. Fases de entrega (simple → máximo)

### Fase 0 — Diseño congelado (1–2 días)
- Confirmar con negocio: 1 bodega piloto, ~50–200 SKUs, flujo anterior
- Migración SQL + contratos API

### Fase 1 — MVP usable (2–3 semanas)
- Tablas + APIs CRUD stock / productos
- Reserva al crear/aceptar OT
- Pantalla Torre “Bodega”: stock + alertas mínimas
- Cola PICKING → PACKING → LISTA_PARA_RUTEO
- Ruteo solo consume listas

**Éxito:** no se rutea mercadería inexistente; se ve stock bajo.

### Fase 2 — Operación real (3–5 semanas)
- `orden_lineas` multi-SKU por OT
- Movimientos auditables
- Scan QR/barcode de SKU (reusar código de escaneo, feature flag)
- App/PWA bodega (Expo) o tablet en Torre
- Dashboard: quiebres, fill-rate, tiempo picking

### Fase 3 — Escala (cuando el piloto lo pida)
- Multi-bodega con transferencias
- Ubicaciones / bins
- Wave/batch picking
- Integración ERP bi-direccional (Defontana, Bsale, SAP webhook)
- Reposición sugerida (min/max + lead time)

Cada fase **no invalida** la anterior: mismas tablas, más columnas / microservicios lógicos.

---

## 7. Arquitectura técnica (escalable sin complejidad temprana)

| Capa | Decisión |
|------|----------|
| DB | Postgres/Supabase, RLS + `tenant_id` (mismo patrón 018–022) |
| API | Worker actual: `/api/bodega/*` |
| UI | Pestaña en Torre primero |
| Eventos | Al confirmar packing → invalidar cache poll + opcional queue |
| Feature flags | `WMS_ENABLED` por tenant (piloto sin romper clientes actuales) |

**Patrones que permiten escalar:**
1. Stock = `disponible` + `reservada` (nunca un solo número mágico).
2. Todo movimiento = fila en `movimientos_inventario`.
3. Estados de OT explícitos; TMS no “adivina” bodega.
4. SKUs y depots como entidades; no hardcodear en metadata JSON para siempre (metadata solo para extras).

---

## 8. Qué lo hace interesante vs WMS/ERP del mercado

No competir con SAP/Manhattan en profundidad. Competir en **unión**:

1. **Bodega + camión + OTIF en un producto** (pocos lo tienen integrado de fábrica).
2. **Chile-first:** DTE/guías, sync Acepta, multi-tenant PyME.
3. **Causa raíz OTIF:** “atraso porque no había stock” vs “atraso en ruta”.
4. **Piloto barato:** semanal, no proyecto de 18 meses.

---

## 9. Fuera de alcance (explícito)

- Contabilidad, nómina, CRM completo
- MRP / producción / BOM complejos
- Automatización de andenes / AGV
- Sustituir el ERP del cliente (solo integrarnos)

Si el cliente ya tiene ERP: **nosotros somos WMS-lite + TMS**.  
Si no tiene nada: sync Excel = “ERP pobre” temporal.

---

## 10. Criterio de “listo para piloto”

- [ ] 1 tenant demo con 1 depot
- [ ] Alta de 20 SKUs + stock mínimo
- [ ] Pedido con línea → reserva o quiebre
- [ ] Flujo picking → packing → aparece en Torre ruteable
- [ ] Alerta visible de stock bajo
- [ ] Entrega con app chofer sin regresión

---

## 11. Siguiente paso inmediato

1. Validar este plan con negocio (tu padre): ¿es este el flujo?
2. Si sí → migración `023_wms_lite.sql` + API stub + pestaña Torre vacía.
3. Luego Fase 1 completa.

**Estimación orden de magnitud Fase 1:** del orden de lo que costó estabilizar poll Torre / POD, no del orden de “reescribir el monorepo”.
