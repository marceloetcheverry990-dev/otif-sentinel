/**
 * src/api/sync.js
 * Auditoría Final: Integridad relacional, SLA preciso, reset de estados, limpieza de datos maestros y Trazabilidad Financiera (Acepta).
 */

import { CONFIG, requireTenantId } from '../config.js';
import { withDbTransaction } from '../db.js';
import { fetchRemoteTextSafe } from '../helpers/safe-remote-fetch.js';
import { parseAceptaCsv } from '../helpers/acepta-csv.js';
import { parseCSVLine } from '../helpers/csv.js';
import { normalizeSantiagoDate } from '../helpers/santiago-time.js';
import { computeScanToken } from '../helpers/scan-token.js';

// --- Helpers de Sanitización ---

const sanitizeFolio = (val) => {
  if (val === null || val === undefined) return null;
  // Conservar alfanumérico + guiones (no colapsar A-1001 y B-1001 a "1001")
  const cleaned = val.toString().trim().toUpperCase().replace(/[^A-Z0-9._:-]/g, '');
  return cleaned === '' ? null : cleaned;
};

const sanitizeCoord = (val) => {
  if (val === null || val === undefined || val === '') return null;
  let str = val.toString().replace(/,/g, '.');
  str = str.replace(/[^\d.-]/g, '');
  const parts = str.split('.');
  const n = parts.length <= 1
    ? parseFloat(str)
    : parseFloat(parts[0] + '.' + parts.slice(1).join(''));
  return Number.isFinite(n) ? n : null;
};

const normalizeDate = (val) => normalizeSantiagoDate(val);

// [ARREGLO] Evitar que cleanFinancial devuelva NaN si recibe strings no numéricos puros. 
// Number() con fallback a 0 protege los campos de la BD.
const cleanFinancial = (val) => {
  const num = Number(val?.toString().replace(/[^0-9.-]+/g, ""));
  return isNaN(num) ? 0 : num;
};

// --- Handler Principal ---

