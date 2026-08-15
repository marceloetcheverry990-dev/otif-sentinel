/**
 * Endpoint: GET /api/eta-accuracy/stats
 * 
 * Retorna estadísticas de precisión ETA agregadas con percentiles calculados en PostgreSQL.
 * Filtrables por período, chofer, fuente de ETA y corrida del optimizer.
 * 
 * Feature: eta-accuracy-metrics
 */

import { CORS_HEADERS, requireTenantId } from '../config.js';
import { withDb } from '../db.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });

export async function handleEtaAccuracyStats(request, env, operator = null) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== 'GET') return jsonRes({ error: 'Method Not Allowed' }, 405);

  const url = new URL(request.url);
  // Tenant siempre del operador autenticado — nunca del query string (anti-IDOR)
  const tenant_id          = operator?.tenant_id || null;
  const desde              = url.searchParams.get('desde') || null;
  const hasta              = url.searchParams.get('hasta') || null;
  const chofer_id          = url.searchParams.get('chofer_id') || null;
  const eta_source         = url.searchParams.get('eta_source') || null;
  const optimization_run_id = url.searchParams.get('optimization_run_id') || null;

  // Validaciones
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  if (desde && !DATE_REGEX.test(desde)) {
    return jsonRes({ error: 'Formato inválido para "desde". Use YYYY-MM-DD.' }, 400);
  }
  if (hasta && !DATE_REGEX.test(hasta)) {
    return jsonRes({ error: 'Formato inválido para "hasta". Use YYYY-MM-DD.' }, 400);
  }

  try {
    return await withDb(env, async (client) => {
    // Query principal — percentiles en PostgreSQL
    const mainQuery = `
      SELECT
        COUNT(*)::int AS total_registros,
        ROUND(AVG(error_minutos)::numeric, 1)                                                              AS error_promedio_min,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY error_absoluto_minutos)::numeric, 1)            AS error_mediana_min,
        ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY error_absoluto_minutos)::numeric, 1)            AS error_p90_min,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY error_absoluto_minutos)::numeric, 1)            AS error_p95_min,
        ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY error_absoluto_minutos)::numeric, 1)            AS error_p99_min,
        ROUND(AVG(error_absoluto_minutos)::numeric, 1)                                                     AS error_absoluto_promedio_min,
        ROUND(100.0 * COUNT(*) FILTER (WHERE error_absoluto_minutos <= 5)  / NULLIF(COUNT(*), 0), 1)       AS pct_dentro_5min,
        ROUND(100.0 * COUNT(*) FILTER (WHERE error_absoluto_minutos <= 10) / NULLIF(COUNT(*), 0), 1)       AS pct_dentro_10min,
        ROUND(100.0 * COUNT(*) FILTER (WHERE error_absoluto_minutos <= 15) / NULLIF(COUNT(*), 0), 1)       AS pct_dentro_15min
      FROM eta_accuracy_metrics
      WHERE tenant_id = $1
        AND ($2::date IS NULL OR fecha >= $2::date)
        AND ($3::date IS NULL OR fecha <= $3::date)
        AND ($4::text IS NULL OR chofer_id = $4)
        AND ($5::text IS NULL OR eta_source = $5)
        AND ($6::text IS NULL OR optimization_run_id = $6)
    `;

    // Query stats_por_chofer — top 10 por volumen
    const choferQuery = `
      SELECT
        chofer_id,
        COUNT(*)::int                                                                          AS total_registros,
        ROUND(AVG(error_absoluto_minutos)::numeric, 1)                                        AS error_absoluto_promedio_min,
        ROUND(100.0 * COUNT(*) FILTER (WHERE error_absoluto_minutos <= 10) / NULLIF(COUNT(*), 0), 1) AS pct_dentro_10min
      FROM eta_accuracy_metrics
      WHERE tenant_id = $1
        AND ($2::date IS NULL OR fecha >= $2::date)
        AND ($3::date IS NULL OR fecha <= $3::date)
        AND ($4::text IS NULL OR chofer_id = $4)
        AND ($5::text IS NULL OR eta_source = $5)
        AND ($6::text IS NULL OR optimization_run_id = $6)
        AND chofer_id IS NOT NULL
      GROUP BY chofer_id
      ORDER BY total_registros DESC
      LIMIT 10
    `;

    // Query stats_por_source
    const sourceQuery = `
      SELECT
        eta_source,
        COUNT(*)::int                                                                          AS total_registros,
        ROUND(AVG(error_absoluto_minutos)::numeric, 1)                                        AS error_absoluto_promedio_min,
        ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY error_absoluto_minutos)::numeric, 1) AS error_p90_min,
        ROUND(AVG(eta_confidence)::numeric, 2)                                                AS eta_confidence_promedio
      FROM eta_accuracy_metrics
      WHERE tenant_id = $1
        AND ($2::date IS NULL OR fecha >= $2::date)
        AND ($3::date IS NULL OR fecha <= $3::date)
        AND ($4::text IS NULL OR chofer_id = $4)
        AND ($5::text IS NULL OR eta_source = $5)
        AND ($6::text IS NULL OR optimization_run_id = $6)
        AND eta_source IS NOT NULL
      GROUP BY eta_source
      ORDER BY total_registros DESC
    `;

    const params = [tenant_id, desde, hasta, chofer_id, eta_source, optimization_run_id];

    const [mainResult, choferResult, sourceResult] = await Promise.all([
      client.query(mainQuery, params),
      client.query(choferQuery, params),
      client.query(sourceQuery, params),
    ]);

    const row = mainResult.rows[0];
    const totalRegistros = row?.total_registros ?? 0;

    // Si no hay datos, retornar nulls
    if (totalRegistros === 0) {
      return jsonRes({
        total_registros: 0,
        error_promedio_min: null,
        error_mediana_min: null,
        error_p90_min: null,
        error_p95_min: null,
        error_p99_min: null,
        error_absoluto_promedio_min: null,
        pct_dentro_5min: null,
        pct_dentro_10min: null,
        pct_dentro_15min: null,
        stats_por_chofer: [],
        stats_por_source: [],
      });
    }

    return jsonRes({
      total_registros:             totalRegistros,
      error_promedio_min:          row.error_promedio_min !== null ? Number(row.error_promedio_min) : null,
      error_mediana_min:           row.error_mediana_min !== null ? Number(row.error_mediana_min) : null,
      error_p90_min:               row.error_p90_min !== null ? Number(row.error_p90_min) : null,
      error_p95_min:               row.error_p95_min !== null ? Number(row.error_p95_min) : null,
      error_p99_min:               row.error_p99_min !== null ? Number(row.error_p99_min) : null,
      error_absoluto_promedio_min: row.error_absoluto_promedio_min !== null ? Number(row.error_absoluto_promedio_min) : null,
      pct_dentro_5min:             row.pct_dentro_5min !== null ? Number(row.pct_dentro_5min) : null,
      pct_dentro_10min:            row.pct_dentro_10min !== null ? Number(row.pct_dentro_10min) : null,
      pct_dentro_15min:            row.pct_dentro_15min !== null ? Number(row.pct_dentro_15min) : null,
      stats_por_chofer: choferResult.rows.map(r => ({
        chofer_id:                   r.chofer_id,
        total_registros:             Number(r.total_registros),
        error_absoluto_promedio_min: r.error_absoluto_promedio_min !== null ? Number(r.error_absoluto_promedio_min) : null,
        pct_dentro_10min:            r.pct_dentro_10min !== null ? Number(r.pct_dentro_10min) : null,
      })),
      stats_por_source: sourceResult.rows.map(r => ({
        eta_source:                  r.eta_source,
        total_registros:             Number(r.total_registros),
        error_absoluto_promedio_min: r.error_absoluto_promedio_min !== null ? Number(r.error_absoluto_promedio_min) : null,
        error_p90_min:               r.error_p90_min !== null ? Number(r.error_p90_min) : null,
        eta_confidence_promedio:     r.eta_confidence_promedio !== null ? Number(r.eta_confidence_promedio) : null,
      })),
    });
    });

  } catch (err) {
    console.error('[ETA_ACCURACY_STATS_ERROR]', err.message);
    return jsonRes({ error: 'Internal Server Error' }, 500);
  }
}
