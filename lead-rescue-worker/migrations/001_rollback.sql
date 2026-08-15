-- ============================================================================
-- Monitoring Schema Rollback - OTIF Sentinel Stability System
-- Version: 001
-- Description: Safely remove monitoring tables and partitions in reverse order
-- WARNING: This will permanently delete all monitoring data!
-- ============================================================================

BEGIN;

-- ============================================================================
-- Pre-Rollback Verification
-- ============================================================================
DO $$
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'MONITORING SCHEMA ROLLBACK - VERSION 001';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'This operation will PERMANENTLY DELETE all monitoring data.';
  RAISE NOTICE 'Current timestamp: %', NOW();
END $$;

-- ============================================================================
-- Backup Check (Optional but Recommended)
-- ============================================================================
-- Uncomment if you want to ensure backups exist before rollback
-- DO $$
-- BEGIN
--   IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'error_logs_backup') THEN
--     RAISE EXCEPTION 'No backup found. Create backup before rollback: CREATE TABLE error_logs_backup AS SELECT * FROM error_logs;';
--   END IF;
-- END $$;


-- ============================================================================
-- Drop Tables in Reverse Order
-- ============================================================================

-- Drop health_check_results (no dependencies)
DO $$
BEGIN
  DROP TABLE IF EXISTS health_check_results CASCADE;
  RAISE NOTICE 'Dropped table: health_check_results';
END $$;

-- Drop alert_history (no dependencies)
DO $$
BEGIN
  DROP TABLE IF EXISTS alert_history CASCADE;
  RAISE NOTICE 'Dropped table: alert_history';
END $$;

-- Drop metrics_summary and all partitions
-- CASCADE ensures all partitions are dropped automatically
DO $$
BEGIN
  DROP TABLE IF EXISTS metrics_summary CASCADE;
  RAISE NOTICE 'Dropped table: metrics_summary (including all partitions)';
END $$;

-- Verify partitions are cleaned up
DO $$
DECLARE
  remaining_partitions INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining_partitions
  FROM pg_class
  WHERE relname LIKE 'metrics_summary_%'
    AND relkind = 'r';
  
  IF remaining_partitions > 0 THEN
    RAISE WARNING 'Found % orphaned partition(s), cleaning up...', remaining_partitions;
    -- Manual cleanup if CASCADE didn't work
    FOR partition_rec IN 
      SELECT relname FROM pg_class 
      WHERE relname LIKE 'metrics_summary_%' AND relkind = 'r'
    LOOP
      EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', partition_rec.relname);
      RAISE NOTICE 'Manually dropped partition: %', partition_rec.relname;
    END LOOP;
  ELSE
    RAISE NOTICE 'All metrics_summary partitions successfully removed';
  END IF;
END $$;

-- Drop error_logs (no dependencies)
DROP TABLE IF EXISTS error_logs CASCADE;
RAISE NOTICE 'Dropped table: error_logs';


-- ============================================================================
-- Verification - Ensure Clean State
-- ============================================================================
DO $$
DECLARE
  remaining_tables INTEGER;
  remaining_indexes INTEGER;
BEGIN
  -- Check for remaining monitoring tables
  SELECT COUNT(*) INTO remaining_tables
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('error_logs', 'metrics_summary', 'alert_history', 'health_check_results');
  
  IF remaining_tables > 0 THEN
    RAISE EXCEPTION 'ROLLBACK INCOMPLETE: % monitoring table(s) still exist', remaining_tables;
  ELSE
    RAISE NOTICE 'SUCCESS: All monitoring tables removed';
  END IF;
  
  -- Check for remaining monitoring indexes
  SELECT COUNT(*) INTO remaining_indexes
  FROM pg_indexes
  WHERE indexname LIKE 'idx_error_logs_%'
     OR indexname LIKE 'idx_metrics_%'
     OR indexname LIKE 'idx_alert_%'
     OR indexname LIKE 'idx_health_%';
  
  IF remaining_indexes > 0 THEN
    RAISE WARNING 'Found % orphaned index(es) - these should have been dropped with CASCADE', remaining_indexes;
  ELSE
    RAISE NOTICE 'SUCCESS: All monitoring indexes removed';
  END IF;
END $$;


-- ============================================================================
-- Optional: Clean Up Any Scheduled Jobs or Functions
-- ============================================================================
-- If you created any functions or scheduled jobs for monitoring, drop them here
-- Example:
-- DROP FUNCTION IF EXISTS cleanup_old_monitoring_data() CASCADE;
-- RAISE NOTICE 'Dropped monitoring cleanup functions';


-- ============================================================================
-- Final Status Report
-- ============================================================================
DO $$
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'ROLLBACK COMPLETED SUCCESSFULLY';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Monitoring tables removed:';
  RAISE NOTICE '  - error_logs';
  RAISE NOTICE '  - metrics_summary (and all partitions)';
  RAISE NOTICE '  - alert_history';
  RAISE NOTICE '  - health_check_results';
  RAISE NOTICE '';
  RAISE NOTICE 'To restore monitoring, run: 001_monitoring_schema.sql';
  RAISE NOTICE 'Timestamp: %', NOW();
END $$;

COMMIT;

-- ============================================================================
-- Post-Rollback Notes
-- ============================================================================
-- 1. All monitoring data has been permanently deleted
-- 2. No backups are created by this script - ensure you have external backups if needed
-- 3. To re-enable monitoring, run the forward migration: 001_monitoring_schema.sql
-- 4. Consider running VACUUM after rollback to reclaim disk space:
--    VACUUM ANALYZE;
-- 5. If monitoring code is still deployed, it may attempt to write to non-existent tables
--    Ensure monitoring feature flags are disabled before rollback
-- ============================================================================
