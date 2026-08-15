# Requirements Document

## Introduction

The Stability and Monitoring System provides comprehensive observability and operational excellence for the Lead Rescue Pipeline (OTIF Sentinel), a Cloudflare Workers-based logistics platform. The system enables real-time health monitoring, structured logging, error tracking, performance metrics, operational alerts, and visual dashboards to ensure system reliability, rapid incident response, and data-driven optimization.

This system addresses critical operational gaps: lack of structured logging, absence of health checks, no alerting mechanism, difficult debugging, and limited performance visibility. By implementing foundational stability infrastructure, the platform will achieve production-grade reliability and enable proactive issue resolution.

## Glossary

- **Monitoring_System**: The complete stability and monitoring infrastructure including health checks, logging, metrics, alerts, and dashboards
- **Health_Check_Endpoint**: HTTP endpoint that verifies operational status of critical system components
- **Structured_Logger**: Logging service that produces consistent, machine-parsable log entries with severity levels and contextual metadata
- **Error_Tracker**: Service that captures, aggregates, and analyzes application errors with full contextual information
- **Metrics_Collector**: Component that gathers quantitative performance measurements (response times, throughput, resource usage)
- **Alert_Manager**: Service that evaluates conditions and dispatches real-time notifications for critical operational issues
- **System_Dashboard**: Web-based visual interface displaying system health metrics, performance indicators, and operational status
- **PostgreSQL_Database**: The Supabase-hosted PostgreSQL database accessed via Hyperdrive connection pooling
- **R2_Bucket**: Cloudflare R2 object storage for evidence photos and file uploads
- **Queue_System**: Cloudflare Queue infrastructure consisting of MAIN_QUEUE, ENRICHMENT_QUEUE, and DELIVERY_QUEUE
- **Tenant_Context**: Multi-tenant isolation identifier (tenant_id) that must be maintained across all operations
- **Log_Severity**: Classification level for log entries (DEBUG, INFO, WARN, ERROR, CRITICAL)
- **Circuit_Breaker**: Fault tolerance pattern that prevents cascading failures by temporarily blocking operations to failing external services
- **Performance_Threshold**: Predefined acceptable limits for response time, error rate, or resource utilization metrics
- **Alert_Channel**: Delivery mechanism for operational notifications (Telegram, email, webhook)
- **Correlation_ID**: Unique identifier linking related operations across distributed system components (trace_id in current implementation)
- **Dead_Letter_Queue**: Storage for messages that failed processing after maximum retry attempts requiring manual intervention

## Requirements

### Requirement 1: System Health Verification

**User Story:** As an operations engineer, I want a health check endpoint that verifies all critical system components, so that I can quickly assess system status and integrate with monitoring tools.

#### Acceptance Criteria

1. THE Health_Check_Endpoint SHALL respond to HTTP GET requests at `/health` or `/api/health` within 500ms
2. WHEN all system components are operational, THE Health_Check_Endpoint SHALL return HTTP 200 status with a JSON response containing overall status "healthy"
3. WHEN any critical component fails health verification, THE Health_Check_Endpoint SHALL return HTTP 503 status with details of failed components
4. THE Health_Check_Endpoint SHALL verify PostgreSQL_Database connectivity by executing a lightweight query within 200ms timeout
5. THE Health_Check_Endpoint SHALL verify R2_Bucket accessibility by checking bucket permissions or executing a lightweight metadata operation
6. THE Health_Check_Endpoint SHALL verify Queue_System availability by checking queue binding accessibility
7. THE Health_Check_Endpoint SHALL include component-level status details in the response: database (connected/disconnected), storage (accessible/inaccessible), queues (available/unavailable)
8. THE Health_Check_Endpoint SHALL include system metadata in the response: service name, version identifier, deployment timestamp, and current worker region
9. THE Health_Check_Endpoint SHALL maintain tenant isolation by not exposing tenant-specific data in health check responses
10. THE Health_Check_Endpoint SHALL be accessible without authentication to enable external monitoring service integration

### Requirement 2: Structured Logging Infrastructure

**User Story:** As a developer, I want structured, machine-parsable logs with consistent format and severity levels, so that I can efficiently debug production issues and analyze system behavior.

#### Acceptance Criteria

