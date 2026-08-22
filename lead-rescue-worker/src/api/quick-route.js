// src/api/quick-route.js
// Ruta Rápida / Espontánea - Crea órdenes y un viaje desde la Torre de Control
// Geocodificación: Mapbox + ArcGIS (N° de casa) con fallback Nominatim.

import { CORS_HEADERS, requireTenantId } from '../config.js';
import { withDb, withDbTransaction } from '../db.js';
import { verifyOperatorToken } from '../helpers/operator-auth.js';
import { geocodeAddress } from '../helpers/geocode.js';
import { resolveDepot, depotToSolver } from '../helpers/depots.js';
import { DEFAULT_DEPOT } from '../helpers/vrp-solver.js';
import { computeScanToken } from '../helpers/scan-token.js';
import { fitsCapacity, normalizeTags } from '../helpers/cargo-constraints.js';
import { resolveSlaFromTimeOfDay } from '../helpers/santiago-time.js';
import { parseFlotaDisponible } from '../helpers/optimizer-flota.js';
import { optimizarRutas } from './optimizer.js';
import { invalidateTowerPoll } from '../helpers/tower-poll-cache.js';

async function resolveOperatorTenant(request, env, operator = null) {
  if (operator?.tenant_id) {
    const err = requireTenantId(operator.tenant_id);
    if (err) return { ok: false, response: err };
    return { ok: true, tenant_id: operator.tenant_id };
  }
  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth;
  const err = requireTenantId(auth.payload.tenant_id);
  if (err) return { ok: false, response: err };
  return { ok: true, tenant_id: auth.payload.tenant_id };
}

/**
 * Geocodifica una dirección (casa si es posible).
 * Devuelve { lat, lng, display, precision } o null.
 */
async function geocodificar(direccion, env) {
  try {
    const hit = await geocodeAddress(direccion, env || {});
    if (!hit) return null;
    const prec = String(hit.precision || '').toLowerCase();
    // Rechazar centroides país/ciudad (misma política que Ruta Rápida UI)
    if (prec && !['house', 'street', 'address', 'pointaddress'].includes(prec)) {
      return null;
    }
    return {
      lat: hit.lat,
      lng: hit.lng,
      display: hit.display,
      precision: hit.precision,
      houseNumber: hit.houseNumber || null,
      provider: hit.provider
    };
  } catch (e) {
    console.error('[GEOCODIFICAR]', e.message);
    return null;
  }
}

/**
 * Geocodifica un array de direcciones en secuencia.
 */
async function geocodificarSecuencial(direcciones, env) {
  const resultados = [];
  for (let i = 0; i < direcciones.length; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 200));
    const coords = await geocodificar(direcciones[i], env);
    resultados.push(coords);
    console.log(`[GEOCODIFICAR] ${i + 1}/${direcciones.length} "${direcciones[i]}" → ${coords ? `${coords.lat},${coords.lng} (${coords.precision}/${coords.provider})` : 'null'}`);
  }
  return resultados;
}

/**
 * Ordena las paradas usando algoritmo nearest-neighbor (vecino más cercano)
 * Sale desde la bodega y en cada paso va a la parada más cercana no visitada
 * Devuelve el array de paradas reordenado con el índice original
 */
