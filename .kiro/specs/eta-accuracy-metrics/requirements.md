# Requirements Document

## Introduction

Este feature implementa un sistema enterprise de medición de precisión ETA (Estimated Time of Arrival) a nivel de parada individual. El sistema captura automáticamente la diferencia entre el ETA calculado por el optimizador y la hora real de llegada/entrega del chofer, persiste ese dato históricamente en la tabla `eta_accuracy_metrics`, expone una API de estadísticas avanzadas (promedio, mediana, p90, p95, p99) y alimenta un panel ejecutivo con KPIs de precisión ETA.

La arquitectura de la tabla incluye campos de contexto enriquecido (`eta_source`, `distancia_restante_km`, `route_version`, `eta_confidence`) que preparan el sistema para analítica avanzada futura: comparación de precisión entre algoritmos ETA, reoptimización continua basada en errores históricos, y modelos de confianza predictiva.

El sistema se integra con el flujo existente de Cloudflare Workers + Neon/PostgreSQL (vía Supabase), aprovechando los eventos `ENTREGA` y `PROBLEMA` de `app-chofer-evento.js`, y `COMPLETADA` y `PROBLEMA` de `app-chofer-sync.js`, usando el ETA calculado que el optimizador persiste en `ordenes_pendientes.eta`.

## Glossary

- **ETA_Accuracy_System**: El sistema completo de medición de precisión ETA descrito en este documento.
- **ETA_Hook**: El mecanismo que registra una fila en `eta_accuracy_metrics` cuando una parada cambia a estado terminal.
- **Stop**: Una parada individual dentro de un viaje (`trip`), representada por una fila en `ordenes_pendientes`.
- **Estado_Terminal**: Estado final de una parada: `ENTREGADO` (via `app-chofer-evento.js`) o `COMPLETADA` (via `app-chofer-sync.js`).
- **ETA_Calculado**: El timestamp ISO almacenado en `ordenes_pendientes.eta` al momento de la asignación o último recálculo.
- **Hora_Real_Llegada**: El timestamp registrado en `ordenes_pendientes.hora_llegada_chofer` (evento `LLEGADA`) con preferencia, o `hora_real` (evento `ENTREGA`/`PROBLEMA`/`COMPLETADA`) como fallback.
- **Error_Minutos**: Diferencia con signo entre `Hora_Real_Llegada` y `ETA_Calculado`, en minutos. Positivo = llegó tarde; negativo = llegó antes.
- **Error_Absoluto_Minutos**: Valor absoluto de `Error_Minutos`.
- **ETA_Source**: Identificador del algoritmo o fuente que generó el ETA registrado. Valores posibles: `MAPBOX_TRAFFIC` (Mapbox directions con tráfico en tiempo real), `HAVERSINE_CASCADE` (recálculo haversine en cascada desde SALIDA), `NO_GPS_FALLBACK` (sin coordenadas GPS disponibles), `NO_COORDS_FALLBACK` (sin coordenadas de destino), `OPTIMIZER_STATIC` (ETA inicial del optimizer sin recálculo posterior).
- **Route_Version**: Identificador de versión de la ruta activa al momento de calcular el ETA. Permite comparar precisión entre versiones de ruta y detectar degradación tras reoptimizaciones.
- **Distancia_Restante_Km**: Distancia en kilómetros desde la posición GPS del chofer al destino al momento de calcular el ETA. Permite analizar si el error correlaciona con la distancia remanente.
- **ETA_Confidence**: Valor numérico entre 0.0 y 1.0 que representa la confianza en el ETA calculado. 1.0 = máxima confianza (Mapbox con GPS activo). 0.5 = confianza media (haversine con GPS). 0.2 = baja confianza (fallback sin GPS). NULL = no calculado.
- **ETA_Stats_API**: El endpoint REST que expone estadísticas agregadas de precisión ETA.
- **ETA_Dashboard_Section**: La sección de precisión ETA incorporada al dashboard ejecutivo existente.
- **Percentil**: Valor estadístico (p50/mediana, p90, p95, p99) calculado sobre la distribución de `Error_Absoluto_Minutos`.
- **Tenant**: Empresa cliente identificada por `tenant_id`.

---

## Requirements

### Requirement 1: Tabla de Persistencia Histórica de Métricas ETA

