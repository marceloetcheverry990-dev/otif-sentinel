/**
 * Endpoints de operador para cerrar QA E2E (GPS / Lead Rescue / notificaciones / POD).
 * No sustituyen la app del chofer en producción: emiten token de chofer y siembran GPS.
 */
import { CORS_HEADERS, jsonResponse, requireTenantId } from '../config.js';
import { withDb } from '../db.js';
import { signDriverToken } from '../helpers/driver-auth.js';
import { processCustomerNotificationOutbox, enqueueCustomerNotify } from '../helpers/customer-notify.js';
import { isEncryptedSecret, sealSecret } from '../helpers/dte/secret-at-rest.js';

/**
 * POST /api/admin/qa/driver-token
 * body: { chofer_id?: string, rut?: string }
 */
export async function adminQaDriverToken(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }

  try {
    return await withDb(env, async (client) => {
      let row = null;
      if (body.rut) {
        const r = await client.query(
          `SELECT chofer_id, rut, nombre_completo, patente_asignada
           FROM choferes WHERE tenant_id = $1 AND rut = $2 LIMIT 1`,
          [tenant_id, String(body.rut)]
        );
        row = r.rows[0] || null;
      } else if (body.chofer_id != null) {
        const r = await client.query(
          `SELECT chofer_id, rut, nombre_completo, patente_asignada
           FROM choferes
           WHERE tenant_id = $1 AND CAST(chofer_id AS VARCHAR) = CAST($2 AS VARCHAR)
           LIMIT 1`,
          [tenant_id, String(body.chofer_id)]
        );
        row = r.rows[0] || null;
      } else {
        const r = await client.query(
          `SELECT chofer_id, rut, nombre_completo, patente_asignada
           FROM choferes WHERE tenant_id = $1
           ORDER BY nombre_completo ASC NULLS LAST LIMIT 1`,
          [tenant_id]
        );
        row = r.rows[0] || null;
      }
      if (!row?.rut) {
        return jsonResponse({ error: 'Chofer no encontrado (falta rut)' }, 404);
      }

      const token = await signDriverToken(
        { chofer_id: row.chofer_id, rut: row.rut, tenant_id },
        env
      );
      return jsonResponse({
        exito: true,
        token,
        chofer: {
          chofer_id: row.chofer_id,
          rut: row.rut,
          nombre: row.nombre_completo,
          patente: row.patente_asignada,
        },
      });
    }, { tenantId: tenant_id });
  } catch (e) {
    console.error('[ADMIN_QA_DRIVER_TOKEN]', e.message);
    return jsonResponse({ error: e.message }, 500);
  }
}

/**
 * POST /api/admin/qa/seed-fleet-gps
 * body: { trip_id, lat, lng, patente?, rut? }
 * Upsert flota_vehiculos para Lead Rescue / gps/live.
 */