1. THE Structured_Logger SHALL produce JSON-formatted log entries for all application events
2. WHEN any application component logs an event, THE Structured_Logger SHALL include mandatory fields: timestamp (ISO 8601), severity level, message, correlation_id (trace_id), and service name
3. THE Structured_Logger SHALL support Log_Severity levels: DEBUG, INFO, WARN, ERROR, and CRITICAL
4. THE Structured_Logger SHALL include contextual metadata in log entries: request_id, tenant_id (when available), user_id (when available), endpoint path, HTTP method, and response status code
5. WHEN an error occurs, THE Structured_Logger SHALL include error stack traces, error type, error message, and relevant context variables
6. THE Structured_Logger SHALL sanitize sensitive data from log entries: authentication tokens, passwords, API keys, and personally identifiable information
7. THE Structured_Logger SHALL integrate with Cloudflare Workers console logging (console.log, console.error)
8. WHERE Cloudflare Logpush is enabled, THE Structured_Logger SHALL ensure logs are compatible with external log aggregation services
9. THE Structured_Logger SHALL maintain tenant isolation by including tenant_id in all tenant-scoped operations
10. THE Structured_Logger SHALL measure and include operation duration in milliseconds for performance-critical operations (database queries, external API calls, queue operations)

### Requirement 3: Error Tracking and Aggregation

**User Story:** As an operations engineer, I want automatic error capture with contextual information and aggregation, so that I can identify patterns, prioritize fixes, and reduce mean time to resolution.

#### Acceptance Criteria

1. THE Error_Tracker SHALL automatically capture all unhandled exceptions in request handlers, queue processors, and scheduled tasks
2. WHEN an error is captured, THE Error_Tracker SHALL record: error type, error message, stack trace, timestamp, correlation_id, tenant_id (when available), request URL, HTTP method, and user agent
3. THE Error_Tracker SHALL store captured errors in the PostgreSQL_Database in a dedicated error_logs table
4. THE Error_Tracker SHALL assign a severity classification to each error: INFO (handled errors), WARN (recoverable errors), ERROR (operation failures), and CRITICAL (system failures)
5. THE Error_Tracker SHALL aggregate errors by error fingerprint (combination of error type, message pattern, and stack trace location)
6. THE Error_Tracker SHALL calculate error occurrence counts and first/last seen timestamps for each error fingerprint
7. WHEN an error occurs in a multi-tenant context, THE Error_Tracker SHALL maintain tenant isolation by associating errors with tenant_id
8. THE Error_Tracker SHALL capture Circuit_Breaker state transitions (CLOSED → OPEN, OPEN → CLOSED) as operational events
9. THE Error_Tracker SHALL provide query interfaces for error analysis: by time range, by severity, by tenant, by error type, and by endpoint
10. THE Error_Tracker SHALL integrate with the Structured_Logger to ensure all captured errors produce corresponding log entries

### Requirement 4: Performance Metrics Collection

**User Story:** As a platform engineer, I want quantitative performance metrics for response times, throughput, and resource usage, so that I can identify bottlenecks, optimize performance, and ensure SLA compliance.

#### Acceptance Criteria

1. THE Metrics_Collector SHALL measure HTTP request response times from request receipt to response completion in milliseconds
2. THE Metrics_Collector SHALL measure database query execution times in milliseconds for all PostgreSQL_Database operations
3. THE Metrics_Collector SHALL measure external API call durations for OpenAI enrichment, Telegram delivery, and other third-party integrations
4. THE Metrics_Collector SHALL measure queue processing throughput: messages processed per minute for MAIN_QUEUE, ENRICHMENT_QUEUE, and DELIVERY_QUEUE
5. THE Metrics_Collector SHALL measure queue processing latency: time from message enqueue to processing completion
6. THE Metrics_Collector SHALL track error rates as percentage: total errors divided by total operations for each endpoint and queue processor
7. WHERE Cloudflare Analytics Engine is available, THE Metrics_Collector SHALL write performance metrics to Analytics Engine for time-series analysis
8. WHERE Cloudflare Analytics Engine is not available, THE Metrics_Collector SHALL store aggregated metrics in PostgreSQL_Database in a metrics_summary table
9. THE Metrics_Collector SHALL calculate and store percentile distributions (p50, p95, p99) for response times and query durations
10. THE Metrics_Collector SHALL maintain tenant isolation by segmenting metrics by tenant_id for multi-tenant operations
11. THE Metrics_Collector SHALL measure Circuit_Breaker activation frequency and duration to assess external service reliability
12. THE Metrics_Collector SHALL track Dead_Letter_Queue message counts to monitor processing failure rates