**User Story:** Como analista de operaciones, quiero que el sistema almacene el error de ETA por cada parada individual completada, incluyendo el contexto del algoritmo y condiciones del viaje, para análisis granular de precisión y evaluación comparativa de modelos predictivos.

#### Acceptance Criteria

1. THE ETA_Accuracy_System SHALL crear la tabla `eta_accuracy_metrics` con columnas:
   - `id` (BIGSERIAL PK)
   - `tenant_id` (VARCHAR(64) NOT NULL)
   - `trip_id` (VARCHAR(64) NOT NULL)
   - `stop_id` (VARCHAR(64) NOT NULL)
   - `chofer_id` (VARCHAR(64))
   - `eta_calculado` (TIMESTAMPTZ NOT NULL)
   - `hora_real_llegada` (TIMESTAMPTZ NOT NULL)
   - `error_minutos` (NUMERIC(8,1)) — diferencia con signo: positivo = llegó tarde
   - `error_absoluto_minutos` (NUMERIC(8,1)) — valor absoluto de `error_minutos`
   - `eta_source` (VARCHAR(32)) — identificador del algoritmo que generó el ETA
   - `distancia_restante_km` (NUMERIC(8,2)) — km desde posición GPS al destino al calcular ETA
   - `route_version` (VARCHAR(64)) — versión o ID de la ruta activa al calcular ETA
   - `eta_confidence` (NUMERIC(3,2)) — confianza en el ETA, entre 0.00 y 1.00
   - `fecha` (DATE NOT NULL)
   - `created_at` (TIMESTAMPTZ DEFAULT NOW())
2. THE ETA_Accuracy_System SHALL crear índices en `(tenant_id, fecha DESC)`, `(chofer_id, fecha DESC)`, `(trip_id)` y `(eta_source, fecha DESC)` — el índice por `eta_source` permite comparar precisión entre algoritmos.
3. THE ETA_Accuracy_System SHALL aplicar constraint `UNIQUE (tenant_id, stop_id)` — un intento de insertar un `stop_id` duplicado dentro del mismo `tenant_id` SHALL ser rechazado sin modificar el registro existente.
4. THE ETA_Accuracy_System SHALL almacenar `error_minutos` como `ROUND((hora_real_llegada - eta_calculado en minutos), 1)`, donde positivo significa llegó tarde.
5. THE ETA_Accuracy_System SHALL almacenar `error_absoluto_minutos` como el valor absoluto de `error_minutos`, con precisión NUMERIC(8,1).
6. WHEN el ETA_Hook recibe un evento terminal para una parada, THE ETA_Accuracy_System SHALL insertar exactamente una fila en `eta_accuracy_metrics` antes de retornar la respuesta del request.
7. IF `eta_calculado` o `hora_real_llegada` son NULL al momento de la inserción, THEN THE ETA_Accuracy_System SHALL omitir la inserción para esa parada.
8. THE ETA_Accuracy_System SHALL derivar `fecha` de `hora_real_llegada` truncado al día en zona horaria `America/Santiago`.
9. THE ETA_Accuracy_System SHALL permitir valores NULL en `eta_source`, `distancia_restante_km`, `route_version` y `eta_confidence` — estos campos son opcionales para mantener retrocompatibilidad con eventos que no dispongan de esa información.
10. IF `eta_confidence` es proporcionado, THEN THE ETA_Accuracy_System SHALL rechazar valores fuera del rango [0.00, 1.00] con una constraint CHECK.

---

### Requirement 2: Hook Automático en Eventos Terminales de Parada

**User Story:** Como operador de logística, quiero que el error ETA se capture automáticamente cuando el chofer registra la entrega o el problema, sin acción manual adicional.

#### Acceptance Criteria

