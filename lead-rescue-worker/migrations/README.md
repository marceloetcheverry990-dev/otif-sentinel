# Database Migrations - OTIF Sentinel Monitoring System

This directory contains database migration scripts for the Stability and Monitoring System.

## Overview

The monitoring system requires four dedicated tables in PostgreSQL:
- `error_logs` - Captures application errors with full context
- `metrics_summary` - Stores aggregated performance metrics (partitioned by month)
- `alert_history` - Tracks operational alert dispatches
- `health_check_results` - Records periodic health check results

## Files

### `001_monitoring_schema.sql`
Forward migration that creates all monitoring tables, indexes, and partitions.

**Features:**
- Creates 4 monitoring tables with appropriate constraints
- Creates 13 optimized indexes for common query patterns
- Creates monthly partitions for `metrics_summary` (current + 3 months ahead)
- Includes verification queries to confirm successful creation
- Follows requirements 7.1, 7.2, 7.3, 7.7, 7.8

### `001_rollback.sql`
Rollback migration that safely removes all monitoring infrastructure.

**Features:**
- Drops tables in reverse dependency order
- Removes all partitions and orphaned objects
- Includes verification to ensure clean state
- Provides detailed logging of removal process

**⚠️ WARNING:** This permanently deletes all monitoring data!

### `test_migration.js`
Automated test script to validate migrations before production deployment.

**Test Coverage:**
- ✓ Table creation verification
- ✓ Index creation verification
- ✓ Partition creation verification (4+ partitions)
- ✓ Constraint validation (CHECK constraints)
- ✓ Basic data insertion tests
- ✓ Rollback verification
- ✓ Data cleanup

## Prerequisites

### Required Software
```bash
# Node.js 18+ for test script
node --version

# PostgreSQL client (for manual execution)
psql --version
```

### Required Packages
```bash
# Install PostgreSQL client for Node.js
npm install pg
```

### Database Access
Ensure you have connection credentials configured:
- **Development:** Uses `localConnectionString` from `wrangler.jsonc`
- **Production:** Uses Hyperdrive binding via Cloudflare Workers

## Usage

### 1. Test Migration (Recommended First Step)

Run automated tests on staging/local database:

```bash
# Test forward migration only
node migrations/test_migration.js forward

# Test rollback only
node migrations/test_migration.js rollback

# Test complete cycle (forward + rollback)
node migrations/test_migration.js both
```

**Expected Output:**
```
[SUCCESS] ✓ All 4 tables created: alert_history, error_logs, health_check_results, metrics_summary
[SUCCESS] ✓ All 13 indexes created
[SUCCESS] ✓ Created 4 partitions: metrics_summary_2024_01, metrics_summary_2024_02, ...
[SUCCESS] ✓ Severity constraint working correctly
[SUCCESS] ✓ All basic inserts successful
[SUCCESS] ✓ FORWARD MIGRATION TEST PASSED
```

### 2. Apply Forward Migration

#### Option A: Using psql (Recommended for production)

```bash
# Set connection string
export PGHOST=aws-0-us-west-2.pooler.supabase.com
export PGPORT=6543
export PGDATABASE=postgres
export PGUSER=postgres.cbjderarqvfwzrbqeqjv
# Set PGPASSWORD securely in the current shell or password manager.
# Never write its value in this repository.

# Execute migration
psql -f migrations/001_monitoring_schema.sql

# Verify success
psql -c "SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%error_logs%' OR table_name LIKE '%metrics%' OR table_name LIKE '%alert%' OR table_name LIKE '%health_check%';"
```

#### Option B: Using Supabase SQL Editor

1. Navigate to: https://supabase.com/dashboard/project/cbjderarqvfwzrbqeqjv/editor
2. Create new query
3. Copy contents of `001_monitoring_schema.sql`
4. Execute query
5. Verify success in table browser

### 3. Apply Rollback (If Needed)