### Requirement 5: Operational Alerting System

**User Story:** As an operations engineer, I want real-time alerts for critical system issues, so that I can respond immediately to incidents and minimize service impact.

#### Acceptance Criteria

1. THE Alert_Manager SHALL evaluate alert conditions continuously during system operation
2. WHEN database connectivity fails for longer than 30 seconds, THE Alert_Manager SHALL dispatch a CRITICAL alert
3. WHEN error rate exceeds 5% for any endpoint over a 5-minute window, THE Alert_Manager SHALL dispatch an ERROR alert
4. WHEN HTTP response time p95 exceeds 3000ms for any endpoint over a 5-minute window, THE Alert_Manager SHALL dispatch a WARN alert
5. WHEN queue processing latency exceeds 10 minutes for any queue, THE Alert_Manager SHALL dispatch an ERROR alert
6. WHEN Circuit_Breaker remains open for longer than 10 minutes for any external service, THE Alert_Manager SHALL dispatch a WARN alert
7. WHEN Dead_Letter_Queue message count exceeds 100 messages, THE Alert_Manager SHALL dispatch an ERROR alert
8. WHEN R2_Bucket operations fail for longer than 5 minutes, THE Alert_Manager SHALL dispatch an ERROR alert
9. THE Alert_Manager SHALL deliver alerts via Telegram to the configured SALES_TEAM_CHAT_ID or a dedicated operations channel
10. THE Alert_Manager SHALL include in alert messages: severity level, affected component, metric value, threshold value, timestamp, and correlation_id for investigation
11. THE Alert_Manager SHALL implement alert deduplication to prevent notification flooding: suppress duplicate alerts within a 15-minute window
12. THE Alert_Manager SHALL support alert escalation: IF a CRITICAL alert is not acknowledged within 10 minutes, THEN THE Alert_Manager SHALL send escalation notifications
13. THE Alert_Manager SHALL log all alert dispatches to enable alert effectiveness analysis

### Requirement 6: Visual System Dashboard

**User Story:** As a platform administrator, I want a visual dashboard displaying system health and performance metrics, so that I can monitor system status at a glance and identify trends.

#### Acceptance Criteria

1. THE System_Dashboard SHALL render an HTML interface accessible via HTTP GET request at `/dashboard` or `/api/dashboard/health`
2. THE System_Dashboard SHALL display overall system health status with color-coded indicators: green (healthy), yellow (degraded), red (critical)
3. THE System_Dashboard SHALL display real-time component status for PostgreSQL_Database, R2_Bucket, and Queue_System with last check timestamp
4. THE System_Dashboard SHALL display current performance metrics: average response time, current error rate, and requests per minute
5. THE System_Dashboard SHALL display queue metrics for each queue: pending message count, processing rate, and average latency
6. THE System_Dashboard SHALL display recent errors: last 10 errors with timestamp, error type, affected endpoint, and tenant_id (when available)
7. THE System_Dashboard SHALL display Circuit_Breaker status for each external service: current state (OPEN/CLOSED), activation count, and last state change timestamp
8. THE System_Dashboard SHALL display Dead_Letter_Queue message count with link to detailed view
9. THE System_Dashboard SHALL auto-refresh every 30 seconds to display near real-time data
10. THE System_Dashboard SHALL provide time-range filtering: last 1 hour, last 24 hours, last 7 days
11. THE System_Dashboard SHALL require authentication to prevent unauthorized access to operational metrics
12. THE System_Dashboard SHALL maintain tenant isolation by providing tenant-filtered views for multi-tenant deployments

### Requirement 7: Monitoring Data Persistence and Retention

**User Story:** As a platform engineer, I want structured storage and retention policies for monitoring data, so that I can perform historical analysis while managing storage costs.

#### Acceptance Criteria

