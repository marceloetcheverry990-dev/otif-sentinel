# Implementation Plan: KPI KM Planificados vs Reales

## Overview

Implementar el KPI de desviación de kilómetros (planificados vs reales) en el sistema OTIF Sentinel. El plan sigue el flujo de datos de diseño: migración SQL → utilidad haversine → acumulador GPS → extensión API dashboard → widget UI. Cada tarea construye sobre la anterior y termina con la integración completa.

## Tasks

- [ ] 1. Crear migración SQL y archivo de utilidad haversine
  - [ ] 1.1 Crear el archivo de migración `migrations/002_kpi_km_reales.sql`
    - Agregar columna `km_reales NUMERIC(10,2) DEFAULT 0` a la tabla `viajes` usando `ALTER TABLE viajes ADD COLUMN IF NOT EXISTS`
    - Agregar constraint `CHECK (km_reales >= 0)` con nombre `viajes_km_reales_non_negative`
    - Envolver todo en `BEGIN; ... COMMIT;` para atomicidad
    - El script debe ser idempotente (usar `IF NOT EXISTS`)
    - _Requirements: 1.1, 1.3, 1.4_

  - [ ] 1.2 Crear `src/utils/haversine.js` con las dos funciones exportadas
    - Implementar `calcularDistanciaKm(lat1, lon1, lat2, lon2)` con radio `6371` km, resultado redondeado a 2 decimales
    - Implementar `sonCoordenadasValidas(lat, lng)` retornando `boolean`
    - Exportar ambas funciones como named exports ESM
    - _Requirements: 2.1, 2.4, 2.6_

  - [ ]* 1.3 Escribir property test para haversine (Property 1)
    - Usar `fast-check` (`npm install --save-dev fast-check`)
    - Archivo: `src/utils/haversine.test.js`
    - **Property 1: Haversine — simetría y no-negatividad**
    - Generar pares de coordenadas válidas arbitrarias con `fc.tuple(fc.float({min:-90,max:90}), fc.float({min:-180,max:180}), ...)`
    - Verificar `calcularDistanciaKm(A,B) === calcularDistanciaKm(B,A)` y `resultado >= 0`
    - Mínimo 100 iteraciones
    - **Validates: Requirements 2.1, 2.6**
    - _// Feature: kpi-km-planificados-vs-reales, Property 1: Haversine simetría y no-negatividad_

- [ ] 2. Refactorizar `src/api/gps.js` para usar haversine compartido y acumular en `viajes`
  - [ ] 2.1 Refactorizar `handleGPSPing` en `src/api/gps.js`
    - Reemplazar la función `calcularDistanciaHaversine` local por el import de `src/utils/haversine.js`
    - Cambiar el umbral mínimo de `0.01` → `0.001` km (Req 2.2)
    - Agregar filtro de outlier: si `delta > 50` → log `[GPS_OUTLIER] trip_id=X delta=Y.YYkm` y skip acumulación (Req 2.5)
    - Agregar UPDATE atómico a tabla `viajes`: `UPDATE viajes SET km_reales = km_reales + $1 WHERE trip_id = $2` dentro del bloque `delta >= 0.001 AND delta <= 50` (Req 2.2, 6.1)
    - Mantener el UPDATE de `flota_vehiculos.km_recorridos_reales` existente para retrocompatibilidad
    - Si no existe posición anterior (NULL), registrar punto actual sin acumular (Req 2.3, 3.5)
    - Si `trip_id` no existe en `viajes`, loggear `[GPS_NO_TRIP]` y retornar 404 (Req 2.7)
    - Si UPDATE de `km_reales` falla, loggear `[GPS_DB_ERROR]` con trip_id y delta (Req 6.4)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 6.1, 6.4_

  - [ ]* 2.2 Escribir property test para el Accumulator (Property 2)
    - Archivo: `src/api/gps.test.js`
    - **Property 2: Accumulator — suma correcta de deltas válidos**
    - Generar secuencias de N coordenadas donde cada delta calculado esté en `[0.001, 50]` km
    - Verificar que `km_reales` final === suma de todos los deltas individuales (redondeados a 2 dec)
    - Mínimo 100 iteraciones
    - **Validates: Requirements 2.2, 6.1**
    - _// Feature: kpi-km-planificados-vs-reales, Property 2: Accumulator suma correcta de deltas válidos_

  - [ ]* 2.3 Escribir property test para inputs inválidos (Property 3)
    - En `src/utils/haversine.test.js`
    - **Property 3: Accumulator — inputs inválidos no modifican km_reales**
    - Generar combinaciones de coords inválidas: null, NaN, lat fuera `[-90,90]`, lng fuera `[-180,180]`
    - Verificar que `sonCoordenadasValidas` retorna `false` en todos esos casos
    - Mínimo 100 iteraciones
    - **Validates: Requirements 2.4, 1.4**
    - _// Feature: kpi-km-planificados-vs-reales, Property 3: Inputs inválidos no modifican km_reales_

  - [ ]* 2.4 Escribir property test para posición GPS (Property 4)
    - En `src/api/gps.test.js`
    - **Property 4: Posición GPS siempre refleja el último punto válido**
    - Generar secuencias de GPS_Events válidos sobre un trip_id
    - Verificar que `ultima_lat`/`ultima_lng` en `flota_vehiculos` corresponden al último evento procesado, independientemente de si se acumuló o no
    - Mínimo 100 iteraciones
    - **Validates: Requirements 3.1, 3.2**
    - _// Feature: kpi-km-planificados-vs-reales, Property 4: Posición GPS refleja último punto válido_