1. WHEN una parada cambia al estado `ENTREGADO` via evento `ENTREGA` en `app-chofer-evento.js`, THE ETA_Hook SHALL ejecutar la inserción en `eta_accuracy_metrics` de forma síncrona antes de retornar la respuesta HTTP al chofer.
2. WHEN una parada cambia al estado `RECHAZADO` via evento `PROBLEMA` en `app-chofer-evento.js`, THE ETA_Hook SHALL ejecutar la inserción en `eta_accuracy_metrics` de forma síncrona antes de retornar la respuesta HTTP al chofer.
3. WHEN una parada cambia al estado `ENTREGADO` via evento `COMPLETADA` en `app-chofer-sync.js`, THE ETA_Hook SHALL ejecutar la inserción en `eta_accuracy_metrics` de forma síncrona antes de retornar la respuesta HTTP.
4. WHEN una parada cambia al estado `RECHAZADO` via evento `PROBLEMA` en `app-chofer-sync.js`, THE ETA_Hook SHALL ejecutar la inserción en `eta_accuracy_metrics` de forma síncrona antes de retornar la respuesta HTTP.
5. THE ETA_Hook SHALL construir el registro con: `eta_calculado` desde `ordenes_pendientes.eta`, `hora_real_llegada` desde `ordenes_pendientes.hora_llegada_chofer` si no es NULL, o `hora_real` como fallback, o timestamp del evento actual como último fallback.
6. WHEN `ordenes_pendientes.eta` es NULL para la parada procesada, THE ETA_Hook SHALL omitir la inserción y continuar el flujo sin error.
7. WHEN el insert falla por violación de constraint UNIQUE, THE ETA_Hook SHALL ignorar el error y continuar — la respuesta HTTP al chofer SHALL ser exitosa.
8. IF el insert falla por causa distinta a duplicado, THEN THE ETA_Hook SHALL registrar `[ETA_METRIC_ERROR] stop_id=X error=Y` en consola y continuar — la respuesta HTTP al chofer SHALL ser exitosa.
9. IF `chofer_id` no está en el payload del evento, THEN THE ETA_Hook SHALL leerlo desde `ordenes_pendientes.chofer_asignado_id` usando el `stop_id` del evento.
10. THE ETA_Hook SHALL extraer `eta_source` desde `ordenes_pendientes.metadata.routing.eta_source` si está disponible; de lo contrario SHALL insertar NULL.
11. THE ETA_Hook SHALL extraer `distancia_restante_km` desde `ordenes_pendientes.metadata.routing.km_al_siguiente` si está disponible; de lo contrario SHALL insertar NULL.
12. THE ETA_Hook SHALL extraer `route_version` desde `ordenes_pendientes.trip_id` concatenado con el `stop_sequence` de la orden (formato: `"{trip_id}-v{stop_sequence}"`); si `stop_sequence` no está disponible SHALL insertar el `trip_id` solo.
13. THE ETA_Hook SHALL asignar `eta_confidence` según la siguiente tabla de valores por defecto basada en `eta_source`: `MAPBOX_TRAFFIC` → 0.90, `HAVERSINE_CASCADE` → 0.55, `NO_GPS_FALLBACK` → 0.20, `NO_COORDS_FALLBACK` → 0.15, `OPTIMIZER_STATIC` → 0.70, fuente desconocida o NULL → NULL.

---

### Requirement 3: API de Estadísticas de Precisión ETA

**User Story:** Como gerente de operaciones, quiero consultar estadísticas avanzadas de precisión ETA filtrables por período y chofer.

#### Acceptance Criteria

