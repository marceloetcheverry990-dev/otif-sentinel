# Implementation Plan: ETA Accuracy Metrics

## Overview

Implementación incremental del sistema de medición de precisión ETA. Se construye de abajo hacia arriba: primero la migración de BD y el helper compartido, luego los hooks en los handlers existentes, después el endpoint de stats, y finalmente la sección del dashboard ejecutivo. Cada fase es verificable de forma independiente.

## Tasks

- [ ] 1. Migración de base de datos, setup de dependencias y `optimization_run_id` en optimizer
  - [ ] 1.0 Agregar `optimization_run_id` al optimizer principal
    - En `src/api/optimizer.js`, dentro de `optimizarRutas()`, inmediatamente después de validar `tenant_id`, agregar:
      ```javascript
      const optimizationRunId = `OPT-${crypto.randomUUID()}`;
      ```
    - Propagar `optimizationRunId` al `metadataObj.routing` de **cada parada** de **cada viaje** en el loop de construcción:
      ```javascript
      routing: { optimization_run_id: optimizationRunId, trip_id: ..., stop_sequence: ..., ... }
      ```
    - **No agregar** `optimization_run_id` en ningún otro archivo — `quick-route.js`, `app-chofer-evento.js` (recálculos post-SALIDA) quedan sin el campo: null es el valor correcto para rutas no formales
    - Verificar que `crypto` está disponible como `globalThis.crypto` (ya lo usa el archivo para `tripId`)
    - _Prerequisito para ETA Accuracy Metrics — debe ejecutarse antes de que el hook empiece a capturar datos_
  - [ ] 1.1 Crear migración `003_eta_accuracy_metrics.sql` con DDL completo
    - Crear `migrations/003_eta_accuracy_metrics.sql` con `CREATE TABLE IF NOT EXISTS eta_accuracy_metrics` incluyendo todos los campos del diseño: `id`, `tenant_id`, `trip_id`, `stop_id`, `chofer_id`, `eta_calculado`, `hora_real_llegada`, `error_minutos`, `error_absoluto_minutos`, `eta_source`, `distancia_restante_km`, `optimization_run_id`, `stop_sequence`, `zona`, `eta_confidence`, `fecha`, `created_at`
    - `optimization_run_id VARCHAR(64)` — reemplaza `route_version`; extrae de `metadata.routing.optimization_run_id`
    - `stop_sequence SMALLINT` nullable — posición de la parada en la ruta al momento de la entrega
    - `zona VARCHAR(64)` nullable — fase 1: columna existe pero siempre se inserta NULL; se poblará en fase 2
    - Incluir `CONSTRAINT uq_eta_metrics_tenant_stop UNIQUE (tenant_id, stop_id)` y `CHECK` para `eta_confidence` entre 0.00 y 1.00
    - Incluir los 5 índices: `(tenant_id, fecha DESC)`, `(chofer_id, fecha DESC)`, `(trip_id)`, `(eta_source, fecha DESC)`, índice parcial en `optimization_run_id WHERE optimization_run_id IS NOT NULL`
    - Envolver en `BEGIN; ... COMMIT;`
    - _Requirements: 1.1, 1.2, 1.3, 1.10_

  - [ ] 1.2 Agregar `fast-check` a las dependencias de desarrollo
    - Ejecutar `npm install --save-dev fast-check` en el directorio del Worker
    - Verificar que `fast-check` aparece en `package.json` bajo `devDependencies`
    - _Requirements: Testing Strategy (design.md)_

