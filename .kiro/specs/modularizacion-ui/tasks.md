# Implementation Plan: Modularización UI — Torre de Control

## Overview

Refactor de `src/ui.js` (~2.500 líneas) a una estructura de módulos ESM cohesivos en `src/ui/`, sin cambiar ni un byte del output HTML/CSS/JS resultante. El contrato externo (`import { renderControlTowerDashboard } from './ui.js'`) se mantiene inalterado durante todas las fases gracias a un re-export en `src/ui/index.js`.

Cada fase termina con **snapshot test en verde + PBT en verde + un commit propio**. Ninguna fase avanza si los tests fallan.

---

## Tasks

- [x] 1. Fase 0 — Snapshot test + eliminar código muerto (BLOQUEANTE)
  - [x] 1.1 Crear fixture de tests y snapshot inicial
    - Crear `src/ui.test.js` con Vitest importando `renderControlTowerDashboard` desde `./ui.js`
    - Definir `inputFixture` con `ordenes`, `viajesActivos` y `listaChoferes` representativos
      - Incluir al menos un viaje con `eta > fecha_hora_sla` (para activar `riesgosSla`) y uno sin riesgo (para ejercitar la rama vacía del widget IA)
      - Incluir strings con backticks y `${` en `cliente` y `ot_id` para ejercitar P2
    - Escribir el test snapshot: `expect(renderControlTowerDashboard(...inputFixture)).toMatchSnapshot()`
    - Ejecutar `npx vitest run src/ui.test.js` — el snapshot se crea en este primer run; debe quedar en verde
    - Verificar que el archivo `.kiro/specs/modularizacion-ui/.config.kiro` existe con `workflowType: "design-first"`
    - **Archivos creados:** `src/ui.test.js`, `src/__snapshots__/ui.test.js.snap`
    - _Requirements: Req 0 — Snapshot test bloqueante_

  - [ ]* 1.2 Escribir los 4 PBT (fast-check) en `src/ui.test.js`
    - **Propiedad P1: Idempotencia de output** — mismo input produce mismo HTML string
      - Usar `fc.property(arbitraryValidInput(), input => render(input) === render(input))`
      - **Validates: Requirements Req 0, Req 7**
    - **Propiedad P2: Integridad de sanitización** — ningún backtick ni `${` crudo en el output
      - Inyectar `maliciousStr` en `cliente`, `ot_id`, `trip_id`; verificar que no aparece crudo en el HTML resultante
      - **Validates: Requirements Req 0, kiro_rules §3 sanitización**
    - **Propiedad P3: Conservación del config-json** — bloque `<script id="config-json">` siempre es JSON válido con claves `BODEGA`, `ESTADOS`, `UI`
      - **Validates: Requirements Req 0, Req 7**
    - **Propiedad P4: Widget IA aparece sii `riesgosSla.length > 0`** — `html.includes('id="ai-copilot-widget"') ↔ |R| > 0`
      - **Validates: Requirements Req 0, Req 6**
    - Ejecutar `npx vitest run src/ui.test.js` — todos los PBT deben pasar
    - _Requirements: Req 0_

  - [x] 1.3 Eliminar `renderPanelFlota` server-side (código muerto)
    - Localizar la función `const renderPanelFlota = function(viajesSeguros) { ... }` en `src/ui.js` (~línea 145)
    - Eliminar el bloque completo de la función (desde `const renderPanelFlota` hasta el cierre `}` antes del `return \`<!DOCTYPE html...`)
    - **No tocar** `window.renderPanelFlota` client-side (~línea 772 en el template literal) — es la implementación real
    - Ejecutar `npx vitest run src/ui.test.js` — snapshot debe seguir en verde
    - Commit: `feat(ui): fase-0 — snapshot test + eliminar renderPanelFlota server-side (código muerto)`
    - **Rollback:** si el snapshot falla, el monolito tiene una diferencia no identificada; investigar antes de continuar; NO hacer `git revert` aún — corregir la causa raíz
    - **Archivos modificados:** `src/ui.js`
    - _Requirements: Req 1 — Eliminar código muerto_

