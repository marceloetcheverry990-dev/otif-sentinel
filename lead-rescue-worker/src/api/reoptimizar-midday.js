/**
 * POST /api/reoptimizar-midday
 * Inserta OTs PENDIENTE_RUTEO (sin trip) en viajes activos con mejor costo,
 * sin tocar EN_SITIO / ENTREGADO / RECHAZADO y sin limpiar flota global.
 */

import { createClient } from '@supabase/supabase-js';
import { CORS_HEADERS, requireTenantId } from '../config.js';
import { resolveDestinoCoords } from '../helpers/destino-coords.js';
import {
  solveVrpAuto,
  calcularDistanciaKm,
} from '../helpers/vrp-solver.js';
import { resolveDepot, depotToSolver } from '../helpers/depots.js';
import {
  splitFrozenOpen,
  pickBestTripForInsert,
  rebuildSequences,
} from '../helpers/midday-reopt.js';
import { enrichOrdersWithSlaRisk } from '../helpers/sla-risk.js';
import { getEffectiveSpeedKmh, applyClimaToSpeed } from '../helpers/speed-calibration.js';
import { CONFIG } from '../config.js';
import { computeScanToken } from '../helpers/scan-token.js';

/** M-16: ETA en cascada desde seed (GPS / última frozen / depot). */
function estimateOpenEtas(openStops, seed, velocidadKmH) {
  const vel = Math.max(5, Number(velocidadKmH) || 35);
  let tMs = Date.now();
  let lat = Number(seed?.lat);
  let lng = Number(seed?.lng);
  const map = new Map();
  for (const s of openStops || []) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const km = calcularDistanciaKm(lat, lng, s.lat, s.lng) * 1.2;
      tMs += (km / vel) * 3600 * 1000;
    } else {
      tMs += 20 * 60 * 1000;
    }
    const etaIso = new Date(tMs).toISOString();
    map.set(s.ot_id, etaIso);
    // servicio corto por defecto (B2C); mid-day no tiene diccionario ML
    tMs += 5 * 60 * 1000;
    lat = s.lat;
    lng = s.lng;
  }
  return map;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function parseTags(raw) {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function orderWeight(o) {
  const meta = parseMeta(o?.metadata);
  const n = Number(o?.peso_kg ?? meta.peso_kg ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function withTwFields(o) {
  const meta = parseMeta(o?.metadata);
  return {
    ...o,
    peso_kg: orderWeight(o),
    ventana_inicio: o.ventana_inicio || meta.ventana_inicio || null,
    ventana_fin: o.ventana_fin || meta.ventana_fin || o.fecha_hora_sla || null,
  };
}

export async function reoptimizarMidday(request, env, ctx, operator = null) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const tenant_id = operator?.tenant_id;
    const tenantError = requireTenantId(tenant_id);
    if (tenantError) return tenantError;

    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const allowNewTrips = body.allow_new_trips !== false;
    const clima = body.clima || 'NORMAL';

    const depotRow = await resolveDepot(env, tenant_id, body.depot_id || null);
    const depot = depotToSolver(depotRow);

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch },
    });

    // F2 — velocidad calibrada + clima
    let velocidad = CONFIG.VELOCIDAD_FALLBACK_KMH || 35;
    try {
      const cal = await getEffectiveSpeedKmh(supabase, { tenant_id });
      velocidad = applyClimaToSpeed(cal.velocidadKmH, clima);
    } catch {
      velocidad = applyClimaToSpeed(CONFIG.VELOCIDAD_FALLBACK_KMH || 35, clima);
    }

    // 1) Pendientes sin viaje
    let pendingRaw = null;
    let errPend = null;
    ({ data: pendingRaw, error: errPend } = await supabase
      .from('ordenes_pendientes')
      .select('ot_id, cliente, volumen, peso_kg, tipo_entrega, fecha_hora_sla, ventana_inicio, ventana_fin, tags_requeridos, tipo_movimiento, valor_oc_clp, lat, lng, metadata, estado_operacional')
      .eq('tenant_id', tenant_id)
      .eq('estado_operacional', 'PENDIENTE_RUTEO')
      .is('trip_id', null));
    if (errPend && /peso_kg|ventana_|\\blat\\b|\\blng\\b|column/i.test(String(errPend.message || ''))) {
      ({ data: pendingRaw, error: errPend } = await supabase
        .from('ordenes_pendientes')
        .select('ot_id, cliente, volumen, tipo_entrega, fecha_hora_sla, tags_requeridos, tipo_movimiento, valor_oc_clp, lat, lng, metadata, estado_operacional')
        .eq('tenant_id', tenant_id)
        .eq('estado_operacional', 'PENDIENTE_RUTEO')
        .is('trip_id', null));
    }
    if (errPend && /\\blat\\b|\\blng\\b|column/i.test(String(errPend.message || ''))) {
      ({ data: pendingRaw, error: errPend } = await supabase
        .from('ordenes_pendientes')
        .select('ot_id, cliente, volumen, tipo_entrega, fecha_hora_sla, tags_requeridos, tipo_movimiento, valor_oc_clp, metadata, estado_operacional')
        .eq('tenant_id', tenant_id)
        .eq('estado_operacional', 'PENDIENTE_RUTEO')
        .is('trip_id', null));
    }

    if (errPend) throw errPend;

    const { data: clientesRows } = await supabase
      .from('clientes')
      .select('nombre_cliente_raw, lat, lng')
      .eq('tenant_id', tenant_id);

    const clientesMap = new Map();
    for (const c of clientesRows || []) {
      if (c.nombre_cliente_raw && c.lat != null && c.lng != null) {
        clientesMap.set(String(c.nombre_cliente_raw).trim().toLowerCase(), c);
      }
    }

    const pending = [];
    for (const o of pendingRaw || []) {
      const cli = clientesMap.get(String(o.cliente || '').trim().toLowerCase()) || null;
      const coords = resolveDestinoCoords(o, cli);
      if (coords.lat == null || coords.lng == null) continue;
      pending.push(withTwFields({
        ...o,
        lat: coords.lat,
        lng: coords.lng,
        volumen: Number(o.volumen || 1),
        tags: parseTags(o.tags_requeridos),
        tipo_movimiento: o.tipo_movimiento || 'ENTREGA',
        fecha_hora_sla: o.fecha_hora_sla || '2099-12-31 23:59:59',
      }));
    }

    if (pending.length === 0) {
      return json({
        exito: true,
        mensaje: 'No hay pendientes geocodificados para insertar',
        insertados: 0,
        viajes_nuevos: 0,
        sin_asignar: 0,
      });
    }

    // 2) Viajes activos (cualquier OT no terminal con trip_id)
    let activeOrders = null;
    let errAct = null;
    ({ data: activeOrders, error: errAct } = await supabase
      .from('ordenes_pendientes')
      .select('ot_id, trip_id, stop_sequence, estado_operacional, cliente, volumen, peso_kg, tags_requeridos, tipo_movimiento, valor_oc_clp, lat, lng, metadata, chofer_asignado_id, fecha_hora_sla, ventana_inicio, ventana_fin')
      .eq('tenant_id', tenant_id)
      .not('trip_id', 'is', null)
      .not('estado_operacional', 'in', '("CANCELADO_PLANILLA")'));
    if (errAct && /peso_kg|ventana_|\\blat\\b|\\blng\\b|column/i.test(String(errAct.message || ''))) {
      ({ data: activeOrders, error: errAct } = await supabase
        .from('ordenes_pendientes')
        .select('ot_id, trip_id, stop_sequence, estado_operacional, cliente, volumen, tags_requeridos, tipo_movimiento, valor_oc_clp, lat, lng, metadata, chofer_asignado_id, fecha_hora_sla')
        .eq('tenant_id', tenant_id)
        .not('trip_id', 'is', null)
        .not('estado_operacional', 'in', '("CANCELADO_PLANILLA")'));
    }
    if (errAct && /\\blat\\b|\\blng\\b|column/i.test(String(errAct.message || ''))) {
      ({ data: activeOrders, error: errAct } = await supabase
        .from('ordenes_pendientes')
        .select('ot_id, trip_id, stop_sequence, estado_operacional, cliente, volumen, tags_requeridos, tipo_movimiento, valor_oc_clp, metadata, chofer_asignado_id, fecha_hora_sla')
        .eq('tenant_id', tenant_id)
        .not('trip_id', 'is', null)
        .not('estado_operacional', 'in', '("CANCELADO_PLANILLA")'));
    }

    if (errAct) throw errAct;

    const byTrip = new Map();
    for (const o of activeOrders || []) {
      if (!o.trip_id) continue;
      const st = String(o.estado_operacional || '').toUpperCase();
      if (['ENTREGADO', 'RECHAZADO', 'EN_SITIO', 'CAMION_ASIGNADO', 'EN_RUTA', 'PENDIENTE'].includes(st) || st === 'PENDIENTE_RUTEO') {
        if (!byTrip.has(o.trip_id)) byTrip.set(o.trip_id, []);
        const cli = clientesMap.get(String(o.cliente || '').trim().toLowerCase()) || null;
        const coords = resolveDestinoCoords(o, cli);
        // A-9: no caer a (0,0) con null ?? Number(null)
        if (coords.lat == null || coords.lng == null) continue;
        byTrip.get(o.trip_id).push(withTwFields({
          ...o,
          lat: coords.lat,
          lng: coords.lng,
          volumen: Number(o.volumen || 1),
          tags: parseTags(o.tags_requeridos),
        }));
      }
    }

    // Choferes + flota GPS seed
    let { data: choferesRows, error: errCh } = await supabase
      .from('choferes')
      .select('chofer_id, capacidad_volumen, capacidad_peso, tags, patente_asignada, estado')
      .eq('tenant_id', tenant_id);
    if (errCh && /capacidad_peso|column/i.test(String(errCh.message || ''))) {
      ({ data: choferesRows, error: errCh } = await supabase
        .from('choferes')
        .select('chofer_id, capacidad_volumen, tags, patente_asignada, estado')
        .eq('tenant_id', tenant_id));
    }

    const choferById = new Map();
    for (const c of choferesRows || []) {
      choferById.set(String(c.chofer_id), {
        ...c,
        capacidad_volumen: Number(c.capacidad_volumen) || 100,
        capacidad_peso: Number(c.capacidad_peso) || 99999,
        tags: parseTags(c.tags),
      });
    }

    const { data: flotaRows } = await supabase
      .from('flota_vehiculos')
      .select('patente, trip_id_actual, ultima_lat, ultima_lng, rut_chofer_asignado')
      .eq('tenant_id', tenant_id);

    const flotaByTrip = new Map();
    for (const f of flotaRows || []) {
      if (f.trip_id_actual) flotaByTrip.set(f.trip_id_actual, f);
    }

    const tripModels = [];
    for (const [trip_id, stops] of byTrip.entries()) {
      const withCoords = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
      if (!withCoords.length) continue;
      const { frozen, open } = splitFrozenOpen(withCoords);
      // Solo considerar viajes con al menos una parada abierta o frozen (activos)
      const hasLive = frozen.some((s) => s.estado_operacional === 'EN_SITIO')
        || open.some((s) => ['CAMION_ASIGNADO', 'EN_RUTA'].includes(String(s.estado_operacional || '').toUpperCase()));
      if (!hasLive && open.length === 0) continue;

      const choferId = String(
        withCoords.find((s) => s.chofer_asignado_id)?.chofer_asignado_id
        || ''
      );
      const chofer = choferById.get(choferId) || null;
      const flota = flotaByTrip.get(trip_id);
      let seed = depot;
      if (flota?.ultima_lat != null && flota?.ultima_lng != null) {
        seed = { lat: Number(flota.ultima_lat), lng: Number(flota.ultima_lng) };
      } else if (frozen.length) {
        const last = frozen[frozen.length - 1];
        seed = { lat: last.lat, lng: last.lng };
      }

      // A-17: capacidad restante = open + EN_SITIO (aún a bordo); no contar ENTREGADO/RECHAZADO
      const aboard = [
        ...frozen.filter((s) => String(s.estado_operacional || '').toUpperCase() === 'EN_SITIO'),
        ...open,
      ];
      const volume = aboard.reduce((s, o) => s + Number(o.volumen || 1), 0);
      const weight = aboard.reduce((s, o) => s + orderWeight(o), 0);
      tripModels.push({
        trip_id,
        chofer_id: choferId || null,
        patente: chofer?.patente_asignada || flota?.patente || null,
        frozen,
        open,
        volume,
        weight,
        capacity: chofer?.capacidad_volumen || 100,
        capacityWeight: chofer?.capacidad_peso || 99999,
        seed,
        depot,
        tags: chofer?.tags || [],
        velocidadKmH: velocidad,
      });
    }

    const inserted = [];
    const leftovers = [];
    const runId = `MID-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    // 3) Insertar cada pendiente en el mejor viaje
    // Trabajar sobre copias mutables de open/volume
    const working = tripModels.map((t) => ({ ...t, open: [...t.open] }));

    for (const cand of pending) {
      const pick = pickBestTripForInsert(working, cand, { depot, velocidadKmH: velocidad });
      if (!pick) {
        leftovers.push(cand);
        continue;
      }
      const trip = working.find((t) => t.trip_id === pick.trip_id);
      trip.open = pick.newOpen;
      trip.volume += Number(cand.volumen || 1);
      trip.weight = Number(trip.weight || 0) + orderWeight(cand);
      inserted.push({
        ot_id: cand.ot_id,
        trip_id: pick.trip_id,
        chofer_id: pick.chofer_id,
        delta_km: Number(pick.deltaKm.toFixed(2)),
      });
    }

    // 4) Persistir inserciones (solo open stops resecuenciados)
    const updates = [];
    for (const trip of working) {
      const touchedIds = new Set(
        inserted.filter((i) => i.trip_id === trip.trip_id).map((i) => i.ot_id)
      );
      if (touchedIds.size === 0) continue;

      const sequenced = rebuildSequences(trip.frozen, trip.open);
      const openOnly = sequenced.filter(
        (s) => !['ENTREGADO', 'RECHAZADO', 'EN_SITIO'].includes(String(s.estado_operacional || '').toUpperCase())
      );
      const etaByOt = estimateOpenEtas(openOnly, trip.seed || depot, velocidad);

      for (const s of openOnly) {
        const metaBase =
          typeof s.metadata === 'string'
            ? (() => { try { return JSON.parse(s.metadata); } catch { return {}; } })()
            : (s.metadata || {});
        const etaIso = etaByOt.get(s.ot_id) || null;
        updates.push(
          (async () => {
            const tok = metaBase.scan_token || await computeScanToken(tenant_id, s.ot_id, env);
            const metadata = {
              ...metaBase,
              ...(tok ? { scan_token: tok } : {}),
              routing: {
                ...(metaBase.routing || {}),
                optimization_run_id: runId,
                trip_id: trip.trip_id,
                stop_sequence: s.stop_sequence,
                midday_insert: touchedIds.has(s.ot_id),
                ...(etaIso ? { eta_estimado: etaIso, eta_source: 'MIDDAY_REOPT' } : {}),
              },
            };
            return supabase
              .from('ordenes_pendientes')
              .update({
                trip_id: trip.trip_id,
                chofer_asignado_id: trip.chofer_id || s.chofer_asignado_id || null,
                stop_sequence: s.stop_sequence,
                estado_operacional: 'CAMION_ASIGNADO',
                metadata,
                ...(etaIso ? { eta: etaIso } : {}),
              })
              .eq('ot_id', s.ot_id)
              .eq('tenant_id', tenant_id);
          })()
        );
      }
    }

    // 5) Leftovers → nuevos viajes (solo choferes DISPONIBLE), sin tocar flota de activos
    let nuevosViajes = 0;
    const sinAsignar = [];
    if (allowNewTrips && leftovers.length > 0) {
      const disponibles = (choferesRows || []).filter(
        (c) => c.estado === 'DISPONIBLE' && c.patente_asignada
      );
      if (disponibles.length > 0) {
        const avgCap =
          disponibles.reduce((s, c) => s + (Number(c.capacidad_volumen) || 100), 0) /
          disponibles.length;
        try {
          await enrichOrdersWithSlaRisk(supabase, tenant_id, leftovers);
        } catch (slaErr) {
          console.warn('[MIDDAY_SLA_RISK]', slaErr.message);
        }
        const pesoRiesgo = leftovers.some((o) => Number(o.riesgo_score) >= 50) ? 0.8 : 0;
        const vrp = solveVrpAuto(leftovers, {
          depot,
          capacity: avgCap,
          maxVehicles: disponibles.length,
          maxStopsPerRoute: 24,
          startMs: Date.now(),
          pesos: { peso_distancia: 1, peso_sla: 1.2, peso_valor_carga: 0, peso_riesgo_ia: pesoRiesgo },
          velocidadKmH: velocidad,
        });

        const pool = [...disponibles];
        for (const route of vrp.routes) {
          if (!route.length || !pool.length) {
            sinAsignar.push(...route.map((r) => r.ot_id));
            continue;
          }
          const ch = pool.shift();
          const tripId = `TRIP-${crypto.randomUUID().split('-')[0].toUpperCase()}`;
          nuevosViajes += 1;
          let seq = 1;
          for (const p of route) {
            updates.push(
              supabase
                .from('ordenes_pendientes')
                .update({
                  trip_id: tripId,
                  chofer_asignado_id: String(ch.chofer_id),
                  stop_sequence: seq++,
                  estado_operacional: 'CAMION_ASIGNADO',
                  metadata: {
                    routing: {
                      optimization_run_id: runId,
                      trip_id: tripId,
                      midday_new_trip: true,
                    },
                  },
                })
                .eq('ot_id', p.ot_id)
                .eq('tenant_id', tenant_id)
            );
          }
          if (ch.patente_asignada) {
            updates.push(
              supabase
                .from('flota_vehiculos')
                .update({ trip_id_actual: tripId, estado: 'CAMION_ASIGNADO' })
                .eq('patente', ch.patente_asignada)
                .eq('tenant_id', tenant_id)
            );
          }
          updates.push(
            supabase
              .from('choferes')
              .update({ estado: 'OCUPADO' })
              .eq('chofer_id', ch.chofer_id)
              .eq('tenant_id', tenant_id)
          );
        }
      } else {
        sinAsignar.push(...leftovers.map((l) => l.ot_id));
      }
    } else if (leftovers.length) {
      sinAsignar.push(...leftovers.map((l) => l.ot_id));
    }

    let dbFailures = 0;
    if (updates.length) {
      const settled = await Promise.allSettled(updates);
      for (const r of settled) {
        if (r.status === 'rejected') { dbFailures += 1; continue; }
        if (r.value && typeof r.value === 'object' && r.value.error) dbFailures += 1;
      }
    }

    const ok = dbFailures === 0;
    return json({
      exito: ok,
      run_id: runId,
      insertados: inserted.length,
      detalle_insertados: inserted.slice(0, 50),
      viajes_nuevos: nuevosViajes,
      sin_asignar: sinAsignar.length,
      db_failures: dbFailures,
      depot_id: depotRow.depot_id,
      depot_nombre: depotRow.nombre,
      sin_asignar_ids: sinAsignar.slice(0, 30),
      viajes_activos_considerados: working.length,
      mensaje:
        inserted.length || nuevosViajes
          ? `Mid-day: ${inserted.length} OT(s) insertada(s) en rutas activas, ${nuevosViajes} viaje(s) nuevo(s). Pedí al chofer refrescar la app.`
          : 'Nada que insertar en rutas activas (capacidad/tags o sin coords).',
    }, ok ? 200 : 207);
  } catch (e) {
    console.error('[REOPT_MIDDAY]', e.message);
    return json({ exito: false, error: 'Internal Server Error' }, 500);
  }
}
