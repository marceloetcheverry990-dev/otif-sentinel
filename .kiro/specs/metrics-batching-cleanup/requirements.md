# Requirements Document

## Introduction

Este spec cubre la **Fase 2 del refactor de métricas**: eliminación completa del sistema de batching obsoleto en `src/monitoring/metrics.js` y sus dependencias en `src/monitoring/config.js` e `src/monitoring/index.js`.

En la Fase 1 (ya desplegada en producción), `recordMetric()` fue migrada a persistencia directa con `aggregation_type = 'raw'`. El código de batching (acumulación en `metricsBatch`, flush periódico, cálculo in-memory de percentiles, inserts múltiples) quedó muerto: nunca se ejecuta, pero aumenta la carga cognitiva, puede confundir a futuros desarrolladores y declara variables module-level que en Cloudflare Workers son efímeras de todos modos.

Este refactor elimina ese código muerto de forma quirúrgica, sin alterar la lógica de negocio, el esquema de base de datos, el dashboard, ni el sampling.

## Glossary

- **Metrics_Module**: El archivo `src/monitoring/metrics.js` que implementa la recolección de métricas.
- **Monitoring_Config**: El archivo `src/monitoring/config.js` que centraliza la configuración del sistema de monitoreo.
- **Monitoring_Index**: El archivo `src/monitoring/index.js` que re-exporta los componentes del sistema de monitoreo.
- **Batch_System**: El conjunto de estructuras y funciones en `Metrics_Module` responsables de acumular métricas en memoria antes de persistirlas: `metricsBatch`, `lastFlushTime`, `BATCH_SIZE`, `FLUSH_INTERVAL_MS`, `flushMetricsBatch`, `flushToAnalyticsEngine`, `flushToPostgreSQL`, `groupByTags`, `sortObject`, `insertMetricRow`, `calculatePercentiles`, `forceFlushMetrics`.
- **Direct_Persistence**: El mecanismo activo en producción: `recordMetric()` inserta una fila directamente en `metrics_summary` con `aggregation_type = 'raw'` usando un `Client` de pg por cada evento muestreado.
- **Dead_Code**: Código presente en el repositorio que no puede ser alcanzado por ninguna ruta de ejecución activa.

---

## Requirements

### Requirement 1: Eliminación del Batch_System de Metrics_Module

**User Story:** Como desarrollador del sistema, quiero eliminar el Batch_System de Metrics_Module, para que el archivo refleje únicamente el comportamiento real en producción y no induzca a error sobre cómo funciona la persistencia de métricas.

#### Acceptance Criteria

1. THE Metrics_Module SHALL NOT contain the module-level variable `metricsBatch`.
2. THE Metrics_Module SHALL NOT contain the module-level variable `lastFlushTime`.
3. THE Metrics_Module SHALL NOT contain the module-level constant `BATCH_SIZE`.
4. THE Metrics_Module SHALL NOT contain the module-level constant `FLUSH_INTERVAL_MS`.
5. THE Metrics_Module SHALL NOT contain the function `flushMetricsBatch`.
6. THE Metrics_Module SHALL NOT contain the function `flushToAnalyticsEngine`.
7. THE Metrics_Module SHALL NOT contain the function `flushToPostgreSQL`.
8. THE Metrics_Module SHALL NOT contain the function `groupByTags`.
9. THE Metrics_Module SHALL NOT contain the function `sortObject`.
10. THE Metrics_Module SHALL NOT contain the function `insertMetricRow`.
11. THE Metrics_Module SHALL NOT contain the function `calculatePercentiles`.
12. THE Metrics_Module SHALL NOT contain the function `forceFlushMetrics`.

---

### Requirement 2: Preservación de la Direct_Persistence

**User Story:** Como operador de producción, quiero que `recordMetric()` continúe insertando directamente en `metrics_summary` con `aggregation_type = 'raw'`, para que la recolección de métricas siga funcionando sin interrupción después del refactor.

#### Acceptance Criteria

1. WHEN `recordMetric(metricName, value, tags, env)` is called and the sampling check passes, THE Metrics_Module SHALL execute exactly one INSERT into `metrics_summary` with `aggregation_type = 'raw'` and `sample_count = 1`.
2. WHEN `recordMetric` is called and the sampling check does not pass, THE Metrics_Module SHALL return without performing any database write.
3. IF a database error occurs during the INSERT, THEN THE Metrics_Module SHALL catch the error and log it to `console.error` with the prefix `[METRICS_ERROR]`, including at minimum `metricName`, `value`, and `error.message` as observable fields, without re-throwing.
4. IF the database connection is established successfully, THEN THE Metrics_Module SHALL call `client.end()` in a `finally` block regardless of whether the INSERT succeeded or failed.
5. THE Metrics_Module SHALL export the functions `recordMetric`, `startTimer`, `withMetrics`, and the constant `METRIC_TYPES`.

---

### Requirement 3: Limpieza de configuración de batching en Monitoring_Config

**User Story:** Como desarrollador del sistema, quiero eliminar las claves de configuración del Batch_System de Monitoring_Config, para que la configuración no exponga parámetros que no tienen efecto en el comportamiento del sistema.

#### Acceptance Criteria

1. THE Monitoring_Config SHALL NOT contain the `batching` key in the `MONITORING_CONFIG` object (removing `metrics_batch_size`, `errors_batch_size`, and `flush_interval_ms`).
2. WHEN `validateMonitoringConfig()` is called after removing the `batching` block, THE function SHALL NOT reference `MONITORING_CONFIG.batching` and SHALL return `{ valid: true, errors: [] }` when all remaining validations pass.
3. THE Monitoring_Config SHALL preserve all other top-level configuration keys with identical structure and values: `features`, `sampling`, `alerts`, `retention`, `dashboard`, `operational`, `metrics`, `security`, and `service`.

---

### Requirement 4: Limpieza del re-export en Monitoring_Index

**User Story:** Como desarrollador del sistema, quiero que Monitoring_Index no re-exporte `forceFlushMetrics`, para que la API pública del módulo de monitoreo no exponga funciones que ya no existen.

#### Acceptance Criteria

1. THE Monitoring_Index SHALL NOT contain a re-export of `forceFlushMetrics` from `./metrics.js`.
2. THE Monitoring_Index SHALL preserve the following named exports from `./metrics.js` unchanged: `recordMetric`, `startTimer` (re-exported as alias `metricsTimer`), `withMetrics`, and `METRIC_TYPES`.

---

### Requirement 5: Verificación de que no existen consumidores del Batch_System

**User Story:** Como desarrollador del sistema, quiero confirmar que ninguna ruta de ejecución activa llama a funciones del Batch_System, para garantizar que la eliminación no rompe ninguna funcionalidad.

#### Acceptance Criteria

1. THE codebase under `src/` SHALL NOT contain any call to `forceFlushMetrics` in any file other than `metrics.js`.
2. THE codebase under `src/` SHALL NOT contain any direct identifier reference to `metricsBatch`, `flushMetricsBatch`, `BATCH_SIZE`, or `FLUSH_INTERVAL_MS` in any file other than `metrics.js`.
3. THE codebase under `src/` SHALL NOT contain any property access or import referencing `MONITORING_CONFIG.batching` in any file other than `monitoring/config.js`.