- [ ] 2. Implementar helper `insertEtaMetric()`
  - [ ] 2.1 Crear `src/helpers/eta-metric.js` con la función `insertEtaMetric(supabase, params)`
    - Definir la constante `ETA_CONFIDENCE_MAP` con los 5 valores del diseño: `MAPBOX_TRAFFIC: 0.90`, `OPTIMIZER_STATIC: 0.70`, `HAVERSINE_CASCADE: 0.55`, `NO_GPS_FALLBACK: 0.20`, `NO_COORDS_FALLBACK: 0.15` — nota: en versiones futuras este mapa podrá evolucionar a scores calculados desde precisión histórica real
    - Implementar la cascada de `hora_real_llegada`: `orden.hora_llegada_chofer ?? orden.hora_real ?? hora_evento`
    - Implementar guard: si `eta_calculado` es null → `console.log('[ETA_METRIC_SKIP] stop_id=...')` + return
    - Implementar guard: si cualquier timestamp no es parseable por `Date.parse()` → `console.log('[ETA_METRIC_SKIP_INVALID_DATE] stop_id=...')` + return
    - Calcular `error_minutos = Math.round((horaReal - etaCalc) / 60000 * 10) / 10` y `error_absoluto_minutos = Math.abs(error_minutos)`
    - Extraer `eta_source` desde `orden.metadata?.routing?.eta_source ?? null`
    - Extraer `distancia_restante_km` desde `orden.metadata?.routing?.km_al_siguiente ?? null`
    - Extraer `optimization_run_id` desde `orden.metadata?.routing?.optimization_run_id ?? null` — NO construir artificialmente
    - Extraer `stop_sequence` desde `orden.stop_sequence ?? null`
    - Asignar `zona = null` — fase 1: siempre null, se poblará en fase 2 con lookup geográfico
    - Asignar `eta_confidence = ETA_CONFIDENCE_MAP[eta_source] ?? null`
    - Ejecutar INSERT incluyendo los nuevos campos `optimization_run_id`, `stop_sequence`, `zona` con `ON CONFLICT (tenant_id, stop_id) DO NOTHING`
    - Capturar errores: código `42P01` → `console.error('[ETA_METRIC_TABLE_MISSING]')` + return; cualquier otro → `console.error('[ETA_METRIC_ERROR] stop_id=X error=Y')` + return
    - Exportar `insertEtaMetric` como named export
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 5.1, 5.2, 5.5_

  - [ ]* 2.2 Escribir unit tests para `insertEtaMetric` en `src/helpers/eta-metric.test.js`
    - Test: cuando `eta` es null → no inserta y retorna sin error
    - Test: timestamp inválido → log `[ETA_METRIC_SKIP_INVALID_DATE]` y retorna
    - Test: cascada de fallback `hora_llegada_chofer → hora_real → hora_evento`
    - Test: `optimization_run_id` se extrae de `metadata.routing.optimization_run_id`; null si no existe — NO se construye artificialmente
    - Test: `stop_sequence` se extrae de `orden.stop_sequence`; null si no existe
    - Test: `zona` siempre es null en fase 1
    - Test: mapeo de `eta_confidence` para cada valor conocido de `eta_source`
    - Test: fuente desconocida → `eta_confidence = null`
    - Test: extracción de `eta_source` y `distancia_restante_km` desde metadata anidada
    - _Requirements: 2.5, 2.9, 2.10, 2.11, 2.12, 2.13_

  - [ ]* 2.3 Escribir property tests (PBT) para el helper en `src/helpers/eta-metric.pbt.test.js`
    - Agregar `import fc from 'fast-check'` al inicio del archivo
    - **Property 1: Cálculo Correcto de Error ETA** — para cualquier par de timestamps válidos, `error_minutos` debe ser `ROUND((horaReal - etaCalc) / 60000, 1)` con signo, y `error_absoluto_minutos` debe ser su valor absoluto — **Validates: Req 1.4, 1.5**
    - **Property 3: Omisión Correcta de Inserciones Inválidas** — si `eta_calculado` es null o timestamp no parseable, no hay insert y el flujo retorna sin lanzar excepción — **Validates: Req 1.7, 2.6, 5.1**
    - **Property 5: Prioridad de `hora_real_llegada`** — para cualquier combinación de valores presentes/ausentes en `(hora_llegada_chofer, hora_real, hora_evento)`, se respeta estrictamente la cascada de prioridad — **Validates: Req 2.5**
    - **Property 6: Mapeo Completo de `eta_confidence`** — para cualquier `eta_source`, `eta_confidence` corresponde exactamente a `ETA_CONFIDENCE_MAP`; fuentes desconocidas o null → null — **Validates: Req 2.13**
    - **Property 7: `optimization_run_id` Bien Formado** — `optimization_run_id` se extrae de `metadata.routing.optimization_run_id`, nunca construido artificialmente; null si no disponible — **Validates: Req 2.12**
    - **Property 7b: `stop_sequence` Persistido** — el valor es exactamente `orden.stop_sequence` o null; nunca derivado — **Validates: Req 1.1**
    - **Property 8: Extracción Correcta de Metadata** — `eta_source` y `distancia_restante_km` son exactamente los valores en `metadata.routing.*`, o null si la ruta no existe — **Validates: Req 2.10, 2.11**
    - **Property 12: Preservación de Outliers** — valores de `error_absoluto_minutos` > 480 son almacenados sin modificación — **Validates: Req 5.2**
    - Cada test incluye el tag: `// Feature: eta-accuracy-metrics, Property N: <descripción>`
    - _Requirements: 1.4, 1.5, 1.7, 2.5, 2.6, 2.10, 2.11, 2.12, 2.13, 5.1, 5.2_

