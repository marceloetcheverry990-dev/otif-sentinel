-- ============================================================================
-- Monitoring Schema Migration - OTIF Sentinel Stability System
-- Version: 001
-- Description: Create monitoring tables for error tracking, metrics collection,
--              alert management, and health check history
-- Requirements: 7.1, 7.2, 7.3, 7.7, 7.8
-- ============================================================================

BEGIN;

-- ============================================================================
-- Table: error_logs
-- Purpose: Store captured errors with full contextual information for analysis
-- Retention: 90 days
-- ============================================================================
CREATE TABLE IF NOT EXISTS error_logs (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
  error_type VARCHAR(255) NOT NULL,
  error_message TEXT NOT NULL,
  error_fingerprint VARCHAR(64) NOT NULL, -- SHA-256 hash for grouping similar errors
  stack_trace TEXT,
  trace_id VARCHAR(100),
  tenant_id VARCHAR(100),
  endpoint VARCHAR(500),
  http_method VARCHAR(10),
  context_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for error_logs - optimized for common query patterns
CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp 
  ON error_logs(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_error_logs_severity 
  ON error_logs(severity);

CREATE INDEX IF NOT EXISTS idx_error_logs_tenant 
  ON error_logs(tenant_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_error_logs_fingerprint 
  ON error_logs(error_fingerprint);

CREATE INDEX IF NOT EXISTS idx_error_logs_trace_id 
  ON error_logs(trace_id);

COMMENT ON TABLE error_logs IS 'Captures application errors with full context for debugging and pattern analysis';


-- ============================================================================
-- Table: metrics_summary
-- Purpose: Store aggregated performance metrics with time-series data
-- Retention: 365 days (managed via partition dropping)
-- Partitioning: Monthly partitions for efficient retention management
-- ============================================================================
CREATE TABLE IF NOT EXISTS metrics_summary (
  id BIGSERIAL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metric_name VARCHAR(100) NOT NULL,
  metric_value NUMERIC NOT NULL,
  metric_unit VARCHAR(20), -- 'ms', 'count', '%', 'msg/min'
  aggregation_type VARCHAR(20) NOT NULL CHECK (aggregation_type IN ('avg', 'sum', 'count', 'p50', 'p95', 'p99')),
  dimension_tags JSONB, -- { endpoint, tenant_id, status_code, queue_name }
  sample_count INTEGER, -- Number of samples aggregated
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);

-- Create partitions for current and next 3 months
-- This ensures data can be written immediately and handles quarter-ahead planning
DO $$
DECLARE
  partition_start DATE;
  partition_end DATE;
  partition_name TEXT;
  i INTEGER;
BEGIN
  FOR i IN 0..3 LOOP
    partition_start := DATE_TRUNC('month', CURRENT_DATE + (i || ' months')::INTERVAL);
    partition_end := partition_start + INTERVAL '1 month';
    partition_name := 'metrics_summary_' || TO_CHAR(partition_start, 'YYYY_MM');
    
    -- Check if partition already exists
    IF NOT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = partition_name
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF metrics_summary FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        partition_start,
        partition_end
      );
      RAISE NOTICE 'Created partition: %', partition_name;
    END IF;
  END LOOP;
END $$;

-- Indexes for metrics_summary - optimized for time-series queries
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp 
  ON metrics_summary(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_metrics_name_time 
  ON metrics_summary(metric_name, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_metrics_tags 
  ON metrics_summary USING GIN (dimension_tags);

COMMENT ON TABLE metrics_summary IS 'Aggregated performance metrics for trend analysis and SLA monitoring';


-- ============================================================================
-- Table: alert_history
-- Purpose: Track all alert dispatches for effectiveness analysis and audit
-- Retention: 180 days
-- ============================================================================
CREATE TABLE IF NOT EXISTS alert_history (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  alert_type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
  component VARCHAR(100) NOT NULL,
  metric_value NUMERIC,
  threshold_value NUMERIC,
  message TEXT NOT NULL,
  delivery_status VARCHAR(20) DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  delivery_error TEXT,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for alert_history
CREATE INDEX IF NOT EXISTS idx_alert_history_timestamp 
  ON alert_history(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_alert_history_severity 
  ON alert_history(severity);

CREATE INDEX IF NOT EXISTS idx_alert_history_type 
  ON alert_history(alert_type);

CREATE INDEX IF NOT EXISTS idx_alert_unacknowledged 
  ON alert_history(acknowledged_at) 
  WHERE acknowledged_at IS NULL;

COMMENT ON TABLE alert_history IS 'Audit log of operational alerts for monitoring effectiveness analysis';


-- ============================================================================
-- Table: health_check_results
-- Purpose: Store periodic health check results for availability trending
-- Retention: 30 days
-- ============================================================================
CREATE TABLE IF NOT EXISTS health_check_results (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  overall_status VARCHAR(20) NOT NULL CHECK (overall_status IN ('healthy', 'degraded', 'unhealthy')),
  database_status BOOLEAN NOT NULL,
  database_latency_ms INTEGER,
  storage_status BOOLEAN NOT NULL,
  queues_status BOOLEAN NOT NULL,
  region VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for time-series queries
CREATE INDEX IF NOT EXISTS idx_health_timestamp 
  ON health_check_results(timestamp DESC);

COMMENT ON TABLE health_check_results IS 'Historical health check data for availability reporting and trend analysis';


-- ============================================================================
-- Verification Queries
-- ============================================================================
-- Verify all tables were created
DO $$
DECLARE
  tables_created INTEGER;
BEGIN
  SELECT COUNT(*) INTO tables_created
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('error_logs', 'metrics_summary', 'alert_history', 'health_check_results');
  
  IF tables_created = 4 THEN
    RAISE NOTICE 'SUCCESS: All 4 monitoring tables created';
  ELSE
    RAISE EXCEPTION 'FAILURE: Only % monitoring tables created', tables_created;
  END IF;
END $$;

-- Verify partitions were created
DO $$
DECLARE
  partitions_created INTEGER;
BEGIN
  SELECT COUNT(*) INTO partitions_created
  FROM pg_class
  WHERE relname LIKE 'metrics_summary_%'
    AND relkind = 'r';
  
  IF partitions_created >= 4 THEN
    RAISE NOTICE 'SUCCESS: % metrics_summary partitions created', partitions_created;
  ELSE
    RAISE EXCEPTION 'FAILURE: Only % partitions created, expected at least 4', partitions_created;
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- Post-Migration Notes
-- ============================================================================
-- 1. Monitor table sizes after deployment: 
--    SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename))
--    FROM pg_tables WHERE tablename LIKE '%error_logs%' OR tablename LIKE '%metrics%';
--
-- 2. Set up scheduled job for partition creation (monthly):
--    Add new partition 1 month ahead to prevent write failures
--
-- 3. Implement retention policies via scheduled cleanup job (see design doc)
--
-- 4. Consider ANALYZE after initial data population for query optimization:
--    ANALYZE error_logs; ANALYZE metrics_summary; ANALYZE alert_history;
-- ============================================================================
