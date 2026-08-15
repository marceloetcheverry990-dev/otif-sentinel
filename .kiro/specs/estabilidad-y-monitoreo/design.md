# Technical Design Document: Stability and Monitoring System

## Overview

### Purpose
The Stability and Monitoring System (SMS) provides comprehensive observability infrastructure for the Lead Rescue Pipeline (OTIF Sentinel), a Cloudflare Workers-based logistics platform. This system transforms the platform from a development-grade service into a production-ready system with real-time health monitoring, structured logging, error tracking, performance metrics, operational alerting, and visual dashboards.

### Business Context

The logistics platform currently operates without foundational observability infrastructure, creating critical operational risks:
- **Blind spots**: No visibility into system health or component failures until user reports
- **Debugging delays**: Unstructured logs make production issue investigation time-consuming
- **Reactive operations**: No alerting mechanism forces reactive incident response
- **Performance uncertainty**: Limited metrics prevent proactive optimization and capacity planning
- **Cost inefficiency**: Lack of monitoring data prevents cost-benefit analysis and resource optimization

The monitoring system addresses these gaps by implementing production-grade observability that enables proactive issue detection, rapid incident resolution, and data-driven operational decisions.

### Scope

**In Scope:**
- Health check endpoints for system status verification
- Structured logging infrastructure with JSON formatting and severity levels
- Error tracking and aggregation with contextual capture
- Performance metrics collection for response times, throughput, and resource usage
- Operational alerting via Telegram for critical system issues
- Visual monitoring dashboard for real-time system health display
- Monitoring data persistence with retention policies
- Integration with existing PostgreSQL (Hyperdrive), R2 storage, and Cloudflare Queues
- Cost optimization through sampling, batching, and intelligent caching
- Security controls for authentication, sanitization, and tenant isolation

**Out of Scope:**
- Third-party APM service integration (Datadog, New Relic, Sentry)
- Custom log shipping to external SIEM systems
- Advanced analytics and machine learning for anomaly detection
- Custom alerting rules engine (initial release uses predefined thresholds)
- Multi-region distributed tracing
- Client-side performance monitoring (RUM)

### Design Principles

1. **Zero Disruption**: Monitoring infrastructure must not break existing functionality
2. **Minimal Performance Impact**: Use asynchronous operations, batching, and sampling to avoid request latency degradation
3. **Cost Awareness**: Stay within Cloudflare free tier limits through intelligent sampling and aggregation
4. **Fail-Safe**: Monitoring failures must not crash application operations (graceful degradation)
5. **Tenant Isolation**: Maintain strict multi-tenant data separation across all monitoring components

## Architecture

### System Overview

The monitoring system follows a **non-invasive middleware pattern** that wraps existing components without requiring architectural changes. The system consists of six core components orchestrated by a central monitoring module:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  Monitoring Layer                          │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │  │
│  │  │  Health  │ │ Str. Log │ │  Error   │ │   Metrics    │ │  │
│  │  │  Check   │ │  Logger  │ │ Tracker  │ │  Collector   │ │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘ │  │
│  │  ┌──────────────────┐ ┌─────────────────────────────────┐ │  │
│  │  │ Alert Manager    │ │    Dashboard Renderer          │ │  │
│  │  └──────────────────┘ └─────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│  ┌───────────────────────────┼───────────────────────────────┐  │
│  │      Application Layer (Wrapped by Monitoring)            │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────────────────┐ │  │
│  │  │  Request   │ │   Queue    │ │   Scheduled Jobs       │ │  │
│  │  │  Handlers  │ │ Processors │ │    (Cron)              │ │  │
│  │  └────────────┘ └────────────┘ └────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │
    ┌────────────────────────┼────────────────────────────────┐
    │                   External Systems                      │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐│
    │  │PostgreSQL│  │    R2    │  │  Queues  │  │ Telegram││
    │  │(Hyperdrive)  │  Bucket  │  │ (3 types)│  │   API   ││
    │  └──────────┘  └──────────┘  └──────────┘  └─────────┘│
    └──────────────────────────────────────────────────────────┘
```

### Component Integration Strategy


**1. Middleware Wrapper Pattern**
- Monitoring wraps existing request handlers, queue processors, and scheduled jobs
- Original code remains unchanged - monitoring is injected at the entry points
- Example: `wrapHandler(existingHandler, { component: 'wms-webhook' })`

**2. Database Integration**
- Uses existing `CONFIG.DB_OPTS(env)` for Hyperdrive connection pooling
- Creates dedicated monitoring tables (non-intrusive schema additions)
- Uses existing `safeRollback()` and `classifyError()` patterns for consistency

**3. Queue Integration**
- Instruments existing queue processors (`processIngestionQueue`, `processEnrichmentQueue`, `processDeliveryQueue`)
- Captures processing metrics without modifying queue logic
- Monitors Dead Letter Queue through existing `dead_letter_events` table

**4. Circuit Breaker Integration**
- Monitors existing circuit breaker state in `system_flags` table
- Tracks `openai_breaker` and `tg_breaker_*` state transitions
- Alerts on prolonged circuit open conditions

**5. Alert Delivery Integration**
- Uses existing Telegram integration pattern from `telegram.js`
- Reuses `env.TG_BOT_TOKEN` and `env.SALES_TEAM_CHAT_ID`
- Creates dedicated operations channel option without breaking sales alerts

### Data Flow

**Request Monitoring Flow:**
```
HTTP Request → Monitoring Middleware (start timer) → Original Handler → 
→ Monitoring Middleware (log result, record metrics) → HTTP Response
```

**Error Capture Flow:**
```
Exception → Error Tracker → [Sanitize] → PostgreSQL (error_logs) → 
→ Alert Manager (if threshold exceeded) → Telegram
```

**Metrics Collection Flow:**
```
Operation Complete → Metrics Collector → [Sample/Batch] → 
→ PostgreSQL (metrics_summary) OR Analytics Engine (if available)
```

**Health Check Flow:**
```
GET /health → Check DB → Check R2 → Check Queues → 
→ Aggregate Status → JSON Response (200 or 503)
```


## Components and Interfaces

### 1. Health Check Service

**Purpose**: Verify operational status of critical system components and provide standardized health endpoint for external monitoring tools.

**Module**: `src/monitoring/health.js`

**Public Interface**:
```javascript
/**
 * Health check handler for /health endpoint
 * @param {Request} request - Incoming HTTP request
 * @param {Env} env - Worker environment bindings
 * @returns {Response} - JSON health status (200 OK or 503 Service Unavailable)
 */
export async function handleHealthCheck(request, env)

/**
 * Check individual component health (internal)
 * @param {Env} env - Worker environment bindings
 * @returns {Object} - { database: bool, storage: bool, queues: bool }
 */
async function checkComponents(env)
```

**Health Check Logic**:
1. **Database Check**: Execute `SELECT 1` with 200ms timeout
2. **R2 Storage Check**: Attempt bucket.head() operation
3. **Queue Check**: Verify env.MAIN_QUEUE binding exists
4. **Response Format**:
```json
{
  "status": "healthy|degraded|unhealthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "service": "otif-sentinel",
  "version": "8.0.0",
  "region": "auto",
  "components": {
    "database": { "status": "connected", "latency_ms": 45 },
    "storage": { "status": "accessible" },
    "queues": { "status": "available" }
  }
}
```

**Caching Strategy**: Cache results for 10 seconds using in-memory Map to reduce redundant checks.


### 2. Structured Logger

**Purpose**: Provide consistent, machine-parsable JSON logs with severity levels and contextual metadata.

**Module**: `src/monitoring/logger.js`

**Public Interface**:
```javascript
/**
 * Structured logger instance
 */
export const Logger = {
  debug(message, context = {}),
  info(message, context = {}),
  warn(message, context = {}),
  error(message, context = {}, error = null),
  critical(message, context = {}, error = null)
}

/**
 * Create request-scoped logger with trace_id
 * @param {string} traceId - Correlation ID
 * @param {Object} baseContext - Base context (tenant_id, etc.)
 * @returns {Object} - Scoped logger instance
 */
export function createRequestLogger(traceId, baseContext = {})
```

**Log Entry Format**:
```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "ERROR",
  "message": "Database query timeout",
  "trace_id": "abc123",
  "tenant_id": "acme-corp",
  "service": "otif-sentinel",
  "component": "queue-processor",
  "context": {
    "ot_id": "OT-12345",
    "queue": "ENRICHMENT_QUEUE",
    "retry_count": 3
  },
  "error": {
    "type": "TimeoutError",
    "message": "Query exceeded 5000ms",
    "stack": "..."
  },
  "duration_ms": 5234
}
```

**Sanitization Rules**:
- Redact `Authorization`, `Cookie`, `X-API-Key` headers
- Mask credit card patterns (Luhn algorithm validation)
- Remove email addresses and phone numbers from error messages
- Escape control characters to prevent log injection


### 3. Error Tracker

**Purpose**: Automatically capture, aggregate, and analyze application errors with full contextual information.

**Module**: `src/monitoring/errors.js`

**Public Interface**:
```javascript
/**
 * Capture and persist error
 * @param {Error} error - Exception object
 * @param {Object} context - Contextual metadata
 * @param {Client} dbClient - Optional DB client (for transactions)
 * @returns {Promise<string>} - Error fingerprint ID
 */
export async function captureError(error, context = {}, dbClient = null)