- [ ] 3. Checkpoint — Verificar helper antes de integrarlo
  - Asegurarse de que todos los tests del helper pasan con `vitest --run src/helpers/`. Preguntar al usuario si hay dudas antes de continuar.

- [ ] 4. Integrar `insertEtaMetric()` en `app-chofer-evento.js`
  - [ ] 4.1 Modificar `src/api/app-chofer-evento.js` para llamar al hook en eventos ENTREGA y PROBLEMA con `ctx.waitUntil()`
    - Agregar `import { insertEtaMetric } from '../helpers/eta-metric.js';` al inicio del archivo
    - En el bloque `ENTREGA`, después del UPDATE exitoso: agregar SELECT de `ordenes_pendientes` con campos `eta, hora_llegada_chofer, hora_real, metadata, chofer_asignado_id, stop_sequence`
    - Reemplazar `await insertEtaMetric(...)` por `ctx.waitUntil(insertEtaMetric(supabase, { tenant_id, stop_id, trip_id, chofer_id: payload.chofer_id ?? null, orden: ordenParaMetrica, hora_evento: timestamp }))` — el `return jsonRes(...)` viene DESPUÉS, garantizando respuesta inmediata al chofer
    - En el bloque `PROBLEMA`, hacer lo mismo con `ctx.waitUntil()`
    - El hook falla silenciosamente en background — la respuesta HTTP al chofer ya se envió antes
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [ ]* 4.2 Escribir unit tests de integración para el hook en `app-chofer-evento.js`
    - Test: evento ENTREGA exitoso → `insertEtaMetric` es llamado con los parámetros correctos
    - Test: evento PROBLEMA exitoso → `insertEtaMetric` es llamado con los parámetros correctos
    - Test: si `insertEtaMetric` lanza error → la respuesta HTTP sigue siendo 200
    - _Requirements: 2.1, 2.2, 2.8_

- [ ] 5. Integrar `insertEtaMetric()` en `app-chofer-sync.js`
  - [ ] 5.1 Modificar `src/api/app-chofer-sync.js` para llamar al hook en eventos COMPLETADA y PROBLEMA con `ctx.waitUntil()`
    - Agregar `ctx` como tercer parámetro de `syncChoferEvent(request, env, ctx)` — actualmente solo recibe `(request, env)`
    - Agregar `import { insertEtaMetric } from '../helpers/eta-metric.js';` al inicio del archivo
    - Después del UPDATE de estado (`.update({estado_operacional: ...})`): agregar SELECT de `ordenes_pendientes` con campos `eta, hora_llegada_chofer, hora_real, metadata, chofer_asignado_id, stop_sequence` para el `stopId` procesado
    - Usar `ctx.waitUntil(insertEtaMetric(supabase, { tenant_id, stop_id: stopId, trip_id: ordenInfo.trip_id, chofer_id: null, orden: ordenParaMetrica, hora_evento: new Date().toISOString() }))` — el hook corre en background
    - El hook aplica solo cuando `status === 'COMPLETADA'` o `status === 'PROBLEMA'` (estados terminales)
    - Verificar que el caller de `syncChoferEvent` en `src/index.js` pasa `ctx` como tercer argumento
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [ ]* 5.2 Escribir unit tests de integración para el hook en `app-chofer-sync.js`
    - Test: status `COMPLETADA` → `insertEtaMetric` es llamado con los parámetros correctos
    - Test: status `PROBLEMA` → `insertEtaMetric` es llamado con los parámetros correctos
    - Test: si `insertEtaMetric` lanza error → la respuesta HTTP sigue siendo 200
    - _Requirements: 2.3, 2.4, 2.8_

