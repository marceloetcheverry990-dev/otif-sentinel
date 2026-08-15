// src/api/dashboard-operational.js
// Panel Operacional Logístico — KPIs desde ordenes_pendientes (sin depender de v_despachos_otif).
import { withDb } from '../db.js';
import { verifyOperatorToken } from '../helpers/operator-auth.js';
import { CORS_HEADERS } from '../config.js';

/**
 * GET /api/dashboard/operational
 *
 * Snapshot JSON:
 *   - kpis: kg (volumen), OTIF%, entregados / atrasados / en curso (día Santiago)
 *   - por_ruta: por comuna del cliente
 *   - por_camioneta: por chofer asignado (hoy / semana / mes)
 */
export async function getOperationalDashboardData(request, env) {
  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth.response;

  const tenant_id = auth.payload.tenant_id;
  if (!tenant_id || typeof tenant_id !== 'string' || tenant_id.trim() === '') {
    return new Response(
      JSON.stringify({ error: 'Forbidden: tenant_id es obligatorio' }),
      { status: 403, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
    );
  }

  try {
    return await withDb(env, async (client) => {
      // Día operativo en Chile
      const dayExpr = `(COALESCE(o.fecha_hora_sla, o.created_at) AT TIME ZONE 'America/Santiago')::date`;
      const todayExpr = `(NOW() AT TIME ZONE 'America/Santiago')::date`;
      const weekExpr = `DATE_TRUNC('week', NOW() AT TIME ZONE 'America/Santiago')::date`;
      const monthExpr = `DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Santiago')::date`;

      // a_tiempo: entregado antes o en el SLA; null si aún no entregado
      const aTiempoExpr = `
        CASE
          WHEN o.estado_operacional = 'ENTREGADO'
            AND COALESCE(o.hora_real, o.eta) IS NOT NULL
            AND o.fecha_hora_sla IS NOT NULL
          THEN COALESCE(o.hora_real, o.eta) <= o.fecha_hora_sla
          ELSE NULL
        END
      `;

      const kpisResult = await client.query(
        `
        SELECT
          COALESCE(SUM(COALESCE(o.monto_total, o.valor_oc_clp, 0) / 1000.0), 0)::numeric(12,1) AS kg_totales,
          COUNT(*) FILTER (WHERE o.estado_operacional = 'ENTREGADO') AS pedidos_entregados,
          COUNT(*) FILTER (
            WHERE ${aTiempoExpr} = false
               OR (
                    o.estado_operacional NOT IN (
                      'ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA'
                    )
                    AND o.fecha_hora_sla IS NOT NULL
                    AND o.fecha_hora_sla < NOW()
                  )
          ) AS pedidos_atrasados,
          COUNT(*) FILTER (
            WHERE o.estado_operacional NOT IN (
              'ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA'
            )
          ) AS pedidos_en_curso,
          ROUND(
            COUNT(*) FILTER (WHERE ${aTiempoExpr} = true)::numeric
            / NULLIF(COUNT(*) FILTER (WHERE (${aTiempoExpr}) IS NOT NULL), 0)
            * 100
          , 1) AS otif_pct
        FROM ordenes_pendientes o
        WHERE o.tenant_id = $1
          AND ${dayExpr} = ${todayExpr}
        `,
        [tenant_id],
      );

      const kpis = kpisResult.rows[0] || {};

      const rutasResult = await client.query(
        `
        SELECT
          COALESCE(NULLIF(TRIM(SPLIT_PART(COALESCE(c.direccion_calle, o.cliente), ',', 2)), ''), COALESCE(o.cliente, 'Sin zona')) AS zona,
          COUNT(*) AS total_pedidos,
          COALESCE(SUM(COALESCE(o.monto_total, o.valor_oc_clp, 0) / 1000.0), 0)::numeric(12,1) AS kg_totales,
          COUNT(*) FILTER (WHERE o.estado_operacional = 'ENTREGADO') AS entregados,
          ROUND(
            COUNT(*) FILTER (WHERE ${aTiempoExpr} = true)::numeric
            / NULLIF(COUNT(*) FILTER (WHERE (${aTiempoExpr}) IS NOT NULL), 0)
            * 100
          , 1) AS otif_pct
        FROM ordenes_pendientes o
        LEFT JOIN clientes c
          ON c.tenant_id = o.tenant_id
         AND LOWER(TRIM(c.nombre_cliente_raw)) = LOWER(TRIM(o.cliente))
        WHERE o.tenant_id = $1
          AND ${dayExpr} = ${todayExpr}
        GROUP BY 1
        ORDER BY kg_totales DESC
        LIMIT 50
        `,
        [tenant_id],
      );

      const camionetasResult = await client.query(
        `
        SELECT
          COALESCE(ch.chofer_id::text, 'sin_asignar') AS camioneta_id,
          COALESCE(ch.nombre_completo, 'Sin asignar') AS camioneta,
          COALESCE(SUM(COALESCE(o.monto_total, o.valor_oc_clp, 0) / 1000.0) FILTER (
            WHERE ${dayExpr} = ${todayExpr}
          ), 0)::numeric(12,1) AS kg_hoy,
          COALESCE(SUM(COALESCE(o.monto_total, o.valor_oc_clp, 0) / 1000.0) FILTER (
            WHERE ${dayExpr} >= ${weekExpr}
          ), 0)::numeric(12,1) AS kg_semana,
          COALESCE(SUM(COALESCE(o.monto_total, o.valor_oc_clp, 0) / 1000.0) FILTER (
            WHERE ${dayExpr} >= ${monthExpr}
          ), 0)::numeric(12,1) AS kg_mes
        FROM ordenes_pendientes o
        LEFT JOIN choferes ch
          ON ch.tenant_id = o.tenant_id
         AND ch.chofer_id::text = o.chofer_asignado_id::text
        WHERE o.tenant_id = $1
          AND o.estado_operacional = 'ENTREGADO'
          AND ${dayExpr} >= ${monthExpr}
        GROUP BY ch.chofer_id, ch.nombre_completo
        ORDER BY kg_hoy DESC
        LIMIT 30
        `,
        [tenant_id],
      );

      return new Response(JSON.stringify({
        timestamp: new Date().toISOString(),
        kpis: {
          kg_totales: parseFloat(kpis.kg_totales) || 0,
          pedidos_entregados: parseInt(kpis.pedidos_entregados, 10) || 0,
          pedidos_atrasados: parseInt(kpis.pedidos_atrasados, 10) || 0,
          pedidos_en_curso: parseInt(kpis.pedidos_en_curso, 10) || 0,
          otif_pct: kpis.otif_pct !== null && kpis.otif_pct !== undefined
            ? parseFloat(kpis.otif_pct)
            : null,
        },
        por_ruta: rutasResult.rows.map((r) => ({
          zona: r.zona,
          total_pedidos: parseInt(r.total_pedidos, 10),
          kg_totales: parseFloat(r.kg_totales),
          entregados: parseInt(r.entregados, 10),
          otif_pct: r.otif_pct !== null ? parseFloat(r.otif_pct) : null,
        })),
        por_camioneta: camionetasResult.rows.map((r) => ({
          camioneta_id: r.camioneta_id,
          camioneta: r.camioneta,
          kg_hoy: parseFloat(r.kg_hoy),
          kg_semana: parseFloat(r.kg_semana),
          kg_mes: parseFloat(r.kg_mes),
        })),
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    }, { statementTimeout: 20000 });
  } catch (error) {
    console.error('[OPERATIONAL_DASHBOARD_ERROR]', error.message);
    return new Response(
      JSON.stringify({ error: 'Failed', message: error.message }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      },
    );
  }
}
