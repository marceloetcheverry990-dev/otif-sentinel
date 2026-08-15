# Requirements Document

## Introduction

Este feature implementa el KPI de **KM Planificados vs KM Reales** en el sistema OTIF Sentinel. El objetivo es medir la desviación entre la distancia calculada por el optimizer al crear una ruta (`distancia_total_viaje_km` en `metadata.routing`) y la distancia real recorrida por el chofer, calculada acumulando los desplazamientos GPS punto a punto durante el viaje. El KPI se expone en el dashboard de la Torre de Control para cada viaje activo, permitiendo detectar desviaciones operativas (rutas alternativas, backtracking, entregas fuera de secuencia).

## Glossary

- **KM_Planificados**: Distancia total en kilómetros calculada por el optimizer y almacenada en `metadata.routing.distancia_total_viaje_km` al momento de crear el viaje.
- **KM_Reales**: Distancia acumulada en kilómetros recorrida por el chofer, calculada sumando la distancia haversine entre cada par de puntos GPS consecutivos recibidos durante el viaje.
- **Desviación_KM**: Diferencia porcentual entre KM_Reales y KM_Planificados, expresada como `((km_reales - km_planificados) / km_planificados) * 100`.
- **GPS_Event**: Actualización de posición enviada por la app del chofer a través del endpoint `/api/app-chofer-sync` o cualquier evento que contenga coordenadas `latitud`/`longitud` asociadas a un `trip_id`.
- **KPI_Widget**: Componente visual del dashboard que muestra los tres valores del KPI: planificado, real y desviación.
- **Sistema**: El backend de Cloudflare Workers de OTIF Sentinel.
- **Accumulator**: Lógica interna del Sistema que acumula la distancia GPS punto a punto para un viaje dado.
- **Dashboard_API**: El endpoint `/api/dashboard/viajes` (función `getControlTowerViajesAPI`) que sirve datos al frontend de la Torre de Control.
- **Viaje**: Registro lógico identificado por un `trip_id`, que agrupa un conjunto de órdenes asignadas a un chofer.
- **Viaje activo**: Viaje cuyo campo `estado` en la tabla `viajes` es `'activo'`.

---

## Requirements

### Requirement 1: Columna de almacenamiento de KM Reales

**User Story:** Como operador de flota, quiero que el sistema persista los kilómetros reales recorridos por cada viaje, para que pueda comparar ese valor con la planificación original.

#### Acceptance Criteria

1. THE Sistema SHALL mantener un campo numérico de KM_Reales por viaje en la tabla `viajes`, con precisión de hasta 2 decimales y valor por defecto `0`, sin romper filas existentes.
2. WHEN el optimizer completa la asignación de un viaje y persiste el registro, THE Sistema SHALL establecer KM_Reales en `0` para ese viaje.
3. IF la columna `km_reales` no existe en la tabla `viajes` tras ejecutar la migración, THEN THE Sistema SHALL haberla creado con tipo numérico de 2 decimales y valor por defecto `0`, y todas las filas preexistentes SHALL tener `km_reales = 0`.
4. IF el Sistema recibe una instrucción que resultaría en `km_reales < 0` para cualquier viaje, THEN THE Sistema SHALL rechazar esa instrucción y preservar el valor anterior de `km_reales`.

---

### Requirement 2: Acumulación de distancia GPS en tiempo real

**User Story:** Como operador de flota, quiero que el sistema calcule automáticamente la distancia recorrida a partir de los eventos GPS del chofer, para que los KM Reales reflejen el trayecto real sin intervención manual.

#### Acceptance Criteria