- [~] 2. Checkpoint Fase 0 — Snapshot + PBT en verde antes de continuar
  - Ejecutar `npx vitest run src/ui.test.js`
  - Todos los tests (snapshot + 4 PBT) deben pasar. Si alguno falla, no avanzar a Fase 1.
  - Preguntar al usuario si hay dudas antes de continuar.

- [ ] 3. Fase 1 — Extraer CSS y modales estáticos (cero riesgo funcional)
  - [~] 3.1 Crear `src/ui/templates/styles.js`
    - Crear el directorio `src/ui/` y sus subdirectorios: `server/`, `templates/`, `client/`
    - Extraer el contenido CSS completo (todo el texto dentro del `<style>...</style>`, sin las etiquetas) a una constante `DASHBOARD_STYLES`
    - `export const DASHBOARD_STYLES = \`...css completo...\``
    - El CSS es completamente estático: sin parámetros, sin interpolaciones
    - **Archivos creados:** `src/ui/templates/styles.js`
    - _Requirements: Req 2 — Extraer DASHBOARD_STYLES_

  - [~] 3.2 Crear `src/ui/templates/modalRutaRapida.js`
    - Extraer el HTML estático del modal de Ruta Rápida (formulario de paradas, campos de dirección, botones)
    - `export const MODAL_RUTA_RAPIDA = \`...html modal...\``
    - Sin parámetros — el modal es completamente estático
    - **Archivos creados:** `src/ui/templates/modalRutaRapida.js`
    - _Requirements: Req 5 — Extraer modales estáticos_

  - [~] 3.3 Crear `src/ui/templates/modalEditarDireccion.js`
    - Extraer el HTML estático del modal de edición de dirección para paradas SPOT-
    - `export const MODAL_EDITAR_DIRECCION = \`...html modal...\``
    - Sin parámetros
    - **Archivos creados:** `src/ui/templates/modalEditarDireccion.js`
    - _Requirements: Req 5 — Extraer modales estáticos_

  - [~] 3.4 Integrar los módulos de Fase 1 en `src/ui.js`
    - Agregar al inicio de `src/ui.js`:
      ```javascript
      import { DASHBOARD_STYLES } from './ui/templates/styles.js';
      import { MODAL_RUTA_RAPIDA } from './ui/templates/modalRutaRapida.js';
      import { MODAL_EDITAR_DIRECCION } from './ui/templates/modalEditarDireccion.js';
      ```
    - Reemplazar el bloque CSS inline en el template por `${DASHBOARD_STYLES}` (dentro de `<style>${DASHBOARD_STYLES}</style>`)
    - Reemplazar los bloques HTML de cada modal por `${MODAL_RUTA_RAPIDA}` y `${MODAL_EDITAR_DIRECCION}`
    - Ejecutar `npx vitest run src/ui.test.js` — snapshot debe seguir verde sin actualización
    - Si el snapshot falla: `git revert` de los commits de este paso; verificar diferencias de whitespace o etiquetas de cierre
    - Commit: `feat(ui): fase-1 — extraer CSS y modales estáticos a templates/`
    - **Archivos modificados:** `src/ui.js`
    - _Requirements: Req 2, Req 5_

  - [ ]* 3.5 Verificar PBT continúan en verde tras Fase 1
    - Ejecutar `npx vitest run src/ui.test.js`
    - Los 4 PBT deben pasar sin cambios al snapshot
    - **Validates: P1, P2, P3, P4**