/**
 * Get error aggregation statistics
 * @param {Object} filters - { timeRange, severity, tenant_id, endpoint }
 * @param {Env} env - Worker environment
 * @returns {Promise<Array>} - Aggregated error stats
 */
export async function getErrorStats(filters, env)
```

**Error Fingerprinting**: 
- Combine: `error.name` + normalized `error.message` (parameters removed) + first 3 stack frames
- Hash using SHA-256 to create fingerprint
- Group errors by fingerprint for occurrence counting

**Severity Classification**:
- **INFO**: Handled business errors (validation failures)
- **WARN**: Recoverable errors (retry succeeded)
- **ERROR**: Operation failures (database timeout)
- **CRITICAL**: System failures (worker crash, memory exhaustion)

**Integration Points**:
- Wraps existing `classifyError()` function to enhance classification
- Stores errors asynchronously using `ctx.waitUntil()` to avoid blocking
- Integrates with Alert Manager for threshold-based notifications


### 4. Metrics Collector

**Purpose**: Gather quantitative performance measurements for response times, throughput, and resource usage.

**Module**: `src/monitoring/metrics.js`

**Public Interface**:
```javascript
/**
 * Record metric data point
 * @param {string} metricName - Metric identifier (e.g., 'http.request.duration')
 * @param {number} value - Metric value
 * @param {Object} tags - Dimension tags { endpoint, tenant_id, status_code }
 * @param {Env} env - Worker environment
 */
export async function recordMetric(metricName, value, tags = {}, env)

/**
 * Timer utility for measuring operation duration
 * @returns {Object} - { stop: () => number } - Returns duration in ms
 */
export function startTimer()

/**
 * Middleware wrapper that automatically captures request metrics
 * @param {Function} handler - Original request handler
 * @param {Object} config - { component: string }
 * @returns {Function} - Wrapped handler
 */
export function withMetrics(handler, config = {})
```

**Metric Types**:

| Metric Name | Type | Unit | Description |
|------------|------|------|-------------|
| `http.request.duration` | Histogram | ms | Request response time |
| `http.request.count` | Counter | count | Total requests |
| `http.error.rate` | Gauge | % | Error rate per endpoint |
| `db.query.duration` | Histogram | ms | Database query time |
| `queue.processing.latency` | Histogram | ms | Queue message processing time |
| `queue.throughput` | Counter | msg/min | Messages processed per minute |
| `circuit_breaker.activations` | Counter | count | Circuit breaker open events |
| `dlq.message.count` | Gauge | count | Dead letter queue depth |

**Aggregation Strategy**:
- Batch writes: Accumulate up to 100 data points before INSERT
- Calculate percentiles (p50, p95, p99) in-memory before persistence
- Use Analytics Engine if available, PostgreSQL as fallback


### 5. Alert Manager

**Purpose**: Evaluate alert conditions and dispatch real-time notifications for critical operational issues.

**Module**: `src/monitoring/alerts.js`

**Public Interface**:
```javascript
/**
 * Evaluate alert conditions and dispatch if triggered
 * @param {Env} env - Worker environment
 * @param {ExecutionContext} ctx - Execution context
 */
export async function evaluateAlerts(env, ctx)

/**
 * Send alert notification via Telegram
 * @param {Object} alert - { type, severity, component, message, value, threshold }
 * @param {Env} env - Worker environment
 */
async function sendAlert(alert, env)
```

**Alert Definitions**:

| Alert Type | Condition | Severity | Action |
|-----------|-----------|----------|--------|
| Database Connectivity | Connection failed > 30s | CRITICAL | Immediate notification |
| High Error Rate | Error rate > 5% over 5min | ERROR | Notification + investigation link |
| Slow Response Time | p95 > 3000ms over 5min | WARN | Performance analysis prompt |
| Queue Backlog | Latency > 10min | ERROR | Capacity scaling recommendation |
| Circuit Breaker Open | Open > 10min | WARN | External service status check |
| Dead Letter Queue | Count > 100 | ERROR | Manual intervention required |
| R2 Storage Failure | Operations failed > 5min | ERROR | Storage system check |

**Deduplication Strategy**:
- Track sent alerts in memory Map: `alertKey → lastSentTimestamp`
- Suppress duplicate alerts within 15-minute window
- Reset suppression on severity escalation (WARN → ERROR → CRITICAL)

**Telegram Message Format**:
```
🚨 **CRITICAL ALERT: Database Connectivity**
━━━━━━━━━━━━━━━━━━
⚠️ **Component**: PostgreSQL (Hyperdrive)
📊 **Metric**: Connection failures
🔢 **Current Value**: 100% failure rate
📈 **Threshold**: > 30 seconds

⏰ **Duration**: 2 minutes
🔗 **Dashboard**: https://admin.otif-sentinel.com/dashboard
🆔 **Trace ID**: abc-123-def

**Recommended Action**:
Check Hyperdrive configuration and PostgreSQL availability.
```


### 6. System Dashboard

**Purpose**: Visual interface displaying system health metrics, performance indicators, and operational status.

**Module**: `src/monitoring/dashboard.js`

**Public Interface**:
```javascript
/**
 * Render HTML dashboard
 * @param {Request} request - HTTP request with optional filters
 * @param {Env} env - Worker environment
 * @returns {Response} - HTML page with auto-refresh
 */
export async function renderDashboard(request, env)

/**
 * API endpoint for dashboard data (JSON)
 * @param {Request} request - HTTP request with filters
 * @param {Env} env - Worker environment
 * @returns {Response} - JSON data for client-side rendering
 */