1. WHEN el Sistema recibe un GPS_Event con `latitud`, `longitud` y un `trip_id` que corresponde a un viaje activo existente, THE Accumulator SHALL calcular la distancia haversine entre la posición GPS anterior y la posición GPS actual para ese viaje.
2. WHEN la distancia haversine calculada es mayor o igual a `0.001` km, THE Sistema SHALL incrementar el valor de `km_reales` del viaje de forma atómica, de modo que ningún incremento concurrente pueda perderse o sobreescribirse.
3. IF el Sistema no dispone de una posición GPS anterior para el `trip_id` recibido, THEN THE Accumulator SHALL registrar la posición actual como punto de referencia inicial y no incrementar `km_reales`.
4. IF el GPS_Event contiene `latitud` o `longitud` con valor `null`, vacío, no numérico o fuera del rango válido (latitud entre -90 y 90, longitud entre -180 y 180), THEN THE Accumulator SHALL ignorar ese evento y no modificar `km_reales`.
5. IF la distancia calculada entre dos puntos GPS consecutivos supera `50` km, THEN THE Accumulator SHALL ignorar ese incremento y registrar una advertencia en el log que identifique el `trip_id` y la distancia calculada como un outlier GPS.
6. THE Accumulator SHALL calcular distancias usando la fórmula haversine con radio terrestre de `6371` km, redondeando el resultado a 2 decimales.
7. IF el `trip_id` del GPS_Event no corresponde a ningún viaje existente en el sistema, THEN THE Accumulator SHALL ignorar el evento y no modificar ningún registro.

---

### Requirement 3: Recuperación de la posición GPS anterior

**User Story:** Como desarrollador, quiero que el sistema almacene el último punto GPS conocido por viaje, para que el Accumulator pueda calcular incrementos de distancia entre eventos consecutivos.

#### Acceptance Criteria

1. THE Sistema SHALL mantener la última posición GPS conocida para cada viaje activo, accesible por `trip_id`, usando las columnas `ultima_lat` y `ultima_lng` en `flota_vehiculos` asociadas mediante `trip_id_actual`.
2. WHEN el Accumulator procesa un GPS_Event que pasa las validaciones de rango y no es un outlier (según Requirement 2, criterios 4 y 5), THE Sistema SHALL actualizar `ultima_lat` y `ultima_lng` en `flota_vehiculos` con las coordenadas del evento actual para ese viaje.
3. WHEN un viaje finaliza, THE Sistema SHALL conservar los valores de `ultima_lat` y `ultima_lng` en `flota_vehiculos` sin modificarlos, preservando la última posición registrada como registro histórico.
4. IF no existe registro en `flota_vehiculos` para el `trip_id` del GPS_Event, THEN THE Accumulator SHALL crear un registro con el punto actual como posición inicial y omitir el cálculo de distancia para ese evento.
5. IF existe un registro en `flota_vehiculos` para el `trip_id` pero `ultima_lat` o `ultima_lng` tienen valor `NULL`, THEN THE Accumulator SHALL tratar esa situación como equivalente a no tener posición anterior: registrar el punto actual como posición inicial y omitir el cálculo de distancia para ese evento.

---

### Requirement 4: Exposición del KPI en la API del dashboard

**User Story:** Como operador de flota, quiero que la API del dashboard retorne los KM Planificados, KM Reales y la Desviación para cada viaje activo, para que el frontend pueda mostrarlos sin cálculos adicionales en el cliente.

#### Acceptance Criteria