export async function syncExcel(request, env, ctx, operator = null) {
  try {
    const tenant_id = operator?.tenant_id;
    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    const formData = await request.formData();
    const urlSecreta = formData.get('url_secreta');
    const aceptaFile = formData.get('acepta_file');

    if (!urlSecreta) throw new Error("URL de Bodega no proporcionada.");

    let aceptaDict = {};
    if (aceptaFile) {
      const buffer = await aceptaFile.arrayBuffer();
      const fileName = typeof aceptaFile === 'object' && 'name' in aceptaFile
        ? aceptaFile.name
        : 'acepta.csv';
      aceptaDict = parseAceptaCsv(buffer, fileName);
    }

    // Fixture embebido: el Worker no siempre puede fetchearse a sí mismo (Access/loopback → 404)
    let csvText;
    const urlStr = String(urlSecreta);
    if (/\/api\/fixtures\/bodega-sample\.csv(?:\?|$)/i.test(urlStr)) {
      csvText = [
        'OT_ID,CLIENTE,VALOR_OC_CLP,LAT_DESTINO,LNG_DESTINO,FECHA_HORA_SLA,DIRECCION_DESTINO',
        'QA-SYNC-1001,Cliente Sync 1,15000,-33.4489,-70.6693,2026-07-29 18:00:00,"Avenida Libertador Bernardo OHiggins 100, Santiago, Chile"',
        'QA-SYNC-1002,Cliente Sync 2,22000,-33.4172,-70.6067,2026-07-29 19:00:00,"Avenida Apoquindo 3000, Las Condes, Santiago, Chile"',
        'QA-SYNC-1003,Cliente Sync 3,18000,-33.4265,-70.6150,2026-07-29 20:00:00,"Avenida Providencia 1200, Providencia, Santiago, Chile"',
      ].join('\n');
    } else {
      // SSRF: HTTPS only, no redirects, size/timeout caps, optional host allowlist
      const allowedHosts = env.SYNC_CSV_ALLOWED_HOSTS
        ? String(env.SYNC_CSV_ALLOWED_HOSTS).split(',').map((h) => h.trim()).filter(Boolean)
        : undefined;
      csvText = await fetchRemoteTextSafe(urlStr, {
        maxBytes: 8 * 1024 * 1024,
        timeoutMs: 15_000,
        allowedHosts,
      });
    }
    const rows = csvText.split(/\r?\n/).filter(line => line.trim() !== "").map(parseCSVLine);
      if (!csvText || csvText.length < 20) {
        throw new Error("CSV vacío o inválido.");
      }
      if (rows.length <= 1) {
        throw new Error("CSV sin filas de datos.");
      }
    const headers = rows[0].map(h => h.trim().toUpperCase());
    
    const idx = {
      ot: headers.indexOf('OT_ID'),
      cli: headers.indexOf('CLIENTE'),
      monto: headers.indexOf('VALOR_OC_CLP'),
      lat: headers.indexOf('LAT_DESTINO'),
      lng: headers.indexOf('LNG_DESTINO'),
      sla: headers.indexOf('FECHA_HORA_SLA'),
      dir: headers.indexOf('DIRECCION_DESTINO'),
      // Res. 154 (opcionales)
      peso: headers.indexOf('PESO_KG'),
      volumen: headers.indexOf('VOLUMEN'),
      cantidad: headers.indexOf('CANTIDAD'),
      tipoTraslado: Math.max(headers.indexOf('TIPO_TRASLADO'), headers.indexOf('TIPO_TRASLADO_RES154')),
      comuna: headers.indexOf('COMUNA_DESTINO'),
    };

    if (idx.ot === -1) throw new Error("Columna OT_ID faltante en CSV de Bodega.");

    // [ARREGLO] Arrays de memoria para agrupar todos los datos.
    const ordenesPreparadas = [];
    const clientesMap = new Map(); // Usar Map previene registros duplicados en el mismo Bulk Upsert.
    const idsPresentes = [];
    const otSeen = new Set();
    // 4. Preparación de Datos (en memoria, sin tocar la DB)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const otId = sanitizeFolio(row[idx.ot]); 
      if (!otId) continue;

        if (otSeen.has(otId)) {
          console.warn(`[SYNC] OT duplicada ignorada: ${otId}`);
          continue;
        }
        otSeen.add(otId);
        idsPresentes.push(otId);
        const lat = sanitizeCoord(row[idx.lat]);
        const lng = sanitizeCoord(row[idx.lng]);
        const slaIso = normalizeDate(row[idx.sla]);
        const matchAcepta = aceptaDict[otId] || { monto_total: null, uri: null };
        const metaObj = { 
          slaIso, 
          trazabilidad: matchAcepta.uri ? 'ACEPTA_OK' : 'PENDIENTE_FACTURACION'
        };
        if (lat != null && lng != null) {
          metaObj.lat_destino = lat;
          metaObj.lng_destino = lng;
        }
        if (idx.dir !== -1 && row[idx.dir]) {
          metaObj.direccion_entrega = String(row[idx.dir]).trim();
        }
        if (idx.comuna !== -1 && row[idx.comuna]) {
          metaObj.comuna_destino = String(row[idx.comuna]).trim();
        }

        const pesoKg = idx.peso !== -1 ? cleanFinancial(row[idx.peso]) : null;
        const volumen = idx.volumen !== -1 ? cleanFinancial(row[idx.volumen]) : null;
        const cantidad = idx.cantidad !== -1 ? cleanFinancial(row[idx.cantidad]) : null;
        let tipoTraslado = null;
        if (idx.tipoTraslado !== -1 && row[idx.tipoTraslado]) {
          tipoTraslado = String(row[idx.tipoTraslado]).trim().toUpperCase().replace(/\s+/g, '_');
        }

          // Almacenamos para ordenes
          ordenesPreparadas.push({
          otId,
          cliente: row[idx.cli] || 'N/A',
          valorOc: cleanFinancial(row[idx.monto]),
          slaIso,
          metadata: JSON.stringify(metaObj),
          montoTotalAcepta: matchAcepta.monto_total,
          uriAcepta: matchAcepta.uri,
          pesoKg: pesoKg || null,
          volumen: volumen || null,
          cantidad: cantidad || null,
          tipoTraslado,
        });

        // Almacenamos para clientes deduplicando
        const nombreCliente = row[idx.cli] ? row[idx.cli].trim() : null;
        if (nombreCliente && nombreCliente !== 'N/A' && nombreCliente !== 'DEFAULT') {
        const comuna = idx.comuna !== -1 && row[idx.comuna] ? String(row[idx.comuna]).trim() : null;
        clientesMap.set(nombreCliente, { nombreCliente, direccion: row[idx.dir], lat, lng, comuna });
      }
    }

    // C-11: token de escaneo por OT (HMAC) en metadata
    await Promise.all(ordenesPreparadas.map(async (o) => {
      const token = await computeScanToken(tenant_id, o.otId, env);
      if (!token) return;
      try {
        const m = JSON.parse(o.metadata || '{}');
        m.scan_token = token;
        o.metadata = JSON.stringify(m);
      } catch { /* ignore */ }
    }));

    // [ARREGLO CRÍTICO] Ordenar por otId. Si dos peticiones corren al mismo tiempo,
    // bloquearán las filas en la misma dirección (ej. 1, 2, 3), evitando el Deadlock por cruce.
    ordenesPreparadas.sort((a, b) => a.otId.localeCompare(b.otId));

    // [ARREGLO] Conexión a la DB justo antes de la inserción, reduciendo el tiempo de la transacción abierta.
    return await withDbTransaction(env, async (client) => {
      await client.query("SET statement_timeout = 5000");

      // 5. Bulk Upsert de Órdenes usando UNNEST
      if (ordenesPreparadas.length > 0) {
        // Transposición de arrays para el UNNEST de PostgreSQL
        const arrOtId = ordenesPreparadas.map(o => o.otId);
        const arrCliente = ordenesPreparadas.map(o => o.cliente);
        const arrValorOc = ordenesPreparadas.map(o => o.valorOc);
        const arrSlaIso = ordenesPreparadas.map(o => o.slaIso);
        const arrMetadata = ordenesPreparadas.map(o => o.metadata);
        const arrMontoTotal = ordenesPreparadas.map(o => o.montoTotalAcepta);
        const arrUri = ordenesPreparadas.map(o => o.uriAcepta);

        // Bulk upsert. Conflicto global por ot_id (legado): el WHERE de tenant evita
        // robar filas ajenas. Tras mig 010 conviene ON CONFLICT (tenant_id, ot_id).
        const upsertOrdenes = await client.query(`
          INSERT INTO ordenes_pendientes (
            ot_id, cliente, estado_operacional, valor_oc_clp, fecha_hora_sla, metadata, monto_total, uri, tenant_id
          )
          SELECT 
            ot_id, cliente, 'PENDIENTE_RUTEO', valor_oc_clp, fecha_hora_sla, metadata, monto_total, uri, $8::text
          FROM UNNEST($1::text[], $2::text[], $3::numeric[], $4::timestamptz[], $5::jsonb[], $6::numeric[], $7::text[]) 
          AS t(ot_id, cliente, valor_oc_clp, fecha_hora_sla, metadata, monto_total, uri)
          ON CONFLICT (tenant_id, ot_id) DO UPDATE SET
            cliente = EXCLUDED.cliente,
            valor_oc_clp = EXCLUDED.valor_oc_clp,
            fecha_hora_sla = EXCLUDED.fecha_hora_sla,
            monto_total = EXCLUDED.monto_total,
            uri = EXCLUDED.uri,
            metadata = COALESCE(ordenes_pendientes.metadata, '{}'::jsonb) || EXCLUDED.metadata,
            estado_operacional = 'PENDIENTE_RUTEO',
            trip_id = NULL,
            chofer_asignado_id = NULL
          WHERE ordenes_pendientes.estado_operacional IN ('PENDIENTE_RUTEO', 'PICKING', 'PACKING', 'STAGING', 'ATRASO')
        `, [arrOtId, arrCliente, arrValorOc, arrSlaIso, arrMetadata, arrMontoTotal, arrUri, tenant_id]);
        console.log('[SYNC] ordenes upsert rowCount=', upsertOrdenes.rowCount);

        // Res. 154: actualizar campos de guía (columnas opcionales del CSV)
        const arrPeso = ordenesPreparadas.map(o => o.pesoKg);
        const arrVol = ordenesPreparadas.map(o => o.volumen);
        const arrCant = ordenesPreparadas.map(o => o.cantidad);
        const arrTipo = ordenesPreparadas.map(o => o.tipoTraslado);
        await client.query(`
          UPDATE ordenes_pendientes o SET
            peso_kg = COALESCE(t.peso_kg, o.peso_kg),
            volumen = COALESCE(t.volumen, o.volumen),
            cantidad = COALESCE(t.cantidad, o.cantidad),
            tipo_traslado = COALESCE(t.tipo_traslado, o.tipo_traslado)
          FROM UNNEST($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::text[])
            AS t(ot_id, peso_kg, volumen, cantidad, tipo_traslado)
          WHERE o.tenant_id = $6 AND o.ot_id = t.ot_id
        `, [arrOtId, arrPeso, arrVol, arrCant, arrTipo, tenant_id]);
      }

      // 6. Bulk Upsert de Clientes
      const clientesArr = Array.from(clientesMap.values());
      if (clientesArr.length > 0) {
        const arrNombre = clientesArr.map(c => c.nombreCliente);
        const arrDir = clientesArr.map(c => c.direccion);
        const arrLat = clientesArr.map(c => c.lat);
        const arrLng = clientesArr.map(c => c.lng);
        const arrComuna = clientesArr.map(c => c.comuna || null);

        // C-8: nunca reasignar tenant_id; solo actualizar filas del mismo tenant
        await client.query(`
          INSERT INTO clientes (nombre_cliente_raw, direccion_calle, lat, lng, comuna, tenant_id)
          SELECT nombre_cliente_raw, direccion_calle, lat, lng, comuna, $6::text
          FROM UNNEST($1::text[], $2::text[], $3::numeric[], $4::numeric[], $5::text[])
          AS t(nombre_cliente_raw, direccion_calle, lat, lng, comuna)
          ON CONFLICT (tenant_id, nombre_cliente_raw) DO UPDATE SET 
            direccion_calle = COALESCE(EXCLUDED.direccion_calle, clientes.direccion_calle),
            lat = COALESCE(EXCLUDED.lat, clientes.lat),
            lng = COALESCE(EXCLUDED.lng, clientes.lng),
            comuna = COALESCE(EXCLUDED.comuna, clientes.comuna)
        `, [arrNombre, arrDir, arrLat, arrLng, arrComuna, tenant_id]);
      }

      // 7. Actualización de Estados "Fantasmas" — solo del tenant autenticado
      if (idsPresentes.length < 3) {
        throw new Error(`Sync abortado: sólo ${idsPresentes.length} OTs detectadas. Posible CSV incompleto.`);
      }
      const resCancel = await client.query(`
        UPDATE ordenes_pendientes 
        SET estado_operacional = 'CANCELADO_PLANILLA'
        WHERE tenant_id = $2
        AND estado_operacional IN ('PENDIENTE_RUTEO', 'PICKING', 'PACKING', 'STAGING', 'ATRASO')
        AND NOT (ot_id = ANY($1::text[]))
      `, [idsPresentes, tenant_id]);
      console.log('[SYNC]', {
        ordenes: ordenesPreparadas.length,
        clientes: Array.from(clientesMap.values()).length,
        presentes: idsPresentes.length,
        canceladas: resCancel.rowCount
      });

      return new Response(JSON.stringify({ 
        exito: true, 
        msg: `Sincronización completada. Procesadas: ${ordenesPreparadas.length}, Canceladas: ${resCancel.rowCount}`,
        procesadas: ordenesPreparadas.length, 
        fantasmas_cancelados: resCancel.rowCount 
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

  } catch (err) {
    console.error('[SYNC]', err.message);
    const msg = String(err.message || 'Error interno de sincronización');
    const clientish = /URL|CSV|Folio|OT_ID|ACEPTA|Host|HTTPS|vacío|inválid|permitid|allowlist|timeout|5MB|Excel|descargando|Redirecciones|recurso/i.test(msg);
    return new Response(JSON.stringify({
      error: clientish ? msg : 'Error interno de sincronización',
      detalle: msg,
    }), {
      status: clientish ? 400 : 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}