- [ ] 3. Checkpoint — Migración y acumulador GPS listos
  - Verificar que `migrations/002_kpi_km_reales.sql` aplica sin errores
  - Verificar que `src/utils/haversine.js` exporta correctamente
  - Asegurar que todos los tests pasan, preguntar al usuario si hay dudas antes de continuar

- [ ] 4. Extender la query SQL en `getControlTowerViajesAPI` (`src/api/dashboard.js`)
  - [ ] 4.1 Modificar la query `resViajes` en `getControlTowerViajesAPI` para incluir los tres campos KPI
    - Agregar `LEFT JOIN viajes vj ON o.trip_id = vj.trip_id` a la query existente (Req 4.1)
    - Agregar al SELECT:
      - `ROUND(CAST(MAX((o.metadata->'routing'->>'distancia_total_viaje_km')::NUMERIC) AS NUMERIC), 1) AS km_planificados` (Req 4.2)
      - `ROUND(CAST(COALESCE(vj.km_reales, 0) AS NUMERIC), 1) AS km_reales` (Req 4.3)
      - Expresión CASE para `desviacion_km_pct`: NULL si km_planificados = 0, 0.0 si km_reales = 0, fórmula porcentual en otro caso (Req 4.4, 4.5, 4.6)
    - Incluir `vj.km_reales` en el GROUP BY o asegurar que está en una función de agregado
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_

  - [ ]* 4.2 Escribir property test para la fórmula de desviación (Property 5)
    - Archivo: `src/api/dashboard.test.js`
    - **Property 5: Motor de cálculo KPI — fórmula de desviación correcta**
    - Extraer la lógica de cálculo de `desviacion_km_pct` a una función pura testeable
    - Generar pares `(km_reales, km_planificados)` con `km_planificados > 0`
    - Verificar `desviacion_km_pct === round(((km_reales - km_planificados) / km_planificados) * 100, 1)`
    - Verificar caso especial: `km_reales === km_planificados → desviacion === 0.0`
    - Mínimo 100 iteraciones
    - **Validates: Requirements 4.4**
    - _// Feature: kpi-km-planificados-vs-reales, Property 5: Fórmula de desviación correcta_

  - [ ]* 4.3 Escribir property test para el contrato de la API (Property 6)
    - En `src/api/dashboard.test.js`
    - **Property 6: API contract — campos KPI siempre presentes en la respuesta**
    - Generar objetos de viaje arbitrarios con `km_planificados` y `km_reales` variables (incluyendo null/0)
    - Verificar que el objeto siempre contiene las claves `km_planificados`, `km_reales`, `desviacion_km_pct`
    - Verificar que `desviacion_km_pct` es null solo cuando `km_planificados` es null o 0
    - Mínimo 100 iteraciones
    - **Validates: Requirements 4.1, 4.7**
    - _// Feature: kpi-km-planificados-vs-reales, Property 6: API response siempre contiene campos KPI_