function optimizarOrdenParadas(paradasConCoords, depot = DEFAULT_DEPOT) {
  const BODEGA_LAT = depot.lat;
  const BODEGA_LNG = depot.lng;

  // Separar paradas con y sin coordenadas
  const conCoords = paradasConCoords.filter(p => p.coords !== null);
  const sinCoords = paradasConCoords.filter(p => p.coords === null);

  if (conCoords.length <= 1) {
    return paradasConCoords; // Sin suficientes puntos para optimizar
  }

  function distancia(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  const visitadas = new Set();
  const resultado = [];
  let currentLat = BODEGA_LAT;
  let currentLng = BODEGA_LNG;

  while (visitadas.size < conCoords.length) {
    let minDist = Infinity;
    let nearest = null;

    for (let i = 0; i < conCoords.length; i++) {
      if (visitadas.has(i)) continue;
      const d = distancia(currentLat, currentLng, conCoords[i].coords.lat, conCoords[i].coords.lng);
      if (d < minDist) {
        minDist = d;
        nearest = i;
      }
    }

    if (nearest !== null) {
      visitadas.add(nearest);
      resultado.push(conCoords[nearest]);
      currentLat = conCoords[nearest].coords.lat;
      currentLng = conCoords[nearest].coords.lng;
    }
  }

  // Las paradas sin coordenadas van al final
  return [...resultado, ...sinCoords];
}

export async function createQuickRoute(request, env, operator = null, ctx = null) {
  try {
    const tenantRes = await resolveOperatorTenant(request, env, operator);
    if (!tenantRes.ok) return tenantRes.response;
    const tenant_id = tenantRes.tenant_id;

    const body = await request.json();
    const { chofer_id, camion_listo, descripcion_carga, paradas } = body;
    const depotRow = await resolveDepot(env, tenant_id, body.depot_id || null);
    const depot = depotToSolver(depotRow);
    const flotaCheck = parseFlotaDisponible(body.flota_disponible);
    const flotaDisponible = flotaCheck.ok ? flotaCheck.value : 1;
    const splitFleet = flotaDisponible >= 2 && !chofer_id;

    if (!chofer_id && !splitFleet) {
      return new Response(JSON.stringify({ error: 'Debe seleccionar un chofer (o usar N° de camiones ≥ 2 en el header para partir la flota)' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    if (!paradas || paradas.length === 0) {
      return new Response(JSON.stringify({ error: 'Debe agregar al menos una parada' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    if (paradas.length > 24) {
      return new Response(JSON.stringify({ error: 'Máximo 24 paradas por ruta rápida' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    // Validar que cada parada tenga nombre y dirección
    for (let i = 0; i < paradas.length; i++) {
      if (!paradas[i].cliente?.trim()) {
        return new Response(JSON.stringify({ error: `Parada ${i + 1}: el nombre del cliente es obligatorio` }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
      if (!paradas[i].direccion?.trim()) {
        return new Response(JSON.stringify({ error: `Parada ${i + 1}: la dirección es obligatoria` }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // Preferir coordenadas ya validadas en el cliente; geocodificar solo las que falten.
    const coordenadas = [];
    for (let i = 0; i < paradas.length; i++) {
      const p = paradas[i];
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        coordenadas.push({
          lat,
          lng,
          precision: p.precision || 'client',
          provider: p.provider || 'client',
          display: p.display || null,
          houseNumber: p.houseNumber || null,
        });
      } else {
        if (i > 0) await new Promise((r) => setTimeout(r, 200));
        coordenadas.push(await geocodificar(p.direccion, env));
      }
    }
    // Optimizar el orden de visita usando nearest-neighbor
    const paradasConCoords = paradas.map((p, i) => ({ parada: p, coords: coordenadas[i], originalIndex: i }));
    const paradasOptimizadas = optimizarOrdenParadas(paradasConCoords, depot);
    const paradasOrdenadas = paradasOptimizadas.map(item => item.parada);
    const coordenadasOrdenadas = paradasOptimizadas.map(item => item.coords);

    // KPIs de ruta (antes del INSERT para persistir en metadata.routing)
    const COSTO_KM = 350;
    function haversineKm(lat1, lng1, lat2, lng2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    let kmPlan = 0;
    let prevLat = depot.lat;
    let prevLng = depot.lng;
    let lastWithCoords = false;
    for (const c of coordenadasOrdenadas) {
      if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
        kmPlan += haversineKm(prevLat, prevLng, c.lat, c.lng);
        prevLat = c.lat;
        prevLng = c.lng;
        lastWithCoords = true;
      }
    }
    if (lastWithCoords) kmPlan += haversineKm(prevLat, prevLng, depot.lat, depot.lng);
    kmPlan = Math.round(kmPlan * 10) / 10;
    const costoPlan = Math.round(kmPlan * COSTO_KM);

    // Bug #4: validar que al menos una parada tenga coordenadas antes de tocar la DB.
    // Si ninguna dirección geocodificó, la ruta es inservible en el mapa y el chofer
    // NO debe quedar marcado como OCUPADO.
    const geocodificadasCount = coordenadasOrdenadas.filter(c => c !== null).length;
    if (geocodificadasCount === 0) {
      return new Response(JSON.stringify({
        error: 'No se pudo geocodificar ninguna dirección. Verificá que las direcciones sean válidas e incluyan ciudad (ej: "Av Providencia 1234, Providencia, Santiago").',
        paradas_fallidas: paradasOrdenadas.map(p => p.direccion),
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    if (splitFleet) {
      const now = new Date();
      const dateStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Santiago',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(now).replace(/-/g, '');
      const batch = (globalThis.crypto?.randomUUID?.() || `${Date.now()}`).replace(/-/g, '').slice(0, 8).toUpperCase();

      await withDbTransaction(env, async (client) => {
        for (let i = 0; i < paradasOrdenadas.length; i++) {
          const parada = paradasOrdenadas[i];
          const coords = coordenadasOrdenadas[i];
          const otId = `RR-${dateStr}-${batch}-${String(i + 1).padStart(2, '0')}`;
          const slaIsoFromClock =
            resolveSlaFromTimeOfDay(parada.sla_hora || parada.hora_limite_sla, now)
            || (parada.fecha_hora_sla ? new Date(parada.fecha_hora_sla).toISOString() : null);
          const slaDateIso = slaIsoFromClock || resolveSlaFromTimeOfDay('18:00', now);
          const ventanaInicioIso = parada.ventana_inicio
            ? (String(parada.ventana_inicio).includes('T')
              ? parada.ventana_inicio
              : resolveSlaFromTimeOfDay(parada.ventana_inicio, now))
            : null;
          const tagsReq = normalizeTags(parada.tags || parada.tags_requeridos || []);
          const pesoKg = Number(parada.peso_kg || parada.peso || 0) || 0;
          const volumen = Number(parada.volumen || 1) || 1;
          const metadata = {
            origen: 'RUTA_RAPIDA',
            descripcion_carga: descripcion_carga || '',
            descripcion_parada: parada.descripcion || '',
            telefono_contacto: parada.telefono || null,
            email_contacto: parada.email || null,
            creado_en: now.toISOString(),
            direccion_entrega: parada.direccion || null,
            lat_destino: coords?.lat || null,
            lng_destino: coords?.lng || null,
            tags_requeridos: tagsReq,
            split_fleet: true,
            tipo_traslado: 'VENTA',
            cliente_rut: parada.cliente_rut || parada.rut || null,
          };
          const insertAttempts = [
            {
              sql: `INSERT INTO ordenes_pendientes (
                ot_id, cliente, estado_operacional, valor_oc_clp, monto_total,
                fecha_hora_sla, metadata, tenant_id, lat, lng, peso_kg, volumen,
                ventana_inicio, ventana_fin, tags_requeridos
              ) VALUES ($1,$2,'PENDIENTE_RUTEO',$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
              params: [
                otId, parada.cliente.trim(), parada.monto || 0, slaDateIso,
                JSON.stringify(metadata), tenant_id, coords?.lat || null, coords?.lng || null,
                pesoKg, volumen, ventanaInicioIso, slaDateIso, JSON.stringify(tagsReq),
              ],
            },
            {
              sql: `INSERT INTO ordenes_pendientes (
                ot_id, cliente, estado_operacional, valor_oc_clp, monto_total,
                fecha_hora_sla, metadata, tenant_id, lat, lng, tags_requeridos
              ) VALUES ($1,$2,'PENDIENTE_RUTEO',$3,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
              params: [
                otId, parada.cliente.trim(), parada.monto || 0, slaDateIso,
                JSON.stringify(metadata), tenant_id, coords?.lat || null, coords?.lng || null,
                JSON.stringify(tagsReq),
              ],
            },
          ];
          let ok = false;
          for (const attempt of insertAttempts) {
            const sp = `sp_rr_${i}_${Math.random().toString(36).slice(2, 6)}`;
            try {
              await client.query(`SAVEPOINT ${sp}`);
              await client.query(attempt.sql, attempt.params);
              await client.query(`RELEASE SAVEPOINT ${sp}`);
              ok = true;
              break;
            } catch (insErr) {
              try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch (_) { /* ignore */ }
              const schemaGap = /column .* does not exist|42703/i.test(String(insErr.message || ''))
                || insErr.code === '42703';
              if (!schemaGap) throw insErr;
            }
          }
          if (!ok) throw new Error('No se pudo insertar la parada ' + (i + 1));
        }
      }, { tenantId: tenant_id });

      const optReq = new Request('https://internal/api/optimizar-rutas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id,
          perfil_id: body.perfil_id || 1,
          flota_disponible: flotaDisponible,
          clima: body.clima || 'NORMAL',
          depot_id: body.depot_id || null,
          is_simulacion: false,
        }),
      });
      const optRes = await optimizarRutas(optReq, env, ctx, operator);
      const optData = await optRes.json().catch(() => ({}));
      if (!optRes.ok || optData.exito === false) {
        return new Response(JSON.stringify({
          error: optData.msg || optData.error || 'No se pudo ruteo con 3 camiones',
          detalle: optData,
        }), {
          status: optRes.status || 500,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
      return new Response(JSON.stringify({
        exito: true,
        split_fleet: true,
        viajes_creados: optData.viajes_creados || 0,
        paradas_creadas: paradasOrdenadas.length,
        chofer: `${optData.viajes_creados || 0} camiones (equilibrado)`,
        trip_id: (optData.viajes || optData.trips || []).map((v) => v.trip_id).filter(Boolean).join(', ') || 'varios',
        km_totales: optData.km_totales || optData.kmEstimado || null,
        costo_operativo: optData.costo_operativo || null,
        mensaje: `Se armaron ${optData.viajes_creados || 0} viajes con ${paradasOrdenadas.length} paradas (N° camiones = ${flotaDisponible}).`,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    let chofer, tripId, otIds, paradasGuardadas, estadoInicial;

    await withDbTransaction(env, async (client) => {
      let choferRes;
      try {
        await client.query('SAVEPOINT sp_chofer_sel');
        choferRes = await client.query(
          `SELECT chofer_id, nombre_completo, patente_asignada, rut,
                  capacidad_volumen, capacidad_peso, tags
           FROM choferes
           WHERE CAST(chofer_id AS VARCHAR) = CAST($1 AS VARCHAR) AND tenant_id = $2`,
          [chofer_id, tenant_id]
        );
        await client.query('RELEASE SAVEPOINT sp_chofer_sel');
      } catch (selErr) {
        try { await client.query('ROLLBACK TO SAVEPOINT sp_chofer_sel'); } catch (_) { /* ignore */ }
        if (!/capacidad_peso|42703|column .* does not exist/i.test(String(selErr.message || '') + selErr.code)) {
          throw selErr;
        }
        choferRes = await client.query(
          `SELECT chofer_id, nombre_completo, patente_asignada, rut, capacidad_volumen, tags
           FROM choferes
           WHERE CAST(chofer_id AS VARCHAR) = CAST($1 AS VARCHAR) AND tenant_id = $2`,
          [chofer_id, tenant_id]
        );
      }
      if (choferRes.rowCount === 0) {
        throw Object.assign(new Error('Chofer no encontrado'), { statusCode: 404 });
      }
      chofer = choferRes.rows[0];

      const stopsForCap = paradasOrdenadas.map((p) => ({
        peso_kg: Number(p.peso_kg || p.peso || 0) || 0,
        volumen: Number(p.volumen || 1) || 1,
        tags: normalizeTags(p.tags || p.tags_requeridos || []),
      }));
      {
        const allTags = stopsForCap.flatMap((s) => s.tags);
        const haz = allTags.some((t) => ['HAZMAT', 'ADR', 'PELGEROSO'].includes(t));
        const food = allTags.some((t) => ['FOOD', 'ALIMENTO', 'ALIMENTOS', 'FRIO_ALIMENTO'].includes(t));
        if (haz && food) {
          throw Object.assign(
            new Error('Segregación HAZMAT/FOOD: no se puede mezclar en la misma ruta rápida'),
            { statusCode: 400, code: 'segregation' }
          );
        }
      }
      const capFit = fitsCapacity(
        stopsForCap,
        Number(chofer.capacidad_volumen) || 100,
        Number(chofer.capacidad_peso) || 99999
      );
      if (!capFit.ok) {
        throw Object.assign(
          new Error(
            capFit.reason === 'weight_exceeded'
              ? 'La ruta excede la capacidad de peso del chofer'
              : 'La ruta excede la capacidad de volumen del chofer'
          ),
          { statusCode: 400, code: capFit.reason }
        );
      }

      const now = new Date();
      // J-2 + M-19: fecha Santiago + UUID (no Math.random de 4 chars)
      const dateStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Santiago',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(now).replace(/-/g, '');
      const randomPart = (globalThis.crypto?.randomUUID?.() || `${Date.now()}`)
        .replace(/-/g, '')
        .slice(0, 8)
        .toUpperCase();
      tripId = `SPOT-${dateStr}-${randomPart}`;
      estadoInicial = camion_listo ? 'CAMION_ASIGNADO' : 'PENDIENTE_RUTEO';
      otIds = [];
      paradasGuardadas = [];

      for (let i = 0; i < paradasOrdenadas.length; i++) {
        const parada = paradasOrdenadas[i];
        const coords = coordenadasOrdenadas[i];
        const otId = `${tripId}-${String(i + 1).padStart(2, '0')}`;
        otIds.push(otId);

        const slaIsoFromClock =
          resolveSlaFromTimeOfDay(parada.sla_hora || parada.hora_limite_sla, now)
          || (parada.fecha_hora_sla ? new Date(parada.fecha_hora_sla).toISOString() : null);
        const slaHorasLegacy = Number(parada.sla_horas);
        const slaDateIso = slaIsoFromClock
          || (Number.isFinite(slaHorasLegacy) && slaHorasLegacy > 0
            ? new Date(now.getTime() + slaHorasLegacy * 60 * 60 * 1000).toISOString()
            : resolveSlaFromTimeOfDay('18:00', now));

        const scanTok = await computeScanToken(tenant_id, otId, env);
        const pesoKg = Number(parada.peso_kg || parada.peso || 0) || 0;
        const ventanaInicio = parada.ventana_inicio || null;
        const ventanaFin = parada.ventana_fin || slaDateIso || null;
        const tagsReq = normalizeTags(parada.tags || parada.tags_requeridos || []);
        const metadata = {
          origen: 'RUTA_RAPIDA',
          descripcion_carga: descripcion_carga || '',
          descripcion_parada: parada.descripcion || '',
          telefono_contacto: parada.telefono || null,
          email_contacto: parada.email || null,
          trip_id_original: tripId,
          creado_en: now.toISOString(),
          direccion_entrega: parada.direccion || null,
          lat_destino: coords?.lat || null,
          lng_destino: coords?.lng || null,
          geocode_precision: coords?.precision || null,
          geocode_provider: coords?.provider || null,
          tags_requeridos: tagsReq,
          tipo_traslado: parada.tipo_traslado || 'VENTA',
          cliente_rut: parada.cliente_rut || parada.rut || null,
          // Demo / video: entrega sin foto/firma/QR (POD completo queda para Excel/tenant).
          pod_requirements: { foto: false, firma: false, scan: false, notas: false },
          routing: {
            distancia_total_viaje_km: kmPlan,
            costo_operacional: costoPlan,
            stop_sequence: i + 1,
          },
          ...(scanTok ? { scan_token: scanTok } : {}),
        };

        const insertParamsBase = [
          otId,
          parada.cliente.trim(),
          estadoInicial,
          parada.monto || 0,
          parada.monto || null,
          slaDateIso,
          JSON.stringify(metadata),
          tripId,
          i + 1,
          chofer_id,
          tenant_id,
        ];
        const latLng = [coords?.lat || null, coords?.lng || null];
        const pesoVentana = [pesoKg, ventanaInicio, ventanaFin];
        const tagsJson = JSON.stringify(tagsReq);

        // Schema real varía: algunos tenants no tienen lat/lng ni peso_kg en ordenes_pendientes.
        // Coords siempre van en metadata.lat_destino/lng_destino (ya en $7).
        const attempts = [
          {
            sql: `INSERT INTO ordenes_pendientes (
              ot_id, cliente, estado_operacional,
              valor_oc_clp, monto_total,
              fecha_hora_sla, metadata,
              trip_id, stop_sequence, chofer_asignado_id,
              tenant_id, lat, lng, peso_kg, ventana_inicio, ventana_fin, tags_requeridos
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
            params: [...insertParamsBase, ...latLng, ...pesoVentana, tagsJson],
          },
          {
            sql: `INSERT INTO ordenes_pendientes (
              ot_id, cliente, estado_operacional,
              valor_oc_clp, monto_total,
              fecha_hora_sla, metadata,
              trip_id, stop_sequence, chofer_asignado_id,
              tenant_id, peso_kg, ventana_inicio, ventana_fin, tags_requeridos
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
            params: [...insertParamsBase, ...pesoVentana, tagsJson],
          },
          {
            sql: `INSERT INTO ordenes_pendientes (
              ot_id, cliente, estado_operacional,
              valor_oc_clp, monto_total,
              fecha_hora_sla, metadata,
              trip_id, stop_sequence, chofer_asignado_id,
              tenant_id, lat, lng, tags_requeridos
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
            params: [...insertParamsBase, ...latLng, tagsJson],
          },
          {
            sql: `INSERT INTO ordenes_pendientes (
              ot_id, cliente, estado_operacional,
              valor_oc_clp, monto_total,
              fecha_hora_sla, metadata,
              trip_id, stop_sequence, chofer_asignado_id,
              tenant_id, tags_requeridos
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
            params: [...insertParamsBase, tagsJson],
          },
          {
            sql: `INSERT INTO ordenes_pendientes (
              ot_id, cliente, estado_operacional,
              valor_oc_clp, monto_total,
              fecha_hora_sla, metadata,
              trip_id, stop_sequence, chofer_asignado_id,
              tenant_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            params: insertParamsBase,
          },
        ];

        let inserted = false;
        let lastInsErr = null;
        for (const attempt of attempts) {
          const sp = `sp_qr_${Math.random().toString(36).slice(2, 8)}`;
          try {
            await client.query(`SAVEPOINT ${sp}`);
            await client.query(attempt.sql, attempt.params);
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            inserted = true;
            break;
          } catch (insErr) {
            lastInsErr = insErr;
            try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch (_) { /* ignore */ }
            const msg = String(insErr.message || '');
            const schemaGap = /column .* does not exist|peso_kg|ventana_|\\blat\\b|\\blng\\b/i.test(msg)
              || insErr.code === '42703';
            if (!schemaGap) throw insErr;
          }
        }
        if (!inserted) throw lastInsErr || new Error('No se pudo insertar la parada');

        // Guardar en tabla clientes con coordenadas
        if (parada.cliente && parada.direccion) {
          const spCli = `sp_cli_${Math.random().toString(36).slice(2, 8)}`;
          try {
            await client.query(`SAVEPOINT ${spCli}`);
            await client.query(`
              INSERT INTO clientes (nombre_cliente_raw, direccion_calle, lat, lng, tenant_id)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (tenant_id, nombre_cliente_raw) DO UPDATE SET
                direccion_calle = COALESCE(EXCLUDED.direccion_calle, clientes.direccion_calle),
                lat = COALESCE(EXCLUDED.lat, clientes.lat),
                lng = COALESCE(EXCLUDED.lng, clientes.lng)
            `, [parada.cliente.trim(), parada.direccion, coords?.lat || null, coords?.lng || null, tenant_id]);
            await client.query(`RELEASE SAVEPOINT ${spCli}`);
          } catch (cliErr) {
            try { await client.query(`ROLLBACK TO SAVEPOINT ${spCli}`); } catch (_) { /* ignore */ }
            console.warn('[QUICK_ROUTE_CLIENTES]', cliErr.message);
          }
        }

        paradasGuardadas.push({
          ot_id: otId,
          cliente: parada.cliente.trim(),
          direccion: parada.direccion,
          lat: coords?.lat || null,
          lng: coords?.lng || null,
          monto: parada.monto || null,
          descripcion: parada.descripcion || null,
          telefono: parada.telefono || null,
          sla: slaDateIso,
          geocodificado: coords !== null
        });
      }

      await client.query(
        "UPDATE choferes SET estado = 'OCUPADO' WHERE CAST(chofer_id AS VARCHAR) = CAST($1 AS VARCHAR) AND tenant_id = $2",
        [chofer_id, tenant_id]
      );

      // Vincular el viaje al vehículo para que la app del chofer lo vea
      // (misma lógica que /api/asignar-chofer).
      if (chofer.patente_asignada) {
        await client.query(
          `UPDATE flota_vehiculos
           SET trip_id_actual = $1,
               estado = $2,
               rut_chofer_asignado = COALESCE($3, rut_chofer_asignado)
           WHERE patente = $4 AND tenant_id = $5`,
          [
            tripId,
            estadoInicial,
            chofer.rut || null,
            chofer.patente_asignada,
            tenant_id,
          ]
        );
      }
      // COMMIT implícito — Response fuera de la transacción
    });

    // DESPACHADO: si el camión ya está listo, avisar destinatarios (idempotente vía outbox)
    if (camion_listo && otIds.length) {
      const { enqueueCustomerNotify } = await import('../helpers/customer-notify.js');
      const notifyJob = Promise.all(
        otIds.map((otId) =>
          enqueueCustomerNotify(env, {
            tenantId: tenant_id,
            otId,
            tripId,
            eventType: 'DESPACHADO',
          }).catch(() => {})
        )
      );
      if (ctx?.waitUntil) ctx.waitUntil(notifyJob);
    }

    const totalGeocodificadas = coordenadasOrdenadas.filter(c => c !== null).length;

    const rutaOptimizada = paradasGuardadas.map((p, i) => ({
      stop: i + 1, ot_id: p.ot_id, cliente: p.cliente, lat: p.lat, lng: p.lng,
    }));

    invalidateTowerPoll(tenant_id);

    return new Response(JSON.stringify({
      exito: true,
      trip_id: tripId,
      ot_ids: otIds,
      chofer: chofer.nombre_completo,
      estado: estadoInicial,
      paradas_creadas: paradasOrdenadas.length,
      paradas_geocodificadas: totalGeocodificadas,
      paradas: paradasGuardadas,
      // KPIs de la ruta
      km_totales: kmPlan,
      costo_operativo: costoPlan,
      ruta_optimizada: rutaOptimizada,
      depot_id: depotRow.depot_id,
      depot_nombre: depotRow.nombre,
      mensaje: `Ruta ${tripId} creada con ${paradas.length} paradas (${totalGeocodificadas} geocodificadas) y asignada a ${chofer.nombre_completo}`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });

  } catch (error) {
    console.error('[CREATE_QUICK_ROUTE]', error);
    const status = error.statusCode === 404 || error.statusCode === 400 ? error.statusCode : 500;
    const msg = (status === 404 || status === 400) ? error.message : 'Error al crear la ruta rápida';
    return new Response(JSON.stringify({
      error: msg,
      code: error.code || undefined,
      detalle: error.message,
    }), {
      status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

/**
 * Exporta las rutas rápidas en formato CSV
 * Compatible con las columnas del Excel de la Torre de Control
 */
export async function exportQuickRoutesCSV(request, env, operator = null) {
  try {
    const tenantRes = await resolveOperatorTenant(request, env, operator);
    if (!tenantRes.ok) return tenantRes.response;
    const tenant_id = tenantRes.tenant_id;

    const res = await withDb(env, async (client) => {
      return client.query(`
      SELECT 
        op.trip_id,
        op.stop_sequence,
        op.estado_operacional,
        op.ot_id,
        op.cliente,
        (op.metadata->>'lat_destino') as lat_destino,
        (op.metadata->>'lng_destino') as lng_destino,
        op.fecha_hora_sla,
        op.valor_oc_clp,
        op.monto_total,
        ch.nombre_completo as nombre_chofer,
        (op.metadata->>'descripcion_parada') as descripcion,
        (op.metadata->>'telefono_contacto') as telefono,
        op.created_at
      FROM ordenes_pendientes op
      LEFT JOIN choferes ch
        ON CAST(op.chofer_asignado_id AS VARCHAR) = CAST(ch.chofer_id AS VARCHAR)
        AND ch.tenant_id = op.tenant_id
      WHERE op.tenant_id = $1
        AND op.metadata->>'origen' = 'RUTA_RAPIDA'
      ORDER BY op.created_at DESC, op.trip_id, op.stop_sequence
    `, [tenant_id]);
    });

    // Generar CSV con las mismas columnas del Excel principal
    const headers = [
      'TRIP_ID', 'STOP_SEQUENCE', 'ESTADO_STOP', 'OT_ID',
      'CLIENTE', 'LAT_DESTINO', 'LNG_DESTINO',
      'FECHA_HORA_SLA', 'VALOR_OC_CLP', 'MONTO_TOTAL',
      'NOMBRE_CHOFER', 'DESCRIPCION', 'TELEFONO', 'CREADO_EN'
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const rows = res.rows.map(r => [
      r.trip_id,
      r.stop_sequence,
      r.estado_operacional,
      r.ot_id,
      r.cliente,
      r.lat_destino || '',
      r.lng_destino || '',
      r.fecha_hora_sla ? new Date(r.fecha_hora_sla).toISOString() : '',
      r.valor_oc_clp || '',
      r.monto_total || '',
      r.nombre_chofer || '',
      r.descripcion || '',
      r.telefono || '',
      r.created_at ? new Date(r.created_at).toISOString() : ''
    ].map(escapeCsv).join(','));

    const csv = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rutas-rapidas-${new Date().toISOString().slice(0, 10)}.csv"`,
        ...CORS_HEADERS
      }
    });

  } catch (error) {
    console.error('[EXPORT_QUICK_ROUTES]', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

/**
* Actualiza los datos faltantes de una parada espontánea
*/
export async function updateQuickRouteStop(request, env, operator = null) {
  const tenantRes = await resolveOperatorTenant(request, env, operator);
  if (!tenantRes.ok) return tenantRes.response;
  const tenant_id = tenantRes.tenant_id;

  const body = await request.json().catch(() => ({}));
  const { ot_id, monto, sla_fecha, descripcion } = body;

  if (!ot_id) {
    return new Response(JSON.stringify({ error: 'ot_id es requerido' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }

  try {
    return await withDb(env, async (client) => {
      const updates = [];
      const values = [];
      let idx = 1;

      if (monto !== undefined) {
        updates.push(`valor_oc_clp = $${idx}`);
        updates.push(`monto_total = $${idx}`);
        values.push(monto);
        idx++;
      }
      if (sla_fecha) {
        updates.push(`fecha_hora_sla = $${idx}`);
        values.push(sla_fecha);
        idx++;
      }
      if (descripcion) {
        updates.push(`metadata = metadata || $${idx}::jsonb`);
        values.push(JSON.stringify({ descripcion_parada: descripcion }));
        idx++;
      }

      if (updates.length === 0) {
        return new Response(JSON.stringify({ error: 'No hay datos para actualizar' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }

      values.push(ot_id);
      values.push(tenant_id);
      await client.query(
        `UPDATE ordenes_pendientes SET ${updates.join(', ')} WHERE ot_id = $${idx} AND tenant_id = $${idx + 1}`,
        values
      );

      return new Response(JSON.stringify({ exito: true, ot_id }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    });

  } catch (error) {
    console.error('[UPDATE_QUICK_ROUTE_STOP]', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

/**
 * PUT /api/quick-route/address
 * Edición en caliente de la dirección de una parada de Ruta Rápida.
 *
 * Body: { ot_id: string, nueva_direccion: string }
 *
 * Flujo:
 *   1. Validar que la parada existe y fue creada por RUTA_RAPIDA.
 *   2. Geocodificar la nueva dirección con Nominatim.
 *   3. Si geocodificación falla → 400.
 *   4. UPDATE ordenes_pendientes: lat, lng y metadata->>'direccion_entrega'.
 *   5. UPDATE clientes: lat, lng, direccion_calle.
 *
 * Restricción: solo editable si estado_operacional NOT IN ('ENTREGADO','RECHAZADO').
 */
export async function updateQuickRouteAddress(request, env, operator = null) {
  const tenantRes = await resolveOperatorTenant(request, env, operator);
  if (!tenantRes.ok) return tenantRes.response;
  const tenant_id = tenantRes.tenant_id;

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Body JSON inválido' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }

  const { ot_id, nueva_direccion } = body;

  if (!ot_id || !nueva_direccion?.trim()) {
    return new Response(JSON.stringify({ error: 'ot_id y nueva_direccion son requeridos' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }

  // Geocodificar en el servidor (casa si es posible — Mapbox/ArcGIS)
  const coords = await geocodificar(nueva_direccion.trim(), env);
  if (!coords) {
    return new Response(JSON.stringify({
      error: 'No se pudo geocodificar la nueva dirección. Verificá que incluya ciudad (ej: "Av Italia 1234, Providencia, Santiago").',
      direccion_intentada: nueva_direccion.trim(),
    }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  try {
    return await withDb(env, async (client) => {
      // Verificar que la parada existe, es de RUTA_RAPIDA y es editable
      const check = await client.query(`
        SELECT ot_id, cliente, estado_operacional, metadata
        FROM ordenes_pendientes
        WHERE ot_id = $1
          AND tenant_id = $2
          AND metadata->>'origen' = 'RUTA_RAPIDA'
          AND estado_operacional NOT IN ('ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA')
        LIMIT 1
      `, [ot_id, tenant_id]);

      if (check.rowCount === 0) {
        return new Response(JSON.stringify({
          error: 'Parada no encontrada, no es de Ruta Rápida, o ya fue cerrada (ENTREGADO/RECHAZADO).',
        }), { status: 404, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }

      const row = check.rows[0];

      // UPDATE: dirección + coords (metadata siempre; lat/lng columnas si existen)
      try {
        await client.query('SAVEPOINT sp_addr_lat');
        await client.query(`
          UPDATE ordenes_pendientes
          SET
            lat      = $1,
            lng      = $2,
            metadata = metadata
              || jsonb_build_object(
                  'lat_destino',        $1::numeric,
                  'lng_destino',        $2::numeric,
                  'direccion_entrega',  $3::text,
                  'geocode_precision',  $6::text
                 )
          WHERE ot_id = $4 AND tenant_id = $5
        `, [coords.lat, coords.lng, nueva_direccion.trim(), ot_id, tenant_id, coords.precision || null]);
        await client.query('RELEASE SAVEPOINT sp_addr_lat');
      } catch (updErr) {
        try { await client.query('ROLLBACK TO SAVEPOINT sp_addr_lat'); } catch (_) { /* ignore */ }
        if (!/column .*lat.* does not exist|column .*lng.* does not exist|42703/i.test(String(updErr.message || '') + updErr.code)) {
          throw updErr;
        }
        await client.query(`
          UPDATE ordenes_pendientes
          SET metadata = metadata
            || jsonb_build_object(
                'lat_destino',        $1::numeric,
                'lng_destino',        $2::numeric,
                'direccion_entrega',  $3::text,
                'geocode_precision',  $6::text
               )
          WHERE ot_id = $4 AND tenant_id = $5
        `, [coords.lat, coords.lng, nueva_direccion.trim(), ot_id, tenant_id, coords.precision || null]);
      }

      // UPDATE clientes (best-effort, no falla la operación si no hay registro)
      await client.query(`
        UPDATE clientes
        SET
          lat             = $1,
          lng             = $2,
          direccion_calle = $3
        WHERE LOWER(TRIM(nombre_cliente_raw)) = LOWER(TRIM($4))
          AND tenant_id = $5
      `, [coords.lat, coords.lng, nueva_direccion.trim(), row.cliente, tenant_id]);

      return new Response(JSON.stringify({
        exito: true,
        ot_id,
        nueva_direccion: nueva_direccion.trim(),
        lat: coords.lat,
        lng: coords.lng,
        display_name: coords.display || null,
        mensaje: `Dirección de ${ot_id} actualizada y geocodificada correctamente.`,
      }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }, { tenantId: tenant_id });
  } catch (error) {
    console.error('[UPDATE_QUICK_ROUTE_ADDRESS]', error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

/**
 * PUT /api/quick-route/cancel
 * Cancela todas las órdenes de un trip_id de Ruta Rápida (SPOT-).
 * Body: { trip_id: string }
 *
 * - Solo cancela viajes cuyo trip_id empieza con 'SPOT-'
 * - Pasa todas las paradas no terminales a CANCELADO_PLANILLA
 * - Libera al chofer (estado → DISPONIBLE) si todas sus rutas activas quedan canceladas
 */
export async function cancelQuickRoute(request, env, operator = null) {
  const tenantRes = await resolveOperatorTenant(request, env, operator);
  if (!tenantRes.ok) return tenantRes.response;
  const tenant_id = tenantRes.tenant_id;

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Body JSON inválido' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }

  const { trip_id } = body;

  if (!trip_id?.trim()) {
    return new Response(JSON.stringify({ error: 'trip_id es requerido' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }

  if (!trip_id.startsWith('SPOT-')) {
    return new Response(JSON.stringify({
      error: 'Solo se pueden cancelar rutas rápidas (trip_id debe empezar con SPOT-).',
    }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  try {
    return await withDb(env, async (client) => {
      // Cancelar todas las paradas activas del viaje
      const result = await client.query(`
        UPDATE ordenes_pendientes
        SET estado_operacional = 'CANCELADO_PLANILLA'
        WHERE trip_id = $1
          AND tenant_id = $2
          AND estado_operacional NOT IN (
            'ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA'
          )
        RETURNING ot_id, chofer_asignado_id
      `, [trip_id, tenant_id]);

      if (result.rowCount === 0) {
        return new Response(JSON.stringify({
          error: 'No se encontraron paradas cancelables para ese trip_id (ya puede estar completado o cancelado).',
        }), { status: 404, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }

      // Liberar flota si este era el viaje activo del vehículo
      await client.query(
        `UPDATE flota_vehiculos
         SET trip_id_actual = NULL, estado = 'ACTIVO'
         WHERE trip_id_actual = $1 AND tenant_id = $2`,
        [trip_id, tenant_id]
      );

      // Liberar al chofer si ya no tiene otros viajes activos
      const choferIds = [...new Set(result.rows.map(r => r.chofer_asignado_id).filter(Boolean))];
      for (const cId of choferIds) {
        const activos = await client.query(`
          SELECT COUNT(*) AS cnt
          FROM ordenes_pendientes
          WHERE CAST(chofer_asignado_id AS VARCHAR) = CAST($1 AS VARCHAR)
            AND tenant_id = $2
            AND estado_operacional NOT IN (
              'ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA'
            )
        `, [cId, tenant_id]);
        if (parseInt(activos.rows[0].cnt, 10) === 0) {
          await client.query(
            "UPDATE choferes SET estado = 'DISPONIBLE' WHERE CAST(chofer_id AS VARCHAR) = CAST($1 AS VARCHAR) AND tenant_id = $2",
            [cId, tenant_id]
          );
        }
      }

      return new Response(JSON.stringify({
        exito: true,
        trip_id,
        paradas_canceladas: result.rowCount,
        mensaje: `Ruta ${trip_id} cancelada. ${result.rowCount} parada(s) marcadas como CANCELADO_PLANILLA.`,
      }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    });
  } catch (error) {
    console.error('[CANCEL_QUICK_ROUTE]', error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}