- [x] 4. Fase 2 — Migrar `tenant_id` y `lastSyncDate` al config-json
  - [x] 4.1 Actualizar `buildJsonBlobs` en `src/ui.js` para incluir `tenant_id` y `last_sync_date`
    - Localizar el bloque que construye `safeConfigJson`:
      ```javascript
      const safeConfigJson = safeJsonStringify(APP_CONFIG);
      ```
    - Reemplazar por:
      ```javascript
      const tenantId = ordenesSeguras[0]?.tenant_id || 'empresa_base';
      const safeConfigJson = safeJsonStringify({
        ...APP_CONFIG,
        tenant_id: tenantId,
        last_sync_date: lastSyncDate || null
      });
      ```
    - Localizar el inline script `window._TENANT_ID = '${escapeHTML(...)}'` dentro del template literal
    - Reemplazar por: `window._TENANT_ID = CONFIG.tenant_id || 'empresa_base';`
    - Reemplazar las 2 interpolaciones de `lastSyncDate` en el script de eventos por `CONFIG.last_sync_date`
    - La validación multi-tenant del servidor (`ordenes[0]?.tenant_id`) **no cambia**
    - **Archivos modificados:** `src/ui.js`
    - _Requirements: Req 3 — Mover tenant_id y lastSyncDate al config-json_

  - [x]* 4.2 Extender P3 para verificar `tenant_id` y `last_sync_date` en config-json
    - En `src/ui.test.js`, actualizar el test P3 para verificar además:
      `'tenant_id' in obj && 'last_sync_date' in obj`
    - Ejecutar `npx vitest run src/ui.test.js` — **el snapshot DEBE actualizarse** en esta fase porque el `config-json` ahora tiene 2 claves extra
    - Actualizar el snapshot deliberadamente con `npx vitest run src/ui.test.js --update-snapshots`; revisar el diff del snapshot antes de commitear
    - Si P3 falla: verificar que `buildJsonBlobs` incluye las nuevas claves antes del `JSON.stringify`; rollback con `git revert` si es necesario
    - Commit: `feat(ui): fase-2 — tenant_id y lastSyncDate al config-json; snapshot actualizado`
    - **Archivos modificados:** `src/ui.test.js`, `src/__snapshots__/ui.test.js.snap`
    - **Validates: P3 (extendida)**

- [x] 5. Checkpoint Fase 2 — Snapshot actualizado + todos los PBT en verde
  - Ejecutar `npx vitest run src/ui.test.js`
  - El snapshot actualizado y los 4 PBT deben pasar. Preguntar al usuario si hay dudas.

- [x] 6. Fase 3 — Split de los 4 scripts de cliente
  - [x] 6.1 Crear `src/ui/client/telemetriaYChat.js`
    - Extraer de `src/ui.js` el bloque de script que contiene:
      `escapeHTMLFront`, `formatHoraCL` (client-side), `window.renderMensajesChat`, `window.enviarMensajeChat`, `window.abrirChat`, `window.actualizarMensajesSilencioso`, `window.generarEnlacePublico`
    - `export const TELEMETRY_CHAT_SCRIPT = \`...script completo...\``
    - Los backticks internos del script deben escaparse como `\\\`` o el string delimitarse con concatenación para no romper el template literal del módulo
    - **Archivos creados:** `src/ui/client/telemetriaYChat.js`
    - _Requirements: Req 4 — Split scripts cliente_

  - [x] 6.2 Crear `src/ui/client/mapaYFlota.js`
    - Extraer el bloque de script que contiene:
      parseo de `config-json` y `ordenes-json` al arranque, `initMap()`, `dibujarRutaEnMapa(safeTripId)`, `rastrearFlotaEnVivo()`, declaraciones de `truckMarkers`, `mapLayersCache`, `mapBoundsCache`, `layerViajeActivo`
    - `export const MAPA_FLOTA_SCRIPT = \`...script completo...\``
    - **Archivos creados:** `src/ui/client/mapaYFlota.js`
    - _Requirements: Req 4_

  - [x] 6.3 Crear `src/ui/client/pollingYEventos.js`
    - Extraer el bloque de script que contiene:
      `appState` (Proxy reactivo), `actualizarUI`, `actualizarViajesSilencioso`, el listener `DOMContentLoaded` completo, `window.renderPanelFlota` (client-side — **no eliminar**)
    - `export const POLLING_EVENTOS_SCRIPT = \`...script completo...\``
    - **Archivos creados:** `src/ui/client/pollingYEventos.js`
    - _Requirements: Req 4_

  - [x] 6.4 Crear `src/ui/client/rutaRapida.js`
    - Extraer el bloque de script que contiene:
      `window.abrirRutaRapida`, `window.cerrarRutaRapida`, `window.agregarParadaRR`, `window.renumerarParadas`, `window.validarDireccionesRR`, `window.guardarRutaRapida`, `window.handleCancelSpot`, `window.handleEditDir`, `window.guardarNuevaDireccion`
    - `export const RUTA_RAPIDA_SCRIPT = \`...script completo...\``
    - **Archivos creados:** `src/ui/client/rutaRapida.js`
    - _Requirements: Req 4_

  - [x] 6.5 Integrar los 4 scripts cliente en `src/ui.js`
    - Agregar imports al inicio de `src/ui.js`:
      ```javascript
      import { TELEMETRY_CHAT_SCRIPT } from './ui/client/telemetriaYChat.js';
      import { MAPA_FLOTA_SCRIPT } from './ui/client/mapaYFlota.js';
      import { POLLING_EVENTOS_SCRIPT } from './ui/client/pollingYEventos.js';
      import { RUTA_RAPIDA_SCRIPT } from './ui/client/rutaRapida.js';
      ```
    - Reemplazar cada bloque de script inline en el template por `${TELEMETRY_CHAT_SCRIPT}`, `${MAPA_FLOTA_SCRIPT}`, etc.
    - Ejecutar `npx vitest run src/ui.test.js` — snapshot debe seguir verde
    - **Punto crítico:** si el snapshot falla con diferencias de escapes, los scripts cliente contienen backticks o `${` que conflictúan con el template literal del servidor; usar concatenación de strings o escape manual dentro de los módulos cliente; rollback con `git revert` si no se resuelve rápidamente
    - Commit: `feat(ui): fase-3 — split scripts cliente a client/`
    - **Archivos modificados:** `src/ui.js`
    - _Requirements: Req 4_

  - [ ]* 6.6 Verificar P2 (sanitización) tras split de scripts
    - Ejecutar `npx vitest run src/ui.test.js`
    - Prestar especial atención a P2: ningún `maliciousStr` con backticks o `${` debe aparecer crudo
    - **Validates: P2**

