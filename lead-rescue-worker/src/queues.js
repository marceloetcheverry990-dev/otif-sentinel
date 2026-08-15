// src/queues.js — Ingesta, enriquecimiento con IA, y cierre de outbox (delivery interno).
import { Client } from 'pg';
import { CONFIG } from './config.js';
import { withDbTransaction, safeRollback, recordEventTx, classifyError } from './db.js';
import { getExponentialBackoff } from './utils.js';
import { evaluateOTRiskWithOpenAI } from './ai.js';
import { withQueueMonitoring } from './monitoring/queue-middleware.js';

// Wrapped with monitoring middleware - Task 4.6
export const processIngestionQueue = withQueueMonitoring(
  async function processIngestionQueueInternal(batch, env, ctx) {
    const validOTs = batch.messages.map(m => m.body).filter(Boolean);
    if (validOTs.length === 0) return batch.ackAll();

    try {
      await withDbTransaction(env, async (client) => {
        await client.query("SET statement_timeout = 5000");

        const insertedIds = new Set();
        for (let i = 0; i < validOTs.length; i += CONFIG.BATCH_SIZE) {
          const chunk = validOTs.slice(i, i + CONFIG.BATCH_SIZE);
          const values = chunk.map((l, idx) => `($${idx*4+1}, $${idx*4+2}, $${idx*4+3}::jsonb, $${idx*4+4})`).join(',');
          const params = chunk.flatMap(l => [l.ot_id, l.created_at, JSON.stringify(l.data), l.t]);
          
          const res = await client.query(`
            INSERT INTO transaction_logs (ot_id, created_at, metadata, trace_id)
            VALUES ${values}
            ON CONFLICT (ot_id) DO NOTHING
            RETURNING ot_id
          `, params);
          
          res.rows.forEach(r => insertedIds.add(r.ot_id));
        }
        
        for (const msg of batch.messages) {
          if (insertedIds.has(msg.body.ot_id)) {
            await env.ENRICHMENT_QUEUE.send(msg.body, { contentType: 'json' });
          }
          msg.ack();
        }
      });
    } catch (err) {
      console.error("[INGESTION_FAIL]", err.message);
      return batch.retryAll();
    }
  },
  { queueName: 'MAIN_QUEUE', component: 'ingestion-processor' }
);