1. THE Monitoring_System SHALL create database tables for monitoring data: error_logs, metrics_summary, alert_history, and health_check_results
2. THE Monitoring_System SHALL store error_logs with fields: id, timestamp, severity, error_type, error_message, stack_trace, correlation_id, tenant_id, endpoint, http_method, and context_metadata (JSONB)
3. THE Monitoring_System SHALL store metrics_summary with fields: id, timestamp, metric_name, metric_value, metric_unit, aggregation_type (avg/sum/count/p50/p95/p99), dimension_tags (JSONB), and tenant_id
4. THE Monitoring_System SHALL store alert_history with fields: id, timestamp, alert_type, severity, component, metric_value, threshold_value, message, delivery_status, and acknowledged_at
5. THE Monitoring_System SHALL implement retention policies: error_logs retained for 90 days, metrics_summary retained for 365 days, alert_history retained for 180 days
6. THE Monitoring_System SHALL implement automated data cleanup via scheduled task that executes retention policy deletion daily at 02:00 UTC
7. THE Monitoring_System SHALL create database indexes on frequently queried fields: error_logs(timestamp, severity, tenant_id), metrics_summary(timestamp, metric_name, tenant_id), alert_history(timestamp, severity)
8. THE Monitoring_System SHALL partition metrics_summary table by month to optimize query performance and simplify retention enforcement
9. THE Monitoring_System SHALL maintain tenant isolation in all monitoring data tables by enforcing tenant_id filtering in queries
10. WHERE storage exceeds 80% capacity threshold, THE Monitoring_System SHALL dispatch an alert to operations team

### Requirement 8: Integration with Existing Infrastructure

**User Story:** As a developer, I want the monitoring system to integrate seamlessly with existing infrastructure, so that I can minimize code changes and avoid disrupting current functionality.

#### Acceptance Criteria

1. THE Monitoring_System SHALL integrate with existing Hyperdrive PostgreSQL connection pooling without requiring connection string changes
2. THE Monitoring_System SHALL integrate with existing Queue_System (MAIN_QUEUE, ENRICHMENT_QUEUE, DELIVERY_QUEUE) processors by wrapping existing handlers
3. THE Monitoring_System SHALL integrate with existing Circuit_Breaker implementations (openai_breaker, tg_breaker) by instrumenting state transitions
4. THE Monitoring_System SHALL integrate with existing CORS_HEADERS configuration from config.js for all monitoring endpoints
5. THE Monitoring_System SHALL integrate with existing tenant_id isolation by extracting tenant context from request headers or JWT tokens
6. THE Monitoring_System SHALL integrate with existing error handling patterns (safeRollback, classifyError) by enhancing rather than replacing them
7. THE Monitoring_System SHALL provide middleware/wrapper functions for request handlers that automatically capture metrics and errors
8. THE Monitoring_System SHALL provide middleware/wrapper functions for queue processors that automatically measure processing latency and capture failures
9. THE Monitoring_System SHALL expose a centralized monitoring configuration object following the pattern established in config.js
10. THE Monitoring_System SHALL maintain backward compatibility with existing console.log statements while enhancing them with structured logging

### Requirement 9: Cost Optimization and Resource Efficiency

**User Story:** As a platform owner, I want the monitoring system to minimize operational costs and resource usage, so that I can maintain profitability while ensuring observability.

#### Acceptance Criteria

1. THE Monitoring_System SHALL batch metrics writes to PostgreSQL_Database: aggregate up to 100 metric data points before executing database insert
2. THE Monitoring_System SHALL use asynchronous operations (ctx.waitUntil) for non-critical monitoring operations to avoid blocking request responses
3. THE Monitoring_System SHALL implement sampling for high-frequency metrics: sample 10% of successful requests, 100% of errors
4. THE Monitoring_System SHALL compress historical metrics by storing hourly aggregations instead of raw data points after 24 hours
5. THE Monitoring_System SHALL limit alert dispatch frequency to prevent notification spam: maximum 10 alerts per component per hour
6. THE Monitoring_System SHALL use lightweight health check queries: SELECT 1 for database connectivity, not full table scans
7. THE Monitoring_System SHALL cache health check results for 10 seconds to reduce redundant verification when multiple concurrent requests occur
8. WHERE Cloudflare Analytics Engine is used, THE Monitoring_System SHALL stay within free tier limits (10 million events per month) through intelligent sampling
9. THE Monitoring_System SHALL monitor its own resource consumption and reduce sampling rate IF worker CPU time exceeds 80% of limit
10. THE Monitoring_System SHALL provide configuration flags to disable non-essential monitoring features in resource-constrained environments

### Requirement 10: Security and Access Control

**User Story:** As a security engineer, I want the monitoring system to protect sensitive operational data and prevent unauthorized access, so that I can maintain security compliance and prevent information disclosure.

#### Acceptance Criteria