export async function getDashboardData(request, env)
```

**Dashboard Sections**:

1. **System Health Summary**
   - Overall status indicator (green/yellow/red)
   - Component status grid (DB, R2, Queues, Circuit Breakers)
   - Last health check timestamp

2. **Performance Metrics**
   - Average response time (current hour)
   - Requests per minute
   - Error rate percentage
   - Queue processing rates (3 queues)

3. **Recent Errors Panel**
   - Last 10 errors with timestamp, type, endpoint
   - Error count by severity (pie chart using Chart.js)
   - Link to full error details

4. **Queue Status**
   - Pending message counts per queue
   - Average processing latency
   - Dead Letter Queue depth with alert indicator

5. **Circuit Breaker Status**
   - Current state (OPEN/CLOSED) for each external service
   - Activation count (last 24 hours)
   - Last state change timestamp

**Auto-Refresh**: JavaScript `setInterval()` refreshes data every 30 seconds via `/api/dashboard/data` endpoint.

**Authentication**: Validates JWT token from request header or uses HTTP Basic Auth with credentials from environment variables.


## Data Models

### Database Schema Design

The monitoring system adds four new tables to the existing PostgreSQL database without modifying current tables. All tables follow the established pattern of including `tenant_id` for multi-tenant isolation.

### Table: `error_logs`

**Purpose**: Store captured errors with full contextual information for analysis and debugging.

```sql
CREATE TABLE error_logs (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
  error_type VARCHAR(255) NOT NULL,
  error_message TEXT NOT NULL,
  error_fingerprint VARCHAR(64) NOT NULL, -- SHA-256 hash for grouping
  stack_trace TEXT,
  trace_id VARCHAR(100),
  tenant_id VARCHAR(100),
  endpoint VARCHAR(500),
  http_method VARCHAR(10),
  context_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX idx_error_logs_timestamp ON error_logs(timestamp DESC);
CREATE INDEX idx_error_logs_severity ON error_logs(severity);
CREATE INDEX idx_error_logs_tenant ON error_logs(tenant_id, timestamp DESC);
CREATE INDEX idx_error_logs_fingerprint ON error_logs(error_fingerprint);
CREATE INDEX idx_error_logs_trace_id ON error_logs(trace_id);
```

**Sample Data**:
```json
{
  "id": 1001,
  "timestamp": "2024-01-15T10:30:45.123Z",
  "severity": "ERROR",
  "error_type": "TimeoutError",
  "error_message": "Database query exceeded timeout",
  "error_fingerprint": "a3f5c2b...",
  "stack_trace": "at processEnrichmentQueue...",
  "trace_id": "req_abc123",
  "tenant_id": "acme-corp",
  "endpoint": "/wms-webhook",
  "http_method": "POST",
  "context_metadata": {
    "ot_id": "OT-12345",
    "retry_count": 3,
    "queue": "ENRICHMENT_QUEUE"
  }
}
```


### Table: `metrics_summary`

**Purpose**: Store aggregated performance metrics with time-series data for trend analysis.

```sql
CREATE TABLE metrics_summary (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metric_name VARCHAR(100) NOT NULL,
  metric_value NUMERIC NOT NULL,
  metric_unit VARCHAR(20), -- 'ms', 'count', '%', 'msg/min'
  aggregation_type VARCHAR(20) NOT NULL, -- 'avg', 'sum', 'count', 'p50', 'p95', 'p99'
  dimension_tags JSONB, -- { endpoint, tenant_id, status_code, queue_name }
  sample_count INTEGER, -- Number of samples aggregated
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (timestamp);

-- Partition by month for efficient retention management
CREATE TABLE metrics_summary_2024_01 PARTITION OF metrics_summary
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE metrics_summary_2024_02 PARTITION OF metrics_summary
  FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
-- Additional partitions created automatically

-- Indexes
CREATE INDEX idx_metrics_timestamp ON metrics_summary(timestamp DESC);
CREATE INDEX idx_metrics_name_time ON metrics_summary(metric_name, timestamp DESC);
CREATE INDEX idx_metrics_tags ON metrics_summary USING GIN (dimension_tags);
```

**Sample Data**:
```json
{
  "id": 5001,
  "timestamp": "2024-01-15T10:00:00Z",
  "metric_name": "http.request.duration",
  "metric_value": 245.5,
  "metric_unit": "ms",
  "aggregation_type": "p95",
  "dimension_tags": {
    "endpoint": "/wms-webhook",
    "tenant_id": "acme-corp",
    "status_code": 200
  },
  "sample_count": 150
}
```


### Table: `alert_history`

**Purpose**: Track all alert dispatches for effectiveness analysis and audit trail.

```sql
CREATE TABLE alert_history (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  alert_type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
  component VARCHAR(100) NOT NULL,
  metric_value NUMERIC,
  threshold_value NUMERIC,
  message TEXT NOT NULL,
  delivery_status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'sent', 'failed'
  delivery_error TEXT,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_alert_history_timestamp ON alert_history(timestamp DESC);
CREATE INDEX idx_alert_history_severity ON alert_history(severity);
CREATE INDEX idx_alert_history_type ON alert_history(alert_type);
CREATE INDEX idx_alert_unacknowledged ON alert_history(acknowledged_at) WHERE acknowledged_at IS NULL;
```

### Table: `health_check_results`

**Purpose**: Store periodic health check results for availability trending.

```sql
CREATE TABLE health_check_results (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  overall_status VARCHAR(20) NOT NULL, -- 'healthy', 'degraded', 'unhealthy'
  database_status BOOLEAN NOT NULL,
  database_latency_ms INTEGER,
  storage_status BOOLEAN NOT NULL,
  queues_status BOOLEAN NOT NULL,
  region VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for time-series queries
CREATE INDEX idx_health_timestamp ON health_check_results(timestamp DESC);
```

### Data Retention Policies

Implemented via scheduled job (daily at 02:00 UTC):

```sql
-- error_logs: 90 days retention
DELETE FROM error_logs WHERE timestamp < NOW() - INTERVAL '90 days';

-- metrics_summary: 365 days retention (drop old partitions)
DROP TABLE IF EXISTS metrics_summary_2023_01;

-- alert_history: 180 days retention
DELETE FROM alert_history WHERE timestamp < NOW() - INTERVAL '180 days';

-- health_check_results: 30 days retention
DELETE FROM health_check_results WHERE timestamp < NOW() - INTERVAL '30 days';
```


### Migration Strategy

**Phase 1: Initial Schema Creation**
```sql
-- Run during deployment window (low traffic period)
BEGIN;
  -- Create tables (commands above)
  -- Create indexes
  -- Create partitions for current and next 3 months
COMMIT;
```

**Phase 2: Backfill Historical Data** (Optional)
- Extract recent errors from existing `ot_events` table
- Populate `error_logs` with classification
- No backfill for metrics (start fresh)

**Phase 3: Enable Monitoring**
- Deploy monitoring code (feature flag controlled)
- Start capturing new data
- Monitor monitoring system resource usage

### Tenant Isolation in Data Models

All monitoring tables respect multi-tenant architecture:
- `tenant_id` column included where applicable
- All queries filter by `tenant_id` when in tenant context
- Dashboard provides tenant-filtered views
- Cross-tenant queries only allowed for platform administrators


## API Endpoints

The monitoring system exposes three primary HTTP endpoints following the existing CORS and routing patterns.

### Endpoint: Health Check

**Route**: `GET /health` or `GET /api/health`

**Purpose**: System health verification for load balancers and monitoring tools.

**Authentication**: None (public endpoint for monitoring)

**Request**: No body or parameters required

**Response**:
```json
// Success (200 OK)
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "service": "otif-sentinel",
  "version": "8.0.0",
  "region": "auto",
  "components": {
    "database": {
      "status": "connected",
      "latency_ms": 45
    },
    "storage": {
      "status": "accessible"
    },
    "queues": {
      "status": "available",
      "bindings": ["MAIN_QUEUE", "ENRICHMENT_QUEUE", "DELIVERY_QUEUE"]
    }
  },
  "uptime_seconds": 3600
}

// Degraded (503 Service Unavailable)
{
  "status": "unhealthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "service": "otif-sentinel",
  "version": "8.0.0",
  "components": {
    "database": {
      "status": "disconnected",
      "error": "Connection timeout after 200ms"
    },
    "storage": {
      "status": "accessible"
    },
    "queues": {
      "status": "available"
    }
  }
}
```

**Rate Limiting**: 60 requests per minute per IP address

**Integration**: Add to `index.js` router:
```javascript
if (request.method === "GET" && url.pathname === "/health") {
  return handleHealthCheck(request, env);
}
```


### Endpoint: Dashboard UI

**Route**: `GET /dashboard/monitoring`

**Purpose**: Human-readable HTML dashboard for operations team.

**Authentication**: Required (JWT token or HTTP Basic Auth)

**Query Parameters**:
- `timeRange`: `1h`, `24h`, `7d` (default: `1h`)
- `tenant`: Tenant ID filter (optional, admin only)

**Response**: HTML page with embedded CSS and JavaScript

**Headers**:
```
Content-Type: text/html; charset=utf-8
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'
X-Frame-Options: DENY
```

**Integration**:
```javascript
if (request.method === "GET" && url.pathname === "/dashboard/monitoring") {
  return renderDashboard(request, env);
}
```

### Endpoint: Dashboard Data API

**Route**: `GET /api/dashboard/data`

**Purpose**: JSON API for dashboard auto-refresh and external integrations.

**Authentication**: Required (same as Dashboard UI)

**Query Parameters**:
- `timeRange`: `1h`, `24h`, `7d` (default: `1h`)
- `tenant`: Tenant ID filter (optional)

**Response**:
```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "health": {
    "status": "healthy",
    "components": { /* same as /health */ }
  },
  "metrics": {
    "avg_response_time_ms": 245,
    "requests_per_minute": 120,
    "error_rate_percent": 0.8,
    "queues": {
      "MAIN_QUEUE": { "pending": 5, "rate": 50, "avg_latency_ms": 1200 },
      "ENRICHMENT_QUEUE": { "pending": 12, "rate": 30, "avg_latency_ms": 3400 },
      "DELIVERY_QUEUE": { "pending": 3, "rate": 25, "avg_latency_ms": 850 }
    }
  },
  "recent_errors": [
    {
      "timestamp": "2024-01-15T10:29:30Z",
      "severity": "ERROR",
      "type": "TimeoutError",
      "message": "Database query timeout",
      "endpoint": "/wms-webhook",
      "trace_id": "req_abc123"
    }
  ],
  "circuit_breakers": {
    "openai_breaker": { "state": "CLOSED", "last_change": "2024-01-15T09:15:00Z", "activations_24h": 2 },
    "tg_breaker": { "state": "OPEN", "last_change": "2024-01-15T10:25:00Z", "activations_24h": 5 }
  },
  "dead_letter_queue": {
    "count": 23,
    "alert_threshold": 100
  }
}
```


## Implementation Strategy

### Phase 1: Core Infrastructure (Week 1)

**Goal**: Establish foundational monitoring without breaking existing functionality.

**Tasks**:
1. Create monitoring module structure:
   - `src/monitoring/config.js` - Configuration constants
   - `src/monitoring/logger.js` - Structured logger
   - `src/monitoring/health.js` - Health check
   - `src/monitoring/index.js` - Export all components

2. Database schema setup:
   - Create tables via migration script
   - Add indexes
   - Test on staging environment

3. Health check integration:
   - Add `/health` route to `index.js`
   - Implement basic checks (DB, R2, Queues)
   - Test with external monitoring tool (UptimeRobot, Pingdom)

4. Structured logging foundation:
   - Replace critical `console.log` calls with `Logger.info()`
   - Test log output format in Cloudflare dashboard
   - Verify sensitive data sanitization

**Validation Criteria**:
- Health endpoint returns 200 when all components healthy
- Logs appear in JSON format with required fields
- No increase in error rate or latency
- Existing functionality unaffected


### Phase 2: Error Tracking and Metrics (Week 2)

**Goal**: Capture errors and performance metrics without impacting response times.

**Tasks**:
1. Error tracker implementation:
   - `src/monitoring/errors.js` - Error capture and persistence
   - Wrap critical sections with try-catch + captureError
   - Test error fingerprinting logic
   - Verify async storage using `ctx.waitUntil()`

2. Metrics collector implementation:
   - `src/monitoring/metrics.js` - Metric recording and batching
   - Create `withMetrics()` middleware wrapper
   - Wrap HTTP handlers in `index.js`
   - Implement batching (100 data points before write)

3. Queue processor instrumentation:
   - Wrap `processIngestionQueue`, `processEnrichmentQueue`, `processDeliveryQueue`
   - Capture processing latency and throughput
   - Monitor Dead Letter Queue depth

**Validation Criteria**:
- Errors appear in `error_logs` table with correct fingerprints
- Metrics batching reduces database writes by 95%
- No observable latency increase in request handling
- Error rate remains stable during rollout


### Phase 3: Alerting and Dashboard (Week 3)

**Goal**: Enable proactive monitoring through alerts and visual dashboard.

**Tasks**:
1. Alert manager implementation:
   - `src/monitoring/alerts.js` - Alert evaluation and dispatch
   - Add `evaluateAlerts()` to cron job in `index.js`
   - Configure Telegram channel for operations alerts
   - Implement deduplication logic

2. Dashboard implementation:
   - `src/monitoring/dashboard.js` - HTML generation and data API
   - Add `/dashboard/monitoring` route
   - Implement authentication middleware
   - Add auto-refresh JavaScript

3. Integration testing:
   - Trigger test alerts by simulating conditions
   - Verify dashboard displays real-time data
   - Load test dashboard endpoint (100 concurrent users)
   - Validate tenant isolation in multi-tenant views

**Validation Criteria**:
- Alerts delivered to Telegram within 60 seconds of condition trigger
- Dashboard loads in < 2 seconds with 1-hour data
- No duplicate alerts sent within 15-minute window
- Dashboard authentication prevents unauthorized access


### Phase 4: Optimization and Documentation (Week 4)

**Goal**: Optimize resource usage and provide operational documentation.

**Tasks**:
1. Performance optimization:
   - Implement sampling (10% of successful requests)
   - Optimize batch sizes based on production traffic patterns
   - Add caching for health checks and dashboard queries
   - Tune database indexes based on query patterns

2. Cost optimization:
   - Measure actual resource usage (CPU time, database connections, storage)
   - Adjust retention policies if storage grows too fast
   - Implement adaptive sampling (reduce under high load)

3. Documentation:
   - Alert runbooks for each alert type
   - Deployment guide with migration scripts
   - Troubleshooting guide for common issues
   - Architecture diagram and data flow documentation

4. Monitoring the monitoring system:
   - Add meta-health endpoint `/health/monitoring`
   - Track monitoring system error rate
   - Implement graceful degradation (fallback to console logs)

**Validation Criteria**:
- Worker CPU time increase < 5% after monitoring enabled
- Database storage growth < 100MB per month
- All alert types have documented runbooks
- Monitoring system errors do not crash application


### Middleware Wrapper Pattern

The monitoring system uses a non-invasive wrapper pattern to integrate with existing code:

**Request Handler Wrapper**:
```javascript
// src/monitoring/middleware.js
export function withMonitoring(handler, config = {}) {
  return async function wrappedHandler(request, env, ctx) {
    const timer = startTimer();
    const traceId = crypto.randomUUID();
    const logger = createRequestLogger(traceId, { component: config.component });
    
    try {
      logger.info('Request started', {
        method: request.method,
        url: request.url
      });
      
      const response = await handler(request, env, ctx);
      const duration = timer.stop();
      
      // Record metrics asynchronously
      ctx.waitUntil(
        recordMetric('http.request.duration', duration, {
          endpoint: config.component,
          status_code: response.status
        }, env)
      );
      
      logger.info('Request completed', { status: response.status, duration_ms: duration });
      return response;
      
    } catch (error) {
      const duration = timer.stop();
      logger.error('Request failed', { duration_ms: duration }, error);
      
      // Capture error asynchronously
      ctx.waitUntil(
        captureError(error, {
          endpoint: config.component,
          method: request.method,
          trace_id: traceId
        }, null)
      );
      
      throw error; // Re-throw to maintain existing error handling
    }
  };
}
```

**Integration Example**:
```javascript
// In index.js - Before
if (request.method === "POST" && url.pathname === "/wms-webhook") {
  return handleWMSWebhook(request, env, ctx);
}

// In index.js - After (no change to existing code)
if (request.method === "POST" && url.pathname === "/wms-webhook") {
  return withMonitoring(handleWMSWebhook, { component: 'wms-webhook' })(request, env, ctx);
}
```


### Configuration Management

All monitoring configuration centralized in `src/monitoring/config.js`:

```javascript
export const MONITORING_CONFIG = {
  // Feature flags
  ENABLED: true,
  ERROR_TRACKING_ENABLED: true,
  METRICS_COLLECTION_ENABLED: true,
  ALERTING_ENABLED: true,
  
  // Sampling rates (0.0 to 1.0)
  METRICS_SAMPLE_RATE: 0.1, // 10% of successful requests
  ERROR_SAMPLE_RATE: 1.0,   // 100% of errors
  
  // Batching thresholds
  METRICS_BATCH_SIZE: 100,
  ERROR_BATCH_SIZE: 50,
  
  // Alert thresholds
  ALERT_THRESHOLDS: {
    ERROR_RATE_PERCENT: 5,
    RESPONSE_TIME_P95_MS: 3000,
    QUEUE_LATENCY_MINUTES: 10,
    CIRCUIT_BREAKER_OPEN_MINUTES: 10,
    DLQ_MESSAGE_COUNT: 100
  },
  
  // Alert deduplication window (milliseconds)
  ALERT_DEDUP_WINDOW_MS: 15 * 60 * 1000, // 15 minutes
  
  // Health check cache duration (milliseconds)
  HEALTH_CHECK_CACHE_MS: 10000, // 10 seconds
  
  // Data retention periods (days)
  RETENTION: {
    ERROR_LOGS_DAYS: 90,
    METRICS_DAYS: 365,
    ALERT_HISTORY_DAYS: 180,
    HEALTH_CHECKS_DAYS: 30
  },
  
  // Dashboard configuration
  DASHBOARD: {
    AUTO_REFRESH_INTERVAL_MS: 30000, // 30 seconds
    DEFAULT_TIME_RANGE: '1h',
    AUTH_REQUIRED: true
  }
};
```

This configuration allows feature toggles and threshold tuning without code changes.


## Error Handling

The monitoring system must never crash the application. All monitoring operations implement defense-in-depth error handling.

### Graceful Degradation Strategy

**Principle**: Monitoring failures should log warnings but not throw exceptions that crash request handling.

**Implementation Layers**:

1. **Try-Catch Wrappers**: All monitoring functions wrapped in try-catch
2. **Circuit Breaker for Monitoring**: If monitoring DB writes fail 5 consecutive times, disable DB writes and fall back to console logging
3. **Timeouts**: All monitoring operations have strict timeouts (1000ms for DB queries)
4. **Async Operations**: Use `ctx.waitUntil()` to prevent blocking request responses

### Error Handling Patterns

**Pattern 1: Database Write Failure**
```javascript
async function recordMetric(metricName, value, tags, env) {
  try {
    // Attempt database write
    await writeMetricToDB(metricName, value, tags, env);
  } catch (error) {
    // Fallback: log to console
    console.warn('[MONITORING_DB_FAIL]', {
      metric: metricName,
      value,
      error: error.message
    });
    
    // Increment monitoring error counter
    monitoringErrorCount++;
    
    // If too many failures, activate circuit breaker
    if (monitoringErrorCount > 5) {
      monitoringCircuitOpen = true;
      console.error('[MONITORING_CIRCUIT_OPEN] Disabling database writes');
    }
  }
}
```


**Pattern 2: Alert Delivery Failure**
```javascript
async function sendAlert(alert, env) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.MONITORING_CHAT_ID || env.SALES_TEAM_CHAT_ID,
        text: formatAlertMessage(alert),
        parse_mode: 'HTML'
      }),
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      throw new Error(`Telegram API error: ${response.status}`);
    }
    
    // Record successful alert delivery
    await recordAlertDelivery(alert.id, 'sent', env);
    
  } catch (error) {
    console.error('[ALERT_DELIVERY_FAIL]', {
      alert_type: alert.type,
      error: error.message
    });
    
    // Record failed delivery (for retry logic)
    await recordAlertDelivery(alert.id, 'failed', env).catch(() => {
      // Even alert history recording failed - log to console
      console.error('[ALERT_HISTORY_WRITE_FAIL]', alert);
    });
  }
}
```

**Pattern 3: Monitoring Query Timeout**
```javascript
async function getDashboardData(filters, env) {
  const client = new Client(CONFIG.DB_OPTS(env));
  
  try {
    await client.connect();
    await client.query("SET statement_timeout = 1000"); // 1 second max
    
    const metrics = await client.query(`
      SELECT metric_name, AVG(metric_value) as avg_value
      FROM metrics_summary
      WHERE timestamp > NOW() - INTERVAL '1 hour'
      GROUP BY metric_name
    `);
    
    return metrics.rows;
    
  } catch (error) {
    if (error.message.includes('timeout')) {
      console.warn('[MONITORING_QUERY_TIMEOUT] Using cached data');
      return getCachedDashboardData(); // Fallback to cache
    }
    throw error; // Re-throw non-timeout errors
  } finally {
    await client.end().catch(() => {});
  }
}
```

### Sanitization and Security

**Sensitive Data Redaction**:
```javascript
function sanitizeLogContext(context) {
  const sanitized = { ...context };
  
  // Remove sensitive headers
  if (sanitized.headers) {
    delete sanitized.headers['authorization'];
    delete sanitized.headers['cookie'];
    delete sanitized.headers['x-api-key'];
  }
  
  // Mask credit card numbers
  if (sanitized.payload) {
    sanitized.payload = sanitized.payload.replace(
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
      'XXXX-XXXX-XXXX-XXXX'
    );
  }
  
  // Remove email addresses
  if (typeof sanitized.error_message === 'string') {
    sanitized.error_message = sanitized.error_message.replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
      '[EMAIL_REDACTED]'
    );
  }
  
  return sanitized;
}
```

**SQL Injection Prevention**:
- Always use parameterized queries
- Validate and sanitize dashboard filter inputs
- Whitelist allowed filter values (timeRange: only `1h`, `24h`, `7d`)


## Testing Strategy

### Overview

The monitoring system requires a dual testing approach: unit tests for individual components and integration tests for end-to-end workflows. **Property-based testing is NOT appropriate** for this feature because:

1. **Infrastructure configuration**: Health checks, dashboard rendering, and alert delivery are deterministic operations with fixed inputs/outputs
2. **Side-effect-only operations**: Most monitoring operations (logging, metric recording, alert sending) have no return value to assert universal properties on
3. **External service integration**: Testing Telegram delivery, database writes, and R2 checks requires mocking or integration tests, not property-based generative testing

Therefore, this design uses **example-based unit tests** for component logic and **integration tests** for database and external service interactions.

### Unit Testing

**Test Framework**: Vitest (already configured in project)

**Coverage Targets**:
- Health check component logic: 90%
- Structured logger formatting: 95%
- Error fingerprinting algorithm: 100%
- Metrics aggregation logic: 90%
- Alert condition evaluation: 95%
- Sanitization functions: 100%

### Test Cases by Component

**1. Health Check Tests**

```javascript
// test/monitoring/health.spec.js
describe('Health Check', () => {
  test('returns 200 when all components healthy', async () => {
    const mockEnv = {
      HYPERDRIVE: { connectionString: 'postgresql://...' },
      R2_BUCKET: { head: () => Promise.resolve({}) },
      MAIN_QUEUE: {}
    };
    
    const response = await handleHealthCheck(mockRequest, mockEnv);
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data.status).toBe('healthy');
    expect(data.components.database.status).toBe('connected');
  });
  
  test('returns 503 when database disconnected', async () => {
    const mockEnv = {
      HYPERDRIVE: { connectionString: 'postgresql://invalid' },
      R2_BUCKET: { head: () => Promise.resolve({}) },
      MAIN_QUEUE: {}
    };
    
    const response = await handleHealthCheck(mockRequest, mockEnv);
    expect(response.status).toBe(503);
    
    const data = await response.json();
    expect(data.status).toBe('unhealthy');
    expect(data.components.database.status).toBe('disconnected');
  });
  
  test('caches results for 10 seconds', async () => {
    const checkSpy = vi.spyOn(healthModule, 'checkComponents');
    
    await handleHealthCheck(mockRequest, mockEnv);
    await handleHealthCheck(mockRequest, mockEnv);
    
    expect(checkSpy).toHaveBeenCalledTimes(1); // Second call used cache
  });
});
```


**2. Structured Logger Tests**

```javascript
// test/monitoring/logger.spec.js
describe('Structured Logger', () => {
  test('formats log entry with all required fields', () => {
    const logger = createRequestLogger('trace-123', { tenant_id: 'acme' });
    const consoleSpy = vi.spyOn(console, 'log');
    
    logger.info('Test message', { ot_id: 'OT-001' });
    
    const logEntry = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logEntry).toMatchObject({
      level: 'INFO',
      message: 'Test message',
      trace_id: 'trace-123',
      tenant_id: 'acme',
      context: { ot_id: 'OT-001' }
    });
    expect(logEntry.timestamp).toBeDefined();
  });
  
  test('sanitizes sensitive headers', () => {
    const context = {
      headers: {
        'authorization': 'Bearer secret-token',
        'content-type': 'application/json'
      }
    };
    
    const sanitized = sanitizeLogContext(context);
    
    expect(sanitized.headers['authorization']).toBeUndefined();
    expect(sanitized.headers['content-type']).toBe('application/json');
  });
  
  test('masks credit card numbers', () => {
    const context = {
      payload: 'Card: 4532-1234-5678-9010'
    };
    
    const sanitized = sanitizeLogContext(context);
    
    expect(sanitized.payload).toBe('Card: XXXX-XXXX-XXXX-XXXX');
    expect(sanitized.payload).not.toContain('4532');
  });
});
```

**3. Error Tracker Tests**

```javascript
// test/monitoring/errors.spec.js
describe('Error Tracker', () => {
  test('generates consistent fingerprint for same error', () => {
    const error1 = new Error('Database timeout at line 42');
    const error2 = new Error('Database timeout at line 42');
    
    const fp1 = generateErrorFingerprint(error1);
    const fp2 = generateErrorFingerprint(error2);
    
    expect(fp1).toBe(fp2);
  });
  
  test('generates different fingerprints for different errors', () => {
    const error1 = new Error('Database timeout');
    const error2 = new Error('Network error');
    
    const fp1 = generateErrorFingerprint(error1);
    const fp2 = generateErrorFingerprint(error2);
    
    expect(fp1).not.toBe(fp2);
  });
  
  test('classifies error severity correctly', () => {
    expect(classifyErrorSeverity(new ValidationError())).toBe('INFO');
    expect(classifyErrorSeverity(new TimeoutError())).toBe('WARN');
    expect(classifyErrorSeverity(new DatabaseError())).toBe('ERROR');
    expect(classifyErrorSeverity(new OutOfMemoryError())).toBe('CRITICAL');
  });
});
```


**4. Metrics Collector Tests**

```javascript
// test/monitoring/metrics.spec.js
describe('Metrics Collector', () => {
  test('batches metrics before database write', async () => {
    const writeSpy = vi.fn();
    const collector = new MetricsCollector({ batchSize: 3, writeFunc: writeSpy });
    
    await collector.record('metric1', 100);
    await collector.record('metric2', 200);
    expect(writeSpy).not.toHaveBeenCalled(); // Not yet batched
    
    await collector.record('metric3', 300);
    expect(writeSpy).toHaveBeenCalledTimes(1); // Batch threshold reached
  });
  
  test('calculates percentiles correctly', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    
    expect(calculatePercentile(values, 50)).toBe(50);
    expect(calculatePercentile(values, 95)).toBe(95);
    expect(calculatePercentile(values, 99)).toBe(99);
  });
  
  test('samples metrics at configured rate', async () => {
    const collector = new MetricsCollector({ sampleRate: 0.1 }); // 10%
    let recordedCount = 0;
    
    for (let i = 0; i < 1000; i++) {
      if (await collector.shouldSample()) {
        recordedCount++;
      }
    }
    
    expect(recordedCount).toBeGreaterThan(80); // ~100 ± 20
    expect(recordedCount).toBeLessThan(120);
  });
});
```

**5. Alert Manager Tests**

```javascript
// test/monitoring/alerts.spec.js
describe('Alert Manager', () => {
  test('triggers alert when error rate exceeds threshold', async () => {
    const sendAlertSpy = vi.fn();
    const manager = new AlertManager({ sendFunc: sendAlertSpy });
    
    const metrics = { error_rate: 6.5 }; // Threshold: 5%
    await manager.evaluate(metrics);
    
    expect(sendAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'high_error_rate',
        severity: 'ERROR',
        value: 6.5,
        threshold: 5
      })
    );
  });
  
  test('deduplicates alerts within 15-minute window', async () => {
    const sendAlertSpy = vi.fn();
    const manager = new AlertManager({ sendFunc: sendAlertSpy });
    
    const alert = { type: 'db_connection', severity: 'ERROR' };
    await manager.sendAlert(alert);
    await manager.sendAlert(alert); // Duplicate within window
    
    expect(sendAlertSpy).toHaveBeenCalledTimes(1); // Second call suppressed
  });
  
  test('does not deduplicate alerts after window expires', async () => {
    vi.useFakeTimers();
    const sendAlertSpy = vi.fn();
    const manager = new AlertManager({ sendFunc: sendAlertSpy });
    
    const alert = { type: 'db_connection', severity: 'ERROR' };
    await manager.sendAlert(alert);
    
    vi.advanceTimersByTime(16 * 60 * 1000); // 16 minutes later
    
    await manager.sendAlert(alert);
    expect(sendAlertSpy).toHaveBeenCalledTimes(2); // Window expired
  });
});
```


### Integration Testing

**Test Environment**: Staging Cloudflare Workers environment with test PostgreSQL database

**Test Cases**:

```javascript
// test/monitoring/integration.spec.js
describe('Monitoring System Integration', () => {
  test('end-to-end: request monitoring captures metrics and logs', async () => {
    // Send test request through monitored handler
    const response = await fetch('https://staging.otif-sentinel.com/wms-webhook', {
      method: 'POST',
      body: JSON.stringify({ ot_id: 'TEST-001' })
    });
    
    expect(response.status).toBe(200);
    
    // Verify metrics were recorded
    const metrics = await queryMetrics({
      metric_name: 'http.request.duration',
      endpoint: 'wms-webhook'
    });
    expect(metrics.length).toBeGreaterThan(0);
    
    // Verify structured log was created
    const logs = await queryLogs({ trace_id: response.headers.get('x-trace-id') });
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'INFO',
        message: 'Request completed'
      })
    );
  });
  
  test('error capture stores in database and triggers alert', async () => {
    // Trigger an error condition
    const response = await fetch('https://staging.otif-sentinel.com/api/test-error');
    
    // Wait for async error capture
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Verify error was stored
    const errors = await queryErrors({ endpoint: '/api/test-error' });
    expect(errors.length).toBe(1);
    expect(errors[0].severity).toBe('ERROR');
    
    // Verify alert was sent (check Telegram or alert_history table)
    const alerts = await queryAlerts({ alert_type: 'high_error_rate' });
    expect(alerts.length).toBeGreaterThan(0);
  });
  
  test('dashboard displays real-time data', async () => {
    const response = await fetch('https://staging.otif-sentinel.com/api/dashboard/data', {
      headers: { 'Authorization': 'Bearer test-token' }
    });
    
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data).toHaveProperty('health');
    expect(data).toHaveProperty('metrics');
    expect(data).toHaveProperty('recent_errors');
    expect(data.health.status).toMatch(/healthy|degraded|unhealthy/);
  });
});
```

### Load Testing

**Tool**: Apache Bench or k6

**Test Scenarios**:

1. **Health Endpoint Load**:
   - 1000 concurrent requests to `/health`
   - Verify response time < 500ms for 95th percentile
   - Verify no 500 errors

2. **Dashboard Under Load**:
   - 100 concurrent users accessing dashboard
   - Verify page load time < 3 seconds
   - Verify database query timeout protections work

3. **Monitoring Overhead Measurement**:
   - Baseline: 1000 requests without monitoring
   - Monitored: 1000 requests with full monitoring
   - Verify latency increase < 5%

### Regression Testing

After each monitoring system update:
1. Run full unit test suite (must pass 100%)
2. Run integration tests on staging
3. Verify existing application functionality unaffected
4. Check for latency regression (compare p95 response times)
5. Monitor error rate for 24 hours after deployment


## Deployment and Migration Strategy

### Pre-Deployment Checklist

- [ ] Database migration scripts tested on staging
- [ ] All unit tests passing (100% pass rate)
- [ ] Integration tests passing on staging environment
- [ ] Monitoring configuration validated (thresholds, sample rates)
- [ ] Telegram bot token and chat ID configured
- [ ] Dashboard authentication credentials set
- [ ] Rollback plan documented and tested

### Database Migration

**Migration Script**: `migrations/001_monitoring_schema.sql`

```sql
-- Execute during low-traffic window (2:00 AM - 4:00 AM UTC)
BEGIN;

