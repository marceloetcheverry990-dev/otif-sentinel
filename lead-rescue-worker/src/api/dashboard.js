// src/api/dashboard.js
import pg from 'pg';
const { Client } = pg;
import { CONFIG, CORS_HEADERS, getCorsHeaders, requireTenantId } from '../config.js';
import { escapeHTML } from '../utils.js';
import { evaluateOTRiskWithOpenAI } from '../ai.js';
import { renderControlTowerDashboard } from '../ui.js';
import { withDb } from '../db.js';
import { verifyOperatorToken } from '../helpers/operator-auth.js';
import { listDepots, resolveDepot, depotToAppConfig } from '../helpers/depots.js';
import { attachSlaRiskToViajes } from '../helpers/sla-risk.js';
import {
  getViajesPollCacheEntry,
  setViajesPollCacheEntry,
} from '../helpers/tower-poll-cache.js';

// Helper para parseo ultra-seguro de metadata
const safeParseMetadata = (metaRaw) => {
  if (!metaRaw) return {};
  if (typeof metaRaw === 'string') {
    try { return JSON.parse(metaRaw); } catch { return {}; }
  }
  return metaRaw;
};

export async function renderReporte(request, env, ctx) {
  const url = new URL(request.url);
  const rawOtId = url.searchParams.get("id");
  if (!rawOtId) return new Response("Error: ID de Orden no especificado.", { status: 400 });

  const otId = escapeHTML(rawOtId);
  let math = null;
  let ia = null;

  try {
    await withDb(env, async (client) => {
    // [ARREGLO DE ARQUITECTO]: Leemos metadata de ordenes_pendientes
    const resOT = await client.query(`SELECT metadata FROM ordenes_pendientes WHERE ot_id = $1 LIMIT 1`, [rawOtId]);
    let isLocked = false;
      if (resOT.rowCount > 0) 
      {
        const meta = safeParseMetadata(resOT.rows[0].metadata);
        if (meta && meta.analysis && meta.analysis.matematica && meta.analysis.ia) 
        {
          math = meta.analysis.matematica;
          ia = meta.analysis.ia;
        }
        if (meta?.analysis_locked === true) {
          isLocked = true;
        }
      }  

        if ((!math || !ia) && !isLocked) 
        {
        const lockId = crypto.randomUUID();
        const lockRes = await client.query(`
          UPDATE ordenes_pendientes
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object( 'analysis_locked', true, 'lock_id', $2::text)
          WHERE ot_id = $1
          AND COALESCE((metadata->>'analysis_locked')::boolean, false) = false
          RETURNING ot_id
          `, [rawOtId, lockId]
        );

        if (lockRes.rowCount > 0) 
        {
          ctx.waitUntil((async () => {
            const bgClient = new Client(CONFIG.DB_OPTS(env));
            try {
                await bgClient.connect();
                const resData = await bgClient.query(`SELECT ot_id, cliente, estado_operacional FROM ordenes_pendientes WHERE ot_id = $1`, [rawOtId]);

              if (resData.rowCount > 0) {
                const row = resData.rows[0];
                const aiAnalysis = await evaluateOTRiskWithOpenAI(row, env, bgClient);

                if (!aiAnalysis || !aiAnalysis.ia || !aiAnalysis.matematica) {
                  throw new Error("Respuesta de IA incompleta o inválida");
                }

                const upd = await bgClient.query(`
                  UPDATE ordenes_pendientes
                  SET metadata = (metadata - 'analysis_locked' - 'lock_id') || jsonb_build_object('analysis', $3::jsonb)
                  WHERE ot_id = $1
                  AND metadata->>'lock_id' = $2
                  `, [rawOtId, lockId, JSON.stringify(aiAnalysis)]
                );

                if (upd.rowCount === 0) {
                  console.warn("[AI_LOCK_LOST]", rawOtId, lockId);
                }
              }
                else 
                {
                  await bgClient.query(`
                    UPDATE ordenes_pendientes 
                    SET metadata = metadata - 'analysis_locked' - 'lock_id' 
                    WHERE ot_id = $1 
                    AND metadata->>'lock_id' = $2
                    `, [rawOtId, lockId]);
                }
            }
              catch (bgErr) 
              {
                console.error("[BACKGROUND_AI_ERROR]", bgErr.message);
                await bgClient.query(`
                    UPDATE ordenes_pendientes
                    SET metadata = metadata - 'analysis_locked' - 'lock_id'
                    WHERE ot_id = $1
                    AND metadata->>'lock_id' = $2
                  `, [rawOtId, lockId]).catch(()=>{});
              }
              
              finally
              {
                await bgClient.end().catch(() => {});
              }

          })());
        }
    }
    }, { statementTimeout: 5000 });
  } 
  catch (err) { 
    console.error("[REPORT_DB_ERROR]", err.message); 
  }

  if (!math || !ia) {
    return new Response(`Cargando reporte de IA para ${otId}...`, { headers: { "Content-Type": "text/html;charset=UTF-8" }, status: 202 });
  }

        return new Response(`Reporte Generado (Aquí iría renderAuditDashboard)`, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }

export async function renderControlTower(request, env, ctx) {
  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth.response;

  const tenant_id = auth.payload.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let ordenes = [], perfiles = [], listaChoferes = [], viajesActivos = [], lastSyncDate = null;
  let depots = [];
  let bodegaConfig = depotToAppConfig(null);

  // Si la DB falla, igual devolvemos el shell HTML y el cliente rellena via poll.
  // Nota: lat/lng NO existen en ordenes_pendientes — viven en clientes (+ metadata).
  // tenantId → set_config app.current_tenant (RLS real solo si Hyperdrive=otif_app).
  try {
    await withDb(env, async (client) => {
      try {
        const resPerfiles = await client.query(
          `SELECT perfil_id, nombre_perfil, is_default
           FROM perfiles_optimizacion
           WHERE tenant_id = $1 OR tenant_id IS NULL
           ORDER BY is_default DESC, perfil_id ASC`,
          [tenant_id]
        );
        perfiles = resPerfiles.rows;
      } catch (perfilErr) {
        // Pre-mig 011: sin columna tenant_id
        if (!String(perfilErr.message || '').includes('tenant_id')) throw perfilErr;
        const resPerfiles = await client.query(
          `SELECT perfil_id, nombre_perfil, is_default
           FROM perfiles_optimizacion
           ORDER BY is_default DESC, perfil_id ASC`
        );
        perfiles = resPerfiles.rows;
      }

      const resChoferes = await client.query(
        `SELECT chofer_id, nombre_completo, skill_score, estado, rut, gps_interval_seconds
         FROM choferes
         WHERE tenant_id = $1 AND estado IN ('DISPONIBLE', 'OCUPADO')
         ORDER BY estado ASC, nombre_completo ASC`,
        [tenant_id]
      );
      listaChoferes = resChoferes.rows;

      const resViajes = await client.query(
        `SELECT
           o.trip_id,
           NULLIF(TRIM(MAX(o.chofer_asignado_id) FILTER (
             WHERE o.chofer_asignado_id IS NOT NULL AND TRIM(o.chofer_asignado_id::text) <> ''
           )), '') AS chofer_id,
           COALESCE(
             MAX(ch.nombre_completo) FILTER (
               WHERE o.chofer_asignado_id IS NOT NULL AND TRIM(o.chofer_asignado_id::text) <> ''
             ),
             'Sin Asignar'
           ) AS chofer,
           COALESCE(MAX(fv.km_recorridos_reales), 0) AS km_recorridos,
           COUNT(o.ot_id) AS total_paradas,
           SUM(o.valor_oc_clp) AS valor_total_viaje,
           COUNT(o.ot_id) FILTER (WHERE o.estado_operacional = 'ENTREGADO') AS entregas_completadas,
           COUNT(o.ot_id) FILTER (WHERE o.estado_operacional = 'RECHAZADO') AS entregas_rechazadas,
           json_agg(json_build_object(
             'ot_id', o.ot_id,
             'cliente', o.cliente,
             'estado', o.estado_operacional,
             'estado_operacional', o.estado_operacional,
             'valor', o.valor_oc_clp,
             'monto_total', o.monto_total,
             'uri', o.uri,
             'stop_sequence', o.stop_sequence,
             'fecha_hora_sla', o.fecha_hora_sla,
             'eta', o.eta,
             'eta_source', o.metadata->'routing'->>'eta_source',
             'hora_llegada_chofer', o.hora_llegada_chofer,
             'hora_real', o.hora_real,
             'evidencia_url', o.evidencia_url,
             'firma_url', COALESCE(o.firma_url, o.metadata->>'firma_url'),
             'routing', o.metadata->'routing',
             'guia_estado', gd.estado,
             'guia_folio', gd.folio,
             'guia_error', gd.error,
             'lat', COALESCE(
               CASE WHEN (o.metadata->>'lat_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                 THEN (o.metadata->>'lat_destino')::double precision END,
               cli.lat
             ),
             'lng', COALESCE(
               CASE WHEN (o.metadata->>'lng_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                 THEN (o.metadata->>'lng_destino')::double precision END,
               cli.lng
             )
           ) ORDER BY o.stop_sequence ASC NULLS LAST) AS detalle_paradas
         FROM ordenes_pendientes o
         LEFT JOIN choferes ch
           ON ch.tenant_id = o.tenant_id
          AND ch.chofer_id::text = o.chofer_asignado_id::text
         LEFT JOIN flota_vehiculos fv
           ON fv.tenant_id = o.tenant_id
          AND fv.trip_id_actual = o.trip_id
         LEFT JOIN clientes cli
           ON cli.tenant_id = o.tenant_id
          AND LOWER(TRIM(cli.nombre_cliente_raw)) = LOWER(TRIM(o.cliente))
         LEFT JOIN guias_despacho gd
           ON gd.tenant_id = o.tenant_id
          AND gd.ot_id = o.ot_id
         WHERE o.tenant_id = $1
           AND o.trip_id IS NOT NULL
           AND (
             o.estado_operacional IS NULL
             OR o.estado_operacional NOT IN ('CANCELADO_PLANILLA','RETORNO_BODEGA')
           )
         GROUP BY o.trip_id`,
        [tenant_id]
      );
      viajesActivos = resViajes.rows;
      await attachSlaRiskToViajes(client, tenant_id, viajesActivos);

      const resOrdenes = await client.query(
        `SELECT
           o.ot_id, o.cliente, o.valor_oc_clp, o.monto_total, o.uri,
           o.estado_operacional, o.trip_id, o.stop_sequence, o.eta,
           COALESCE(
             CASE WHEN (o.metadata->>'lat_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
               THEN (o.metadata->>'lat_destino')::double precision END,
             c.lat
           ) AS lat,
           COALESCE(
             CASE WHEN (o.metadata->>'lng_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
               THEN (o.metadata->>'lng_destino')::double precision END,
             c.lng
           ) AS lng,
           (o.metadata->'analysis'->'ia'->>'riesgo') AS riesgo_ia
         FROM ordenes_pendientes o
         LEFT JOIN clientes c
           ON c.tenant_id = o.tenant_id
          AND LOWER(TRIM(c.nombre_cliente_raw)) = LOWER(TRIM(o.cliente))
         WHERE o.tenant_id = $1
           AND (
             o.estado_operacional IN ('PENDIENTE_RUTEO', 'PENDIENTE', 'PENDIENTE_CARGA')
             OR o.trip_id IS NOT NULL
           )
           AND (
             o.estado_operacional IS NULL
             OR o.estado_operacional NOT IN ('CANCELADO_PLANILLA','RETORNO_BODEGA')
           )`,
        [tenant_id]
      );
      ordenes = resOrdenes.rows;

      // Fecha de último sync Excel (solo para el badge; no es crítico)
      try {
        const resSync = await client.query(
          `SELECT created_at FROM transaction_logs
           WHERE ot_id = 'SYSTEM_SYNC' AND metadata->>'event' = 'EXCEL_SYNC'
           ORDER BY created_at DESC LIMIT 1`
        );
        lastSyncDate = resSync.rowCount > 0 ? resSync.rows[0].created_at.toISOString() : null;
      } catch (_) { /* ignore */ }
    }, { statementTimeout: 12000, tenantId: tenant_id });
  } catch (err) {
    console.error("[CONTROL_TOWER_DB_ERROR]", err.message);
    // Shell degradado: la UI carga y el poll /api/control-tower-viajes completa datos.
  }

  try {
    depots = await listDepots(env, tenant_id);
    const defaultDepot = await resolveDepot(env, tenant_id, null);
    bodegaConfig = depotToAppConfig(defaultDepot);
  } catch (e) {
    console.warn('[CONTROL_TOWER_DEPOTS]', e.message);
  }

  return new Response(
    renderControlTowerDashboard(
      ordenes,
      perfiles,
      null,
      escapeHTML,
      lastSyncDate,
      viajesActivos,
      listaChoferes,
      auth.payload.tenant_id,
      {
        username: auth.payload.username || null,
        display_name: auth.payload.display_name || auth.payload.username || null,
        is_admin: !!auth.payload.is_admin,
        operator_id: auth.payload.sub || null,
      },
      { depots, bodega: bodegaConfig, dte_live: String(env.DTE_PROVIDER || '').toLowerCase() === 'simpleapi' && String(env.DTE_ALLOW_STUB || '').toLowerCase() !== 'true' },
    ),
    {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "Cache-Control": "no-store",
      },
    },
  );
}