- [ ] 5. Crear `renderKmKpiWidget` en `src/ui.js` e integrarlo en las cards de viaje
  - [ ] 5.1 Agregar la función `renderKmKpiWidget(kmPlanificados, kmReales, desviacionPct)` a `src/ui.js`
    - La función recibe los tres valores y retorna un string HTML
    - Implementar lógica de semáforo: rojo si `desviacionPct > 10`, verde si `-10 <= desviacionPct <= 10`, amarillo si `< -10` (Req 5.2, 5.3, 5.4)
    - Formatear distancias como `"145.0 km"` (1 decimal + unidad) (Req 5.6)
    - Formatear desviación como `"+11.7%"`, `"-3.2%"`, `"0.0%"` (signo explícito para positivos, sin signo para 0.0) (Req 5.7)
    - Mostrar `"—"` cuando el campo es `null` (Req 5.5)
    - Mostrar etiquetas "Planificado", "Real", "Desviación" (Req 5.1)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ] 5.2 Inyectar el widget en el `trip-subtitle` de cada card de viaje en `renderControlTowerDashboard`
    - Llamar a `renderKmKpiWidget(v.km_planificados, v.km_reales, v.desviacion_km_pct)` dentro de la generación del HTML de cada card
    - Insertar el HTML resultante dentro de `.trip-subtitle` junto a los datos existentes (stops, costo op, etc.)
    - _Requirements: 5.1_

  - [ ]* 5.3 Escribir property test para el semáforo (Property 7)
    - Archivo: `src/ui.test.js`
    - **Property 7: Semáforo — clasificación correcta para cualquier valor de desviación**
    - Extraer función de clasificación del semáforo a una función pura
    - Generar números arbitrarios con `fc.float()` incluyendo extremos
    - Verificar: `> 10 → 'red'`, `[-10, 10] → 'green'`, `< -10 → 'yellow'`; nunca otro valor
    - Mínimo 100 iteraciones
    - **Validates: Requirements 5.2, 5.3, 5.4**
    - _// Feature: kpi-km-planificados-vs-reales, Property 7: Semáforo clasificación correcta_

  - [ ]* 5.4 Escribir property test para formato de valores (Property 8)
    - En `src/ui.test.js`
    - **Property 8: Widget render — formato de valores para cualquier número**
    - Extraer funciones de formato (`formatDistancia`, `formatDesviacion`) como funciones puras
    - Para `formatDistancia(n)` con `n >= 0`: verificar que retorna string terminado en `' km'` con exactamente 1 decimal
    - Para `formatDesviacion(n)`: verificar que termina en `'%'`, tiene 1 decimal; `'+'` si `n > 0`; `'-'` si `n < 0`; sin signo si `n === 0.0`
    - Mínimo 100 iteraciones
    - **Validates: Requirements 5.6, 5.7**
    - _// Feature: kpi-km-planificados-vs-reales, Property 8: Formato de valores para cualquier número_

  - [ ]* 5.5 Escribir property test para nulls en el widget (Property 9)
    - En `src/ui.test.js`
    - **Property 9: Widget render — nulls siempre producen "—"**
    - Generar combinaciones donde al menos uno de los tres campos sea `null`
    - Verificar que el HTML retornado por `renderKmKpiWidget` contiene `"—"` en la posición del campo nulo
    - Mínimo 100 iteraciones
    - **Validates: Requirements 5.5**
    - _// Feature: kpi-km-planificados-vs-reales, Property 9: Nulls producen "—" en el widget_

- [ ] 6. Checkpoint final — Integración completa
  - Verificar que el widget se renderiza correctamente en las cards del dashboard
  - Verificar que la API `/api/dashboard/viajes` retorna los tres campos KPI en cada viaje
  - Verificar retrocompatibilidad: `flota_vehiculos.km_recorridos_reales` sigue funcionando
  - Asegurar que todos los tests pasan, preguntar al usuario si hay dudas

## Notes

- Las tareas marcadas con `*` son opcionales y pueden omitirse para MVP más rápido
- Cada tarea referencia los criterios de aceptación específicos para trazabilidad
- La migración SQL es idempotente: puede ejecutarse dos veces sin error (`ADD COLUMN IF NOT EXISTS`)
- NO reemplazar `km_recorridos_reales` en `flota_vehiculos` — es retrocompatibilidad requerida
- El UPDATE de `km_reales` en `viajes` debe ser atómico (`km_reales = km_reales + $delta`), nunca un read-modify-write
- Instalar `fast-check` antes de escribir los property tests: `npm install --save-dev fast-check`
- Ejecutar tests con `vitest --run` (modo single-run, sin watcher)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "5.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "5.4", "5.5"] }
  ]
}
```