-- Create monitoring tables
\i sql/create_error_logs.sql
\i sql/create_metrics_summary.sql
\i sql/create_alert_history.sql
\i sql/create_health_check_results.sql

-- Create indexes
\i sql/create_indexes.sql

-- Create partitions for metrics_summary (current + next 3 months)
\i sql/create_partitions.sql

-- Verify table creation
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('error_logs', 'metrics_summary', 'alert_history', 'health_check_results');

COMMIT;
```

**Rollback Script**: `migrations/001_rollback.sql`

```sql
BEGIN;

-- Drop tables in reverse order
DROP TABLE IF EXISTS health_check_results CASCADE;
DROP TABLE IF EXISTS alert_history CASCADE;
DROP TABLE IF EXISTS metrics_summary CASCADE;
DROP TABLE IF EXISTS error_logs CASCADE;

COMMIT;
```


### Deployment Steps

**Phase 1: Database Schema (Day 1)**

1. Backup production database
2. Execute migration script during maintenance window
3. Verify table creation and indexes
4. Test database connection from staging worker
5. No application code changes yet (tables exist but unused)

**Phase 2: Code Deployment - Monitoring Only (Day 2-3)**

1. Deploy monitoring modules without integration:
   - `src/monitoring/config.js`
   - `src/monitoring/logger.js`
   - `src/monitoring/health.js`
   - `src/monitoring/errors.js`
   - `src/monitoring/metrics.js`

2. Add `/health` endpoint only (no wrappers yet)
3. Verify health endpoint responds correctly
4. Monitor for any errors in Cloudflare dashboard

**Phase 3: Gradual Integration (Day 4-7)**

1. Enable monitoring for low-traffic endpoints first:
   - Wrap `/api/sync-excel` handler
   - Wrap `/api/recalcular-scoring` handler

2. Monitor for 24 hours:
   - Check error logs for monitoring failures
   - Verify latency increase < 5%
   - Confirm metrics being recorded

3. If stable, wrap high-traffic endpoints:
   - `/wms-webhook`
   - `/api/gps/ping`
   - `/telegram-webhook`

4. Monitor for 48 hours

**Phase 4: Alerting and Dashboard (Day 8-10)**

1. Deploy alert manager (disabled initially)
2. Deploy dashboard endpoint
3. Test dashboard with authentication
4. Enable alerting with conservative thresholds
5. Monitor alert frequency (adjust if too noisy)


### Feature Flag Configuration

Use environment variables for gradual rollout:

```javascript
// wrangler.toml (staging)
[vars]
MONITORING_ENABLED = "true"
MONITORING_ERROR_TRACKING = "true"
MONITORING_METRICS = "true"
MONITORING_ALERTING = "false"  # Disabled initially
MONITORING_SAMPLE_RATE = "0.1" # 10% sampling

