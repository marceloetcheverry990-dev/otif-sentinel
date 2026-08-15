// src/monitoring/health.js
// Health Check Service for Stability and Monitoring System
// Implements Requirements 1.1-1.10 and 9.7

import { MONITORING_CONFIG } from './config.js';
import { CONFIG } from '../config.js';
import pg from 'pg';

const { Client } = pg;

/**
 * In-memory cache for health check results
 * Reduces redundant checks when multiple concurrent requests occur
 * Format: { result: Object, timestamp: number }
 */
let healthCheckCache = null;

/**
 * Health check handler for /health endpoint
 * 
 * Validates operational status of critical system components:
 * - PostgreSQL database (via Hyperdrive)
 * - R2 storage bucket
 * - Cloudflare Queues
 * 
 * Returns HTTP 200 when all components are operational (status: "healthy")
 * Returns HTTP 503 when any critical component fails (status: "unhealthy")
 * 
 * Implements 10-second caching to reduce redundant checks under concurrent load.
 * 
 * @param {Request} request - Incoming HTTP request
 * @param {Env} env - Worker environment bindings (HYPERDRIVE, chat_photos, MAIN_QUEUE, etc.)
 * @returns {Promise<Response>} - JSON health status (200 OK or 503 Service Unavailable)
 * 
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.8, 1.9, 1.10, 9.7**
 */
export async function handleHealthCheck(request, env) {
  const now = Date.now();
  
  // Check cache validity (10-second cache as per operational.health_check_cache_seconds)
  if (healthCheckCache && (now - healthCheckCache.timestamp) < (MONITORING_CONFIG.operational.health_check_cache_seconds * 1000)) {
    // Return cached result
    return new Response(
      JSON.stringify(healthCheckCache.result),
      {
        status: healthCheckCache.result.status === 'healthy' ? 200 : 503,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${MONITORING_CONFIG.operational.health_check_cache_seconds}`,
        },
      }
    );
  }

  // Execute health checks with timeout
  const healthCheckPromise = checkComponents(env);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error('Health check timeout')),
      MONITORING_CONFIG.operational.health_check_timeout_ms
    )
  );

  let components;
  try {
    components = await Promise.race([healthCheckPromise, timeoutPromise]);
  } catch (error) {
    // Timeout or unexpected error during health check
    const errorResult = {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      service: MONITORING_CONFIG.service.name,
      version: MONITORING_CONFIG.service.version,
      region: 'auto',
      components: {
        database: { status: 'error', error: error.message },
        storage: { status: 'unknown' },
        queues: { status: 'unknown' },
      },
      error: 'Health check failed',
    };

    return new Response(
      JSON.stringify(errorResult),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      }
    );
  }

  // Determine overall status
  const allHealthy = components.database.status === 'connected' &&
                     components.storage.status === 'accessible' &&
                     components.queues.status === 'available';

  const overallStatus = allHealthy ? 'healthy' : 'unhealthy';

  // Build response object
  const result = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    service: MONITORING_CONFIG.service.name,
    version: MONITORING_CONFIG.service.version,
    region: 'auto', // Cloudflare Workers region (auto-selected)
    components,
  };

  // Cache the result
  healthCheckCache = {
    result,
    timestamp: now,
  };

  // Return response
  return new Response(
    JSON.stringify(result),
    {
      status: allHealthy ? 200 : 503,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${MONITORING_CONFIG.operational.health_check_cache_seconds}`,
      },
    }
  );
}

/**
 * Check individual component health (internal function)
 * 
 * Performs lightweight checks on critical system components:
 * 1. Database: SELECT 1 with 200ms timeout
 * 2. R2 Storage: bucket.head() operation
 * 3. Queues: Verify queue bindings exist
 * 
 * Measures database latency during check and includes in response.
 * 
 * @param {Env} env - Worker environment bindings
 * @returns {Promise<Object>} - { database: {status, latency_ms?}, storage: {status}, queues: {status, bindings?} }
 * 
 * **Validates: Requirements 1.4, 1.5, 1.6, 1.7**
 */
async function checkComponents(env) {
  const components = {
    database: { status: 'disconnected' },
    storage: { status: 'inaccessible' },
    queues: { status: 'unavailable' },
  };

  // Check Database (PostgreSQL via Hyperdrive)
  try {
    const dbStartTime = Date.now();
    
    const client = new Client(CONFIG.DB_OPTS(env));
    
    // Connect with timeout
    const connectPromise = client.connect();
    const connectTimeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Connection timeout')),
        MONITORING_CONFIG.operational.db_health_check_timeout_ms
      )
    );
    
    await Promise.race([connectPromise, connectTimeout]);

    // Execute SELECT 1 with timeout
    const queryPromise = client.query('SELECT 1 AS health_check');
    const queryTimeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Query timeout')),
        MONITORING_CONFIG.operational.db_health_check_timeout_ms
      )
    );
    
    await Promise.race([queryPromise, queryTimeout]);
    
    const dbLatency = Date.now() - dbStartTime;
    
    // Close connection
    await client.end();

    components.database = {
      status: 'connected',
      latency_ms: dbLatency,
    };
  } catch (error) {
    components.database = {
      status: 'disconnected',
      error: `${error.name}: ${error.message}`,
    };
  }

  // Check R2 Storage (chat_photos bucket)
  try {
    if (!env.chat_photos) {
      throw new Error('R2 bucket binding not found');
    }

    // Perform lightweight head operation on a known key (or just verify bucket exists)
    // We'll use a lightweight check - just verify the binding is accessible
    // For a more thorough check, we could do: await env.chat_photos.head('health-check-marker')
    // But for now, verifying the binding exists is sufficient
    
    // Try to list with limit 1 to verify bucket is accessible
    const listResult = await env.chat_photos.list({ limit: 1 });
    
    components.storage = {
      status: 'accessible',
    };
  } catch (error) {
    components.storage = {
      status: 'inaccessible',
      error: `${error.name}: ${error.message}`,
    };
  }

  // Check Queues (verify bindings exist)
  try {
    const queueBindings = [];
    
    // Check all three queue bindings
    if (env.MAIN_QUEUE) queueBindings.push('MAIN_QUEUE');
    if (env.ENRICHMENT_QUEUE) queueBindings.push('ENRICHMENT_QUEUE');
    if (env.DELIVERY_QUEUE) queueBindings.push('DELIVERY_QUEUE');

    if (queueBindings.length === 0) {
      throw new Error('No queue bindings found');
    }

    components.queues = {
      status: 'available',
      bindings: queueBindings,
    };
  } catch (error) {
    components.queues = {
      status: 'unavailable',
      error: `${error.name}: ${error.message}`,
    };
  }

  return components;
}