1. WHEN la Dashboard_API recibe una solicitud GET para viajes con `estado = 'activo'`, THE Dashboard_API SHALL incluir en cada objeto de viaje los campos `km_planificados`, `km_reales` y `desviacion_km_pct`.
2. THE Dashboard_API SHALL calcular `km_planificados` como el valor máximo de `distancia_total_viaje_km` presente en el campo `routing` de los metadatos de las órdenes agrupadas por `trip_id`, redondeado a 1 decimal.
3. THE Dashboard_API SHALL calcular `km_reales` leyendo el valor acumulado de KM_Reales de la tabla `viajes` para el `trip_id` correspondiente, redondeado a 1 decimal.
4. THE Dashboard_API SHALL calcular `desviacion_km_pct` como la diferencia porcentual entre `km_reales` y `km_planificados` respecto a `km_planificados`, redondeada a 1 decimal.
5. IF `km_planificados` es `0` o `NULL`, THEN THE Dashboard_API SHALL retornar `desviacion_km_pct` como `null` para ese viaje.
6. IF `km_reales` es `0` o `NULL` y el viaje está activo, THEN THE Dashboard_API SHALL retornar `km_reales` como `0` y `desviacion_km_pct` como `0.0`.
7. THE Dashboard_API SHALL retornar los campos numéricos `km_planificados` y `km_reales` con precisión de 1 decimal.
8. IF ninguna orden del viaje contiene el campo `distancia_total_viaje_km` en sus metadatos de routing, THEN THE Dashboard_API SHALL retornar `km_planificados` como `null` y `desviacion_km_pct` como `null` para ese viaje.
9. IF no hay viajes con `estado = 'activo'`, THEN THE Dashboard_API SHALL retornar una lista vacía sin error.

---

### Requirement 5: Visualización del KPI en el dashboard

**User Story:** Como operador de flota, quiero ver el KPI de KM Planificados vs KM Reales con su desviación en la Torre de Control, para identificar de un vistazo qué viajes están recorriendo más o menos kilómetros de lo planificado.

#### Acceptance Criteria

1. WHEN el KPI_Widget recibe datos de la Dashboard_API, THE KPI_Widget SHALL mostrar simultáneamente: el valor de `km_planificados` con etiqueta "Planificado", el valor de `km_reales` con etiqueta "Real", y el valor de `desviacion_km_pct` con etiqueta "Desviación".
2. WHEN `desviacion_km_pct` es mayor que `10`, THE KPI_Widget SHALL aplicar color rojo al indicador de desviación.
3. WHEN `desviacion_km_pct` está entre `-10` y `10` (inclusive), THE KPI_Widget SHALL aplicar color verde al indicador de desviación.
4. WHEN `desviacion_km_pct` es menor que `-10`, THE KPI_Widget SHALL aplicar color amarillo al indicador de desviación.
5. WHEN cualquiera de los campos `km_planificados`, `km_reales` o `desviacion_km_pct` es `null`, THE KPI_Widget SHALL mostrar "—" en lugar del valor numérico para ese campo específico.
6. THE KPI_Widget SHALL formatear los valores de distancia con 1 decimal y la unidad "km" (ejemplo: "145.0 km").
7. THE KPI_Widget SHALL formatear el valor de desviación con 1 decimal y unidad "%", mostrando signo "+" para valores positivos, signo "-" para valores negativos, y sin signo para el valor exacto `0.0` (ejemplos: "+11.7%", "-3.2%", "0.0%").

---

### Requirement 6: Integridad de datos y operación concurrente

**User Story:** Como arquitecto del sistema, quiero que la acumulación de KM Reales sea correcta bajo múltiples eventos GPS simultáneos, para evitar condiciones de carrera que corrompan el total acumulado.

#### Acceptance Criteria

1. THE Sistema SHALL incrementar `km_reales` de forma atómica a nivel de base de datos, de modo que el resultado final de N incrementos concurrentes sobre el mismo `trip_id` sea igual a la suma de todos los deltas individuales, sin pérdida ni duplicación.
2. WHEN un viaje finaliza (todas las órdenes en estado `ENTREGADO`, `RECHAZADO` o `CANCELADO_PLANILLA`), THE Sistema SHALL conservar el valor final de `km_reales` como registro histórico, y el proceso de acumulación SHALL cesar de modificar ese campo para ese viaje.
3. THE Sistema SHALL completar la operación de actualización de `km_reales` en la base de datos en menos de `500` ms por evento GPS, medido desde la recepción del GPS_Event hasta la confirmación de escritura en la BD.
4. IF la operación de actualización de `km_reales` falla (error de BD, timeout, conflicto), THEN THE Sistema SHALL registrar el error con el `trip_id` y el delta no aplicado, sin dejar `km_reales` en un estado parcialmente modificado.

---