**⚠️ DANGER ZONE - This deletes all monitoring data!**

```bash
# Backup data first (optional but recommended)
psql -c "CREATE TABLE error_logs_backup AS SELECT * FROM error_logs;"
psql -c "CREATE TABLE alert_history_backup AS SELECT * FROM alert_history;"

# Execute rollback
psql -f migrations/001_rollback.sql

# Verify tables removed
psql -c "SELECT table_name FROM information_schema.tables WHERE table_name IN ('error_logs', 'metrics_summary', 'alert_history', 'health_check_results');"
```

## Post-Migration Steps

### 1. Verify Tables Created

```sql
-- Check all tables exist
SELECT table_name, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables 
WHERE schemaname = 'public' 
  AND (
    table_name LIKE '%error_logs%' OR 
    table_name LIKE '%metrics%' OR 
    table_name LIKE '%alert%' OR 
    table_name LIKE '%health_check%'
  )
ORDER BY table_name;
```

Expected: 8+ rows (4 tables + 4 partitions)

### 2. Verify Indexes Created

```sql
-- Check indexes
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND (
    indexname LIKE 'idx_error_logs_%' OR
    indexname LIKE 'idx_metrics_%' OR
    indexname LIKE 'idx_alert_%' OR
    indexname LIKE 'idx_health_%'
  )
ORDER BY tablename, indexname;
```

Expected: 13 indexes

### 3. Verify Partitions Created

```sql
-- Check partitions
SELECT 
  parent.relname AS parent_table,
  child.relname AS partition_name,
  pg_get_expr(child.relpartbound, child.oid) AS partition_range
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child ON pg_inherits.inhrelid = child.oid
WHERE parent.relname = 'metrics_summary'
ORDER BY partition_name;
```

Expected: 4 partitions (current month + 3 months ahead)

### 4. Test Data Insertion

```sql
-- Test error_logs
INSERT INTO error_logs (severity, error_type, error_message, error_fingerprint, tenant_id)
VALUES ('INFO', 'TestError', 'Migration test message', 'test123', 'test-tenant');

-- Test metrics_summary
INSERT INTO metrics_summary (metric_name, metric_value, aggregation_type, dimension_tags)
VALUES ('test.metric', 100, 'avg', '{"test": true}'::jsonb);

-- Test alert_history
INSERT INTO alert_history (alert_type, severity, component, message)
VALUES ('test_alert', 'INFO', 'migration', 'Test alert');

-- Test health_check_results
INSERT INTO health_check_results (overall_status, database_status, storage_status, queues_status)
VALUES ('healthy', true, true, true);

-- Verify insertions
SELECT COUNT(*) FROM error_logs WHERE error_type = 'TestError';
SELECT COUNT(*) FROM metrics_summary WHERE metric_name = 'test.metric';
SELECT COUNT(*) FROM alert_history WHERE alert_type = 'test_alert';
SELECT COUNT(*) FROM health_check_results WHERE overall_status = 'healthy';

-- Cleanup test data
DELETE FROM error_logs WHERE error_type = 'TestError';
DELETE FROM metrics_summary WHERE metric_name = 'test.metric';
DELETE FROM alert_history WHERE alert_type = 'test_alert';
DELETE FROM health_check_results WHERE overall_status = 'healthy';
```

### 5. Optimize Statistics

```sql
-- Analyze tables for query optimization
ANALYZE error_logs;
ANALYZE metrics_summary;
ANALYZE alert_history;
ANALYZE health_check_results;
```

## Maintenance

### Monthly Partition Creation

Create a new partition each month (automate via cron or scheduled job):

```sql
-- Create next month's partition
DO $$
DECLARE
  next_month_start DATE := DATE_TRUNC('month', CURRENT_DATE + INTERVAL '4 months');
  next_month_end DATE := next_month_start + INTERVAL '1 month';
  partition_name TEXT := 'metrics_summary_' || TO_CHAR(next_month_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF metrics_summary FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    next_month_start,
    next_month_end
  );
  RAISE NOTICE 'Created partition: %', partition_name;
END $$;
```