1. THE ETA_Stats_API SHALL exponer `GET /api/eta-accuracy/stats` con parámetros: `tenant_id` (obligatorio), `desde` (YYYY-MM-DD, opcional), `hasta` (YYYY-MM-DD, opcional), `chofer_id` (opcional), `eta_source` (opcional), `route_version` (opcional).
2. WHEN `tenant_id` no es proporcionado, THE ETA_Stats_API SHALL responder HTTP 400 con `{"error": "tenant_id es requerido"}`.
3. WHEN la consulta es exitosa y hay registros, THE ETA_Stats_API SHALL responder HTTP 200 con: `total_registros`, `error_promedio_min`, `error_mediana_min` (p50), `error_p90_min`, `error_p95_min`, `error_p99_min`, `error_absoluto_promedio_min`, `pct_dentro_5min`, `pct_dentro_10min`, `pct_dentro_15min`, todos redondeados a 1 decimal.
4. WHEN no existen registros para los filtros dados, THE ETA_Stats_API SHALL responder HTTP 200 con `total_registros: 0` y todos los demás campos numéricos en `null`.
5. THE ETA_Stats_API SHALL calcular percentiles como el valor de `error_absoluto_minutos` tal que el X% de los registros tienen un valor menor o igual a ese número.
6. THE ETA_Stats_API SHALL calcular `pct_dentro_Xmin` como el porcentaje (0–100, 1 decimal) de registros con `error_absoluto_minutos <= X`.
7. IF `desde` o `hasta` tienen formato inválido (no YYYY-MM-DD), THEN THE ETA_Stats_API SHALL responder HTTP 400 con mensaje descriptivo del error de formato.
8. IF `chofer_id` es proporcionado, THEN THE ETA_Stats_API SHALL restringir todos los cálculos a registros de ese chofer.
9. THE ETA_Stats_API SHALL retornar `stats_por_chofer`: array con `chofer_id`, `total_registros`, `error_absoluto_promedio_min`, `pct_dentro_10min` para los 10 choferes con más registros en el período; si `chofer_id` está filtrado, el array contendrá solo ese chofer.
10. IF el dataset contiene más de 100,000 registros para los filtros dados, THEN THE ETA_Stats_API SHALL completar la respuesta en menos de 3 segundos.
11. THE ETA_Stats_API SHALL retornar `stats_por_source`: array con `eta_source`, `total_registros`, `error_absoluto_promedio_min`, `error_p90_min` y `eta_confidence_promedio` para cada fuente ETA presente en el período — permite comparar precisión entre algoritmos.
12. IF `eta_source` es proporcionado como filtro, THEN THE ETA_Stats_API SHALL restringir todos los cálculos a registros de esa fuente ETA específica.
13. IF `route_version` es proporcionado como filtro, THEN THE ETA_Stats_API SHALL restringir todos los cálculos a registros de esa versión de ruta específica — permite evaluar degradación de precisión tras reoptimizaciones.

---

### Requirement 4: Sección ETA en Dashboard Ejecutivo

**User Story:** Como ejecutivo, quiero ver los KPIs de precisión ETA integrados en el dashboard ejecutivo.

#### Acceptance Criteria

1. WHEN el dashboard ejecutivo carga los KPIs, THE ETA_Dashboard_Section SHALL obtener las métricas de precisión ETA desde `GET /api/eta-accuracy/stats` con el `tenant_id` activo.
2. THE ETA_Dashboard_Section SHALL mostrar: `Error ETA Promedio`, `Mediana`, `P90` (todos en minutos, 1 decimal) y `% Entregas en ±10min` (porcentaje, 1 decimal).
3. WHEN `pct_dentro_10min >= 80`, THE ETA_Dashboard_Section SHALL mostrar ese KPI en color verde.
4. WHEN `pct_dentro_10min` está entre 60 y 79 (inclusive), THE ETA_Dashboard_Section SHALL mostrar ese KPI en color amarillo.
5. WHEN `pct_dentro_10min < 60`, THE ETA_Dashboard_Section SHALL mostrar ese KPI en color rojo.
6. WHEN `total_registros = 0`, THE ETA_Dashboard_Section SHALL mostrar el texto `"Sin datos aún"` en lugar de valores numéricos.
7. THE ETA_Dashboard_Section SHALL mostrar `total_registros` como subtexto de contexto bajo los KPIs.
8. WHEN el período activo del dashboard cambia, THE ETA_Dashboard_Section SHALL re-consultar la API con los nuevos parámetros `desde` y `hasta`.

---

### Requirement 5: Consistencia y Calidad de Datos

**User Story:** Como ingeniero de datos, quiero que el sistema maneje correctamente datos faltantes o inconsistentes.

#### Acceptance Criteria

1. WHEN `eta_calculado` o `hora_real_llegada` no son parseables como timestamp válido, THE ETA_Hook SHALL omitir la inserción y registrar `[ETA_METRIC_SKIP_INVALID_DATE] stop_id=X` en consola.
2. WHEN `error_absoluto_minutos` calculado excede 480 minutos, THE ETA_Hook SHALL insertar el registro sin modificar el valor — los outliers deben preservarse.
3. THE ETA_Accuracy_System SHALL incluir siempre el filtro `tenant_id` en todas las queries de inserción y consulta.
4. FOR ALL registros insertados, `fecha` SHALL derivarse de `hora_real_llegada` convertida a zona horaria `America/Santiago`, no de la fecha UTC del servidor.
5. IF la tabla `eta_accuracy_metrics` no existe en la BD (entorno sin migrar), THEN THE ETA_Hook SHALL capturar el error de "table does not exist", registrar `[ETA_METRIC_TABLE_MISSING]` y continuar sin afectar el flujo del chofer.