- [x] 7. Checkpoint Fase 3 — Snapshot + PBT en verde
  - Ejecutar `npx vitest run src/ui.test.js`
  - Todos los tests deben pasar. Preguntar al usuario si hay dudas.

- [x] 8. Fase 4 — Extraer `renderLayout()` y `renderAiWidget()` para el HTML dinámico
  - [x] 8.1 Crear `src/ui/server/appConfig.js`
    - Mover `deepFreeze` y `APP_CONFIG` desde `src/ui.js`
    - ```javascript
      export const deepFreeze = obj => { ... };
      export const APP_CONFIG = deepFreeze({ ... });
      ```
    - **Archivos creados:** `src/ui/server/appConfig.js`
    - _Requirements: Req 6 — Extraer renderLayout y HTML dinámico_

  - [x] 8.2 Crear `src/ui/server/calculosViaje.js`
    - Mover desde `src/ui.js` todas las funciones de cálculo server-side:
      `money`, `safeParseJSON`, `buildSafeHelpers` (encapsula la redefinición de `escapeHTML` y `safeVal`), `calcularRiesgosSla`, `sortViajesSeguros`, `formatearParadas`, `buildJsonBlobs`, `safeJsonStringify`, `formatHoraCL`
    - Exportar cada función individualmente
    - Importar `APP_CONFIG` desde `./appConfig.js`
    - **Archivos creados:** `src/ui/server/calculosViaje.js`
    - _Requirements: Req 6_

  - [x] 8.3 Crear `src/ui/templates/aiWidget.js`
    - Extraer el bloque HTML condicional del widget IA flotante
    - ```javascript
      export function renderAiWidget(riesgosSla, escapeHTML) {
        if (!riesgosSla || riesgosSla.length === 0) return '';
        return `<div id="ai-copilot-widget">...</div>`;
      }
      ```
    - **Invariante P4:** la condición `riesgosSla.length === 0` es no negociable — no refactorizar a otra lógica
    - **Archivos creados:** `src/ui/templates/aiWidget.js`
    - _Requirements: Req 6_

  - [x] 8.4 Crear `src/ui/templates/layout.js`
    - Extraer toda la generación del body HTML dinámico (`<header>`, sidebar, KPIs, tabs, panel flota, panel backlog, `<main>` del mapa)
    - ```javascript
      import { APP_CONFIG } from '../server/appConfig.js';
      export function renderLayout(datos) { return `...html dinámico...`; }
      ```
    - El objeto `datos` incluye: `money`, `escapeHTML`, `safeVal`, `viajesSeguros`, `ordenesPendientes`, `perfilesSeguros`, `listaChoferes`, `totalDineroEnCalle`, `totalDineroRiesgo`, `otifProyectado`, `safeOrdenesJson`, `safeViajesJson`, `safeConfigJson`, `lastSyncDate`, `tenantId`
    - Verificar que **todas** las interpolaciones usan `escapeHTML()` o `safeVal()` para valores dinámicos — nunca crudos
    - **Archivos creados:** `src/ui/templates/layout.js`
    - _Requirements: Req 6_

  - [x] 8.5 Crear `src/ui/index.js` como punto de entrada definitivo
    - Importar todos los módulos internos
    - Orquestar las llamadas a `calculosViaje`, `renderLayout`, `renderAiWidget` y los strings estáticos en el mismo orden que el template literal original
    - ```javascript
      export function renderControlTowerDashboard(ordenes, perfiles, moneyFormatterUser, escapeHTML, lastSyncDate, viajesActivos = [], listaChoferes = []) {
        // ... orquestación completa ...
        return `<!DOCTYPE html>...`;
      }
      ```
    - **Archivos creados:** `src/ui/index.js`
    - _Requirements: Req 6_

  - [x] 8.6 Convertir `src/ui.js` en re-export hacia `src/ui/index.js`
    - Reemplazar todo el contenido de `src/ui.js` por:
      ```javascript
      // Re-export para mantener contrato externo inalterado
      export { renderControlTowerDashboard } from './ui/index.js';
      ```
    - El archivo `api/dashboard.js` importa desde `./ui.js` — este re-export mantiene ese contrato sin tocar ningún otro archivo
    - Ejecutar `npx vitest run src/ui.test.js` — snapshot debe seguir verde sin actualización
    - Si el snapshot falla: `git revert` de la Fase 4; revisar que todos los parámetros de `datos` se pasan correctamente y que no hay interpolaciones faltantes en KPIs o panel flota
    - Commit: `feat(ui): fase-4 — extraer renderLayout, renderAiWidget y server/ a src/ui/`
    - **Archivos creados:** `src/ui/index.js`, `src/ui/server/appConfig.js`, `src/ui/server/calculosViaje.js`, `src/ui/templates/layout.js`, `src/ui/templates/aiWidget.js`
    - **Archivos modificados:** `src/ui.js` (ahora solo re-export)
    - _Requirements: Req 6_

  - [ ]* 8.7 Verificar P4 (widget IA) tras extracción de renderAiWidget
    - Ejecutar `npx vitest run src/ui.test.js`
    - P4 es el test más crítico aquí: `html.includes('id="ai-copilot-widget"') ↔ riesgosSla.length > 0`
    - **Validates: P4**