### Data Retention Enforcement

Schedule this query to run daily at 02:00 UTC:

```sql
BEGIN;
  -- error_logs: 90 days retention
  DELETE FROM error_logs WHERE timestamp < NOW() - INTERVAL '90 days';
  
  -- alert_history: 180 days retention
  DELETE FROM alert_history WHERE timestamp < NOW() - INTERVAL '180 days';
  
  -- health_check_results: 30 days retention
  DELETE FROM health_check_results WHERE timestamp < NOW() - INTERVAL '30 days';
  
  -- metrics_summary: 365 days retention (drop old partitions)
  -- Example: DROP TABLE IF EXISTS metrics_summary_2023_01;
  
COMMIT;

-- Reclaim disk space
VACUUM ANALYZE;
```

## Monitoring Table Sizes

```sql
-- Check table and partition sizes
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
  pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) AS index_size
FROM pg_tables 
WHERE schemaname = 'public' 
  AND (
    tablename LIKE '%error_logs%' OR 
    tablename LIKE '%metrics%' OR 
    tablename LIKE '%alert%' OR 
    tablename LIKE '%health_check%'
  )
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

## Troubleshooting

### Issue: Migration fails with "relation already exists"

**Solution:** Tables already exist. Either:
1. Run rollback first: `psql -f migrations/001_rollback.sql`
2. Or manually drop tables and re-run migration

### Issue: Partition creation fails

**Solution:** Ensure date ranges don't overlap:
```sql
-- Check existing partitions
SELECT tablename FROM pg_tables WHERE tablename LIKE 'metrics_summary_%';

-- Manually drop conflicting partition
DROP TABLE IF EXISTS metrics_summary_2024_01 CASCADE;
```

### Issue: Test script connection fails

**Solution:** Verify credentials:
```bash
# Test database connection
psql "$DATABASE_URL" -c "SELECT 1;"

# Set DATABASE_URL in the current shell or secret manager first.
# Never write a real connection string in this repository.
node migrations/test_migration.js forward
```

### Issue: Permission denied errors

**Solution:** Ensure database user has necessary privileges:
```sql
-- Grant privileges to service role
GRANT CREATE, USAGE ON SCHEMA public TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
```

## Deployment Checklist

- [ ] Run test script on staging database: `node migrations/test_migration.js both`
- [ ] Verify all tests pass
- [ ] Schedule low-traffic window for production deployment
- [ ] Backup production database (if critical)
- [ ] Execute forward migration on production: `psql -f 001_monitoring_schema.sql`
- [ ] Verify tables, indexes, and partitions created
- [ ] Test data insertion with sample records
- [ ] Run ANALYZE on all new tables
- [ ] Deploy monitoring code (feature flag: OFF initially)
- [ ] Enable monitoring feature flag gradually (10% → 50% → 100%)
- [ ] Monitor database performance and storage usage
- [ ] Set up monthly partition creation job
- [ ] Set up daily retention cleanup job

## Rollback Plan

If monitoring system causes issues:

1. **Disable monitoring code** (feature flag OFF)
2. **Wait for in-flight operations** (5 minutes)
3. **Verify no active writes**: 
   ```sql
   SELECT COUNT(*) FROM pg_stat_activity WHERE query LIKE '%error_logs%' OR query LIKE '%metrics_summary%';
   ```
4. **Execute rollback**: `psql -f migrations/001_rollback.sql`
5. **Verify tables removed**
6. **Investigate root cause** before re-enabling

## Support

For issues or questions about migrations:
- Check design document: `.kiro/specs/estabilidad-y-monitoreo/design.md`
- Check requirements: `.kiro/specs/estabilidad-y-monitoreo/requirements.md`
- Review database logs in Supabase dashboard
- Test on local/staging first before production changes