- [ ] 6. Checkpoint — Verificar integración del hook
  - Asegurarse de que los tests de integración de los handlers pasan. Preguntar al usuario si hay dudas antes de continuar.

- [ ] 7. Implementar endpoint `GET /api/eta-accuracy/stats`
  - [ ] 7.1 Crear `src/api/eta-accuracy.js` con el handler `handleEtaAccuracyStats`
    - Leer `tenant_id`, `desde`, `hasta`, `chofer_id`, `eta_source`, `optimization_run_id` desde `url.searchParams`
    - Validar `tenant_id` presente → HTTP 400 `{"error": "tenant_id es requerido"}` si falta
    - Validar formato `YYYY-MM-DD` de `desde` y `hasta` con regex `/^\d{4}-\d{2}-\d{2}$/` → HTTP 400 con mensaje descriptivo si inválido
    - Instanciar `pg.Client` con `CONFIG.DB_OPTS(env)` (patrón igual que `dashboard-executive.js`)
    - Ejecutar la query SQL principal con percentiles `PERCENTILE_CONT` para p50, p90, p95, p99 (ver diseño §4)
    - Ejecutar query secundaria para `stats_por_chofer`: top 10 choferes con más registros en el período
    - Ejecutar query secundaria para `stats_por_source`: agrupar por `eta_source` con `error_p90_min` y `eta_confidence_promedio`
    - Si `total_registros === 0` → retornar todos los campos numéricos en `null`
    - Exportar `handleEtaAccuracyStats` como named export
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.11, 3.12, 3.13_

  - [ ]* 7.2 Escribir property tests para el endpoint en `src/api/eta-accuracy.integration.test.js`
    - **Property 9: Corrección Estadística del Endpoint** — para cualquier dataset generado por fast-check, `error_mediana_min ≤ error_p90_min ≤ error_p95_min ≤ error_p99_min`, `pct_5 ≤ pct_10 ≤ pct_15`, todos en [0,100], `error_absoluto_promedio ≥ 0`, cero registros → todo null — **Validates: Req 3.3, 3.4, 3.5, 3.6**
    - **Property 10: Filtros Restringen Correctamente** — aplicar `chofer_id`, `eta_source` o `optimization_run_id` produce resultados idénticos a calcular manualmente sobre el subconjunto filtrado — **Validates: Req 3.8, 3.12, 3.13**
    - **Property 11: Aislamiento Multi-Tenant** — registros de tenant A nunca aparecen en consultas de tenant B — **Validates: Req 5.3**
    - Cada test incluye el tag: `// Feature: eta-accuracy-metrics, Property N: <descripción>`
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.8, 3.12, 3.13, 5.3_

  - [ ]* 7.3 Escribir property tests adicionales para unicidad y zona horaria
    - **Property 2: Unicidad de Parada por Tenant** — múltiples inserciones con el mismo `(tenant_id, stop_id)` resultan en exactamente un registro; sin errores HTTP — **Validates: Req 1.3, 2.7**
    - **Property 4: Zona Horaria Correcta para `fecha`** — para cualquier `hora_real_llegada`, `fecha` es la fecha en `America/Santiago`, no UTC — **Validates: Req 1.8, 5.4**
    - Cada test incluye el tag: `// Feature: eta-accuracy-metrics, Property N: <descripción>`
    - _Requirements: 1.3, 1.8, 2.7, 5.4_

- [ ] 8. Registrar ruta en `src/index.js`
  - [ ] 8.1 Agregar import y ruta para el nuevo endpoint de stats
    - Agregar `import { handleEtaAccuracyStats } from './api/eta-accuracy.js';` junto al resto de imports de API
    - Agregar la línea de ruteo: `if (request.method === 'GET' && url.pathname === '/api/eta-accuracy/stats') return handleEtaAccuracyStats(request, env);` dentro del bloque `fetch()`, en la sección de rutas API REST
    - _Requirements: 3.1_

