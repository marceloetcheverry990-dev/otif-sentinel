// src/api/asignar-chofer.js
// Asigna o desasigna chofer de un trip vía Hyperdrive.
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { withDbTransaction } from '../db.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const OPEN_STOPS_SQL = `
  UPPER(COALESCE(estado_operacional, '')) NOT IN (
    'ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA'
  )
`;

export async function handleAsignarChofer(request, env, operator = null) {
  try {
    const body = await request.json();
    // J-6: nunca caer a body.tenant_id
    const tenant_id = operator?.tenant_id;
    const trip_id = body.trip_id;
    // chofer_id vacío / null = desasignar
    const rawChofer = body.chofer_id;
    const unassign =
      rawChofer == null
      || rawChofer === ''
      || String(rawChofer).trim() === ''
      || body.unassign === true;

    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    if (!trip_id) {
      return json({ error: 'trip_id es obligatorio', code: 'bad_request' }, 400);
    }

    const result = await withDbTransaction(env, async (client) => {
      const tripIdStr = String(trip_id).trim();

      const tripCheck = await client.query(
        `SELECT ot_id, estado_operacional, chofer_asignado_id
         FROM ordenes_pendientes
         WHERE tenant_id = $1 AND trip_id = $2`,
        [tenant_id, tripIdStr]
      );
      if (tripCheck.rowCount === 0) {
        const err = new Error('Viaje no encontrado en este tenant');
        err.statusCode = 404;
        err.code = 'trip_not_found';
        throw err;
      }

      // Viaje ya en calle: no se puede cambiar ni desasignar chofer
      const LOCKED_STATES = new Set(['EN_RUTA', 'EN_SITIO', 'ENTREGADO', 'RECHAZADO']);
      const locked = tripCheck.rows.some((r) =>
        LOCKED_STATES.has(String(r.estado_operacional || '').toUpperCase())
      );
      if (locked) {
        const err = new Error(
          'No se puede cambiar el chofer: el viaje ya está en ruta o con entregas en curso'
        );
        err.statusCode = 409;
        err.code = 'trip_in_progress';
        throw err;
      }

      const prevChoferIds = [
        ...new Set(
          tripCheck.rows
            .map((r) => (r.chofer_asignado_id != null ? String(r.chofer_asignado_id).trim() : ''))
            .filter(Boolean)
        ),
      ];

      if (unassign) {
        const upd = await client.query(
          `UPDATE ordenes_pendientes
           SET chofer_asignado_id = NULL
           WHERE tenant_id = $1
             AND trip_id = $2
             AND ${OPEN_STOPS_SQL}`,
          [tenant_id, tripIdStr]
        );

        // Liberar flota vinculada a este trip
        await client.query(
          `UPDATE flota_vehiculos
           SET trip_id_actual = NULL,
               estado = 'DISPONIBLE'
           WHERE tenant_id = $1
             AND trip_id_actual = $2`,
          [tenant_id, tripIdStr]
        );

        // Si el chofer previo no tiene otros viajes abiertos, volver a DISPONIBLE
        for (const prevId of prevChoferIds) {
          const other = await client.query(
            `SELECT 1 FROM ordenes_pendientes
             WHERE tenant_id = $1
               AND CAST(chofer_asignado_id AS VARCHAR) = CAST($2 AS VARCHAR)
               AND trip_id IS NOT NULL
               AND trip_id <> $3
               AND ${OPEN_STOPS_SQL}
             LIMIT 1`,
            [tenant_id, prevId, tripIdStr]
          );
          if (other.rowCount === 0) {
            await client.query(
              `UPDATE choferes
               SET estado = 'DISPONIBLE'
               WHERE CAST(chofer_id AS VARCHAR) = CAST($1 AS VARCHAR)
                 AND tenant_id = $2`,
              [prevId, tenant_id]
            );
          }
        }

        return {
          updated: upd.rowCount || 0,
          unassigned: true,
          chofer_id: null,
          nombre: null,
          patente: null,
          verificado: true,
        };
      }

      const choferRes = await client.query(
        `SELECT chofer_id, patente_asignada, nombre_completo, estado
         FROM choferes
         WHERE CAST(chofer_id AS VARCHAR) = CAST($1 AS VARCHAR)
           AND tenant_id = $2
         LIMIT 1`,
        [String(rawChofer), tenant_id]
      );
      if (choferRes.rowCount === 0) {
        const err = new Error('Chofer no encontrado en este tenant');
        err.statusCode = 404;
        err.code = 'chofer_not_found';
        throw err;
      }
      const chofer = choferRes.rows[0];
      const choferIdStr = String(chofer.chofer_id);

      const upd = await client.query(
        `UPDATE ordenes_pendientes
         SET chofer_asignado_id = $1,
             estado_operacional = CASE
               WHEN UPPER(COALESCE(estado_operacional, '')) IN (
                 'ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA', 'EN_SITIO'
               ) THEN estado_operacional
               ELSE 'CAMION_ASIGNADO'
             END
         WHERE tenant_id = $2
           AND trip_id = $3
           AND ${OPEN_STOPS_SQL}`,
        [choferIdStr, tenant_id, tripIdStr]
      );

      if (!upd.rowCount) {
        const err = new Error(
          'No se pudo asignar: el viaje no tiene paradas abiertas (todas entregadas/cerradas)'
        );
        err.statusCode = 409;
        err.code = 'no_open_stops';
        throw err;
      }

      await client.query(
        `UPDATE choferes
         SET estado = 'OCUPADO'
         WHERE CAST(chofer_id AS VARCHAR) = CAST($1 AS VARCHAR)
           AND tenant_id = $2`,
        [choferIdStr, tenant_id]
      );

      // Liberar choferes previos del trip si ya no tienen otras rutas
      for (const prevId of prevChoferIds) {
        if (prevId === choferIdStr) continue;
        const other = await client.query(
          `SELECT 1 FROM ordenes_pendientes
           WHERE tenant_id = $1
             AND CAST(chofer_asignado_id AS VARCHAR) = CAST($2 AS VARCHAR)
             AND trip_id IS NOT NULL
             AND ${OPEN_STOPS_SQL}
           LIMIT 1`,
          [tenant_id, prevId]
        );
        if (other.rowCount === 0) {
          await client.query(
            `UPDATE choferes
             SET estado = 'DISPONIBLE'
             WHERE CAST(chofer_id AS VARCHAR) = CAST($1 AS VARCHAR)
               AND tenant_id = $2`,
            [prevId, tenant_id]
          );
        }
      }

      let patente = chofer.patente_asignada || null;
      if (patente) {
        await client.query(
          `UPDATE flota_vehiculos
           SET trip_id_actual = $1,
               estado = 'CAMION_ASIGNADO'
           WHERE patente = $2
             AND tenant_id = $3`,
          [tripIdStr, patente, tenant_id]
        );
      }

      // J-5: verificación por igualdad exacta (no MAX de texto)
      const verify = await client.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (
                  WHERE CAST(chofer_asignado_id AS VARCHAR) = CAST($3 AS VARCHAR)
                )::int AS match_n
         FROM ordenes_pendientes
         WHERE tenant_id = $1 AND trip_id = $2
           AND chofer_asignado_id IS NOT NULL
           AND TRIM(chofer_asignado_id) <> ''
           AND ${OPEN_STOPS_SQL}`,
        [tenant_id, tripIdStr, choferIdStr]
      );
      const n = verify.rows[0]?.n || 0;
      const matchN = verify.rows[0]?.match_n || 0;

      return {
        updated: upd.rowCount || 0,
        unassigned: false,
        patente,
        chofer_id: choferIdStr,
        nombre: chofer.nombre_completo,
        verificado: n > 0 && matchN === n,
      };
    }, { statementTimeout: 8000 });

    return json({
      exito: true,
      ...result,
      aviso: result.unassigned
        ? 'Chofer desasignado del viaje'
        : (result.patente ? null : 'Chofer asignado; no tiene patente vinculada en flota'),
    });
  } catch (e) {
    console.error('[handleAsignarChofer] Error:', e.message);
    const status = e.statusCode || 500;
    return json({
      error: status === 500 ? 'Internal Server Error' : e.message,
      code: e.code || null,
      detalle: status === 500 ? e.message : undefined,
    }, status);
  }
}