- [x] 9. Checkpoint Fase 4 — Snapshot + PBT en verde
  - Ejecutar `npx vitest run src/ui.test.js`
  - Todos los tests deben pasar. Preguntar al usuario si hay dudas.

- [x] 10. Fase 5 — Verificación final e importaciones de `api/dashboard.js`
  - [x] 10.1 Verificar que `api/dashboard.js` no requiere cambios de importación
    - Leer `src/api/dashboard.js` y confirmar que importa desde `'../ui.js'` (o `'./ui.js'`)
    - El re-export de Fase 4 mantiene ese contrato inalterado — no se modifica `dashboard.js`
    - Si hubiera imports directos hacia funciones internas de `ui.js`, agregarlos al re-export en `src/ui.js`
    - **Archivos verificados:** `src/api/dashboard.js`
    - _Requirements: Req 7 — Verificación final_

  - [x] 10.2 Ejecutar suite completa final
    - `npx vitest run src/ui.test.js` — todos los tests deben pasar
    - Revisar que la estructura de archivos final coincide con el target:
      ```
      src/ui/
        index.js
        server/
          appConfig.js
          calculosViaje.js
        templates/
          styles.js
          layout.js
          aiWidget.js
          modalRutaRapida.js
          modalEditarDireccion.js
        client/
          telemetriaYChat.js
          mapaYFlota.js
          pollingYEventos.js
          rutaRapida.js
      ```
    - _Requirements: Req 7_

  - [x]* 10.3 Correr todos los PBT con seed fijo para reproducibilidad
    - Agregar en `src/ui.test.js` un run con seed explícito para CI: `fc.assert(..., { seed: 42, numRuns: 500 })`
    - `npx vitest run src/ui.test.js`
    - Si algún PBT falla con un contraejemplo: identificar qué propiedad viola, corregir en la fase responsable, no liberar hasta que todos pasen
    - **Validates: P1, P2, P3, P4**

  - [x] 10.4 Commit y cierre
    - Commit: `feat(ui): fase-5 — verificación final; estructura src/ui/ completa`
    - La feature está lista para PR

