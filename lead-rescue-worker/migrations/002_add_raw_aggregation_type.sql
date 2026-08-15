-- ============================================================================
-- Migration 002: Add 'raw' to metrics_summary aggregation_type constraint
-- Version: 002
-- Description: Extends the CHECK constraint on metrics_summary.aggregation_type
--              to include 'raw', enabling direct per-event inserts from the
--              metrics pipeline without pre-aggregation.
--
-- Context: The metrics pipeline (recordMetric in src/monitoring/metrics.js)
--          previously relied on in-memory batching before inserting aggregated
--          rows (p50, p95, p99, avg, sum). That pattern is unreliable in
--          Cloudflare Workers because module-level state (the batch Map) is not
--          guaranteed to survive across isolate invocations.
--
--          This migration enables 'raw' as a valid aggregation_type so that
--          each metric event can be persisted immediately and safely.
--
-- Compatibility: Existing queries in alerts.js filter by aggregation_type IN
--                ('p95', 'avg') — 'raw' rows are invisible to them.
--                No existing query behaviour changes.
--
-- Idempotency: The migration checks whether 'raw' is already present in the
--              constraint definition before attempting to alter it. Safe to
--              run more than once.
--
-- Rollback: See 002_rollback.sql
-- ============================================================================

BEGIN;

-- ============================================================================
-- IDEMPOTENCY GUARD
-- Only alter the constraint if 'raw' is not already allowed.
-- pg_get_constraintdef returns the full constraint expression as text;
-- we check whether the string 'raw' is already present.
-- ============================================================================
DO $$
DECLARE
  constraint_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO constraint_def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'metrics_summary'
     AND c.conname = 'metrics_summary_aggregation_type_check';

  IF constraint_def IS NULL THEN
    RAISE NOTICE 'SKIP: constraint metrics_summary_aggregation_type_check not found — table may not exist yet';
  ELSIF constraint_def LIKE '%raw%' THEN
    RAISE NOTICE 'SKIP: raw is already present in the constraint — no changes made';
  ELSE
    -- Drop the old constraint and recreate it with 'raw' added
    ALTER TABLE metrics_summary
      DROP CONSTRAINT metrics_summary_aggregation_type_check;

    ALTER TABLE metrics_summary
      ADD CONSTRAINT metrics_summary_aggregation_type_check
      CHECK (aggregation_type IN ('avg', 'sum', 'count', 'p50', 'p95', 'p99', 'raw'));

    RAISE NOTICE 'SUCCESS: constraint updated — raw added to aggregation_type';
  END IF;
END $$;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
DO $$
DECLARE
  constraint_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO constraint_def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'metrics_summary'
     AND c.conname = 'metrics_summary_aggregation_type_check';

  IF constraint_def LIKE '%raw%' THEN
    RAISE NOTICE 'VERIFICATION PASSED: raw is present in aggregation_type constraint';
  ELSE
    RAISE EXCEPTION 'VERIFICATION FAILED: raw not found in constraint after migration';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- Post-Migration Notes
-- ============================================================================
-- 1. After applying this migration, deploy the updated metrics.js that uses
--    aggregation_type = 'raw' in recordMetric(). The code change and this
--    migration must be applied together — if code is deployed before the
--    migration, INSERTs will fail the CHECK constraint and be caught silently
--    by the try/catch in recordMetric(), logging [METRICS_ERROR] to console.
--
-- 2. Rows inserted with aggregation_type = 'raw' are NOT returned by existing
--    alert queries (which filter for 'p95' and 'avg'). Alert behaviour is
--    unchanged until Fase 2 rewrites those queries to use window aggregations
--    over raw events.
--
-- 3. To rollback: run 002_rollback.sql which removes 'raw' from the constraint.
--    Any rows with aggregation_type = 'raw' must be deleted first, or the
--    rollback will fail (constraint re-addition would reject existing rows).
-- ============================================================================
