/**
 * Migration Test Script - OTIF Sentinel Monitoring Schema
 * 
 * This script tests the monitoring database migration on a local/staging environment
 * before production deployment.
 * 
 * Usage:
 *   node migrations/test_migration.js [forward|rollback]
 * 
 * Requirements:
 *   - npm install pg (PostgreSQL client)
 *   - Database connection configured in wrangler.jsonc or environment
 */

import { Client } from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Configuration
// ============================================================================
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required; provide it through the environment or a secret manager');
}

const DB_CONFIG = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
};

const EXPECTED_TABLES = ['error_logs', 'metrics_summary', 'alert_history', 'health_check_results'];
const EXPECTED_INDEXES = [
  'idx_error_logs_timestamp',
  'idx_error_logs_severity',
  'idx_error_logs_tenant',
  'idx_error_logs_fingerprint',
  'idx_error_logs_trace_id',
  'idx_metrics_timestamp',
  'idx_metrics_name_time',
  'idx_metrics_tags',
  'idx_alert_history_timestamp',
  'idx_alert_history_severity',
  'idx_alert_history_type',
  'idx_alert_unacknowledged',
  'idx_health_timestamp'
];

// ============================================================================
// Utility Functions
// ============================================================================

function log(message, level = 'INFO') {
  const colors = {
    INFO: '\x1b[36m',    // Cyan
    SUCCESS: '\x1b[32m', // Green
    ERROR: '\x1b[31m',   // Red
    WARN: '\x1b[33m',    // Yellow
    RESET: '\x1b[0m'
  };
  
  const color = colors[level] || colors.INFO;
  const timestamp = new Date().toISOString();
  console.log(`${color}[${level}]${colors.RESET} ${timestamp} - ${message}`);
}

async function executeSQL(client, sqlFile, description) {
  log(`Executing: ${description}`, 'INFO');
  const sql = readFileSync(join(__dirname, sqlFile), 'utf-8');
  
  try {
    await client.query(sql);
    log(`✓ ${description} completed successfully`, 'SUCCESS');
    return true;
  } catch (error) {
    log(`✗ ${description} failed: ${error.message}`, 'ERROR');
    throw error;
  }
}