export async function getControlTowerViajesAPI(request, env, ctx, operator = null) {
  let tenant_id = operator?.tenant_id || null;
  if (!tenant_id) {
    const auth = await verifyOperatorToken(request, env);
    if (!auth.ok) return auth.response;
    tenant_id = auth.payload.tenant_id;
  }

  const url = new URL(request.url);
  const requestedTenant = url.searchParams.get('tenant_id');

  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;
  if (requestedTenant && requestedTenant !== tenant_id) {
    return new Response(
      JSON.stringify({ error: 'Tenant no autorizado', code: 'tenant_incorrecto' }),
      { status: 403, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }

  // Cache corto en el isolate: el poll T.Real (~10s) no debe martillar Hyperdrive.
  const cacheKey = `${tenant_id}|sla=${url.searchParams.get('sla') || '0'}`;
  const cached = getViajesPollCacheEntry(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env), 'X-Poll-Cache': 'HIT' }
    });
  }

  try {
    return await withDb(env, async (client) => {
      // Poll torre: coords desde orden (013) primero; join clientes exacto (sin LOWER/TRIM).
      // HAVING: ocultar viajes 100% terminales que ensucian la flota.
      const resViajes = await client.query(`
      SELECT 
        o.trip_id, 
        NULLIF(TRIM(MAX(o.chofer_asignado_id) FILTER (
          WHERE o.chofer_asignado_id IS NOT NULL AND TRIM(o.chofer_asignado_id::text) <> ''
        )), '') as chofer_id, 
        COALESCE(
          MAX(ch.nombre_completo) FILTER (
            WHERE o.chofer_asignado_id IS NOT NULL AND TRIM(o.chofer_asignado_id::text) <> ''
          ),
          'Sin Asignar'
        ) as chofer, 
        COALESCE(MAX(fv.km_recorridos_reales), 0) as km_recorridos,
        COUNT(o.ot_id) as total_paradas, 
        SUM(o.valor_oc_clp) as valor_total_viaje,
        COUNT(o.ot_id) FILTER (WHERE o.estado_operacional = 'ENTREGADO') as entregas_completadas,
        COUNT(o.ot_id) FILTER (WHERE o.estado_operacional = 'RECHAZADO') as entregas_rechazadas,
        json_agg(json_build_object(
          'ot_id', o.ot_id, 
          'cliente', o.cliente, 
          'estado', o.estado_operacional, 
          'estado_operacional', o.estado_operacional,
          'valor', o.valor_oc_clp, 
          'monto_total', o.monto_total,
          'uri', o.uri,
          'stop_sequence', o.stop_sequence, 
          'fecha_hora_sla', o.fecha_hora_sla,
          'eta', o.eta,
          'eta_source', o.metadata->'routing'->>'eta_source',
          'hora_llegada_chofer', o.hora_llegada_chofer,
          'hora_real', o.hora_real,
          'evidencia_url', o.evidencia_url,
          'firma_url', COALESCE(o.firma_url, o.metadata->>'firma_url'),
          'routing', o.metadata->'routing',
          'guia_estado', gd.estado,
          'guia_folio', gd.folio,
          'guia_error', gd.error,
          'lat', COALESCE(
            o.lat::double precision,
            CASE WHEN (o.metadata->>'lat_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
              THEN (o.metadata->>'lat_destino')::double precision END,
            cli.lat
          ),
          'lng', COALESCE(
            o.lng::double precision,
            CASE WHEN (o.metadata->>'lng_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
              THEN (o.metadata->>'lng_destino')::double precision END,
            cli.lng
          )
        ) ORDER BY o.stop_sequence ASC NULLS LAST) as detalle_paradas
      FROM ordenes_pendientes o
      LEFT JOIN choferes ch
        ON ch.tenant_id = o.tenant_id
       AND ch.chofer_id::text = o.chofer_asignado_id::text
      LEFT JOIN flota_vehiculos fv
        ON fv.tenant_id = o.tenant_id
       AND fv.trip_id_actual = o.trip_id
      LEFT JOIN clientes cli
        ON cli.tenant_id = o.tenant_id
       AND cli.nombre_cliente_raw = o.cliente
      LEFT JOIN guias_despacho gd
        ON gd.tenant_id = o.tenant_id
       AND gd.ot_id = o.ot_id
      WHERE o.tenant_id = $1
      AND o.trip_id IS NOT NULL
      AND (
          o.estado_operacional IS NULL 
          OR o.estado_operacional NOT IN ('CANCELADO_PLANILLA', 'RETORNO_BODEGA')
      )
      GROUP BY o.trip_id
      HAVING COUNT(*) FILTER (
        WHERE o.estado_operacional IS NULL
           OR o.estado_operacional NOT IN ('ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA')
      ) > 0
    `, [tenant_id]);

      const [resOrdenesSinViaje, resChoferes, fleet_alerts] = await Promise.all([
        client.query(`
      SELECT
        o.ot_id, o.cliente, o.valor_oc_clp, o.monto_total, o.uri,
        o.estado_operacional, o.trip_id, o.stop_sequence, o.eta,
        COALESCE(
          o.lat::double precision,
          CASE WHEN (o.metadata->>'lat_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN (o.metadata->>'lat_destino')::double precision END,
          c.lat
        ) AS lat,
        COALESCE(
          o.lng::double precision,
          CASE WHEN (o.metadata->>'lng_destino') ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN (o.metadata->>'lng_destino')::double precision END,
          c.lng
        ) AS lng
      FROM ordenes_pendientes o
      LEFT JOIN clientes c
        ON c.tenant_id = o.tenant_id
       AND c.nombre_cliente_raw = o.cliente
      WHERE o.tenant_id = $1
        AND (o.trip_id IS NULL OR o.trip_id = '')
        AND o.estado_operacional IN ('PENDIENTE_RUTEO', 'PENDIENTE', 'PENDIENTE_CARGA')
      ORDER BY o.created_at DESC
      LIMIT 200
    `, [tenant_id]),
        client.query(
          `SELECT chofer_id, nombre_completo, skill_score, estado, rut, gps_interval_seconds
           FROM choferes
           WHERE tenant_id = $1 AND estado IN ('DISPONIBLE', 'OCUPADO')
           ORDER BY estado ASC, nombre_completo ASC`,
          [tenant_id],
        ),
        client.query(
          `SELECT id, trip_id, alert_type, severity, status, stuck_minutes, lat, lng, payload, created_at, updated_at
           FROM fleet_alerts
           WHERE tenant_id = $1 AND status IN ('OPEN', 'ACKED', 'RESCUING')
             AND (status = 'RESCUING' OR COALESCE(stuck_minutes, 0) < $2)
           ORDER BY
             CASE severity WHEN 'RED' THEN 0 ELSE 1 END,
             updated_at DESC
           LIMIT 20`,
          [tenant_id, CONFIG.LEAD_RESCUE.STALE_ALERT_MAX_MIN]
        ).then((r) => r.rows).catch((alertErr) => {
          if (alertErr.code !== '42P01') {
            console.warn('[LIVE_VIAJES_ALERTS]', alertErr.message);
          }
          return [];
        }),
      ]);

      const viajes = resViajes.rows;
      // SLA enrichment es caro (métricas); no bloquear el poll en vivo de la Torre.
      // Se puede forzar con ?sla=1 si un panel lo necesita.
      if (url.searchParams.get('sla') === '1') {
        await attachSlaRiskToViajes(client, tenant_id, viajes);
      }

      const body = JSON.stringify({
        exito: true,
        viajes,
        ordenes_pendientes: resOrdenesSinViaje.rows,
        choferes: resChoferes.rows,
        fleet_alerts,
      });
      setViajesPollCacheEntry(cacheKey, body);

      return new Response(body, {
        headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env), 'X-Poll-Cache': 'MISS' }
      });
    }, { statementTimeout: 12000, tenantId: tenant_id });
  } catch (err) {
    console.error("[LIVE_VIAJES_ERROR]", err.message);
    return new Response(JSON.stringify({ exito: false, error: err.message }), { 
      status: 500, 
      headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) }
    });
  }
}