export async function adminQaSeedFleetGps(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'JSON inválido' }, 400);
  }
  const trip_id = body.trip_id != null ? String(body.trip_id) : null;
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!trip_id || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return jsonResponse({ error: 'trip_id, lat y lng requeridos' }, 400);
  }
  if (lat === 0 && lng === 0) {
    return jsonResponse({ error: 'GPS 0,0 no válido' }, 400);
  }

  try {
    return await withDb(env, async (client) => {
      // Resolver patente / rut desde chofer del viaje
      const ord = await client.query(
        `SELECT chofer_asignado_id FROM ordenes_pendientes
         WHERE tenant_id = $1 AND trip_id = $2 AND chofer_asignado_id IS NOT NULL
         LIMIT 1`,
        [tenant_id, trip_id]
      );
      let patente = body.patente ? String(body.patente) : null;
      let rut = body.rut ? String(body.rut) : null;
      const choferId = ord.rows[0]?.chofer_asignado_id;
      if (choferId != null) {
        const ch = await client.query(
          `SELECT rut, patente_asignada FROM choferes
           WHERE tenant_id = $1 AND CAST(chofer_id AS VARCHAR) = CAST($2 AS VARCHAR)
           LIMIT 1`,
          [tenant_id, String(choferId)]
        );
        if (ch.rows[0]) {
          rut = rut || ch.rows[0].rut;
          patente = patente || ch.rows[0].patente_asignada;
        }
      }
      if (!patente) patente = `QA-${String(trip_id).slice(-8)}`;
      if (!rut) rut = '11111111-1';

      // Intentos de upsert según schema
      const attempts = [
        {
          sql: `INSERT INTO flota_vehiculos
                  (tenant_id, patente, trip_id_actual, ultima_lat, ultima_lng, rut_chofer_asignado, estado, ultima_actualizacion)
                VALUES ($1,$2,$3,$4,$5,$6,'EN_RUTA', NOW())
                ON CONFLICT (tenant_id, patente) DO UPDATE SET
                  trip_id_actual = EXCLUDED.trip_id_actual,
                  ultima_lat = EXCLUDED.ultima_lat,
                  ultima_lng = EXCLUDED.ultima_lng,
                  rut_chofer_asignado = EXCLUDED.rut_chofer_asignado,
                  estado = 'EN_RUTA',
                  ultima_actualizacion = NOW()`,
          params: [tenant_id, patente, trip_id, lat, lng, rut],
        },
        {
          sql: `UPDATE flota_vehiculos
                 SET trip_id_actual = $3,
                     ultima_lat = $4,
                     ultima_lng = $5,
                     rut_chofer_asignado = $6,
                     ultima_actualizacion = NOW()
                 WHERE tenant_id = $1 AND patente = $2`,
          params: [tenant_id, patente, trip_id, lat, lng, rut],
        },
        {
          sql: `UPDATE flota_vehiculos
                 SET trip_id_actual = $2,
                     ultima_lat = $3,
                     ultima_lng = $4,
                     rut_chofer_asignado = COALESCE($5, rut_chofer_asignado),
                     ultima_actualizacion = NOW()
                 WHERE tenant_id = $1 AND trip_id_actual = $2`,
          params: [tenant_id, trip_id, lat, lng, rut],
        },
      ];

      let lastErr = null;
      for (let i = 0; i < attempts.length; i++) {
        const sp = `sp_qa_gps_${i}`;
        try {
          await client.query(`SAVEPOINT ${sp}`);
          const r = await client.query(attempts[i].sql, attempts[i].params);
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          if (r.rowCount > 0 || i === 0) {
            return jsonResponse({
              exito: true,
              trip_id,
              patente,
              rut,
              lat,
              lng,
              mode: i === 0 ? 'upsert' : 'update',
            });
          }
        } catch (e) {
          lastErr = e;
          try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch (_) { /* ignore */ }
        }
      }
      throw lastErr || new Error('No se pudo sembrar GPS de flota');
    }, { tenantId: tenant_id });
  } catch (e) {
    console.error('[ADMIN_QA_SEED_GPS]', e.message);
    return jsonResponse({ error: e.message, detalle: e.message }, 500);
  }
}

/**
 * POST /api/admin/notifications/flush
 * Procesa outbox PENDING (SMS/email).
 */