async function verifyTables(client) {
  log('Verifying table creation...', 'INFO');
  
  const result = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_name IN ($1, $2, $3, $4)
    ORDER BY table_name
  `, EXPECTED_TABLES);
  
  const foundTables = result.rows.map(r => r.table_name);
  
  if (foundTables.length === EXPECTED_TABLES.length) {
    log(`✓ All ${EXPECTED_TABLES.length} tables created: ${foundTables.join(', ')}`, 'SUCCESS');
    return true;
  } else {
    const missing = EXPECTED_TABLES.filter(t => !foundTables.includes(t));
    log(`✗ Missing tables: ${missing.join(', ')}`, 'ERROR');
    return false;
  }
}

async function verifyIndexes(client) {
  log('Verifying index creation...', 'INFO');
  
  const result = await client.query(`
    SELECT indexname 
    FROM pg_indexes 
    WHERE schemaname = 'public' 
      AND (
        indexname LIKE 'idx_error_logs_%' OR
        indexname LIKE 'idx_metrics_%' OR
        indexname LIKE 'idx_alert_%' OR
        indexname LIKE 'idx_health_%'
      )
    ORDER BY indexname
  `);
  
  const foundIndexes = result.rows.map(r => r.indexname);
  const missing = EXPECTED_INDEXES.filter(idx => !foundIndexes.includes(idx));
  
  if (missing.length === 0) {
    log(`✓ All ${EXPECTED_INDEXES.length} indexes created`, 'SUCCESS');
    return true;
  } else {
    log(`✗ Missing indexes (${missing.length}): ${missing.join(', ')}`, 'ERROR');
    return false;
  }
}

async function verifyPartitions(client) {
  log('Verifying partition creation...', 'INFO');
  
  const result = await client.query(`
    SELECT tablename 
    FROM pg_tables 
    WHERE schemaname = 'public' 
      AND tablename LIKE 'metrics_summary_%'
    ORDER BY tablename
  `);
  
  const partitions = result.rows.map(r => r.tablename);
  
  if (partitions.length >= 4) {
    log(`✓ Created ${partitions.length} partitions: ${partitions.join(', ')}`, 'SUCCESS');
    return true;
  } else {
    log(`✗ Expected at least 4 partitions, found ${partitions.length}`, 'ERROR');
    return false;
  }
}

async function testTableConstraints(client) {
  log('Testing table constraints...', 'INFO');
  
  try {
    // Test severity CHECK constraint in error_logs
    await client.query(`
      INSERT INTO error_logs (severity, error_type, error_message, error_fingerprint)
      VALUES ('INVALID', 'TestError', 'Test message', 'test123')
    `);
    log('✗ Severity constraint not working (accepted invalid value)', 'ERROR');
    return false;
  } catch (error) {
    if (error.message.includes('violates check constraint')) {
      log('✓ Severity constraint working correctly', 'SUCCESS');
    } else {
      log(`✗ Unexpected error testing constraints: ${error.message}`, 'ERROR');
      return false;
    }
  }
  
  try {
    // Test aggregation_type CHECK constraint in metrics_summary
    await client.query(`
      INSERT INTO metrics_summary (metric_name, metric_value, aggregation_type)
      VALUES ('test_metric', 100, 'invalid_agg')
    `);
    log('✗ Aggregation type constraint not working', 'ERROR');
    return false;
  } catch (error) {
    if (error.message.includes('violates check constraint')) {
      log('✓ Aggregation type constraint working correctly', 'SUCCESS');
    } else {
      log(`✗ Unexpected error: ${error.message}`, 'ERROR');
      return false;
    }
  }
  
  return true;
}

async function testBasicInserts(client) {
  log('Testing basic data insertion...', 'INFO');
  
  try {
    // Test error_logs insert
    await client.query(`
      INSERT INTO error_logs (severity, error_type, error_message, error_fingerprint, tenant_id)
      VALUES ('ERROR', 'TestError', 'Test error message', 'abc123', 'test-tenant')
    `);
    
    // Test metrics_summary insert
    await client.query(`
      INSERT INTO metrics_summary (metric_name, metric_value, aggregation_type, dimension_tags)
      VALUES ('http.request.duration', 250.5, 'avg', '{"endpoint": "/test", "status_code": 200}'::jsonb)
    `);
    
    // Test alert_history insert
    await client.query(`
      INSERT INTO alert_history (alert_type, severity, component, message)
      VALUES ('test_alert', 'WARN', 'test_component', 'Test alert message')
    `);
    
    // Test health_check_results insert
    await client.query(`
      INSERT INTO health_check_results (overall_status, database_status, storage_status, queues_status)
      VALUES ('healthy', true, true, true)
    `);
    
    log('✓ All basic inserts successful', 'SUCCESS');
    return true;
  } catch (error) {
    log(`✗ Insert test failed: ${error.message}`, 'ERROR');
    return false;
  }
}

async function cleanupTestData(client) {
  log('Cleaning up test data...', 'INFO');
  
  try {
    await client.query("DELETE FROM error_logs WHERE error_type = 'TestError'");
    await client.query("DELETE FROM metrics_summary WHERE metric_name = 'test_metric'");
    await client.query("DELETE FROM alert_history WHERE alert_type = 'test_alert'");
    await client.query("DELETE FROM health_check_results WHERE overall_status = 'healthy'");
    
    log('✓ Test data cleaned up', 'SUCCESS');
    return true;
  } catch (error) {
    log(`✗ Cleanup failed: ${error.message}`, 'WARN');
    return false;
  }
}

async function verifyTablesRemoved(client) {
  log('Verifying tables were removed...', 'INFO');
  
  const result = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_name IN ($1, $2, $3, $4)
  `, EXPECTED_TABLES);
  
  if (result.rows.length === 0) {
    log('✓ All monitoring tables successfully removed', 'SUCCESS');
    return true;
  } else {
    const remaining = result.rows.map(r => r.table_name);
    log(`✗ Tables still exist: ${remaining.join(', ')}`, 'ERROR');
    return false;
  }
}