// wrangler.toml (production)
[vars]
MONITORING_ENABLED = "false"   # Start disabled
MONITORING_ERROR_TRACKING = "false"
MONITORING_METRICS = "false"
MONITORING_ALERTING = "false"
MONITORING_SAMPLE_RATE = "0.05" # 5% sampling when enabled
```

Enable features progressively by updating environment variables without code redeployment.

### Rollback Plan

**Scenario 1: Monitoring Causes Errors**

1. Set `MONITORING_ENABLED = "false"` in environment
2. Redeploy worker (3-minute process)
3. Monitoring disabled, application runs normally
4. Investigate errors in Cloudflare logs
5. Fix issue, test on staging, redeploy

**Scenario 2: Database Performance Degradation**

1. Check `pg_stat_statements` for slow monitoring queries
2. Temporarily disable metrics: `MONITORING_METRICS = "false"`
3. Add missing indexes if identified
4. Optimize batch sizes
5. Re-enable after validation

**Scenario 3: Alert Spam**

1. Adjust alert thresholds in `MONITORING_CONFIG`
2. Increase deduplication window
3. Temporarily disable specific alert types
4. Review alert conditions logic
5. Re-enable with tuned thresholds

### Monitoring the Monitoring System

After deployment, track these metrics:

1. **Monitoring Error Rate**: Errors in monitoring code / Total monitoring operations
   - Target: < 0.1%
   - Alert if > 1%

2. **Monitoring Latency Overhead**: (Monitored request time - Baseline) / Baseline
   - Target: < 5%
   - Alert if > 10%

3. **Database Storage Growth**: Bytes per day
   - Target: < 100MB/day
   - Alert if > 500MB/day

4. **Alert Noise Ratio**: False positive alerts / Total alerts
   - Target: < 20%
   - Review if > 50%


## Security and Access Control

### Authentication Strategy

**Dashboard Access**:

1. **JWT Token Validation** (Primary):
```javascript
async function validateDashboardAccess(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, reason: 'Missing token' };
  }
  
  const token = authHeader.substring(7);
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    return { 
      valid: true, 
      user: payload.sub,
      roles: payload.roles 
    };
  } catch (error) {
    return { valid: false, reason: 'Invalid token' };
  }
}
```

2. **HTTP Basic Auth** (Fallback):
```javascript
function validateBasicAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Basic ')) {
    return false;
  }
  
  const credentials = atob(authHeader.substring(6));
  const [username, password] = credentials.split(':');
  
  return username === env.MONITORING_USERNAME && 
         password === env.MONITORING_PASSWORD;
}
```

### Tenant Isolation

All monitoring queries enforce tenant context:

```javascript
async function getErrorLogs(filters, tenantContext, env) {
  const client = new Client(CONFIG.DB_OPTS(env));
  await client.connect();
  
  // Always filter by tenant_id unless user is platform admin
  const tenantFilter = tenantContext.isAdmin 
    ? '' 
    : 'AND tenant_id = $1';
  
  const query = `
    SELECT * FROM error_logs
    WHERE timestamp > $${tenantContext.isAdmin ? 1 : 2}
    ${tenantFilter}
    ORDER BY timestamp DESC
    LIMIT 100
  `;
  
  const params = tenantContext.isAdmin
    ? [filters.since]
    : [tenantContext.tenant_id, filters.since];
  
  const result = await client.query(query, params);
  await client.end();
  
  return result.rows;
}
```


### Rate Limiting

Prevent abuse of monitoring endpoints:

```javascript
// In-memory rate limiter (per worker instance)
const rateLimitCache = new Map();