- [x] 11. Checkpoint Final — Feature completa
  - `npx vitest run src/ui.test.js` en verde
  - Estructura de archivos target verificada
  - Sin `window.location.reload()` en ningún módulo nuevo
  - `safeVal`, `escapeHTML` override y `safeJsonStringify` intactos
  - `tenant_id` siempre proviene de `ordenes[0]?.tenant_id || 'empresa_base'`
  - Sin `require()` ni `import()` dinámico en ningún módulo

---

## Notes

- Las tareas marcadas con `*` son opcionales y pueden omitirse para un MVP más rápido, pero se recomienda ejecutarlas — los PBT son la red de seguridad del refactor
- Cada fase tiene su propio commit; el rollback siempre es `git revert <commit>` de la fase fallida
- El snapshot **no se actualiza** salvo en Fase 2 (que agrega `tenant_id` y `last_sync_date` al config-json) — cualquier otra actualización de snapshot es una señal de regresión
- Los scripts cliente (`client/*.js`) exportan strings; los backticks internos deben escaparse con `\\\`` dentro del template literal del módulo o usar concatenación de strings para los bloques conflictivos
- `window.renderPanelFlota` client-side (en `pollingYEventos.js`) **jamás se toca** — es la implementación real del panel reactivo

### Comandos de verificación por fase

| Fase | Comando |
|---|---|
| 0, 1, 3, 4, 5 | `npx vitest run src/ui.test.js` |
| 2 (snapshot update) | `npx vitest run src/ui.test.js --update-snapshots` + revisar diff |

### Procedimiento de rollback por fase

| Fase | Gatillo | Acción |
|---|---|---|
| **Fase 0** | Snapshot falla en primera ejecución | Investigar diferencia antes de continuar; NO hay commit que revertir aún |
| **Fase 1** | Snapshot falla tras extraer CSS o modales | `git revert HEAD` (commit de Fase 1); verificar whitespace en strings CSS |
| **Fase 2** | Snapshot falla o `config-json` pierde claves | `git revert HEAD` (commit de Fase 2); verificar que `buildJsonBlobs` incluye las nuevas claves |
| **Fase 3** | Snapshot falla o P2 detecta escapes incorrectos | `git revert HEAD` (commit de Fase 3); revisar backticks conflictivos en scripts cliente |
| **Fase 4** | Snapshot falla en `renderLayout()` | `git revert HEAD` (commit de Fase 4); verificar todos los parámetros del objeto `datos` |
| **Fase 5** | Algún PBT falla con contraejemplo | Identificar fase responsable del bug; corregir allí; no liberar hasta que todos los PBT pasen |

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3"] },
    { "id": 3, "tasks": ["3.4"] },
    { "id": 4, "tasks": ["3.5", "4.1"] },
    { "id": 5, "tasks": ["4.2"] },
    { "id": 6, "tasks": ["6.1", "6.2", "6.3", "6.4"] },
    { "id": 7, "tasks": ["6.5"] },
    { "id": 8, "tasks": ["6.6", "8.1", "8.2"] },
    { "id": 9, "tasks": ["8.3", "8.4"] },
    { "id": 10, "tasks": ["8.5"] },
    { "id": 11, "tasks": ["8.6"] },
    { "id": 12, "tasks": ["8.7", "10.1"] },
    { "id": 13, "tasks": ["10.2"] },
    { "id": 14, "tasks": ["10.3", "10.4"] }
  ]
}
```