// ============================================================================
// Main Test Functions
// ============================================================================

async function testForwardMigration(client) {
  log('========================================', 'INFO');
  log('TESTING FORWARD MIGRATION (001_monitoring_schema.sql)', 'INFO');
  log('========================================', 'INFO');
  
  const results = {
    migration: false,
    tables: false,
    indexes: false,
    partitions: false,
    constraints: false,
    inserts: false,
    cleanup: false
  };
  
  try {
    results.migration = await executeSQL(client, '001_monitoring_schema.sql', 'Forward Migration');
    results.tables = await verifyTables(client);
    results.indexes = await verifyIndexes(client);
    results.partitions = await verifyPartitions(client);
    results.constraints = await testTableConstraints(client);
    results.inserts = await testBasicInserts(client);
    results.cleanup = await cleanupTestData(client);
    
    const allPassed = Object.values(results).every(r => r === true);
    
    if (allPassed) {
      log('========================================', 'SUCCESS');
      log('✓ FORWARD MIGRATION TEST PASSED', 'SUCCESS');
      log('========================================', 'SUCCESS');
    } else {
      log('========================================', 'ERROR');
      log('✗ FORWARD MIGRATION TEST FAILED', 'ERROR');
      log('Failed checks: ' + Object.entries(results)
        .filter(([_, passed]) => !passed)
        .map(([name]) => name)
        .join(', '), 'ERROR');
      log('========================================', 'ERROR');
    }
    
    return allPassed;
  } catch (error) {
    log(`Migration test failed with error: ${error.message}`, 'ERROR');
    return false;
  }
}

async function testRollback(client) {
  log('========================================', 'INFO');
  log('TESTING ROLLBACK MIGRATION (001_rollback.sql)', 'INFO');
  log('========================================', 'INFO');
  
  try {
    await executeSQL(client, '001_rollback.sql', 'Rollback Migration');
    const tablesRemoved = await verifyTablesRemoved(client);
    
    if (tablesRemoved) {
      log('========================================', 'SUCCESS');
      log('✓ ROLLBACK MIGRATION TEST PASSED', 'SUCCESS');
      log('========================================', 'SUCCESS');
    } else {
      log('========================================', 'ERROR');
      log('✗ ROLLBACK MIGRATION TEST FAILED', 'ERROR');
      log('========================================', 'ERROR');
    }
    
    return tablesRemoved;
  } catch (error) {
    log(`Rollback test failed with error: ${error.message}`, 'ERROR');
    return false;
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  const mode = process.argv[2] || 'forward';
  
  if (!['forward', 'rollback', 'both'].includes(mode)) {
    console.error('Usage: node test_migration.js [forward|rollback|both]');
    process.exit(1);
  }
  
  const client = new Client(DB_CONFIG);
  
  try {
    log('Connecting to database...', 'INFO');
    await client.connect();
    log('✓ Database connected', 'SUCCESS');
    
    let success = true;
    
    if (mode === 'forward' || mode === 'both') {
      success = await testForwardMigration(client) && success;
    }
    
    if (mode === 'rollback' || mode === 'both') {
      success = await testRollback(client) && success;
    }
    
    if (mode === 'both' && success) {
      log('\n========================================', 'SUCCESS');
      log('✓ COMPLETE MIGRATION TEST CYCLE PASSED', 'SUCCESS');
      log('Forward and rollback migrations working correctly', 'SUCCESS');
      log('========================================', 'SUCCESS');
    }
    
    process.exit(success ? 0 : 1);
  } catch (error) {
    log(`Fatal error: ${error.message}`, 'ERROR');
    console.error(error);
    process.exit(1);
  } finally {
    await client.end();
    log('Database connection closed', 'INFO');
  }
}

main();
