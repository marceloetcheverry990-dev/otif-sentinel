/**
 * POST /api/recalcular-ruteo
 * Reaplica perfil, N° camiones y clima sobre viajes YA ARMADOS que el operador elige.
 * body.trip_ids: obligatorio (1..50). Solo viajes que todavía no salieron.
 * body.incluir_backlog: opcional; si es true, mezcla PENDIENTE_RUTEO en el VRP.
 */

import { createClient } from '@supabase/supabase-js';
import { CONFIG, CORS_HEADERS, requireTenantId } from '../config.js';
import { resolveDestinoCoords } from '../helpers/destino-coords.js';
import { resolveDepot, depotToSolver } from '../helpers/depots.js';
import { enrichOrdersWithSlaRisk } from '../helpers/sla-risk.js';
import { getEffectiveSpeedKmh, applyClimaToSpeed } from '../helpers/speed-calibration.js';
import { computeScanToken } from '../helpers/scan-token.js';
import { parseFlotaDisponible } from '../helpers/optimizer-flota.js';
import { resolvePerfilPesos } from '../helpers/perfil-pesos.js';
import { solveVrpAuto, calcularDistanciaKm } from '../helpers/vrp-solver.js';
import { rebuildSequences } from '../helpers/midday-reopt.js';
import {
  classifyTripStops,
  selectRecalcDrivers,
  estimateOpenEtas,
  parseSelectedTripIds,
} from '../helpers/recalcular-ruteo.js';
import { tryOptimizerLock, releaseOptimizerLock } from './optimizer.js';

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

function withGeo(o, clientesMap) {
  const cli = clientesMap.get(String(o.cliente || '').trim().toLowerCase()) || null;
  const coords = resolveDestinoCoords(o, cli);
  if (coords.lat == null || coords.lng == null) return null;
  const meta = parseMeta(o.metadata);
  return {
    ...o,
    lat: Number(coords.lat),
    lng: Number(coords.lng),
    volumen: Number(o.volumen || 1),
    peso_kg: Number(o.peso_kg ?? meta.peso_kg ?? 0) || 0,
    tags: parseTags(o.tags_requeridos || meta.tags_requeridos),
    tipo_movimiento: o.tipo_movimiento || 'ENTREGA',
    fecha_hora_sla: o.fecha_hora_sla || '2099-12-31 23:59:59',
    ventana_inicio: o.ventana_inicio || meta.ventana_inicio || null,
    ventana_fin: o.ventana_fin || meta.ventana_fin || o.fecha_hora_sla || null,
    metadata: meta,
  };
}

function tourKm(stops, depot) {
  if (!stops?.length) return 0;
  let d = calcularDistanciaKm(depot.lat, depot.lng, stops[0].lat, stops[0].lng);
  for (let i = 0; i < stops.length - 1; i++) {
    d += calcularDistanciaKm(stops[i].lat, stops[i].lng, stops[i + 1].lat, stops[i + 1].lng);
  }
  d += calcularDistanciaKm(stops[stops.length - 1].lat, stops[stops.length - 1].lng, depot.lat, depot.lng);
  return d * 1.2;
}