export async function adminFlushNotifications(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }

  // Encolar manual opcional
  if (body.enqueue && body.ot_id && body.event_type) {
    await enqueueCustomerNotify(env, {
      tenantId: tenant_id,
      otId: String(body.ot_id),
      tripId: body.trip_id ? String(body.trip_id) : null,
      eventType: String(body.event_type),
      trackingUrl: body.tracking_url || null,
    });
  }

  const result = await processCustomerNotificationOutbox(env, { limit: Number(body.limit) || 40 });

  // Snapshot reciente
  let recent = [];
  try {
    recent = await withDb(env, async (client) => {
      const r = await client.query(
        `SELECT id, ot_id, event_type, channel, to_address, status, error, provider_id, created_at, sent_at
         FROM customer_notifications
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [tenant_id]
      );
      return r.rows;
    }, { tenantId: tenant_id });
  } catch (e) {
    recent = [{ error: e.message }];
  }

  const twilio = {
    sid: Boolean(env.TWILIO_ACCOUNT_SID),
    token: Boolean(env.TWILIO_AUTH_TOKEN),
    from: Boolean(env.TWILIO_FROM_NUMBER),
  };
  const resend = {
    key: Boolean(env.RESEND_API_KEY),
    from: Boolean(env.RESEND_FROM_EMAIL),
  };

  return jsonResponse({
    exito: true,
    processed: result.processed,
    pending_seen: result.pending_seen,
    results: result.results,
    error: result.error || null,
    providers: { twilio, resend },
    recent,
  });
}

/**
 * POST /api/admin/qa/ot-scan-token
 * body: { ot_id }
 */
export async function adminQaOtScanToken(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'JSON inválido' }, 400);
  }
  const ot_id = body.ot_id != null ? String(body.ot_id) : null;
  if (!ot_id) return jsonResponse({ error: 'ot_id requerido' }, 400);

  try {
    return await withDb(env, async (client) => {
      const r = await client.query(
        `SELECT ot_id, trip_id, metadata FROM ordenes_pendientes
         WHERE tenant_id = $1 AND ot_id = $2 LIMIT 1`,
        [tenant_id, ot_id]
      );
      if (!r.rowCount) return jsonResponse({ error: 'OT no encontrada' }, 404);
      let meta = r.rows[0].metadata;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
      }
      meta = meta || {};
      return jsonResponse({
        exito: true,
        ot_id,
        trip_id: r.rows[0].trip_id,
        scan_token: meta.scan_token || null,
      });
    }, { tenantId: tenant_id });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

async function tableColumns(client, table) {
  const r = await client.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return r.rows;
}

/**
 * POST /api/admin/qa/schema-status
 * Inspecciona columnas críticas (012 + 013).
 */
export async function adminQaSchemaStatus(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  try {
    return await withDb(env, async (client) => {
      const ordenes = await tableColumns(client, 'ordenes_pendientes');
      const choferes = await tableColumns(client, 'choferes');
      const tenantSettings = await tableColumns(client, 'tenant_settings');
      const names = (rows) => new Set(rows.map((r) => r.column_name));
      const o = names(ordenes);
      const c = names(choferes);
      const t = names(tenantSettings);

      let customerNotifications = false;
      try {
        const r = await client.query(
          `SELECT to_regclass('public.customer_notifications') AS reg`
        );
        customerNotifications = Boolean(r.rows[0]?.reg);
      } catch { /* ignore */ }

      const need012 = {
        peso_kg: o.has('peso_kg'),
        ventana_inicio: o.has('ventana_inicio'),
        ventana_fin: o.has('ventana_fin'),
        firma_url: o.has('firma_url'),
        capacidad_peso: c.has('capacidad_peso'),
        notify_sms_enabled: t.has('notify_sms_enabled'),
        pod_requirements: t.has('pod_requirements'),
        customer_notifications: customerNotifications,
      };
      const need013 = {
        lat: o.has('lat'),
        lng: o.has('lng'),
        tags_requeridos: o.has('tags_requeridos'),
      };

      return jsonResponse({
        exito: true,
        tenant_id,
        mig_012_ok: Object.values(need012).every(Boolean),
        mig_013_ok: Object.values(need013).every(Boolean),
        mig_012: need012,
        mig_013: need013,
      });
    }, { tenantId: tenant_id });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

/**
 * POST /api/admin/qa/apply-schema
 * Aplica migraciones 012 + 013 + 014 + 015 (idempotente ADD IF NOT EXISTS + backfill).
 */
export async function adminQaApplySchema(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  const steps = [];
  try {
    await withDb(env, async (client) => {
      const run = async (label, sql) => {
        await client.query(sql);
        steps.push({ step: label, ok: true });
      };

      // ── 012 ────────────────────────────────────────────────────────────
      await run('012_ordenes_cols', `
        ALTER TABLE ordenes_pendientes
          ADD COLUMN IF NOT EXISTS peso_kg NUMERIC DEFAULT 0,
          ADD COLUMN IF NOT EXISTS ventana_inicio TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS ventana_fin TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS firma_url TEXT`);
      await run('012_choferes_capacidad_peso', `
        ALTER TABLE choferes
          ADD COLUMN IF NOT EXISTS capacidad_peso NUMERIC DEFAULT 99999`);
      await run('012_tenant_settings', `
        ALTER TABLE tenant_settings
          ADD COLUMN IF NOT EXISTS notify_sms_enabled BOOLEAN NOT NULL DEFAULT true,
          ADD COLUMN IF NOT EXISTS notify_email_enabled BOOLEAN NOT NULL DEFAULT true,
          ADD COLUMN IF NOT EXISTS brand_name VARCHAR(120),
          ADD COLUMN IF NOT EXISTS pod_requirements JSONB NOT NULL DEFAULT '{"foto":true,"firma":true,"scan":true,"notas":false}'::jsonb`);
      await run('012_customer_notifications', `
        CREATE TABLE IF NOT EXISTS customer_notifications (
          id            BIGSERIAL PRIMARY KEY,
          tenant_id     VARCHAR(64) NOT NULL,
          ot_id         TEXT NOT NULL,
          trip_id       TEXT,
          event_type    VARCHAR(32) NOT NULL,
          channel       VARCHAR(16) NOT NULL,
          to_address    TEXT,
          payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
          status        VARCHAR(16) NOT NULL DEFAULT 'PENDING',
          provider_id   TEXT,
          error         TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          sent_at       TIMESTAMPTZ,
          CONSTRAINT customer_notifications_event_chk
            CHECK (event_type IN ('DESPACHADO', 'ETA_15MIN', 'ENTREGADO')),
          CONSTRAINT customer_notifications_channel_chk
            CHECK (channel IN ('sms', 'email')),
          CONSTRAINT customer_notifications_status_chk
            CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED'))
        )`);
      await run('012_idx_pending_sent', `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_notifications_pending_sent
          ON customer_notifications (tenant_id, ot_id, event_type, channel)
          WHERE status IN ('PENDING', 'SENT')`);
      await run('012_idx_pending', `
        CREATE INDEX IF NOT EXISTS idx_customer_notifications_pending
          ON customer_notifications (status, created_at)
          WHERE status = 'PENDING'`);

      // ── 013 ────────────────────────────────────────────────────────────
      await run('013_coords_tags_cols', `
        ALTER TABLE ordenes_pendientes
          ADD COLUMN IF NOT EXISTS lat NUMERIC,
          ADD COLUMN IF NOT EXISTS lng NUMERIC,
          ADD COLUMN IF NOT EXISTS tags_requeridos JSONB`);
      await run('013_backfill_lat', `
        UPDATE ordenes_pendientes
        SET lat = (metadata->>'lat_destino')::numeric
        WHERE lat IS NULL
          AND metadata ? 'lat_destino'
          AND (metadata->>'lat_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          AND ABS((metadata->>'lat_destino')::numeric) <= 90
          AND (metadata->>'lat_destino')::numeric <> 0`);
      await run('013_backfill_lng', `
        UPDATE ordenes_pendientes
        SET lng = (metadata->>'lng_destino')::numeric
        WHERE lng IS NULL
          AND metadata ? 'lng_destino'
          AND (metadata->>'lng_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          AND ABS((metadata->>'lng_destino')::numeric) <= 180
          AND (metadata->>'lng_destino')::numeric <> 0`);
      await run('013_backfill_tags', `
        UPDATE ordenes_pendientes
        SET tags_requeridos = metadata->'tags_requeridos'
        WHERE (tags_requeridos IS NULL OR tags_requeridos = '[]'::jsonb)
          AND metadata ? 'tags_requeridos'
          AND jsonb_typeof(metadata->'tags_requeridos') = 'array'`);
      await run('013_idx_lat_lng', `
        CREATE INDEX IF NOT EXISTS idx_ordenes_pendientes_tenant_lat_lng
          ON ordenes_pendientes (tenant_id)
          WHERE lat IS NOT NULL AND lng IS NOT NULL`);

      // ── 014 Res. 154 guías ─────────────────────────────────────────────
      await run('014_depots_postal', `
        ALTER TABLE depots
          ADD COLUMN IF NOT EXISTS direccion TEXT,
          ADD COLUMN IF NOT EXISTS comuna VARCHAR(64)`);
      await run('014_ordenes_guia_cols', `
        ALTER TABLE ordenes_pendientes
          ADD COLUMN IF NOT EXISTS cantidad NUMERIC,
          ADD COLUMN IF NOT EXISTS tipo_traslado VARCHAR(32)`);
      await run('014_guias_despacho', `
        CREATE TABLE IF NOT EXISTS guias_despacho (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id       VARCHAR(64) NOT NULL,
          trip_id         TEXT NOT NULL,
          ot_id           TEXT NOT NULL,
          estado          VARCHAR(16) NOT NULL DEFAULT 'PENDING',
          folio           TEXT,
          track_id        TEXT,
          fecha_emision   TIMESTAMPTZ,
          tipo_traslado   VARCHAR(32),
          conductor_rut   TEXT,
          conductor_nombre TEXT,
          patente         TEXT,
          origen_direccion TEXT,
          origen_comuna    TEXT,
          destino_direccion TEXT,
          destino_comuna    TEXT,
          cantidad        NUMERIC,
          peso_kg         NUMERIC,
          volumen         NUMERIC,
          valor_clp       NUMERIC,
          proveedor       VARCHAR(32),
          payload_enviado JSONB,
          respuesta       JSONB,
          error           TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT guias_despacho_estado_chk
            CHECK (estado IN ('PENDING', 'EMITTING', 'EMITIDA', 'ERROR', 'SKIPPED', 'STUB'))
        )`);
      await run('014_uq_guias_ot', `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_guias_despacho_tenant_ot
          ON guias_despacho (tenant_id, ot_id)`);
      await run('014_idx_guias_trip', `
        CREATE INDEX IF NOT EXISTS idx_guias_despacho_trip
          ON guias_despacho (tenant_id, trip_id)`);
      await run('014_idx_guias_estado', `
        CREATE INDEX IF NOT EXISTS idx_guias_despacho_estado
          ON guias_despacho (tenant_id, estado)
          WHERE estado IN ('PENDING', 'ERROR', 'EMITTING')`);
      // Backfill mínimo Res.154 (solo celdas vacías) para no bloquear emisión en piloto
      await client.query(
        `UPDATE depots
            SET direccion = COALESCE(NULLIF(TRIM(direccion), ''), nombre),
                comuna = COALESCE(NULLIF(TRIM(comuna), ''), 'Maipú')
          WHERE tenant_id = $1
            AND (direccion IS NULL OR TRIM(direccion) = '' OR comuna IS NULL OR TRIM(comuna) = '')`,
        [tenant_id]
      );
      steps.push({ step: '014_backfill_depot_origen', ok: true });
      await client.query(
        `UPDATE clientes
            SET comuna = COALESCE(NULLIF(TRIM(comuna), ''), 'Santiago')
          WHERE tenant_id = $1
            AND (comuna IS NULL OR TRIM(comuna) = '')`,
        [tenant_id]
      );
      steps.push({ step: '014_backfill_clientes_comuna', ok: true });

      // ── 015 auditoría Res.154 ──────────────────────────────────────────
      await run('015_bitacora_server_received', `
        ALTER TABLE bitacora_viajes
          ADD COLUMN IF NOT EXISTS server_received_at TIMESTAMPTZ`);
      await run('015_tenant_dte_cols', `
        ALTER TABLE tenant_settings
          ADD COLUMN IF NOT EXISTS dte_rut_emisor VARCHAR(32),
          ADD COLUMN IF NOT EXISTS dte_razon_social VARCHAR(255),
          ADD COLUMN IF NOT EXISTS dte_ambiente VARCHAR(32),
          ADD COLUMN IF NOT EXISTS dte_provider VARCHAR(32),
          ADD COLUMN IF NOT EXISTS dte_api_token TEXT`);
      await run('015_guias_estado_stub', `
        ALTER TABLE guias_despacho DROP CONSTRAINT IF EXISTS guias_despacho_estado_chk;
        ALTER TABLE guias_despacho
          ADD CONSTRAINT guias_despacho_estado_chk
          CHECK (estado IN ('PENDING', 'EMITTING', 'EMITIDA', 'ERROR', 'SKIPPED', 'STUB'))`);
      await run('015_migrate_stub_folios', `
        UPDATE guias_despacho
           SET estado = 'STUB',
               folio = NULL,
               track_id = NULL,
               error = COALESCE(error, 'Migrado desde stub con folio sintético'),
               updated_at = NOW()
         WHERE estado = 'SKIPPED'
           AND folio LIKE 'STUB-%'`);

      // ── 016 Fase 2 Res.154 (R3/S6–S8) ─────────────────────────────────
      await run('016_guias_phase2_cols', `
        ALTER TABLE guias_despacho
          ADD COLUMN IF NOT EXISTS ts_source VARCHAR(32),
          ADD COLUMN IF NOT EXISTS fecha_estimada_entrega TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS fecha_llegada TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS origen_lat DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS origen_lng DOUBLE PRECISION`);
      await run('016_guias_estado_review', `
        ALTER TABLE guias_despacho DROP CONSTRAINT IF EXISTS guias_despacho_estado_chk;
        ALTER TABLE guias_despacho
          ADD CONSTRAINT guias_despacho_estado_chk
          CHECK (estado IN (
            'PENDING', 'EMITTING', 'EMITIDA', 'ERROR', 'SKIPPED', 'STUB', 'REVIEW'
          ))`);
      await run('016_uq_guias_traslado', `
        DROP INDEX IF EXISTS uq_guias_despacho_tenant_ot;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_guias_despacho_traslado
          ON guias_despacho (tenant_id, ot_id, trip_id, (COALESCE(patente, '')))`);
    }, { tenantId: tenant_id, statementTimeout: 60000 });

    return jsonResponse({ exito: true, applied: steps });
  } catch (e) {
    return jsonResponse({ error: e.message, applied: steps }, 500);
  }
}

/**
 * GET/POST /api/admin/qa/dte-settings — identidad DTE por tenant (R4).
 * GET: estado enmascarado (nunca devuelve el token).
 * POST body: {
 *   dte_provider?, dte_rut_emisor?, dte_razon_social?, dte_ambiente?,
 *   dte_api_token?: string (plaintext; se cifra antes de guardar),
 *   reencrypt_existing?: boolean (sella token plaintext ya guardado)
 * }
 */
export async function adminQaDteSettings(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  if (request.method === 'GET') {
    try {
      return await withDb(env, async (client) => {
        const r = await client.query(
          `SELECT dte_provider, dte_rut_emisor, dte_razon_social, dte_ambiente, dte_api_token
           FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
          [tenant_id]
        );
        const row = r.rows[0] || null;
        const tok = row?.dte_api_token || null;
        return jsonResponse({
          exito: true,
          tenant_id,
          dte_provider: row?.dte_provider || null,
          dte_rut_emisor: row?.dte_rut_emisor || null,
          dte_razon_social: row?.dte_razon_social || null,
          dte_ambiente: row?.dte_ambiente || null,
          dte_api_token_set: Boolean(tok),
          dte_api_token_encrypted: tok ? isEncryptedSecret(tok) : false,
        });
      }, { tenantId: tenant_id });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }

  try {
    return await withDb(env, async (client) => {
      const cur = await client.query(
        `SELECT dte_provider, dte_rut_emisor, dte_razon_social, dte_ambiente, dte_api_token
         FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
        [tenant_id]
      );
      const prev = cur.rows[0] || {};

      let nextToken = prev.dte_api_token || null;
      let sealed = false;
      if (body.dte_api_token != null && String(body.dte_api_token).length > 0) {
        const sealedRes = await sealSecret(String(body.dte_api_token), env);
        nextToken = sealedRes.value;
        sealed = true;
      } else if (body.reencrypt_existing === true && nextToken && !isEncryptedSecret(nextToken)) {
        const sealedRes = await sealSecret(nextToken, env);
        nextToken = sealedRes.value;
        sealed = sealedRes.sealed;
      }

      const provider = body.dte_provider != null
        ? String(body.dte_provider).toLowerCase()
        : (prev.dte_provider || null);
      const rut = body.dte_rut_emisor != null ? String(body.dte_rut_emisor) : (prev.dte_rut_emisor || null);
      const razon = body.dte_razon_social != null
        ? String(body.dte_razon_social)
        : (prev.dte_razon_social || null);
      const ambiente = body.dte_ambiente != null
        ? String(body.dte_ambiente)
        : (prev.dte_ambiente || null);

      await client.query(
        `INSERT INTO tenant_settings (
           tenant_id, dte_provider, dte_rut_emisor, dte_razon_social, dte_ambiente, dte_api_token
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id) DO UPDATE SET
           dte_provider = EXCLUDED.dte_provider,
           dte_rut_emisor = EXCLUDED.dte_rut_emisor,
           dte_razon_social = EXCLUDED.dte_razon_social,
           dte_ambiente = EXCLUDED.dte_ambiente,
           dte_api_token = EXCLUDED.dte_api_token`,
        [tenant_id, provider, rut, razon, ambiente, nextToken]
      );

      return jsonResponse({
        exito: true,
        tenant_id,
        dte_provider: provider,
        dte_rut_emisor: rut,
        dte_razon_social: razon,
        dte_ambiente: ambiente,
        dte_api_token_set: Boolean(nextToken),
        dte_api_token_encrypted: nextToken ? isEncryptedSecret(nextToken) : false,
        sealed_now: sealed,
      });
    }, { tenantId: tenant_id });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

/**
 * POST /api/admin/qa/cleanup
 * body: { apply?: boolean } — default dry-run (solo conteos).
 */
export async function adminQaCleanup(request, env, operator = null) {
  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const apply = body.apply === true;

  try {
    return await withDb(env, async (client) => {
      const spot = await client.query(
        `SELECT COUNT(*)::int AS n FROM ordenes_pendientes
         WHERE tenant_id = $1 AND ot_id LIKE 'SPOT-20260728-%'`,
        [tenant_id]
      );
      const ghosts = await client.query(
        `SELECT COUNT(DISTINCT trip_id)::int AS n FROM ordenes_pendientes
         WHERE tenant_id = $1 AND trip_id ~ '^TRIP-[A-H]$'`,
        [tenant_id]
      );
      const orphanDrivers = await client.query(
        `SELECT COUNT(*)::int AS n FROM choferes c
         WHERE c.tenant_id = $1
           AND UPPER(COALESCE(c.estado, '')) = 'OCUPADO'
           AND NOT EXISTS (
             SELECT 1 FROM flota_vehiculos fv
             WHERE fv.tenant_id = c.tenant_id
               AND fv.rut_chofer_asignado = c.rut
               AND fv.trip_id_actual IS NOT NULL
           )`,
        [tenant_id]
      );

      const before = {
        spot_qa: spot.rows[0]?.n || 0,
        trip_ghost: ghosts.rows[0]?.n || 0,
        chofer_ocupado_huerfano: orphanDrivers.rows[0]?.n || 0,
      };

      if (!apply) {
        return jsonResponse({
          exito: true,
          dry_run: true,
          before,
          hint: 'Reenviar con { "apply": true } para ejecutar',
        });
      }

      const cancelSpot = await client.query(
        `UPDATE ordenes_pendientes
         SET estado_operacional = 'CANCELADO_PLANILLA',
             trip_id = NULL,
             stop_sequence = NULL,
             chofer_asignado_id = NULL,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'qa_cleanup', true,
               'qa_cleanup_at', NOW()::text
             )
         WHERE tenant_id = $1
           AND ot_id LIKE 'SPOT-20260728-%'
           AND COALESCE(estado_operacional, '') <> 'CANCELADO_PLANILLA'
         RETURNING ot_id`,
        [tenant_id]
      );

      const freeFleet = await client.query(
        `UPDATE flota_vehiculos
         SET trip_id_actual = NULL,
             ultima_actualizacion = NOW()
         WHERE tenant_id = $1
           AND trip_id_actual ~ '^TRIP-[A-H]$'
         RETURNING patente`,
        [tenant_id]
      );

      const detachGhostTrips = await client.query(
        `UPDATE ordenes_pendientes
         SET estado_operacional = CASE
               WHEN COALESCE(estado_operacional, '') IN ('ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA')
                 THEN estado_operacional
               ELSE 'CANCELADO_PLANILLA'
             END,
             trip_id = NULL,
             stop_sequence = NULL,
             chofer_asignado_id = NULL,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'qa_cleanup', true,
               'qa_cleanup_ghost_trip', true,
               'qa_cleanup_at', NOW()::text
             )
         WHERE tenant_id = $1
           AND trip_id ~ '^TRIP-[A-H]$'
         RETURNING ot_id`,
        [tenant_id]
      );

      const freeDrivers = await client.query(
        `UPDATE choferes c
         SET estado = 'DISPONIBLE'
         WHERE c.tenant_id = $1
           AND UPPER(COALESCE(c.estado, '')) = 'OCUPADO'
           AND NOT EXISTS (
             SELECT 1 FROM flota_vehiculos fv
             WHERE fv.tenant_id = c.tenant_id
               AND fv.rut_chofer_asignado = c.rut
               AND fv.trip_id_actual IS NOT NULL
           )
         RETURNING rut, nombre_completo`,
        [tenant_id]
      );

      return jsonResponse({
        exito: true,
        dry_run: false,
        before,
        applied: {
          spot_cancelled: cancelSpot.rowCount,
          fleet_cleared: freeFleet.rowCount,
          ghost_trip_ots_detached: detachGhostTrips.rowCount,
          drivers_freed: freeDrivers.rowCount,
        },
      });
    }, { tenantId: tenant_id, statementTimeout: 30000 });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