- [ ] 9. Integrar sección ETA en el dashboard ejecutivo
  - [ ] 9.1 Modificar `src/monitoring/dashboard-executive.js` para agregar la sección `ETA_Dashboard_Section`
    - Agregar una sección HTML de KPIs de precisión ETA en el HTML del dashboard ejecutivo
    - En la carga de datos del dashboard, hacer `fetch('/api/eta-accuracy/stats?tenant_id='+tenantId+'&desde='+desde+'&hasta='+hasta)` para obtener las métricas ETA
    - Renderizar los 4 KPIs: `Error ETA Promedio` (min, 1 decimal), `Mediana` (min, 1 decimal), `P90` (min, 1 decimal), `% Entregas en ±10min` (porcentaje, 1 decimal)
    - Implementar coloración semáforo para `pct_dentro_10min`: `>= 80` → `#10b981` (verde), entre 60–79 → `#f59e0b` (amarillo), `< 60` → `#ef4444` (rojo)
    - Mostrar `"Sin datos aún"` en gris cuando `total_registros === 0`
    - Mostrar `total_registros` como subtexto de contexto bajo los KPIs
    - Re-consultar la API cuando el período activo del dashboard cambia (pasar `desde`/`hasta` actualizados)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [ ]* 9.2 Escribir property tests para la lógica de coloración semáforo
    - **Property 13: Coloración Correcta en Dashboard** — para cualquier valor de `pct_dentro_10min`: `>= 80` → verde, `60 ≤ pct < 80` → amarillo, `< 60` → rojo; los umbrales exactos (80, 60) se asignan a verde y amarillo respectivamente — **Validates: Req 4.3, 4.4, 4.5**
    - Extraer la función de coloración como función pura y testearla con fast-check con generadores de números en [0,100]
    - Cada test incluye el tag: `// Feature: eta-accuracy-metrics, Property 13: <descripción>`
    - _Requirements: 4.3, 4.4, 4.5_

- [ ] 10. Checkpoint final — Verificar integración completa
  - Asegurarse de que todos los tests pasan con `vitest --run`. Preguntar al usuario si hay dudas antes de hacer el deploy.

## Notes

- Las tareas marcadas con `*` son opcionales y pueden omitirse para un MVP más rápido
- **Persistencia asíncrona**: el hook usa `ctx.waitUntil()` — el chofer recibe HTTP 200 antes de que el INSERT ocurra; cero latencia añadida al flujo crítico
- `app-chofer-sync.js` requiere agregar `ctx` como tercer parámetro del handler — verificar que `src/index.js` lo pase correctamente
- `optimization_run_id` reemplaza `route_version`; se extrae de `metadata.routing.optimization_run_id`, nunca construido artificialmente
- `stop_sequence` y `zona` son nuevos campos; `zona` siempre null en fase 1
- `eta_confidence` es un valor heurístico estático en esta versión; en versiones futuras podrá calcularse dinámicamente desde `AVG(error_absoluto_minutos)` por `eta_source`
- Los percentiles se calculan en SQL (PostgreSQL `PERCENTILE_CONT`), no en JavaScript, para manejar 100k+ registros eficientemente
- La `fecha` se calcula con `AT TIME ZONE 'America/Santiago'` en el INSERT SQL para garantizar zona horaria correcta
- `fast-check` debe agregarse a `devDependencies` (tarea 1.2) antes de ejecutar cualquier PBT
- La migración `003_eta_accuracy_metrics.sql` debe ejecutarse antes de que el hook sea activo en producción

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.0", "1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3"] },
    { "id": 3, "tasks": ["4.1", "5.1", "7.1"] },
    { "id": 4, "tasks": ["4.2", "5.2", "7.2", "7.3", "8.1"] },
    { "id": 5, "tasks": ["9.1"] },
    { "id": 6, "tasks": ["9.2"] }
  ]
}
```
