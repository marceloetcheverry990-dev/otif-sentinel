// src/api/dashboard-executive.js
// Dashboard Ejecutivo - Business Intelligence y KPIs Operacionales
// Responde preguntas clave del negocio

import { withDb } from '../db.js';
import { verifyOperatorToken } from '../helpers/operator-auth.js';

/**
 * DASHBOARD EJECUTIVO - API
 * 
 * Proporciona KPIs de negocio y análisis operacional:
 * - Comparativas temporales (mes actual vs anterior)
 * - Performance de choferes
 * - Análisis por cliente
 * - OTIF real
 * - Análisis de pérdidas
 * - Tendencias anuales
 */

export async function getExecutiveDashboardData(request, env) {
  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth.response;

  const tenant_id = auth.payload.tenant_id;
  if (!tenant_id || typeof tenant_id !== 'string' || tenant_id.trim() === '') {
    return new Response(
      JSON.stringify({ error: 'Forbidden: tenant_id es obligatorio' }),
      { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
    );
  }

  const url = new URL(request.url);
  const period = url.searchParams.get('period') || 'all'; // all, today, week, month, year

  try {
    return await withDb(env, async (client) => {
    // ============================================================================
    // FILTROS DE PERÍODO - Usando created_at
    // ============================================================================
    let currentPeriodFilter = '';
    let previousPeriodFilter = '';
    
    switch(period) {
      case 'today':
        currentPeriodFilter = "AND created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'";
        previousPeriodFilter = "AND created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE";
        break;
      case 'week':
        currentPeriodFilter = "AND created_at >= DATE_TRUNC('week', CURRENT_DATE) AND created_at < DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '1 week'";
        previousPeriodFilter = "AND created_at >= DATE_TRUNC('week', CURRENT_DATE) - INTERVAL '1 week' AND created_at < DATE_TRUNC('week', CURRENT_DATE)";
        break;
      case 'month':
        currentPeriodFilter = "AND created_at >= DATE_TRUNC('month', CURRENT_DATE) AND created_at < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'";
        previousPeriodFilter = "AND created_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month' AND created_at < DATE_TRUNC('month', CURRENT_DATE)";
        break;
      case 'year':
        currentPeriodFilter = "AND created_at >= DATE_TRUNC('year', CURRENT_DATE) AND created_at < DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'";
        previousPeriodFilter = "AND created_at >= DATE_TRUNC('year', CURRENT_DATE) - INTERVAL '1 year' AND created_at < DATE_TRUNC('year', CURRENT_DATE)";
        break;
      case 'all':
      default:
        currentPeriodFilter = '';
        previousPeriodFilter = "AND 1=0"; // No data for previous period when showing all
        break;
    }

    // ===========================================================================
    // 1. KPIs PRINCIPALES - CON FILTRO DE PERÍODO Y COMPARATIVAS
    // ===========================================================================
    const kpisQuery = await client.query(`
      WITH current_period AS (
        SELECT 
          COUNT(*) FILTER (WHERE estado_operacional = 'ENTREGADO') as entregas_exitosas,
          COUNT(*) FILTER (WHERE estado_operacional = 'RECHAZADO') as entregas_rechazadas,
          -- OTIF: solo órdenes que ya tienen resultado (ENTREGADO o RECHAZADO)
          COUNT(*) FILTER (WHERE estado_operacional IN ('ENTREGADO','RECHAZADO')) as total_con_resultado,
          COUNT(*) as total_entregas,
          SUM(CASE WHEN estado_operacional = 'ENTREGADO' THEN COALESCE(monto_total, valor_oc_clp, 0) ELSE 0 END) as ingresos,
          -- Multas: rechazos + entregas tardías (hora_real > fecha_hora_sla)
          SUM(CASE 
            WHEN estado_operacional = 'RECHAZADO' 
            THEN COALESCE(monto_total, valor_oc_clp, 0) * 0.10
            WHEN estado_operacional = 'ENTREGADO' AND hora_real IS NOT NULL AND fecha_hora_sla IS NOT NULL AND hora_real > fecha_hora_sla
            THEN COALESCE(monto_total, valor_oc_clp, 0) * 0.10
            ELSE 0 
          END) as multas
        FROM ordenes_pendientes
        WHERE tenant_id = $1 ${currentPeriodFilter}
      ),
      previous_period AS (
        SELECT 
          COUNT(*) FILTER (WHERE estado_operacional = 'ENTREGADO') as entregas_exitosas,
          COUNT(*) FILTER (WHERE estado_operacional IN ('ENTREGADO','RECHAZADO')) as total_con_resultado,
          COUNT(*) as total_entregas,
          SUM(CASE WHEN estado_operacional = 'ENTREGADO' THEN COALESCE(monto_total, valor_oc_clp, 0) ELSE 0 END) as ingresos,
          SUM(CASE 
            WHEN estado_operacional = 'RECHAZADO' 
            THEN COALESCE(monto_total, valor_oc_clp, 0) * 0.10
            WHEN estado_operacional = 'ENTREGADO' AND hora_real IS NOT NULL AND fecha_hora_sla IS NOT NULL AND hora_real > fecha_hora_sla
            THEN COALESCE(monto_total, valor_oc_clp, 0) * 0.10
            ELSE 0 
          END) as multas
        FROM ordenes_pendientes
        WHERE tenant_id = $1 ${previousPeriodFilter}
      )
      SELECT 
        cp.entregas_exitosas as current_entregas,
        pp.entregas_exitosas as previous_entregas,
        CASE 
          WHEN pp.entregas_exitosas > 0 
          THEN ROUND(((cp.entregas_exitosas - pp.entregas_exitosas)::numeric / pp.entregas_exitosas * 100), 2)
          ELSE 0 
        END as entregas_growth,
        
        cp.total_entregas as current_total,
        pp.total_entregas as previous_total,
        
        cp.ingresos as current_ingresos,
        pp.ingresos as previous_ingresos,
        CASE 
          WHEN pp.ingresos > 0 
          THEN ROUND(((cp.ingresos - pp.ingresos)::numeric / pp.ingresos * 100), 2)
          ELSE 0 
        END as ingresos_growth,
        
        cp.multas as current_multas,
        pp.multas as previous_multas,
        
        ROUND((cp.entregas_exitosas::numeric / NULLIF(cp.total_con_resultado, 0) * 100), 2) as otif_actual,
        ROUND((pp.entregas_exitosas::numeric / NULLIF(pp.total_con_resultado, 0) * 100), 2) as otif_anterior
      FROM current_period cp, previous_period pp
    `, [tenant_id]);

    const kpis = kpisQuery.rows[0] || {
      current_entregas: 0,
      previous_entregas: 0,
      entregas_growth: 0,
      current_total: 0,
      previous_total: 0,
      current_ingresos: 0,
      previous_ingresos: 0,
      ingresos_growth: 0,
      current_multas: 0,
      previous_multas: 0,
      otif_actual: 0,
      otif_anterior: 0
    };

    // ===========================================================================
    // 2. KILÓMETROS TOTALES - CON FILTRO DE PERÍODO
    // ===========================================================================
    const kmQuery = await client.query(`
      SELECT 
        SUM((metadata->'routing'->>'distancia_total_viaje_km')::numeric) as km_totales_mes,
        AVG((metadata->'routing'->>'distancia_total_viaje_km')::numeric) as km_promedio_ruta
      FROM ordenes_pendientes
      WHERE tenant_id = $1
        AND metadata->'routing'->>'distancia_total_viaje_km' IS NOT NULL
        ${currentPeriodFilter}
    `, [tenant_id]);

    const kmData = kmQuery.rows[0] || { km_totales_mes: 0, km_promedio_ruta: 0 };

    // ===========================================================================
    // 3. TENDENCIA MENSUAL/ANUAL - Dinámico según período
    // ===========================================================================
    let trendQuery;
    
    if (period === 'year' || period === 'all') {
      // Mostrar meses del año SOLO hasta el mes actual
      const currentMonth = new Date().getMonth() + 1; // 1-12
      const currentYear = new Date().getFullYear();
      trendQuery = await client.query(`
        WITH months AS (
          SELECT generate_series(1, ${currentMonth}) as month_num
        ),
        month_data AS (
          SELECT 
            EXTRACT(MONTH FROM created_at)::int as month_num,
            COUNT(*) FILTER (WHERE estado_operacional = 'ENTREGADO') as entregas_exitosas,
            COUNT(*) FILTER (WHERE estado_operacional = 'RECHAZADO') as entregas_rechazadas,
            COUNT(*) as total,
            SUM(CASE WHEN estado_operacional = 'ENTREGADO' THEN COALESCE(monto_total, valor_oc_clp, 0) ELSE 0 END) as ingresos
          FROM ordenes_pendientes
          WHERE tenant_id = $1
            AND EXTRACT(YEAR FROM created_at) = ${currentYear}
          GROUP BY EXTRACT(MONTH FROM created_at)::int
        )
        SELECT 
          LPAD(m.month_num::text, 2, '0') as mes,
          TO_CHAR(TO_DATE(m.month_num::text, 'MM'), 'TMMonth') as mes_nombre,
          COALESCE(d.entregas_exitosas, 0) as entregas_exitosas,
          COALESCE(d.entregas_rechazadas, 0) as entregas_rechazadas,
          COALESCE(d.total, 0) as total,
          COALESCE(d.ingresos, 0) as ingresos
        FROM months m
        LEFT JOIN month_data d ON m.month_num = d.month_num
        ORDER BY m.month_num
      `, [tenant_id]);
    } else if (period === 'month') {
      // Mostrar tendencia diaria del mes
      trendQuery = await client.query(`
        SELECT 
          TO_CHAR(created_at, 'YYYY-MM-DD') as mes,
          TO_CHAR(created_at, 'DD TMMonth') as mes_nombre,
          COUNT(*) FILTER (WHERE estado_operacional = 'ENTREGADO') as entregas_exitosas,
          COUNT(*) FILTER (WHERE estado_operacional = 'RECHAZADO') as entregas_rechazadas,
          COUNT(*) as total,
          SUM(CASE WHEN estado_operacional = 'ENTREGADO' THEN COALESCE(monto_total, valor_oc_clp, 0) ELSE 0 END) as ingresos
        FROM ordenes_pendientes
        WHERE tenant_id = $1 ${currentPeriodFilter}
        GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD'), TO_CHAR(created_at, 'DD TMMonth')
        ORDER BY TO_CHAR(created_at, 'YYYY-MM-DD')
      `, [tenant_id]);
    } else if (period === 'week') {
      // Mostrar tendencia diaria de la semana
      trendQuery = await client.query(`
        SELECT 
          TO_CHAR(created_at, 'YYYY-MM-DD') as mes,
          TO_CHAR(created_at, 'TMDay DD') as mes_nombre,
          COUNT(*) FILTER (WHERE estado_operacional = 'ENTREGADO') as entregas_exitosas,
          COUNT(*) FILTER (WHERE estado_operacional = 'RECHAZADO') as entregas_rechazadas,
          COUNT(*) as total,
          SUM(CASE WHEN estado_operacional = 'ENTREGADO' THEN COALESCE(monto_total, valor_oc_clp, 0) ELSE 0 END) as ingresos
        FROM ordenes_pendientes
        WHERE tenant_id = $1 ${currentPeriodFilter}
        GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD'), TO_CHAR(created_at, 'TMDay DD'), EXTRACT(DOW FROM created_at)
        ORDER BY TO_CHAR(created_at, 'YYYY-MM-DD')
      `, [tenant_id]);
    } else {
      // today - Mostrar tendencia por hora
      trendQuery = await client.query(`
        SELECT 
          TO_CHAR(created_at, 'HH24') as mes,
          TO_CHAR(created_at, 'HH24:00') as mes_nombre,
          COUNT(*) FILTER (WHERE estado_operacional = 'ENTREGADO') as entregas_exitosas,
          COUNT(*) FILTER (WHERE estado_operacional = 'RECHAZADO') as entregas_rechazadas,
          COUNT(*) as total,
          SUM(CASE WHEN estado_operacional = 'ENTREGADO' THEN COALESCE(monto_total, valor_oc_clp, 0) ELSE 0 END) as ingresos
        FROM ordenes_pendientes
        WHERE tenant_id = $1 ${currentPeriodFilter}
        GROUP BY TO_CHAR(created_at, 'HH24'), TO_CHAR(created_at, 'HH24:00')
        ORDER BY TO_CHAR(created_at, 'HH24')
      `, [tenant_id]);
    }

    const tendenciaAnual = trendQuery.rows;

    // ===========================================================================
    // 4. TOP CHOFERES - Performance CON FILTRO DE PERÍODO
    // ===========================================================================
    const choferesQuery = await client.query(`
      SELECT 
        c.chofer_id,
        c.nombre_completo,
        c.skill_score,
        COUNT(op.ot_id) FILTER (WHERE op.estado_operacional = 'ENTREGADO') as entregas_exitosas,
        COUNT(op.ot_id) FILTER (WHERE op.estado_operacional = 'RECHAZADO') as entregas_rechazadas,
        COUNT(op.ot_id) as total_entregas,
        ROUND((COUNT(op.ot_id) FILTER (WHERE op.estado_operacional = 'ENTREGADO')::numeric / 
               NULLIF(COUNT(op.ot_id), 0) * 100), 2) as otif_chofer,
        SUM((op.metadata->'routing'->>'distancia_total_viaje_km')::numeric) as km_recorridos,
          SUM(CASE WHEN estado_operacional = 'ENTREGADO' THEN COALESCE(op.monto_total, op.valor_oc_clp, 0) ELSE 0 END) as ingresos_generados
      FROM choferes c
      LEFT JOIN ordenes_pendientes op ON CAST(c.chofer_id AS VARCHAR) = CAST(op.chofer_asignado_id AS VARCHAR)
        AND op.tenant_id = $1
        ${currentPeriodFilter ? 'AND 1=1 ' + currentPeriodFilter.replace(/created_at/g, 'op.created_at') : ''}
      WHERE c.tenant_id = $1
        AND c.estado IN ('DISPONIBLE', 'OCUPADO')
      GROUP BY c.chofer_id, c.nombre_completo, c.skill_score
      HAVING COUNT(op.ot_id) > 0
      ORDER BY entregas_exitosas DESC, otif_chofer DESC
      LIMIT 10
    `, [tenant_id]);

    const topChoferes = choferesQuery.rows;

    // ===========================================================================
    // 5. TOP CLIENTES - Por Ingresos CON FILTRO DE PERÍODO
    // ===========================================================================
    const clientesQuery = await client.query(`
      SELECT 
        cliente,
        COUNT(*) FILTER (WHERE estado_operacional = 'ENTREGADO') as entregas_exitosas,
        COUNT(*) FILTER (WHERE estado_operacional = 'RECHAZADO') as entregas_rechazadas,
        COUNT(*) as total_entregas,
        ROUND((COUNT(*) FILTER (WHERE estado_operacional = 'ENTREGADO')::numeric / 
               NULLIF(COUNT(*), 0) * 100), 2) as otif_cliente,
        SUM(CASE WHEN estado_operacional = 'ENTREGADO' THEN COALESCE(monto_total, valor_oc_clp, 0) ELSE 0 END) as ingresos,
        SUM(CASE 
          WHEN estado_operacional = 'RECHAZADO' 
          THEN COALESCE(monto_total, valor_oc_clp, 0) * 0.10
          WHEN estado_operacional = 'ENTREGADO' AND hora_real IS NOT NULL AND fecha_hora_sla IS NOT NULL AND hora_real > fecha_hora_sla
          THEN COALESCE(monto_total, valor_oc_clp, 0) * 0.10
          ELSE 0 
        END) as multas_potenciales
      FROM ordenes_pendientes
      WHERE tenant_id = $1 ${currentPeriodFilter}
      GROUP BY cliente
      ORDER BY ingresos DESC
      LIMIT 10
    `, [tenant_id]);

    const topClientes = clientesQuery.rows;

    // ===========================================================================
    // 6. ANÁLISIS DE PÉRDIDAS - Dónde perdemos dinero CON FILTRO DE PERÍODO
    // ===========================================================================
    const perdidasQuery = await client.query(`
      WITH rechazos AS (
        SELECT 
          cliente,
          COUNT(*) as total_rechazos,
          SUM(COALESCE(monto_total, valor_oc_clp, 0) * 0.10) as multas_estimadas,
          STRING_AGG(DISTINCT metadata->>'motivo_rechazo', ', ') as motivos_principales
        FROM ordenes_pendientes
        WHERE tenant_id = $1
          AND estado_operacional = 'RECHAZADO'
          ${currentPeriodFilter}
        GROUP BY cliente
      )
      SELECT 
        cliente,
        total_rechazos,
        ROUND(multas_estimadas::numeric, 2) as multas_estimadas,
        motivos_principales
      FROM rechazos
      ORDER BY multas_estimadas DESC
      LIMIT 10
    `, [tenant_id]);

    const perdidas = perdidasQuery.rows;

    // ===========================================================================
    // 7. DISTRIBUCIÓN HORARIA - Cuándo entregamos más CON FILTRO DE PERÍODO
    // ===========================================================================
    const horariaQuery = await client.query(`
      SELECT 
        EXTRACT(HOUR FROM hora_real) as hora,
        COUNT(*) as entregas
      FROM ordenes_pendientes
      WHERE tenant_id = $1
        AND estado_operacional = 'ENTREGADO'
        AND hora_real IS NOT NULL
        ${currentPeriodFilter}
      GROUP BY EXTRACT(HOUR FROM hora_real)
      ORDER BY hora
    `, [tenant_id]);

    const distribucionHoraria = horariaQuery.rows;

    // ===========================================================================
    // COMPILAR RESPUESTA
    // ===========================================================================
    const dashboardData = {
      timestamp: new Date().toISOString(),
      period,
      kpis: {
        otif: {
          actual: parseFloat(kpis.otif_actual || 0),
          anterior: parseFloat(kpis.otif_anterior || 0),
          cambio: parseFloat(kpis.otif_actual || 0) - parseFloat(kpis.otif_anterior || 0)
        },
        entregas: {
          actual: parseInt(kpis.current_entregas || 0),
          anterior: parseInt(kpis.previous_entregas || 0),
          crecimiento: parseFloat(kpis.entregas_growth || 0)
        },
        ingresos: {
          actual: parseFloat(kpis.current_ingresos || 0),
          anterior: parseFloat(kpis.previous_ingresos || 0),
          crecimiento: parseFloat(kpis.ingresos_growth || 0)
        },
        multas: {
          actual: parseFloat(kpis.current_multas || 0),
          anterior: parseFloat(kpis.previous_multas || 0)
        },
        kilometros: {
          totales: parseFloat(kmData.km_totales_mes || 0),
          promedio: parseFloat(kmData.km_promedio_ruta || 0)
        }
      },
      tendenciaAnual,
      topChoferes,
      topClientes,
      perdidas,
      distribucionHoraria
    };

    return new Response(JSON.stringify(dashboardData), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
    }, { statementTimeout: 10000 });

  } catch (error) {
    console.error('[EXECUTIVE_DASHBOARD_ERROR]', error);
    
    return new Response(
      JSON.stringify({
        error: 'Failed to retrieve executive dashboard data',
        message: error.message,
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}

export default {
  getExecutiveDashboardData,
};
