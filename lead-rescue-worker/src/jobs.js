// src/jobs.js
import { CONFIG, WebhookSchema } from './config.js';
import { withDb } from './db.js';
import {
  alertTypeForKind,
  evaluateDeadMan,
} from './helpers/dead-man-switch.js';
const LR = () => CONFIG.LEAD_RESCUE || {};

export async function runOutboxRecovery(env) {
  try {
    await withDb(env, async (client) => {
      await client.query("SET statement_timeout = 5000");

      // Fase 1: transacción manual — mover OTs a dead_letter y eliminar de outbox
      await client.query('BEGIN');
      try {
        await client.query(`
          INSERT INTO dead_letter_events (ot_id, payload, reason, error_detail, trace_id, event_type) 
          SELECT ot_id, payload, 'MAX_RETRIES', last_error, (payload->>'t'), event_type 
          FROM outbox_events WHERE retry_count >= $1
          ON CONFLICT DO NOTHING
        `, [CONFIG.MAX_DELIVERY_ATTEMPTS]);
        await client.query(`DELETE FROM outbox_events WHERE retry_count >= $1`, [CONFIG.MAX_DELIVERY_ATTEMPTS]);
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      }

      // Fase 2: sweep no-transaccional sobre el mismo client
      const sweep = await client.query(`WITH cte AS (SELECT id FROM outbox_events WHERE processed_at IS NULL AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '2 minutes') AND retry_count < $1 ORDER BY retry_count ASC, created_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED) UPDATE outbox_events o SET locked_at = NOW() FROM cte WHERE o.id = cte.id RETURNING o.id, o.ot_id, o.payload, o.event_type`, [CONFIG.MAX_DELIVERY_ATTEMPTS, CONFIG.BATCH_SIZE]);
      
      for (const row of sweep.rows) {
        try {
          const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
          const targetQueue = row.event_type === 'SEND_TO_ENRICHMENT' ? env.ENRICHMENT_QUEUE : env.DELIVERY_QUEUE;
          await targetQueue.send({ otId: payload.otId, t: payload.t, outboxId: row.id, data: payload.data }, { contentType: 'json' });
        } catch (err) {
          console.error('[SWEEP_QUEUE_FAIL]', err.message);
        }
      }

      const orphanIngestionSweep = await client.query(`
        WITH zombies AS (
          SELECT ot_id, metadata, trace_id 
          FROM transaction_logs 
          WHERE processed_at IS NULL 
            AND delivered_at IS NULL 
            AND (
                 (metadata->>'enrichment_locked_until' IS NULL)
              OR ((metadata->>'enrichment_locked_until')::timestamp < NOW())
            )
            AND created_at < NOW() - INTERVAL '1 minute' 
            AND COALESCE((metadata->>'ai_attempts')::int, 0) < 3
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        SELECT * FROM zombies;
      `, [CONFIG.BATCH_SIZE]);
        
      for (const row of orphanIngestionSweep.rows) {
        try {
          const full = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
          
          const safeNumber = (val) => {
            const num = Number(val);
            return isNaN(num) ? 0 : num;
          };

          // CORRECCIÓN: Validamos que la etapa sea una de las permitidas por el WebhookSchema
          const validEtapas = ["BODEGA", "PICKING", "PACKING", "CAMION_ASIGNADO", "EN_RUTA", "ENTREGADO"];
          const etapaSegura = (full.etapa && validEtapas.includes(full.etapa)) ? full.etapa : "BODEGA";

          const originalData = WebhookSchema.parse({ 
            ot_id: row.ot_id, 
            produccion_estandar: safeNumber(full.produccion_estandar), 
            produccion_real: safeNumber(full.produccion_real), 
            horas_para_sla: safeNumber(full.horas_para_sla), 
            etapa: etapaSegura, 
            minutos_camion_esperando: safeNumber(full.minutos_camion_esperando), 
            cliente: full.cliente || 'Sin Cliente'
          });

          await env.ENRICHMENT_QUEUE.send({ ot_id: row.ot_id, data: originalData, t: row.trace_id }, { contentType: 'json' });
        } catch (err) { 
          console.error(`[ORPHAN_SWEEP_INVALID_PAYLOAD]`, { error: err.message }); 
        }
      }
    });
  } catch (e) { 
    console.error(`[MAINTENANCE_ERR]`, e.message); 
  }
}