function checkRateLimit(ip, endpoint, limit, windowMs) {
  const key = `${ip}:${endpoint}`;
  const now = Date.now();
  
  // Clean expired entries
  if (rateLimitCache.size > 1000) {
    for (const [k, v] of rateLimitCache) {
      if (now - v.resetAt > windowMs) {
        rateLimitCache.delete(k);
      }
    }
  }
  
  const record = rateLimitCache.get(key);
  
  if (!record || now - record.resetAt > windowMs) {
    // New window
    rateLimitCache.set(key, { count: 1, resetAt: now });
    return { allowed: true, remaining: limit - 1 };
  }
  
  if (record.count >= limit) {
    return { allowed: false, remaining: 0, retryAfter: windowMs - (now - record.resetAt) };
  }
  
  record.count++;
  return { allowed: true, remaining: limit - record.count };
}

// Usage
const rateCheck = checkRateLimit(clientIP, '/health', 60, 60000); // 60 req/min
if (!rateCheck.allowed) {
  return new Response('Rate limit exceeded', { 
    status: 429,
    headers: {
      'Retry-After': Math.ceil(rateCheck.retryAfter / 1000)
    }
  });
}
```

### Data Sanitization

Comprehensive sanitization prevents sensitive data leakage:

```javascript
const SENSITIVE_PATTERNS = {
  creditCard: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  phone: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
  jwt: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
  apiKey: /\b[a-zA-Z0-9]{32,}\b/g // Generic long alphanumeric strings
};