// Wrapped with monitoring middleware - Task 4.6
export const processEnrichmentQueue = withQueueMonitoring(
  async function processEnrichmentQueueInternal(batch, env, ctx) {
    const client = new Client(CONFIG.DB_OPTS(env));
  let isCircuitActive = false;
  let circuitExpiresAt = null;

  try {
    await client.connect();
    await client.query("SET statement_timeout = 5000");

    for (const msg of batch.messages) {
      let inTx = false;
      const { ot_id: otId, data: otData, t: traceId, outboxId: originOutboxId } = msg.body;
      
      try {
        if (circuitExpiresAt === null) {
          const circuitQuery = await client.query(`SELECT value, expires_at FROM system_flags WHERE key = 'openai_breaker'`);
          const row = circuitQuery.rows[0] || { value: 'CLOSED', expires_at: null };
          circuitExpiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
          isCircuitActive = row.value === 'OPEN' && Date.now() < circuitExpiresAt;
        } else if (isCircuitActive && Date.now() > circuitExpiresAt) {
           await client.query(`UPDATE system_flags SET value = 'CLOSED', expires_at = NULL WHERE key = 'openai_breaker'`).catch(()=>{});
           isCircuitActive = false; 
        }

        const metaCheck = originOutboxId ? await client.query(`SELECT retry_count FROM outbox_events WHERE id = $1`, [originOutboxId]) : null;
        const trueAttempts = metaCheck?.rows?.[0]?.retry_count || 0;

        if (isCircuitActive) { 
          if (originOutboxId) await client.query(`UPDATE outbox_events SET retry_count = retry_count + 1, last_error = 'OAI_CIRCUIT_OPEN' WHERE id = $1`, [originOutboxId]).catch(()=>{});
          msg.retry({ delaySeconds: getExponentialBackoff(trueAttempts) }); 
          continue; 
        }

        if (trueAttempts >= CONFIG.MAX_ENRICHMENT_ATTEMPTS) {
          if (originOutboxId) await client.query(`UPDATE outbox_events SET processed_at = NOW() WHERE id = $1`, [originOutboxId]).catch(()=>{});
          await client.query(`INSERT INTO dead_letter_events (ot_id, payload, reason, error_detail, trace_id, event_type) VALUES ($1, $2, 'MAX_RETRIES_ENRICH', 'Breaker/Timeout loop', $3, 'ENRICHMENT')`, [otId, JSON.stringify(msg.body), traceId]).catch(()=>{});
          msg.ack(); continue;
        }
        
        const lock = await client.query(`
          UPDATE transaction_logs 
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'enrichment_locked_until', (NOW() + INTERVAL '2 minutes'),
            'ai_attempts', COALESCE((metadata->>'ai_attempts')::int, 0) + 1
          ) 
          WHERE ot_id = $1 
            AND processed_at IS NULL
            AND (
                 (metadata->>'enrichment_locked_until' IS NULL)
              OR ((metadata->>'enrichment_locked_until')::timestamp < NOW())
            )
          RETURNING ot_id
        `, [otId]);

        if (lock.rowCount === 0) {
          msg.ack(); 
          continue;
        }
        
        const aiAnalysis = await evaluateOTRiskWithOpenAI(otData, env, client);
        
        await client.query('BEGIN');
        inTx = true;
        const res = await client.query(`UPDATE transaction_logs SET processed_at = NOW(), metadata = (metadata - 'enrichment_locked_until') || jsonb_build_object('analysis', $1::jsonb) WHERE ot_id = $2 AND processed_at IS NULL RETURNING ot_id`, [JSON.stringify(aiAnalysis), otId]);
        
        if (res.rowCount > 0) {
          if (originOutboxId) await client.query(`UPDATE outbox_events SET processed_at = NOW() WHERE id = $1`, [originOutboxId]);
          const idempotencyKey = `${otId}:SEND_TO_DELIVERY`;
          const outbox = await client.query(`INSERT INTO outbox_events (ot_id, event_type, idempotency_key, priority, payload) VALUES ($1, 'SEND_TO_DELIVERY', $2, 0, $3) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [otId, idempotencyKey, JSON.stringify({ otId, t: traceId, aiAnalysis })]);
          await recordEventTx(client, otId, traceId, 'ENRICHED', { riesgo: aiAnalysis.ia.riesgo, score: aiAnalysis.ia.risk_score });
          
          if (outbox.rowCount > 0) {
            await env.DELIVERY_QUEUE.send({ otId, t: traceId, outboxId: outbox.rows[0].id }, { contentType: 'json' });
          }
          await client.query('COMMIT');
          inTx = false;
          msg.ack();
        } else { 
          await safeRollback(client); inTx = false; 
          const check = await client.query(`SELECT processed_at FROM transaction_logs WHERE ot_id = $1`, [otId]);
          if (check.rows[0]?.processed_at) { msg.ack(); } 
          else { throw new Error("OT_NOT_FOUND_OR_RACE_CONDITION"); }
        }
      } catch (innerErr) { 
        if (inTx) await safeRollback(client);
        inTx = false;
        
        const errorType = classifyError(innerErr, innerErr.message.startsWith('OPENAI_HTTP_') ? parseInt(innerErr.message.split('_')[2], 10) : null);
        
        try {
          await client.query(`UPDATE transaction_logs SET metadata = metadata - 'enrichment_locked_until' WHERE ot_id = $1`, [otId]).catch(()=>{});
          
          if (errorType === 'RATE_LIMIT' || errorType === 'SERVER_ERROR') {
            await client.query(`
              INSERT INTO system_flags (key, value, expires_at) 
              VALUES ('openai_breaker', 'OPEN', NOW() + INTERVAL '2 minutes')
              ON CONFLICT (key) DO UPDATE 
              SET value = 'OPEN', expires_at = GREATEST(system_flags.expires_at, NOW() + INTERVAL '2 minutes')
            `);
            isCircuitActive = true; 
            circuitExpiresAt = Date.now() + 120000;
          }

          const metaCheckFail = originOutboxId ? await client.query(`SELECT retry_count FROM outbox_events WHERE id = $1`, [originOutboxId]) : null;
          const currentDbAttempts = metaCheckFail?.rows?.[0]?.retry_count || 0;

          if (originOutboxId) {
             await client.query(`UPDATE outbox_events SET retry_count = retry_count + 1, last_error = $1 WHERE id = $2`, [innerErr.message, originOutboxId]).catch(()=>{});
          }
          msg.retry({ delaySeconds: getExponentialBackoff(currentDbAttempts) }); 
        } catch (recoveryErr) {
          msg.retry({ delaySeconds: 60 }); 
        }
      }
    }
  } catch (err) {
    console.error("[ENRICHMENT_QUEUE_FATAL]", err.message);
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
},
{ queueName: 'ENRICHMENT_QUEUE', component: 'enrichment-processor' }
);

// Delivery = cierre interno de outbox. El análisis queda en Torre /reporte (sin canal externo).
export const processDeliveryQueue = withQueueMonitoring(
  async function processDeliveryQueueInternal(batch, env) {
  const client = new Client(CONFIG.DB_OPTS(env));

  try {
    await client.connect();
    await client.query("SET statement_timeout = 5000");

    for (const msg of batch.messages) {
      let inTx = false;
      const { otId, outboxId, t: traceId } = msg.body || {};

      try {
        if (!otId || !outboxId) { msg.ack(); continue; }

        const metaCheck = await client.query(`SELECT retry_count FROM outbox_events WHERE id = $1`, [outboxId]);
        const trueRetries = metaCheck.rows[0]?.retry_count || 0;

        if (trueRetries >= CONFIG.MAX_DELIVERY_ATTEMPTS) {
          try {
            await client.query(
              `INSERT INTO dead_letter_events (ot_id, trace_id, event_type, payload, reason)
               VALUES ($1, $2, 'DELIVERY', $3, 'MAX_RETRIES')`,
              [otId, traceId, JSON.stringify(msg.body)]
            );
            await client.query(`UPDATE outbox_events SET processed_at = NOW() WHERE id = $1`, [outboxId]);
          } catch (_) { /* best-effort DLQ */ }
          msg.ack();
          continue;
        }

        await client.query('BEGIN');
        inTx = true;

        const lockCheck = await client.query(
          `SELECT delivered_at FROM transaction_logs WHERE ot_id = $1 FOR UPDATE SKIP LOCKED`,
          [otId]
        );
        if (lockCheck.rowCount === 0) {
          await safeRollback(client);
          inTx = false;
          msg.retry({ delaySeconds: getExponentialBackoff(trueRetries, 30) });
          continue;
        }

        if (lockCheck.rows[0].delivered_at !== null) {
          await client.query(`UPDATE outbox_events SET processed_at = NOW() WHERE id = $1`, [outboxId]).catch(() => {});
          await safeRollback(client);
          inTx = false;
          msg.ack();
          continue;
        }

        const finalUpdate = await client.query(
          `UPDATE transaction_logs
           SET delivered_at = NOW(),
               external_idempotency_key = NULL,
               external_idempotency_key_set_at = NULL,
               delivery_attempted_at = COALESCE(delivery_attempted_at, NOW()),
               delivery_latency_ms = CASE
                 WHEN created_at IS NOT NULL THEN EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000
                 ELSE NULL
               END
           WHERE ot_id = $1 AND delivered_at IS NULL
           RETURNING ot_id`,
          [otId]
        );

        if (finalUpdate.rowCount > 0) {
          await client.query(`UPDATE outbox_events SET processed_at = NOW() WHERE id = $1`, [outboxId]);
          await recordEventTx(client, otId, traceId, 'DELIVERED', { channel: 'internal' });
        }

        await client.query('COMMIT');
        inTx = false;
        msg.ack();
      } catch (e) {
        if (inTx) await safeRollback(client);
        inTx = false;
        try {
          const metaCheckFail = await client.query(`SELECT retry_count FROM outbox_events WHERE id = $1`, [outboxId]);
          const currentDbAttempts = metaCheckFail.rows[0]?.retry_count || 0;
          if (outboxId) {
            await client.query(
              `UPDATE outbox_events SET retry_count = retry_count + 1, last_error = $1 WHERE id = $2`,
              [e.message, outboxId]
            );
          }
          msg.retry({ delaySeconds: getExponentialBackoff(currentDbAttempts) });
        } catch (cleanupErr) {
          console.warn('[DELIVERY_CLEANUP_WARN]', cleanupErr.message);
          msg.retry({ delaySeconds: 60 });
        }
      }
    }
  } catch (err) {
    console.error('[DELIVERY_QUEUE_FATAL]', err);
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
},
{ queueName: 'DELIVERY_QUEUE', component: 'delivery-processor' }
);