export async function alertarRiesgosCriticos(env) {
  // Sin canal push: solo loguea para que ops revise Torre de Control.
  try {
    await withDb(env, async (client) => {
      const resRiesgo = await client.query(`
      SELECT
        o.tenant_id,
        o.trip_id,
        ch.nombre_completo as chofer,
        COUNT(*) as paradas_criticas,
        SUM(o.valor_oc_clp * 0.05) as multa_estimada
      FROM ordenes_pendientes o
      LEFT JOIN choferes ch
        ON ch.tenant_id = o.tenant_id
       AND CAST(ch.chofer_id AS VARCHAR) = CAST(o.chofer_asignado_id AS VARCHAR)
      LEFT JOIN LATERAL (
        SELECT (metadata->'routing'->>'eta')::timestamptz as eta
        FROM transaction_logs
        WHERE ot_id = o.ot_id AND metadata->'routing' IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      ) eta_log ON true
      WHERE o.estado_operacional = 'EN_RUTA'
        AND eta_log.eta > o.fecha_hora_sla
      GROUP BY o.tenant_id, o.trip_id, ch.nombre_completo
    `);

      for (const viaje of resRiesgo.rows) {
        console.info(
          '[CRON_RIESGO]',
          viaje.tenant_id,
          viaje.trip_id,
          viaje.chofer,
          viaje.paradas_criticas,
          viaje.multa_estimada
        );
      }
    });
  } catch (e) {
    console.error('[CRON_ALERT_ERROR]', e.message);
  }
}

/**
 * Dead Man's Switch — detecta camiones quietos / sin señal y abre fleet_alerts.
 * Corre cada ~2 min vía scheduled().
 */