export async function recalcularRuteo(request, env, ctx, operator = null) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const tenant_id = operator?.tenant_id;
  const tenantError = requireTenantId(tenant_id);
  if (tenantError) return tenantError;

  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  const flotaCheck = parseFlotaDisponible(body.flota_disponible);
  if (!flotaCheck.ok) {
    return json({ exito: false, error: 'FLOTA_INVALIDA', msg: flotaCheck.error }, 400);
  }
  const nCamiones = flotaCheck.value === 99 ? 50 : flotaCheck.value;
  if (nCamiones < 1) {
    return json({ exito: false, error: 'FLOTA_INVALIDA', msg: 'Indicá al menos 1 camión para recalcular.' }, 400);
  }

  const selectedTrips = parseSelectedTripIds(body.trip_ids);
  if (!selectedTrips.ok) {
    return json({ exito: false, error: 'TRIPS_REQUIRED', msg: selectedTrips.error }, 400);
  }
  const incluirBacklog = body.incluir_backlog === true;
  const clima = body.clima || 'NORMAL';
  const perfilId = parseInt(body.perfil_id, 10) || null;

  const gotLock = await tryOptimizerLock(env, tenant_id);
  if (!gotLock) {
    return json({ exito: false, error: 'OPTIMIZATION_IN_PROGRESS', msg: 'Ya hay una optimización en curso.' }, 409);
  }

  try {
    const depotRow = await resolveDepot(env, tenant_id, body.depot_id || null);
    const depot = depotToSolver(depotRow);
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch },
    });

    let velocidad = CONFIG.VELOCIDAD_FALLBACK_KMH || 35;
    try {
      const cal = await getEffectiveSpeedKmh(supabase, { tenant_id });
      velocidad = applyClimaToSpeed(cal.velocidadKmH, clima);
    } catch {
      velocidad = applyClimaToSpeed(CONFIG.VELOCIDAD_FALLBACK_KMH || 35, clima);
    }

    let perfilPesos = resolvePerfilPesos(null);
    let perfilNombre = perfilPesos.nombre_perfil;
    if (perfilId) {
      let perfilData = null;
      let errPerfil = null;
      ({ data: perfilData, error: errPerfil } = await supabase
        .from('perfiles_optimizacion')
        .select('peso_distancia, peso_sla, peso_valor_carga, peso_riesgo_ia, nombre_perfil, tenant_id')
        .eq('perfil_id', perfilId)
        .or(`tenant_id.eq.${tenant_id},tenant_id.is.null`)
        .maybeSingle());
      if (errPerfil && /tenant_id/.test(String(errPerfil.message || ''))) {
        ({ data: perfilData, error: errPerfil } = await supabase
          .from('perfiles_optimizacion')
          .select('peso_distancia, peso_sla, peso_valor_carga, peso_riesgo_ia, nombre_perfil')
          .eq('perfil_id', perfilId)
          .maybeSingle());
      }
      if (perfilData) {
        perfilPesos = resolvePerfilPesos(perfilData);
        perfilNombre = perfilPesos.nombre_perfil;
      }
    }

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

    let { data: activeOrders, error: errAct } = await supabase
      .from('ordenes_pendientes')
      .select('ot_id, trip_id, stop_sequence, estado_operacional, cliente, volumen, peso_kg, tags_requeridos, tipo_movimiento, valor_oc_clp, lat, lng, metadata, chofer_asignado_id, fecha_hora_sla, ventana_inicio, ventana_fin')
      .eq('tenant_id', tenant_id)
      .not('trip_id', 'is', null)
      .not('estado_operacional', 'in', '("CANCELADO_PLANILLA")');
    if (errAct && /column/i.test(String(errAct.message || ''))) {
      ({ data: activeOrders, error: errAct } = await supabase
        .from('ordenes_pendientes')
        .select('ot_id, trip_id, stop_sequence, estado_operacional, cliente, volumen, tags_requeridos, tipo_movimiento, valor_oc_clp, lat, lng, metadata, chofer_asignado_id, fecha_hora_sla')
        .eq('tenant_id', tenant_id)
        .not('trip_id', 'is', null));
    }
    if (errAct) throw errAct;

    let { data: pendingRaw, error: errPend } = await supabase
      .from('ordenes_pendientes')
      .select('ot_id, trip_id, stop_sequence, estado_operacional, cliente, volumen, peso_kg, tags_requeridos, tipo_movimiento, valor_oc_clp, lat, lng, metadata, chofer_asignado_id, fecha_hora_sla, ventana_inicio, ventana_fin')
      .eq('tenant_id', tenant_id)
      .eq('estado_operacional', 'PENDIENTE_RUTEO')
      .is('trip_id', null);
    if (errPend && /column/i.test(String(errPend.message || ''))) {
      ({ data: pendingRaw, error: errPend } = await supabase
        .from('ordenes_pendientes')
        .select('ot_id, trip_id, stop_sequence, estado_operacional, cliente, volumen, tags_requeridos, tipo_movimiento, valor_oc_clp, lat, lng, metadata, chofer_asignado_id, fecha_hora_sla')
        .eq('tenant_id', tenant_id)
        .eq('estado_operacional', 'PENDIENTE_RUTEO')
        .is('trip_id', null));
    }
    if (errPend) throw errPend;

    const pending = [];
    for (const o of pendingRaw || []) {
      const g = withGeo(o, clientesMap);
      if (g) pending.push(g);
    }

    const byTrip = new Map();
    for (const o of activeOrders || []) {
      const g = withGeo(o, clientesMap);
      if (!g || !g.trip_id) continue;
      if (!byTrip.has(g.trip_id)) byTrip.set(g.trip_id, []);
      byTrip.get(g.trip_id).push(g);
    }

    let { data: choferesRows, error: errCh } = await supabase
      .from('choferes')
      .select('chofer_id, nombre_completo, capacidad_volumen, capacidad_peso, tags, patente_asignada, estado')
      .eq('tenant_id', tenant_id);
    if (errCh && /capacidad_peso|column/i.test(String(errCh.message || ''))) {
      ({ data: choferesRows, error: errCh } = await supabase
        .from('choferes')
        .select('chofer_id, nombre_completo, capacidad_volumen, tags, patente_asignada, estado')
        .eq('tenant_id', tenant_id));
    }
    if (errCh) throw errCh;

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
      .select('patente, trip_id_actual, ultima_lat, ultima_lng, estado')
      .eq('tenant_id', tenant_id);
    const flotaByTrip = new Map();
    for (const f of flotaRows || []) {
      if (f.trip_id_actual) flotaByTrip.set(f.trip_id_actual, f);
    }

    const inProgress = [];
    const unstarted = [];
    for (const [trip_id, stops] of byTrip.entries()) {
      const typed = classifyTripStops(stops);
      if (typed.kind === 'empty') continue;
      const choferId = String(stops.find((s) => s.chofer_asignado_id)?.chofer_asignado_id || '');
      const chofer = choferById.get(choferId) || null;
      const flota = flotaByTrip.get(trip_id);
      let seed = depot;
      if (flota?.ultima_lat != null && flota?.ultima_lng != null) {
        seed = { lat: Number(flota.ultima_lat), lng: Number(flota.ultima_lng) };
      } else if (typed.frozen.length) {
        const last = typed.frozen[typed.frozen.length - 1];
        seed = { lat: last.lat, lng: last.lng };
      }
      const model = {
        trip_id,
        chofer_id: choferId || null,
        chofer,
        patente: chofer?.patente_asignada || flota?.patente || null,
        frozen: typed.frozen,
        open: typed.open,
        seed,
      };
      if (typed.kind === 'in_progress') inProgress.push(model);
      else unstarted.push(model);
    }

    const wanted = new Set(selectedTrips.ids);
    const omitidosEnCurso = inProgress.filter((t) => wanted.has(t.trip_id)).map((t) => t.trip_id);
    const unstartedSel = unstarted.filter((t) => wanted.has(t.trip_id));
    if (!unstartedSel.length) {
      return json({
        exito: false,
        error: 'NO_UNSTARTED',
        msg: omitidosEnCurso.length
          ? 'Esos viajes ya salieron. Recalcular solo aplica a rutas que todavía no salieron.'
          : 'No encontré esos viajes para recalcular.',
        omitidos_en_curso: omitidosEnCurso,
      }, 409);
    }
    const protectedChoferIds = new Set();
    for (const t of inProgress) {
      if (t.chofer_id) protectedChoferIds.add(String(t.chofer_id));
    }
    for (const t of unstarted) {
      if (wanted.has(t.trip_id)) continue;
      if (t.chofer_id) protectedChoferIds.add(String(t.chofer_id));
    }
    unstarted.length = 0;
    unstarted.push(...unstartedSel);

    const pendingUsed = incluirBacklog ? pending : [];

    const runId = `REC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const updates = [];
    let reseqInProgress = 0;
    let viajesNuevos = 0;
    let viajesFusionados = 0;
    let vehicleTarget = 0;
    const sinAsignar = [];

    const persistOpen = (tripId, choferId, frozen, open, seed, extraMeta = {}) => {
      const sequenced = rebuildSequences(frozen, open);
      const openOnly = sequenced.filter((s) => {
        const st = String(s.estado_operacional || '').toUpperCase();
        return st !== 'ENTREGADO' && st !== 'RECHAZADO' && st !== 'EN_SITIO';
      });
      const etaByOt = estimateOpenEtas(openOnly, seed || depot, velocidad);
      const km = Number(tourKm(openOnly, seed || depot).toFixed(2));
      for (const s of openOnly) {
        const metaBase = parseMeta(s.metadata);
        const etaIso = etaByOt.get(s.ot_id) || null;
        updates.push((async () => {
          const tok = metaBase.scan_token || await computeScanToken(tenant_id, s.ot_id, env);
          const metadata = {
            ...metaBase,
            ...(tok ? { scan_token: tok } : {}),
            routing: {
              ...(metaBase.routing || {}),
              optimization_run_id: runId,
              trip_id: tripId,
              stop_sequence: s.stop_sequence,
              clima,
              perfil_id: perfilId,
              perfil_nombre: perfilNombre,
              ...(etaIso ? { eta_estimado: etaIso, eta_source: 'RECALC_RUTEO' } : {}),
              ...extraMeta,
            },
          };
          return supabase.from('ordenes_pendientes').update({
            trip_id: tripId,
            chofer_asignado_id: choferId || s.chofer_asignado_id || null,
            stop_sequence: s.stop_sequence,
            estado_operacional: String(s.estado_operacional || '').toUpperCase() === 'EN_RUTA'
              ? 'EN_RUTA'
              : 'CAMION_ASIGNADO',
            metadata,
            ...(etaIso ? { eta: etaIso } : {}),
          }).eq('ot_id', s.ot_id).eq('tenant_id', tenant_id);
        })());
      }
      if (tripId) {
        updates.push(supabase.from('trip_metrics').upsert({
          trip_id: tripId,
          tenant_id,
          chofer_id: choferId ? String(choferId) : null,
          km_planificados: km,
          total_paradas: (frozen?.length || 0) + openOnly.length,
          estado: 'activo',
        }, { onConflict: 'trip_id' }));
      }
    };

    const pool = [...pendingUsed];
    for (const t of unstarted) pool.push(...t.open);

    if (pool.length) {
      try { await enrichOrdersWithSlaRisk(supabase, tenant_id, pool); } catch (e) {
        console.warn('[RECALC_SLA]', e.message);
      }

      const assigned = unstarted
        .map((t) => t.chofer)
        .filter(Boolean);
      const disponibles = (choferesRows || []).filter((c) => {
        const id = String(c.chofer_id || '');
        if (!id || protectedChoferIds.has(id)) return false;
        const st = String(c.estado || '').toUpperCase();
        return st === 'DISPONIBLE' || st === 'OCUPADO';
      }).map((c) => choferById.get(String(c.chofer_id)) || c);

      const drivers = selectRecalcDrivers(assigned, disponibles, nCamiones);
      vehicleTarget = Math.min(
        nCamiones,
        Math.max(1, drivers.length),
        pool.length,
      );
      if (!drivers.length) {
        sinAsignar.push(...pool.map((p) => p.ot_id).filter(Boolean));
      } else {
      const avgVol = drivers.reduce((s, c) => s + (Number(c.capacidad_volumen) || 100), 0) / drivers.length;
      const avgPeso = drivers.reduce((s, c) => s + (Number(c.capacidad_peso) || 99999), 0) / drivers.length;
      const vrp = solveVrpAuto(pool, {
        depot,
        capacity: avgVol,
        capacityWeight: avgPeso,
        maxVehicles: vehicleTarget,
        maxStopsPerRoute: 24,
        startMs: Date.now(),
        pesos: perfilPesos,
        velocidadKmH: velocidad,
      });

      const tripByChofer = new Map();
      for (const t of unstarted) {
        if (t.chofer_id) tripByChofer.set(String(t.chofer_id), t.trip_id);
      }
      const usedTripIds = new Set();
      const usedChofer = new Set();
      const vrpRoutes = (vrp.routes || []).filter((r) => r.length).sort((a, b) => b.length - a.length);
      const covered = new Set(vrpRoutes.flat().map((s) => String(s.ot_id)));
      const missing = pool.filter((p) => p.ot_id && !covered.has(String(p.ot_id)));
      if (missing.length) {
        if (vrpRoutes.length) vrpRoutes[0].push(...missing);
        else vrpRoutes.push(missing);
      }

      vrpRoutes.forEach((route, idx) => {
        if (!route.length) return;
        const ch = drivers[idx];
        if (!ch) {
          sinAsignar.push(...route.map((r) => r.ot_id));
          return;
        }
        const choferId = String(ch.chofer_id);
        let tripId = tripByChofer.get(choferId);
        if (!tripId) {
          tripId = `TRIP-${crypto.randomUUID().split('-')[0].toUpperCase()}`;
          viajesNuevos += 1;
        }
        usedTripIds.add(tripId);
        usedChofer.add(choferId);
        persistOpen(tripId, choferId, [], route, depot, { recalc_unstarted: true });
        if (ch.patente_asignada) {
          updates.push(supabase.from('flota_vehiculos').update({
            trip_id_actual: tripId,
            estado: 'CAMION_ASIGNADO',
          }).eq('patente', ch.patente_asignada).eq('tenant_id', tenant_id));
        }
        updates.push(supabase.from('choferes').update({ estado: 'OCUPADO' })
          .eq('chofer_id', ch.chofer_id).eq('tenant_id', tenant_id));
      });

      for (const t of unstarted) {
        if (usedTripIds.has(t.trip_id)) continue;
        viajesFusionados += 1;
        if (t.chofer_id && !usedChofer.has(String(t.chofer_id))) {
          updates.push(supabase.from('choferes').update({ estado: 'DISPONIBLE' })
            .eq('chofer_id', t.chofer_id).eq('tenant_id', tenant_id));
        }
        if (t.patente) {
          updates.push(supabase.from('flota_vehiculos').update({
            trip_id_actual: null,
            estado: 'DISPONIBLE',
          }).eq('patente', t.patente).eq('tenant_id', tenant_id));
        }
      }
      }
      const sinUniq = [...new Set(sinAsignar.filter(Boolean))];
      for (const otId of sinUniq) {
        updates.push(supabase.from('ordenes_pendientes').update({
          trip_id: null,
          chofer_asignado_id: null,
          stop_sequence: null,
          estado_operacional: 'PENDIENTE_RUTEO',
        }).eq('ot_id', otId).eq('tenant_id', tenant_id));
      }
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
    const partes = [];
    if (reseqInProgress) partes.push(`${reseqInProgress} viaje(s) en curso reordenados`);
    if (pool.length) {
      partes.push(`perfil «${perfilNombre}», clima ${clima}, ${vehicleTarget || nCamiones} camión(es)`);
    }
    if (viajesNuevos) partes.push(`${viajesNuevos} viaje(s) nuevo(s)`);
    if (viajesFusionados) partes.push(`${viajesFusionados} viaje(s) fusionado(s)`);
    if (nCamiones > vehicleTarget && vehicleTarget > 0) {
      partes.push(`pediste ${nCamiones} camiones y se usaron ${vehicleTarget} (no hay más choferes libres para estas rutas)`);
    }
    if (sinAsignar.length) partes.push(`${sinAsignar.length} parada(s) volvieron a pendientes`);
    return json({
      exito: ok,
      run_id: runId,
      perfil: perfilNombre,
      perfil_pesos: {
        peso_distancia: perfilPesos.peso_distancia,
        peso_sla: perfilPesos.peso_sla,
        peso_valor_carga: perfilPesos.peso_valor_carga,
        peso_riesgo_ia: perfilPesos.peso_riesgo_ia,
        key: perfilPesos.key,
      },
      clima,
      camiones: nCamiones,
      camiones_usados: vehicleTarget || 0,
      velocidad_kmh: velocidad,
      viajes_en_curso: reseqInProgress,
      viajes_nuevos: viajesNuevos,
      viajes_fusionados: viajesFusionados,
      sin_asignar: sinAsignar.length,
      db_failures: dbFailures,
      trip_ids: unstarted.map((t) => t.trip_id),
      omitidos_en_curso: omitidosEnCurso,
      msg: partes.length
        ? `Recalculado: ${partes.join('. ')}. Pedí al chofer refrescar la app.`
        : 'Nada para recalcular.',
    }, ok ? 200 : 207);
  } catch (e) {
    console.error('[RECALC_RUTEO]', e.message);
    return json({ exito: false, error: e.message || 'Internal Server Error' }, 500);
  } finally {
    await releaseOptimizerLock(env, tenant_id);
  }
}