function sanitizeString(str) {
  let sanitized = str;
  
  sanitized = sanitized.replace(SENSITIVE_PATTERNS.creditCard, 'XXXX-XXXX-XXXX-XXXX');
  sanitized = sanitized.replace(SENSITIVE_PATTERNS.email, '[EMAIL_REDACTED]');
  sanitized = sanitized.replace(SENSITIVE_PATTERNS.phone, 'XXX-XXX-XXXX');
  sanitized = sanitized.replace(SENSITIVE_PATTERNS.jwt, '[JWT_TOKEN_REDACTED]');
  sanitized = sanitized.replace(SENSITIVE_PATTERNS.apiKey, '[API_KEY_REDACTED]');
  
  // Escape control characters to prevent log injection
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');
  
  return sanitized;
}
```

### Content Security Policy

Dashboard HTML includes strict CSP:

```javascript
const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net", // Chart.js CDN
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');
```

### Audit Logging

All administrative actions logged:

```javascript
async function logAdminAction(action, user, details, env) {
  const client = new Client(CONFIG.DB_OPTS(env));
  await client.connect();
  
  await client.query(`
    INSERT INTO admin_audit_log (timestamp, action, user_id, details)
    VALUES (NOW(), $1, $2, $3)
  `, [action, user, JSON.stringify(details)]);
  
  await client.end();
}