export async function auditarFlotaEnVivo(env) {
  const thresholds = {
    YELLOW_STUCK_MIN: LR().YELLOW_STUCK_MIN,
    RED_STUCK_MIN: LR().RED_STUCK_MIN,
    SIGNAL_LOST_MIN: LR().SIGNAL_LOST_MIN,
    RECENT_PING_MAX_MIN: LR().RECENT_PING_MAX_MIN,
  };

  try {
    await withDb(env, async (client) => {
      let fleet;
      try {
        fleet = await client.query(`
          SELECT fv.tenant_id, fv.trip_id_actual AS trip_id, fv.patente,
                 fv.ultima_lat AS lat, fv.ultima_lng AS lng,
                 fv.ultima_actualizacion,
                 COALESCE(fv.last_significant_move_at, fv.ultima_actualizacion) AS last_significant_move_at,
                 fv.rut_chofer_asignado,
                 ch.nombre_completo AS chofer
          FROM flota_vehiculos fv
          LEFT JOIN choferes ch
            ON ch.tenant_id = fv.tenant_id
           AND ch.rut = fv.rut_chofer_asignado
          WHERE fv.trip_id_actual IS NOT NULL
            AND fv.ultima_lat IS NOT NULL
        `);
      } catch (colErr) {
        if (!String(colErr.message || '').includes('last_significant_move_at')) throw colErr;
        console.warn('[DEAD_MAN_SWITCH] migración 006 pendiente — skip');
        return;
      }

      for (const row of fleet.rows) {
        const enSitio = await client.query(
          `SELECT 1 FROM ordenes_pendientes
           WHERE tenant_id = $1 AND trip_id = $2 AND estado_operacional = 'EN_SITIO'
           LIMIT 1`,
          [row.tenant_id, row.trip_id]
        );

        const verdict = evaluateDeadMan({
          lastSignificantMoveAt: row.last_significant_move_at,
          ultimaActualizacion: row.ultima_actualizacion,
          hasEnSitio: enSitio.rowCount > 0,
          thresholds,
        });

        if (verdict.kind === 'ok') {
          // Auto-resolver alertas abiertas si el camión se movió
          await client.query(
            `UPDATE fleet_alerts
             SET status = 'RESOLVED', updated_at = NOW()
             WHERE tenant_id = $1 AND trip_id = $2
               AND status IN ('OPEN', 'ACKED')
               AND alert_type IN ('STUCK_VEHICLE', 'SIGNAL_LOST')`,
            [row.tenant_id, row.trip_id]
          );
          continue;
        }

        const alertType = alertTypeForKind(verdict.kind);
        const payload = {
          patente: row.patente,
          chofer: row.chofer,
          stuck_minutes: verdict.stuckMinutes,
          kind: verdict.kind,
        };

        const existing = await client.query(
          `SELECT id, severity, notified_at, status
           FROM fleet_alerts
           WHERE tenant_id = $1 AND trip_id = $2 AND alert_type = $3
             AND status IN ('OPEN', 'ACKED', 'RESCUING')
           LIMIT 1`,
          [row.tenant_id, row.trip_id, alertType]
        );

        let alertId;
        let shouldNotify = false;

        if (existing.rowCount) {
          alertId = existing.rows[0].id;
          const prevSev = existing.rows[0].severity;
          const escalated = prevSev === 'YELLOW' && verdict.severity === 'RED';
          await client.query(
            `UPDATE fleet_alerts
             SET severity = $1, stuck_minutes = $2, lat = $3, lng = $4,
                 payload = $5::jsonb, updated_at = NOW()
             WHERE id = $6`,
            [
              verdict.severity,
              verdict.stuckMinutes,
              row.lat,
              row.lng,
              JSON.stringify(payload),
              alertId,
            ]
          );
          shouldNotify =
            existing.rows[0].status !== 'RESCUING' &&
            (!existing.rows[0].notified_at || escalated);
        } else {
          try {
            const ins = await client.query(
              `INSERT INTO fleet_alerts
                 (tenant_id, trip_id, alert_type, severity, status, stuck_minutes, lat, lng, payload)
               VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $7, $8::jsonb)
               RETURNING id`,
              [
                row.tenant_id,
                row.trip_id,
                alertType,
                verdict.severity,
                verdict.stuckMinutes,
                row.lat,
                row.lng,
                JSON.stringify(payload),
              ]
            );
            alertId = ins.rows[0].id;
            shouldNotify = true;
          } catch (insErr) {
            // Unique parcial: otra alerta open concurrente
            if (insErr.code !== '23505') throw insErr;
            const again = await client.query(
              `SELECT id, notified_at, status FROM fleet_alerts
               WHERE tenant_id = $1 AND trip_id = $2 AND alert_type = $3
                 AND status IN ('OPEN','ACKED','RESCUING') LIMIT 1`,
              [row.tenant_id, row.trip_id, alertType]
            );
            alertId = again.rows[0]?.id;
            shouldNotify = again.rows[0] && !again.rows[0].notified_at && again.rows[0].status !== 'RESCUING';
          }
        }

        // Canal de aviso = fila en fleet_alerts (Torre / Lead Rescue). Sin push externo.
        if (shouldNotify && alertId) {
          await client.query(
            `UPDATE fleet_alerts SET notified_at = NOW() WHERE id = $1`,
            [alertId]
          );
          console.info(
            '[DEAD_MAN_SWITCH]',
            row.tenant_id,
            row.trip_id,
            verdict.kind,
            verdict.severity,
            verdict.stuckMinutes
          );
        }
      }

      // Resolver alertas de viajes que ya no están en flota activa
      await client.query(
        `UPDATE fleet_alerts fa
         SET status = 'RESOLVED', updated_at = NOW()
         WHERE fa.status IN ('OPEN', 'ACKED')
           AND NOT EXISTS (
             SELECT 1 FROM flota_vehiculos fv
             WHERE fv.tenant_id = fa.tenant_id
               AND fv.trip_id_actual = fa.trip_id
           )`
      );
    });
  } catch (e) {
    if (e.code === '42P01') {
      console.warn('[DEAD_MAN_SWITCH] tablas fase 0/1 ausentes — aplicar migrations/006_gps_trail_dwell_rescue.sql');
      return;
    }
    console.error('[DEAD_MAN_SWITCH_ERROR]', e.message);
  }
}
