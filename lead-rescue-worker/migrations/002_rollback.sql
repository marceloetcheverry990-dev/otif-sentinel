-- ============================================================================
-- Rollback 002: Revert aggregation_type constraint to original set
-- Version: 002_rollback
-- Description: Removes 'raw' from the metrics_summary aggregation_type
--              constraint, reverting to the original set:
--              ('avg', 'sum', 'count', 'p50', 'p95', 'p99')
--
-- WARNING: This rollback will FAIL if any rows with aggregation_type = 'raw'
--          exist in metrics_summary. You must delete or migrate those rows
--          before running this script. See pre-rollback cleanup below.
--
-- Safe order of operations:
--   1. Deploy previous version of metrics.js (with batching, no 'raw' inserts)
--   2. Wait for in-flight requests to complete (seconds)
--   3. Delete raw rows: DELETE FROM metrics_summary WHERE aggregation_type = 'raw';
--   4. Run this rollback script
-- ============================================================================

BEGIN;

-- ============================================================================
-- PRE-ROLLBACK GUARD: abort if raw rows still exist
-- ============================================================================
DO $$
DECLARE
  raw_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO raw_count
    FROM metrics_summary
   WHERE aggregation_type = 'raw';

  IF raw_count > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK ABORTED: % rows with aggregation_type = raw still exist. '
      'Delete or migrate them before running this rollback.',
      raw_count;
  END IF;
END $$;

-- ============================================================================
-- IDEMPOTENCY GUARD: only alter if 'raw' is currently present
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
    RAISE NOTICE 'SKIP: constraint not found — nothing to rollback';
  ELSIF constraint_def NOT LIKE '%raw%' THEN
    RAISE NOTICE 'SKIP: raw is not present in the constraint — already rolled back';
  ELSE
    ALTER TABLE metrics_summary
      DROP CONSTRAINT metrics_summary_aggregation_type_check;

    ALTER TABLE metrics_summary
      ADD CONSTRAINT metrics_summary_aggregation_type_check
      CHECK (aggregation_type IN ('avg', 'sum', 'count', 'p50', 'p95', 'p99'));

    RAISE NOTICE 'SUCCESS: constraint reverted — raw removed from aggregation_type';
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

  IF constraint_def NOT LIKE '%raw%' THEN
    RAISE NOTICE 'VERIFICATION PASSED: raw removed from aggregation_type constraint';
  ELSE
    RAISE EXCEPTION 'VERIFICATION FAILED: raw still present in constraint after rollback';
  END IF;
END $$;

COMMIT;