// Usage
await logAdminAction('dashboard_access', userId, { 
  ip: clientIP, 
  tenant_filter: filters.tenant 
}, env);
```


## Cost Optimization Summary

### Resource Usage Estimates

**Database Storage**:
- Error logs: ~50 records/day × 500 bytes = 25 KB/day = 750 KB/month
- Metrics summary: ~1,000 aggregated records/day × 200 bytes = 200 KB/day = 6 MB/month
- Alert history: ~10 alerts/day × 300 bytes = 3 KB/day = 90 KB/month
- Health checks: ~2,880 checks/day × 100 bytes = 288 KB/day = 8.6 MB/month
- **Total: ~15 MB/month** (well within PostgreSQL free tier)

**Worker CPU Time**:
- Current baseline: ~30ms average per request
- Monitoring overhead: ~1.5ms per request (5% increase)
- With 10% sampling: ~0.5ms effective overhead (1.7% increase)
- **Impact: Negligible** (well within Cloudflare free tier 100k requests/day)

**Analytics Engine** (if used):
- Metrics data points: ~10,000/day with 10% sampling
- Alert events: ~10/day
- Health checks: ~2,880/day
- **Total: ~13,000 events/day = 400k/month** (within 10M free tier)

**Telegram API**:
- Operational alerts: ~10-20/day
- No cost (Telegram Bot API is free)

**Total Estimated Cost**: $0/month (within free tiers)

### Optimization Techniques Applied

1. **Sampling**: 10% of successful requests, 100% of errors
2. **Batching**: 100 data points per database write (reduces writes by 99%)
3. **Caching**: Health checks cached for 10 seconds
4. **Async Operations**: All monitoring uses `ctx.waitUntil()` to avoid blocking
5. **Partitioning**: Metrics table partitioned by month for efficient retention
6. **Deduplication**: Alerts suppressed within 15-minute windows
7. **Compression**: Historical metrics aggregated to hourly rollups after 24 hours


## Operational Runbooks

### Runbook: Database Connectivity Alert

**Alert Type**: `database_connectivity`  
**Severity**: CRITICAL  
**Typical Message**: "Database connection failed for > 30 seconds"

**Symptoms**:
- Health endpoint returns 503
- Application errors in Cloudflare logs
- All database-dependent operations failing

**Investigation Steps**:
1. Check Hyperdrive status in Cloudflare dashboard
2. Verify PostgreSQL server is running (check Supabase dashboard)
3. Test connection from local machine: `psql $DATABASE_URL`
4. Check for network issues or firewall changes
5. Review PostgreSQL logs for errors

**Resolution**:
- If Hyperdrive issue: Contact Cloudflare support
- If PostgreSQL down: Restart database or contact Supabase
- If credential issue: Rotate secrets and update environment variables
- If network issue: Update firewall rules or DNS

**Prevention**:
- Set up Supabase uptime monitoring
- Configure database connection pooling appropriately
- Implement database replica for failover

---

### Runbook: High Error Rate Alert

**Alert Type**: `high_error_rate`  
**Severity**: ERROR  
**Typical Message**: "Error rate 7.2% exceeds threshold of 5%"

**Symptoms**:
- Multiple failed requests
- Users reporting failures
- Dashboard shows elevated error count

**Investigation Steps**:
1. Access dashboard: `/dashboard/monitoring`
2. Review "Recent Errors" section for patterns
3. Check error types: Are they all TimeoutError? ValidationError?
4. Filter by endpoint: Is one endpoint failing?
5. Check external service circuit breakers (OpenAI, Telegram)
6. Review recent deployments (last 24 hours)

**Resolution**:
- If timeout errors: Increase timeout thresholds or optimize queries
- If validation errors: Fix input validation logic
- If external service failing: Circuit breaker should handle; investigate service status
- If recent deployment: Roll back to previous version

**Prevention**:
- Implement comprehensive input validation
- Add retry logic with exponential backoff
- Monitor external service SLAs
- Use canary deployments for gradual rollout

---

### Runbook: Queue Backlog Alert

**Alert Type**: `queue_backlog`  
**Severity**: ERROR  
**Typical Message**: "ENRICHMENT_QUEUE latency 15 minutes exceeds threshold"

**Symptoms**:
- Messages piling up in queue
- Slow order processing
- Delayed Telegram notifications

**Investigation Steps**:
1. Check Dead Letter Queue: `SELECT COUNT(*) FROM dead_letter_events WHERE event_type = 'ENRICHMENT'`
2. Check circuit breaker status for OpenAI: `SELECT value FROM system_flags WHERE key = 'openai_breaker'`
3. Review worker execution time in Cloudflare dashboard
4. Check OpenAI API status page
5. Verify database performance (slow queries)

**Resolution**:
- If circuit breaker open: Wait for cooldown or investigate OpenAI issues
- If DLQ full: Manually reprocess failed messages
- If worker CPU limit: Optimize queue processor logic
- If database slow: Add indexes or optimize queries

**Prevention**:
- Increase queue batch size for higher throughput
- Implement queue priority levels
- Add more aggressive timeout handling
- Monitor external service reliability


## Design Decisions and Trade-offs

### Decision 1: PostgreSQL vs Analytics Engine

**Options Considered**:
1. Store all metrics in Cloudflare Analytics Engine
2. Store all metrics in PostgreSQL
3. Hybrid approach (Analytics Engine preferred, PostgreSQL fallback)

**Chosen**: Hybrid approach

**Rationale**:
- Analytics Engine has 10M event/month free tier (sufficient for our scale)
- PostgreSQL provides SQL querying flexibility for ad-hoc analysis
- Fallback ensures monitoring works even if Analytics Engine unavailable
- PostgreSQL required anyway for error logs (rich contextual data)

**Trade-offs**:
- Additional complexity in metrics writer (try Analytics Engine, fallback to PostgreSQL)
- Storage cost minimal due to aggregation and retention policies

---

### Decision 2: Middleware Wrapper vs Direct Integration

**Options Considered**:
1. Modify every handler directly to add monitoring calls
2. Use middleware wrapper pattern
3. Use Proxy/Interceptor pattern

**Chosen**: Middleware wrapper pattern

**Rationale**:
- Non-invasive: Existing code remains unchanged
- Easy to disable: Remove wrapper to disable monitoring
- Centralized logic: All monitoring code in one place
- Easy to test: Mock the wrapper without touching handlers

**Trade-offs**:
- Slightly less efficient than direct integration (extra function call)
- Must wrap each handler explicitly (not automatic)
- Less visibility into internal handler logic

---

### Decision 3: Sampling Strategy

**Options Considered**:
1. Record 100% of requests
2. Fixed sampling rate (10%)
3. Adaptive sampling (reduce under load)

**Chosen**: Fixed 10% sampling for successful requests, 100% for errors

**Rationale**:
- 10% provides sufficient statistical significance (120 requests/hour = 12 samples)
- Captures all errors (most important for debugging)
- Predictable resource usage
- Simpler implementation than adaptive

**Trade-offs**:
- Might miss some edge cases in the 90% not sampled
- Not optimal for very low or very high traffic scenarios
- Could implement adaptive sampling in future if needed

---

### Decision 4: Telegram for Alerts vs Email/Webhook

**Options Considered**:
1. Email alerts (SendGrid, Mailgun)
2. Webhook to Slack/Discord
3. Telegram Bot API
4. Multi-channel (all of the above)

**Chosen**: Telegram Bot API (existing integration)

**Rationale**:
- Already integrated for delivery notifications (reuse existing bot)
- Real-time delivery (push notifications)
- No additional cost (Telegram API is free)
- Team already uses Telegram for operations

**Trade-offs**:
- Single point of failure (if Telegram down, no alerts)
- Limited formatting compared to Slack
- Could add webhook fallback in future


## Correctness Properties

**Note**: Property-based testing (PBT) is not applicable to this feature. See detailed analysis below.

### Property 1: Infrastructure configuration correctness

Infrastructure components (health checks, data persistence, security, alerting) must be deterministically configured and verifiable through schema validation and smoke tests rather than property-based testing. This property is verified via integration tests with mocked services.

**Validates: Requirements 1, 7, 10, 12**

#### Property-Based Testing Applicability Assessment

After analyzing the acceptance criteria in the requirements document, **property-based testing (PBT) is NOT applicable** to this monitoring and stability system. This decision is based on the following assessment:

### Why PBT Does Not Apply

**1. Infrastructure Configuration Testing**
- Requirements 1, 7, 10, 12: Health checks, data persistence, security configuration, documentation
- These are one-time setup checks and configuration validation
- PBT requires varying inputs to find edge cases; infrastructure configuration is deterministic
- **Test Strategy**: Schema validation tests, smoke tests, integration tests with mocked services

**2. Side-Effect-Only Operations**
- Requirements 2, 3, 5: Structured logging, error tracking, operational alerting
- These operations write to databases, send Telegram messages, write logs
- No return value to assert universal properties on
- Cannot write "for any input X, property P(X) holds" when operations are fire-and-forget
- **Test Strategy**: Mock-based unit tests verifying correct side effects were triggered

**3. External Service Integration**
- Requirements 1, 4, 8: PostgreSQL connectivity, R2 storage checks, Telegram delivery
- Testing external service behavior, not our code's logic
- Behavior doesn't vary meaningfully with different inputs (service is up or down)
- 100 iterations won't find more bugs than 2-3 integration tests
- **Test Strategy**: Integration tests with 1-3 representative examples, mocked unit tests

**4. Deterministic Rendering and Display**
- Requirement 6: Visual dashboard with HTML generation
- UI rendering is deterministic: same input always produces same HTML output
- No universal properties across varying inputs
- **Test Strategy**: Snapshot tests for HTML output, example-based tests for data fetching


### Acceptance Criteria Testability Analysis

Below is the analysis of each acceptance criterion from the requirements document:

**Requirement 1: System Health Verification**
- 1.1-1.10: Health check endpoint behavior
- **Classification**: INTEGRATION (smoke tests)
- **Reasoning**: Testing infrastructure connectivity (DB, R2, Queues) - either works or doesn't. Running 100 times doesn't add value over 2-3 integration tests.
- **Test Strategy**: Integration tests with mocked services, smoke tests for actual infrastructure

**Requirement 2: Structured Logging Infrastructure**
- 2.1-2.10: JSON log formatting, severity levels, sanitization
- **Classification**: EXAMPLE (unit tests with specific inputs)
- **Reasoning**: Log formatting is deterministic. Testing with 5-10 example inputs covers all code paths. No benefit to generating 100 random log entries.
- **Test Strategy**: Unit tests with representative examples (error with stack trace, info with context, debug with metadata)

**Requirement 3: Error Tracking and Aggregation**
- 3.1-3.10: Error capture, fingerprinting, aggregation
- **Classification**: EXAMPLE + INTEGRATION
- **Reasoning**: Error fingerprinting algorithm can be unit tested with specific examples. Error persistence is side-effect testing (database writes). Aggregation queries are integration tests.
- **Test Strategy**: Unit tests for fingerprinting logic, integration tests for database operations

**Requirement 4: Performance Metrics Collection**
- 4.1-4.12: Measure response times, throughput, queue processing
- **Classification**: INTEGRATION (side effects)
- **Reasoning**: Metrics collection involves database writes or Analytics Engine writes (side effects). Cannot assert universal properties on "recording a metric" operation.
- **Test Strategy**: Mock-based unit tests verifying correct metric recording calls, integration tests for actual writes

**Requirement 5: Operational Alerting System**
- 5.1-5.13: Alert conditions, thresholds, Telegram delivery
- **Classification**: EXAMPLE + INTEGRATION
- **Reasoning**: Alert condition evaluation can be unit tested (threshold comparisons). Alert delivery is external service integration. Deduplication logic is testable with specific examples.
- **Test Strategy**: Unit tests for condition evaluation and deduplication, integration tests for Telegram delivery

**Requirement 6: Visual System Dashboard**
- 6.1-6.12: HTML rendering, data fetching, authentication
- **Classification**: INTEGRATION + SNAPSHOT
- **Reasoning**: Dashboard rendering is deterministic. Data fetching is database integration. Authentication is example-based testing (valid token, invalid token, no token).
- **Test Strategy**: Snapshot tests for HTML output, integration tests for data API, unit tests for authentication logic

**Requirement 7: Monitoring Data Persistence and Retention**
- 7.1-7.10: Database schema, retention policies, indexes
- **Classification**: SMOKE (schema validation)
- **Reasoning**: One-time schema setup and configuration. Either schema exists correctly or doesn't. Retention policy is tested by running the cleanup job once.
- **Test Strategy**: Schema validation tests, integration test for retention cleanup job

**Requirement 8: Integration with Existing Infrastructure**
- 8.1-8.10: Hyperdrive, queues, circuit breakers, CORS
- **Classification**: INTEGRATION
- **Reasoning**: Testing integration points with existing code. Verification that monitoring doesn't break existing functionality.
- **Test Strategy**: Integration tests, regression tests comparing before/after monitoring enabled

**Requirement 9: Cost Optimization and Resource Efficiency**
- 9.1-9.10: Batching, sampling, caching, async operations
- **Classification**: EXAMPLE (performance tests)
- **Reasoning**: Performance characteristics tested with specific load patterns. "Does batching reduce database writes?" is answered with one test.
- **Test Strategy**: Performance benchmarks, load tests with specific traffic patterns

**Requirement 10: Security and Access Control**
- 10.1-10.10: Authentication, sanitization, rate limiting, tenant isolation
- **Classification**: EXAMPLE (security tests)
- **Reasoning**: Security tests use specific attack vectors (SQL injection attempts, XSS payloads, invalid tokens). Not universal properties.
- **Test Strategy**: Security-focused unit tests with known attack patterns, penetration testing

**Requirement 11: Monitoring System Observability**
- 11.1-11.10: Meta-monitoring, graceful degradation, circuit breakers
- **Classification**: INTEGRATION + EXAMPLE
- **Reasoning**: Testing monitoring's own error handling and fallback behavior with specific failure scenarios.
- **Test Strategy**: Fault injection tests, chaos engineering scenarios

**Requirement 12: Documentation and Operational Runbooks**
- 12.1-12.10: Documentation completeness, runbooks
- **Classification**: Not testable (documentation quality)
- **Reasoning**: Documentation quality is subjective and reviewed manually.
- **Test Strategy**: Manual review, checklist validation

### Conclusion

This monitoring system requires **no property-based tests**. All requirements are best validated through:
- **Unit tests** with specific examples (sanitization, fingerprinting, formatting)
- **Integration tests** with 1-3 scenarios (database operations, external services)
- **Smoke tests** for configuration and schema validation
- **Performance/load tests** for resource efficiency verification
- **Security tests** with known attack patterns

The Testing Strategy section (above) provides comprehensive coverage using these appropriate testing methodologies.


## Summary

The Stability and Monitoring System transforms the OTIF Sentinel logistics platform from a development-grade service into a production-ready system with comprehensive observability. This design achieves the following goals:

### Key Achievements

1. **Zero Disruption**: Non-invasive middleware pattern ensures existing functionality remains unaffected
2. **Production Observability**: Structured logging, error tracking, and performance metrics provide full visibility
3. **Proactive Operations**: Real-time alerting enables rapid incident response before users are impacted
4. **Cost Efficiency**: Intelligent sampling, batching, and caching keep resource usage within free tiers
5. **Security First**: Authentication, sanitization, and tenant isolation protect sensitive operational data
6. **Fail-Safe Design**: Graceful degradation ensures monitoring failures never crash the application

### Architecture Highlights

- **6 Core Components**: Health Check, Logger, Error Tracker, Metrics Collector, Alert Manager, Dashboard
- **Middleware Pattern**: Wraps existing handlers without code modification
- **Dual Storage**: Analytics Engine for time-series, PostgreSQL for rich queries
- **Feature Flags**: Gradual rollout with environment-based configuration
- **Meta-Monitoring**: System monitors its own health and degrades gracefully

### Implementation Roadmap

- **Week 1**: Core infrastructure (health checks, structured logging, database schema)
- **Week 2**: Error tracking and metrics collection with minimal overhead
- **Week 3**: Alerting via Telegram and visual dashboard with authentication
- **Week 4**: Performance optimization, documentation, and operational runbooks

### Success Metrics

After full deployment, the system should demonstrate:
- < 5% latency overhead from monitoring instrumentation
- < 0.1% monitoring system error rate
- < 100 MB/month database storage growth
- < 60 seconds alert delivery time for critical issues
- Zero production incidents caused by monitoring failures

### Next Steps

1. Review and approve design document
2. Create database migration scripts
3. Begin Phase 1 implementation (Week 1 tasks)
4. Set up staging environment for integration testing
5. Define alert thresholds based on baseline metrics

This design provides a solid foundation for operational excellence, enabling the OTIF Sentinel platform to scale confidently with proactive monitoring, rapid debugging, and data-driven optimization.