1. THE Monitoring_System SHALL require authentication for System_Dashboard access via JWT token validation or HTTP basic authentication
2. THE Monitoring_System SHALL sanitize error messages before storage to remove sensitive data patterns: credit card numbers, API keys, passwords, email addresses, and phone numbers
3. THE Monitoring_System SHALL sanitize log entries before output to prevent log injection attacks: escape control characters and newline characters
4. THE Monitoring_System SHALL implement rate limiting for Health_Check_Endpoint: maximum 60 requests per minute per IP address to prevent abuse
5. THE Monitoring_System SHALL implement tenant isolation in all monitoring queries by enforcing tenant_id WHERE clauses
6. THE Monitoring_System SHALL prevent cross-tenant data leakage in error logs by validating tenant_id matches authenticated user context
7. THE Monitoring_System SHALL log all authentication failures for Security_Dashboard access to enable intrusion detection
8. THE Monitoring_System SHALL redact sensitive HTTP headers from logged requests: Authorization, Cookie, X-API-Key headers
9. THE Monitoring_System SHALL implement Content Security Policy headers for System_Dashboard to prevent XSS attacks
10. THE Monitoring_System SHALL validate and sanitize all user input in dashboard filter parameters to prevent SQL injection in monitoring queries

### Requirement 11: Monitoring System Observability (Meta-Monitoring)

**User Story:** As an operations engineer, I want the monitoring system itself to be observable and reliable, so that I can trust the monitoring data and detect monitoring system failures.

#### Acceptance Criteria

1. THE Monitoring_System SHALL track its own error rate and dispatch alerts IF monitoring component error rate exceeds 1%
2. THE Monitoring_System SHALL measure and log latency of monitoring operations: log write duration, metrics batch write duration, alert dispatch duration
3. THE Monitoring_System SHALL implement graceful degradation: IF monitoring database writes fail, THE Monitoring_System SHALL fall back to console logging without blocking application operations
4. THE Monitoring_System SHALL implement circuit breaker for monitoring operations: IF monitoring database connection fails 5 consecutive times, THE Monitoring_System SHALL temporarily disable database writes and log to console only
5. THE Monitoring_System SHALL track monitoring data loss: count of failed metric writes, failed error captures, and failed alert dispatches
6. THE Monitoring_System SHALL expose a meta-health endpoint at `/health/monitoring` that reports monitoring system component status
7. THE Monitoring_System SHALL validate monitoring data integrity: detect and alert on missing time-series data gaps longer than 10 minutes
8. THE Monitoring_System SHALL log configuration changes to monitoring thresholds and alert rules with timestamp and operator identifier
9. THE Monitoring_System SHALL implement monitoring operation timeouts: abort monitoring database queries after 1000ms to prevent blocking
10. THE Monitoring_System SHALL provide monitoring system metrics in Health_Check_Endpoint response: last successful metric write timestamp, last successful alert dispatch timestamp, current monitoring error rate

### Requirement 12: Documentation and Operational Runbooks

**User Story:** As an operations engineer, I want comprehensive documentation and runbooks for monitoring system configuration and incident response, so that I can effectively operate the system and train new team members.

#### Acceptance Criteria

1. THE Monitoring_System SHALL include inline code documentation following JSDoc format for all public functions and configuration options
2. THE Monitoring_System SHALL provide a configuration reference document listing all environment variables, thresholds, and feature flags with descriptions and default values
3. THE Monitoring_System SHALL provide architecture documentation describing monitoring data flow, component interactions, and integration points
4. THE Monitoring_System SHALL provide an alert runbook for each alert type including: symptom description, impact assessment, investigation steps, and resolution procedures
5. THE Monitoring_System SHALL provide a deployment guide with step-by-step instructions for initial setup: database schema migration, environment variable configuration, and feature enablement
6. THE Monitoring_System SHALL provide a troubleshooting guide for common issues: missing metrics, alert delivery failures, dashboard loading errors, and performance degradation
7. THE Monitoring_System SHALL include example queries for common monitoring tasks: error rate calculation, slow query identification, tenant-specific metrics extraction
8. THE Monitoring_System SHALL provide a cost estimation worksheet showing expected resource usage (database storage, Analytics Engine events, alert delivery volume) at different scale levels
9. THE Monitoring_System SHALL document the monitoring data schema with entity-relationship diagrams showing table relationships and key constraints
10. THE Monitoring_System SHALL provide migration documentation for transitioning from console.log to Structured_Logger with code examples
