import { createClient } from '@supabase/supabase-js';
import { CONFIG, CORS_HEADERS } from '../config.js';
import { withDb } from '../db.js';
import {
  DEFAULT_DEPOT,
  calcularDistanciaKm,
  solveVrpAuto,
} from '../helpers/vrp-solver.js';
import { resolveDestinoCoords } from '../helpers/destino-coords.js';
import { resolveDepot, depotToSolver } from '../helpers/depots.js';
import { enrichOrdersWithSlaRisk } from '../helpers/sla-risk.js';
import { getEffectiveSpeedKmh, applyClimaToSpeed } from '../helpers/speed-calibration.js';
import { computeScanToken } from '../helpers/scan-token.js';

async function tryOptimizerLock(env, tenantId) {
  return withDb(env, async (client) => {
    const key = `optimizer_lock_${tenantId}`;
    const res = await client.query(
      `INSERT INTO system_flags (key, value, expires_at)
       VALUES ($1, 'OPEN', NOW() + INTERVAL '3 minutes')
       ON CONFLICT (key) DO UPDATE
         SET value = 'OPEN', expires_at = NOW() + INTERVAL '3 minutes'
       WHERE system_flags.value IS DISTINCT FROM 'OPEN'
          OR system_flags.expires_at IS NULL
          OR system_flags.expires_at < NOW()
       RETURNING key`,
      [key]
    );
    return res.rowCount > 0;
  }, { tenantId }).catch((err) => {
    console.warn('[OPTIMIZER_LOCK]', err.message);
    return true; // fail-open si no existe system_flags
  });
}

async function releaseOptimizerLock(env, tenantId) {
  return withDb(env, async (client) => {
    await client.query(
      `UPDATE system_flags SET value = 'CLOSED', expires_at = NULL WHERE key = $1`,
      [`optimizer_lock_${tenantId}`]
    );
  }, { tenantId }).catch(() => {});
}

// ============================================================================
// CONSTANTES
// ============================================================================
const BODEGA_LAT = DEFAULT_DEPOT.lat;
const BODEGA_LNG = DEFAULT_DEPOT.lng;
const FACTOR_EQUIDAD = 0.6; 
const PRECIO_DIESEL_CLP = 1050;
const RENDIMIENTO_KML = 8;
const COSTO_TAG_KM = 60;

function calcularTiempoServicioSegundos(orden, diccionarioTiempos) {
  const clienteNormalizado = orden.cliente ? String(orden.cliente).trim().toLowerCase() : '';
  if (diccionarioTiempos && diccionarioTiempos.has(clienteNormalizado)) {
    return diccionarioTiempos.get(clienteNormalizado);
  }
  if (orden.tipo_entrega === 'B2B') return 45 * 60;
  if (Number(orden.volumen) > 10) return 30 * 60;
  return 5 * 60;
}

// [ARQUITECTURA CORE]: Constructor ISO absoluto inmune a la zona horaria del servidor Edge
function obtenerInicioOperacionMs() {
  const now = new Date();
  
  // Función pura para extraer solo el valor numérico de la hora local chilena (0-23)
  const getChileHour = (dateObj) => parseInt(new Intl.DateTimeFormat('en-US', { 
    timeZone: 'America/Santiago', hour: 'numeric', hourCycle: 'h23' 
  }).format(dateObj), 10);
  
  const currentHour = getChileHour(now);

  // Si son pasadas las 20:00 o antes de las 08:00, calculamos el inicio para las 08:00 AM operativas
  if (currentHour >= 20 || currentHour < 8) {
    const diasASumar = currentHour >= 20 ? 1 : 0;
    const targetDate = new Date(now.getTime() + (diasASumar * 86400000));
    
    // Extraemos de forma segura el Día, Mes y Año de Santiago
    const datePartsStr = new Intl.DateTimeFormat('en-US', { 
        timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' 
    }).format(targetDate);
    
    const dateParts = datePartsStr.split('/');
    const mm = dateParts[0].padStart(2, '0');
    const dd = dateParts[1].padStart(2, '0');
    const yyyy = dateParts[2];
    
    // Construimos una fecha rígida asumiendo el estándar UTC-4 (Invierno CL) a las 08:00 AM
    let attemptTime = new Date(`${yyyy}-${mm}-${dd}T08:00:00.000-04:00`).getTime();
    
    // Verificamos matemáticamente en qué hora decantó este intento (Autocompensación DST)
    const attemptHour = getChileHour(new Date(attemptTime));
    
    if (attemptHour === 9) {
        attemptTime -= 3600000; // Restamos 1 hora si el DST hizo que fueran las 09:00
    } else if (attemptHour === 7) {
        attemptTime += 3600000; // Sumamos 1 hora si el país transita a UTC-5
    }
    
    return attemptTime;
  }
  
  // Ruteo en horario laboral: Inicia "ahora"
  return now.getTime();
}

async function resolverViajeTrafico(cluster, env, depot = DEFAULT_DEPOT) {
  try {
    const MAPBOX_TOKEN = env.MAPBOX_TOKEN || CONFIG.MAPBOX_TOKEN;
    if (!MAPBOX_TOKEN) throw new Error("Missing Mapbox Token");

    const coords = [{ lat: depot.lat, lng: depot.lng }, ...cluster];
    if (coords.length > 25) return null; 

    const coordsString = coords.map(c => `${c.lng},${c.lat}`).join(';');
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coordsString}?geometries=geojson&steps=false&access_token=${MAPBOX_TOKEN}`;
    
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 6000); 
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id); 
    
    if (!res.ok) throw new Error(`Mapbox HTTP Error: ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) return null;
    return { route: data.routes[0] };
  } catch (e) {
    return null; 
  }
}

// ============================================================================
// ORQUESTADOR PRINCIPAL DEL EDGE WORKER
// ============================================================================
export async function optimizarRutas(request, env, ctx, operator = null) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS, status: 204 });

  try {
    const body = await request.json();
    const isSimulacion = body.is_simulacion === true;
    // Tenant siempre desde JWT de operador; no confiar en body.tenant_id
    const tenant_id = operator?.tenant_id || body.tenant_id;
    
    // Regla #2: Validación estricta Multi-Tenant
    if (!tenant_id) {
        return new Response(JSON.stringify({ error: 'Bad Request: Missing tenant_id.' }), { 
          status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } 
        });
    }

    const climaSeleccionado = body.clima || 'NORMAL';
    // Identificador único de esta corrida del optimizer — se propaga a todas las órdenes
    const optimizationRunId = `OPT-${crypto.randomUUID()}`;
    // M-18: 0 debe congelar salidas; solo null/undefined/NaN → sin límite
    const flotaRaw = body.flota_disponible;
    const flotaParsed = flotaRaw === null || flotaRaw === undefined || flotaRaw === ''
      ? NaN
      : parseInt(flotaRaw, 10);
    const flotaDisponible = Number.isFinite(flotaParsed)
      ? Math.max(0, flotaParsed)
      : 99;
    if (flotaDisponible === 0) {
      return new Response(JSON.stringify({
        exito: true, msg: 'FLOTA_CONGELADA', viajes_creados: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    // A-21: lock por tenant (evita doble clic)
    const gotLock = await tryOptimizerLock(env, tenant_id);
    if (!gotLock) {
      return new Response(JSON.stringify({
        exito: false, error: 'OPTIMIZATION_IN_PROGRESS',
        msg: 'Ya hay una optimización en curso para este tenant',
      }), { status: 409, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    try {
    const perfilId = parseInt(body.perfil_id, 10) || null;
    const depotRow = await resolveDepot(env, tenant_id, body.depot_id || null);
    const depot = depotToSolver(depotRow);
    const BODEGA_LAT = depot.lat;
    const BODEGA_LNG = depot.lng;
    console.log('[OPTIMIZER] Depot:', depotRow.depot_id, depotRow.nombre, BODEGA_LAT, BODEGA_LNG);

    // Regla #1: Conexión vía HTTP a Supabase
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false }, global: { fetch: fetch }
    });

    // F2 — base calibrada; clima como factor relativo
    let velocidadPromedioKmH = CONFIG.VELOCIDAD_FALLBACK_KMH || 35;
    try {
      const cal = await getEffectiveSpeedKmh(supabase, { tenant_id });
      velocidadPromedioKmH = applyClimaToSpeed(cal.velocidadKmH, climaSeleccionado);
      console.log('[OPTIMIZER] Velocidad F2:', cal.velocidadKmH, cal.source, '→ clima', climaSeleccionado, '=', velocidadPromedioKmH);
    } catch (speedErr) {
      velocidadPromedioKmH = applyClimaToSpeed(CONFIG.VELOCIDAD_FALLBACK_KMH || 35, climaSeleccionado);
      console.warn('[OPTIMIZER_SPEED_CAL]', speedErr.message);
    }

    // 1. DICCIONARIO ML
    const diccionarioTiempos = new Map();
    try {
      const { data: historico, error: errHist } = await supabase
        .from('ordenes_pendientes')
        .select('cliente, hora_real_entrega, hora_llegada')
        .eq('tenant_id', tenant_id)
        .eq('estado_operacional', 'ENTREGADO')
        .not('hora_real_entrega', 'is', null)
        .not('hora_llegada', 'is', null);

      if (!errHist && historico) {
        const tempGroup = {};
        historico.forEach(row => {
            if (!row.cliente) return;
            const clienteNormalizado = String(row.cliente).trim().toLowerCase();
            const diffSegundos = (new Date(row.hora_real_entrega).getTime() - new Date(row.hora_llegada).getTime()) / 1000;
            if (diffSegundos > 0) {
                if (!tempGroup[clienteNormalizado]) tempGroup[clienteNormalizado] = { sum: 0, count: 0 };
                tempGroup[clienteNormalizado].sum += diffSegundos;
                tempGroup[clienteNormalizado].count++;
            }
        });
        for (const [cli, stats] of Object.entries(tempGroup)) {
            diccionarioTiempos.set(cli, Math.round(stats.sum / stats.count));
        }
      }
    } catch (err) {
      console.warn("[ML_FALLBACK] Reglas estáticas activadas.");
    }

    // 2. LIMPIEZA DE VIAJES ANTERIORES
    // IMPORTANTE: excluir PENDIENTE, CAMION_ASIGNADO, EN_RUTA y EN_SITIO para no destruir
    // rutas que ya están asignadas o en curso (ej: creadas por Ruta Rápida).
    await supabase
      .from('ordenes_pendientes')
      .update({trip_id: null, chofer_asignado_id: null, stop_sequence: null})
      .eq('tenant_id', tenant_id)
      // A-18: no tocar PENDIENTE_RUTEO (Ruta Rápida con camion_listo=false ya tiene trip_id)
      .not('estado_operacional', 'in', '("ENTREGADO","RECHAZADO","CAMION_ASIGNADO","EN_RUTA","EN_SITIO","PENDIENTE","PENDIENTE_RUTEO")');
    // Solo liberar vehículos ociosos. Nunca tocar camiones ya en ruta / asignados
    // (su trip_id_actual es la fuente de verdad de la app chofer).
    await supabase
      .from('flota_vehiculos')
      .update({trip_id_actual: null, estado: 'DISPONIBLE'})
      .eq('tenant_id', tenant_id)
      .not('trip_id_actual', 'is', null)
      .not('estado', 'in', '("EN_RUTA","CAMION_ASIGNADO")');

    // 3. EXTRACCIÓN DE ÓRDENES Y CRUCE GEOGRÁFICO EN MEMORIA
    let ordenesRowsRaw = null;
    let errOrdenes = null;
    ({ data: ordenesRowsRaw, error: errOrdenes } = await supabase
        .from('ordenes_pendientes')
        .select('ot_id, cliente, volumen, peso_kg, tipo_entrega, fecha_hora_sla, ventana_inicio, ventana_fin, tags_requeridos, tipo_movimiento, valor_oc_clp, lat, lng, metadata') 
        .eq('tenant_id', tenant_id)
        .eq('estado_operacional', 'PENDIENTE_RUTEO')
        .is('trip_id', null));
    if (errOrdenes && /peso_kg|ventana_|\\blat\\b|\\blng\\b|column/i.test(String(errOrdenes.message || ''))) {
      ({ data: ordenesRowsRaw, error: errOrdenes } = await supabase
        .from('ordenes_pendientes')
        .select('ot_id, cliente, volumen, tipo_entrega, fecha_hora_sla, tags_requeridos, tipo_movimiento, valor_oc_clp, metadata')
        .eq('tenant_id', tenant_id)
        .eq('estado_operacional', 'PENDIENTE_RUTEO')
        .is('trip_id', null));
    }

    if (errOrdenes) throw errOrdenes;
    console.log('[OPTIMIZER] Ordenes raw:', ordenesRowsRaw?.length || 0);
    if (!ordenesRowsRaw || ordenesRowsRaw.length === 0) {
      return new Response(JSON.stringify({ exito: true, msg: "NO_PENDING_ORDERS", viajes_creados: 0 }), { 
        status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } 
      });
    }

    const { data: clientesRows, error: errClientes } = await supabase
        .from('clientes')
        .select('nombre_cliente_raw, lat, lng')
        .eq('tenant_id', tenant_id);
    
    if (errClientes) throw errClientes;
    console.log('[OPTIMIZER] Clientes:', clientesRows?.length || 0);
    const clientesMap = new Map();
    if (clientesRows) {
        clientesRows.forEach(c => {
            if (c.nombre_cliente_raw && c.lat != null && c.lng != null) {
                clientesMap.set(String(c.nombre_cliente_raw).trim().toLowerCase(), { lat: c.lat, lng: c.lng });
            }
        });
    }

    const ordenes = [];
    ordenesRowsRaw.forEach(o => {
        const cliKey = o.cliente ? String(o.cliente).trim().toLowerCase() : '';
        const clienteRow = clientesMap.get(cliKey) || null;
        const resolved = resolveDestinoCoords(o, clienteRow);
        
        if (resolved.lat != null && resolved.lng != null) {
            const meta = typeof o.metadata === 'string'
              ? (() => { try { return JSON.parse(o.metadata); } catch { return {}; } })()
              : (o.metadata || {});
            const riesgo =
              Number(meta?.analysis?.ia?.risk_score) ||
              Number(meta?.routing?.risk_score) ||
              0;
            ordenes.push({
                ...o,
                lat: Number(resolved.lat),
                lng: Number(resolved.lng),
                volumen: o.volumen || 1,
                peso_kg: Number(o.peso_kg || 0),
                tipo_entrega: o.tipo_entrega || 'B2C',
                fecha_hora_sla: o.fecha_hora_sla || '2099-12-31 23:59:59',
                ventana_inicio: o.ventana_inicio || null,
                ventana_fin: o.ventana_fin || o.fecha_hora_sla || null,
                tags: (() => {
                  try {
                    const t = typeof o.tags_requeridos === 'string'
                      ? JSON.parse(o.tags_requeridos)
                      : (o.tags_requeridos || []);
                    return Array.isArray(t) ? t : [];
                  } catch { return []; }
                })(),
                tipo_movimiento: o.tipo_movimiento || 'ENTREGA',
                riesgo_score: riesgo,
            });
        }
    });

    console.log('[OPTIMIZER] Ordenes geocodificadas:', ordenes.length);
    console.log('[OPTIMIZER] Primeras ordenes:', ordenes.slice(0,3));
    if (ordenes.length === 0) {
      return new Response(JSON.stringify({ exito: true, msg: "NO_GEOCODED_ORDERS", viajes_creados: 0 }), { 
        status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } 
      });
    }

    // F3 — riesgo SLA empírico (dwell p90 + bias ETA) alimenta soft reorder VRP
    try {
      await enrichOrdersWithSlaRisk(supabase, tenant_id, ordenes);
    } catch (slaErr) {
      console.warn('[OPTIMIZER_SLA_RISK]', slaErr.message);
    }

    // 4. EXTRACCIÓN DE CHOFERES (respetando el límite de flota_disponible)
    // patente_asignada se incluye aquí para usarla en trip_metrics sin queries N+1
    const { data: choferesRows, error: errChoferes } = await (async () => {
      let res = await supabase
        .from('choferes')
        .select('chofer_id, nombre_completo, km_acumulados_semana, capacidad_volumen, capacidad_peso, tags, patente_asignada')
        .eq('tenant_id', tenant_id)
        .eq('estado', 'DISPONIBLE')
        .limit(flotaDisponible);
      if (res.error && /capacidad_peso|column/i.test(String(res.error.message || ''))) {
        res = await supabase
          .from('choferes')
          .select('chofer_id, nombre_completo, km_acumulados_semana, capacidad_volumen, tags, patente_asignada')
          .eq('tenant_id', tenant_id)
          .eq('estado', 'DISPONIBLE')
          .limit(flotaDisponible);
      }
      return res;
    })();

    if (errChoferes) throw errChoferes;
    console.log('[OPTIMIZER] Choferes disponibles:', choferesRows?.length || 0, '| Límite:', flotaDisponible);
    if (!choferesRows || choferesRows.length === 0) throw new Error("NO_AVAILABLE_DRIVERS");

    // 4b. CARGAR PERFIL DE OPTIMIZACIÓN
    // Los pesos del perfil afectan el puntaje de scoring en el VRP.
    // peso_distancia: importancia de minimizar km | peso_sla: importancia de cumplir horario
    // peso_valor_carga: priorizar órdenes de mayor valor | peso_riesgo_ia: penalizar órdenes con riesgo
    let perfilPesos = { peso_distancia: 1.0, peso_sla: 1.0, peso_valor_carga: 0.0, peso_riesgo_ia: 0.0 };
    if (perfilId) {
      // M-13: tras mig 011 filtra tenant; filas legacy (tenant_id NULL) siguen válidas
      let perfilData = null;
      let errPerfil = null;
      ({ data: perfilData, error: errPerfil } = await supabase
        .from('perfiles_optimizacion')
        .select('peso_distancia, peso_sla, peso_valor_carga, peso_riesgo_ia, nombre_perfil, tenant_id')
        .eq('perfil_id', perfilId)
        .or(`tenant_id.eq.${tenant_id},tenant_id.is.null`)
        .maybeSingle());
      if (errPerfil && /tenant_id/.test(String(errPerfil.message || ''))) {
        // Columna aún no migrada
        ({ data: perfilData, error: errPerfil } = await supabase
          .from('perfiles_optimizacion')
          .select('peso_distancia, peso_sla, peso_valor_carga, peso_riesgo_ia, nombre_perfil')
          .eq('perfil_id', perfilId)
          .maybeSingle());
      }
      if (errPerfil) console.warn('[OPTIMIZER] Perfil error:', errPerfil.message);
      if (perfilData) {
        perfilPesos = {
          peso_distancia: Number(perfilData.peso_distancia) || 1.0,
          peso_sla:       Number(perfilData.peso_sla)       || 1.0,
          peso_valor_carga: Number(perfilData.peso_valor_carga) || 0.0,
          peso_riesgo_ia: Number(perfilData.peso_riesgo_ia) || 0.0,
        };
        console.log('[OPTIMIZER] Perfil cargado:', perfilData.nombre_perfil, perfilPesos);
      } else {
        console.warn('[OPTIMIZER] Perfil no encontrado; usando defaults');
      }
    }
    // Si hay riesgo empírico/IA, activar soft reorder aunque el perfil tenga peso 0
    if (ordenes.some((o) => Number(o.riesgo_score) >= 50)) {
      perfilPesos.peso_riesgo_ia = Math.max(Number(perfilPesos.peso_riesgo_ia) || 0, 0.8);
    }

    let choferes = choferesRows.map(c => {
      let tagsValidos = [];
      try { tagsValidos = typeof c.tags === 'string' ? JSON.parse(c.tags) : (c.tags || []); } catch (e) {}
      return {
          ...c,
          km_acumulados: Number(c.km_acumulados_semana) || 0,
          capacidad_volumen: Number(c.capacidad_volumen) || 100,
          capacidad_peso: Number(c.capacidad_peso) || 99999,
          volumen_asignado: 0,
          peso_asignado: 0,
          tags: Array.isArray(tagsValidos) ? tagsValidos : [],
          patente_asignada: c.patente_asignada || null,
      };
    });

    // 5. VRP: Clarke-Wright + 2-opt + VRPTW + dual capacity
    const totalKmFlota = choferes.reduce((sum, ch) => sum + ch.km_acumulados, 0);
    const promedioFlotaKm = totalKmFlota / choferes.length;
    const totalCapacidadVolumen = choferes.reduce((sum, ch) => sum + ch.capacidad_volumen, 0);
    const capacidadMaxVolumen = totalCapacidadVolumen / choferes.length;
    const capacidadMaxPeso =
      choferes.reduce((sum, ch) => sum + ch.capacidad_peso, 0) / Math.max(1, choferes.length);
    const startMs = obtenerInicioOperacionMs();

    const vrp = solveVrpAuto(ordenes, {
      depot,
      capacity: capacidadMaxVolumen,
      capacityWeight: capacidadMaxPeso,
      maxVehicles: choferes.length,
      maxStopsPerRoute: 24,
      startMs,
      pesos: perfilPesos,
      velocidadKmH: velocidadPromedioKmH,
    });
    const clusters = vrp.routes;
    console.log('[OPTIMIZER] Solver:', vrp.solver, '| Rutas:', clusters.length, '| km est:', vrp.kmEstimado, '| candidatos:', JSON.stringify(vrp.candidatos || []));
    let viajesEstructurados = [];

    for (const cluster of clusters) {
      const mapboxResult = await resolverViajeTrafico(cluster, env, depot);
      let distanciaTotalKm = 0;
      let secuenciaOptima = cluster;
      let duracionesLegs = []; 

      if (mapboxResult) {
        distanciaTotalKm = mapboxResult.route.distance / 1000;
        duracionesLegs = mapboxResult.route.legs.map(l => l.duration);
        // M-12: Mapbox no incluye retorno a bodega — sumarlo como el fallback
        if (secuenciaOptima.length > 0) {
          const last = secuenciaOptima[secuenciaOptima.length - 1];
          const retKm = calcularDistanciaKm(last.lat, last.lng, BODEGA_LAT, BODEGA_LNG) * 1.2;
          distanciaTotalKm += retKm;
        }
      } else {
        // Fallback: haversine tour (bodega → stops → bodega)
        distanciaTotalKm = 0;
        let prevLat = BODEGA_LAT;
        let prevLng = BODEGA_LNG;
        duracionesLegs = [];
        for (const o of secuenciaOptima) {
          const legKm = calcularDistanciaKm(prevLat, prevLng, o.lat, o.lng) * 1.2;
          distanciaTotalKm += legKm;
          duracionesLegs.push((legKm / velocidadPromedioKmH) * 3600);
          prevLat = o.lat;
          prevLng = o.lng;
        }
        distanciaTotalKm += calcularDistanciaKm(prevLat, prevLng, BODEGA_LAT, BODEGA_LNG) * 1.2;
      }

      const tagsRequeridos = [...new Set(secuenciaOptima.flatMap(o => {
          try {
            const val = typeof o.tags === 'string' ? JSON.parse(o.tags) : (o.tags || []);
            return Array.isArray(val) ? val : [];
          } catch(e) { return []; }
      }))];

      const volumenViaje = secuenciaOptima.reduce((s, o) => s + Number(o.volumen || 1), 0);
      const pesoViaje = secuenciaOptima.reduce((s, o) => s + Number(o.peso_kg || 0), 0);
      const costoOperacional = (distanciaTotalKm / RENDIMIENTO_KML) * PRECIO_DIESEL_CLP + (distanciaTotalKm * COSTO_TAG_KM);

      viajesEstructurados.push({
        paradas: secuenciaOptima,
        distanciaKm: distanciaTotalKm,
        duracionesLegs,
        tagsRequeridos,
        costoOperacional,
        volumen: volumenViaje,
        peso: pesoViaje,
      });
    }

    viajesEstructurados.sort((a, b) => b.distanciaKm - a.distanciaKm);
    const asignacionesFinales = [];
    const sinAsignarIds = [];
    const cryptoApi = globalThis.crypto;

    for (const viaje of viajesEstructurados) {
      let mejorChoferIdx = -1;
      let menorCosto = Infinity;
      const volumenViaje = Number(viaje.volumen || 0);
      const pesoViaje = Number(viaje.peso || 0);
      const otIdsViaje = (viaje.paradas || []).map((p) => p.ot_id).filter(Boolean);

      for (let i = 0; i < choferes.length; i++) {
        const ch = choferes[i];
        // A-19: sin patente la app no ve el viaje
        if (!ch.patente_asignada) continue;
        const choferValido = viaje.tagsRequeridos.every(tag => ch.tags.includes(tag));
        if (!choferValido) continue;
        // Segregación: no asignar HAZMAT+FOOD mezclados (ya filtrado en solver; reforzar)
        const haz = viaje.tagsRequeridos.some((t) => ['HAZMAT', 'ADR', 'PELGEROSO'].includes(String(t).toUpperCase()));
        const food = viaje.tagsRequeridos.some((t) => ['FOOD', 'ALIMENTO', 'ALIMENTOS', 'FRIO_ALIMENTO'].includes(String(t).toUpperCase()));
        if (haz && food) continue;
        const capacidadRestante = Number(ch.capacidad_volumen || 0) - Number(ch.volumen_asignado || 0);
        if (volumenViaje > capacidadRestante + 1e-6) continue;
        const pesoRestante = Number(ch.capacidad_peso || 99999) - Number(ch.peso_asignado || 0);
        if (pesoViaje > pesoRestante + 1e-6) continue;

        const costo = viaje.distanciaKm - (FACTOR_EQUIDAD * (promedioFlotaKm - ch.km_acumulados));
        if (costo < menorCosto) { menorCosto = costo; mejorChoferIdx = i; }
      }

      if (mejorChoferIdx === -1) {
        // A-20: no descartar en silencio
        console.warn('[OPTIMIZER] Viaje sin chofer asignable', otIdsViaje.length, 'OTs');
        sinAsignarIds.push(...otIdsViaje);
        continue;
      }

      const [choferAsignado] = choferes.splice(mejorChoferIdx, 1);
      choferAsignado.km_acumulados += viaje.distanciaKm;
      choferAsignado.volumen_asignado = Number(choferAsignado.volumen_asignado || 0) + volumenViaje;
      choferAsignado.peso_asignado = Number(choferAsignado.peso_asignado || 0) + pesoViaje;

      const tripId = `TRIP-${(typeof cryptoApi !== 'undefined' && cryptoApi.randomUUID) ? cryptoApi.randomUUID().split('-')[0].toUpperCase() : Date.now()}`;
      asignacionesFinales.push({ tripId, choferId: choferAsignado.chofer_id, patente: choferAsignado.patente_asignada, viaje });
    }

    // 6. ACTUALIZACIÓN ASÍNCRONA MASIVA EN DB 
    const tiempoBaseGlobalMs = obtenerInicioOperacionMs();
    const tiemposDisponibilidadChofer = {};
    const colacionesTomadasChofer = {}; 
    const dbUpdatePromises = [];

    // 6a. CREAR FILAS trip_metrics — sin queries N+1
    // patente_asignada ya está en memoria desde el SELECT de choferes (paso 4).
    // Se usa upsert con onConflict='trip_id' para ser idempotente ante re-optimizaciones.
    if (!isSimulacion) {
      for (const asignacion of asignacionesFinales) {
        const conduccionSeg = asignacion.viaje.duracionesLegs.reduce((s, d) => s + d, 0);
        const servicioSeg = (asignacion.viaje.paradas || []).reduce(
          (s, p) => s + calcularTiempoServicioSegundos(p, diccionarioTiempos), 0
        );
        let retornoSeg = 0;
        if (asignacion.viaje.paradas?.length) {
          const ultima = asignacion.viaje.paradas[asignacion.viaje.paradas.length - 1];
          const retKm = calcularDistanciaKm(ultima.lat, ultima.lng, BODEGA_LAT, BODEGA_LNG);
          retornoSeg = (retKm / velocidadPromedioKmH) * 3600;
        }
        // M-17: conducción + servicio + retorno (+1h colación si hay ≥1 parada al mediodía se estima aparte en ETA)
        const tiempoTotalSeg = conduccionSeg + servicioSeg + retornoSeg;
        dbUpdatePromises.push(
          supabase.from('trip_metrics').upsert({
            trip_id:                asignacion.tripId,
            tenant_id:              tenant_id,
            chofer_id:              String(asignacion.choferId),
            patente:                asignacion.patente,
            km_planificados:        Number(asignacion.viaje.distanciaKm.toFixed(2)),
            tiempo_planificado_min: Math.round(tiempoTotalSeg / 60),
            costo_planificado:      Math.round(asignacion.viaje.costoOperacional),
            total_paradas:          asignacion.viaje.paradas.length,
            estado:                 'activo',
          }, { onConflict: 'trip_id' })
        );
      }
    }

    for (const asignacion of asignacionesFinales) {
        let tiempoReferenciaMs = tiemposDisponibilidadChofer[asignacion.choferId] || tiempoBaseGlobalMs;
        let segundosAcumulados = 0;

        for (let i = 0; i < asignacion.viaje.paradas.length; i++) {
            const parada = asignacion.viaje.paradas[i];
            const stopSequence = i + 1;
            const duracionConduccion = asignacion.viaje.duracionesLegs[i] || 600; 
            segundosAcumulados += duracionConduccion;

            let pausa_colacion_aplicada = false;
            let fechaEtaTemporal = new Date(tiempoReferenciaMs + (segundosAcumulados * 1000));
            
            const horaETA = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', hour: 'numeric', hourCycle: 'h23' }).format(fechaEtaTemporal), 10);
            const etaIso = fechaEtaTemporal.toISOString();
            const tiempoDeServicioParada = calcularTiempoServicioSegundos(parada, diccionarioTiempos);
            
            segundosAcumulados += tiempoDeServicioParada;

            if (!colacionesTomadasChofer[asignacion.choferId] && horaETA >= 13 && horaETA < 15) {
                segundosAcumulados += 3600; 
                colacionesTomadasChofer[asignacion.choferId] = true; 
                pausa_colacion_aplicada = true;
            }

            const metaBase =
              typeof parada.metadata === 'string'
                ? (() => { try { return JSON.parse(parada.metadata); } catch { return {}; } })()
                : (parada.metadata || {});

            if (!isSimulacion) {
              const updateRequest = (async () => {
                const scanTok = metaBase.scan_token || await computeScanToken(tenant_id, parada.ot_id, env);
                const metadataObj = {
                  ...metaBase,
                  ...(scanTok ? { scan_token: scanTok } : {}),
                  routing: {
                    ...(metaBase.routing || {}),
                    optimization_run_id: optimizationRunId,
                    trip_id: asignacion.tripId, stop_sequence: stopSequence, eta_estimado: etaIso,
                    duracion_tramo_seg: Math.round(duracionConduccion), tiempo_servicio_estimado_seg: tiempoDeServicioParada,
                    fecha_hora_sla_objetivo: parada.fecha_hora_sla, tags_viaje_exigidos: asignacion.viaje.tagsRequeridos,
                    pausa_colacion_aplicada, costo_operacional: Math.round(asignacion.viaje.costoOperacional),
                    distancia_total_viaje_km: Number(asignacion.viaje.distanciaKm.toFixed(1)),
                  },
                };
                const { error } = await supabase.from('ordenes_pendientes')
                  .update({
                    trip_id: asignacion.tripId, chofer_asignado_id: asignacion.choferId,
                    stop_sequence: stopSequence, estado_operacional: 'CAMION_ASIGNADO',
                    metadata: metadataObj, eta: etaIso,
                  })
                  .eq('ot_id', parada.ot_id).eq('tenant_id', tenant_id);
                if (error) {
                  return supabase.from('ordenes_pendientes')
                    .update({ trip_id: asignacion.tripId, chofer_asignado_id: asignacion.choferId, stop_sequence: stopSequence, estado_operacional: 'CAMION_ASIGNADO' })
                    .eq('ot_id', parada.ot_id).eq('tenant_id', tenant_id);
                }
                return { error: null };
              })();
              dbUpdatePromises.push(updateRequest);
            }
        }

        // Un UPDATE de flota por viaje (no por parada)
        if (!isSimulacion && asignacion.patente) {
          dbUpdatePromises.push(
            supabase
              .from('flota_vehiculos')
              .update({ trip_id_actual: asignacion.tripId, estado: 'EN_RUTA' })
              .eq('tenant_id', tenant_id)
              .eq('patente', asignacion.patente)
          );
        }

        if (asignacion.viaje.paradas.length > 0) {
            const ultimaParada = asignacion.viaje.paradas[asignacion.viaje.paradas.length - 1];
            const distRetornoKm = calcularDistanciaKm(ultimaParada.lat, ultimaParada.lng, BODEGA_LAT, BODEGA_LNG);
            const tiempoRetornoSeg = (distRetornoKm / velocidadPromedioKmH) * 3600;
            tiemposDisponibilidadChofer[asignacion.choferId] = tiempoReferenciaMs + ((segundosAcumulados + tiempoRetornoSeg + 2700) * 1000);
        }
    }

    let dbFailures = 0;
    if (!isSimulacion && dbUpdatePromises.length > 0) {
        const settled = await Promise.allSettled(dbUpdatePromises);
        for (const r of settled) {
          if (r.status === 'rejected') { dbFailures += 1; continue; }
          const val = r.value;
          if (val && typeof val === 'object' && val.error) dbFailures += 1;
        }
    }

    // A-11: no mentir si hubo fallos de persistencia
    const ok = dbFailures === 0;
    return new Response(JSON.stringify({ 
      exito: ok,
      viajes_creados: asignacionesFinales.length,
      sin_asignar_ids: sinAsignarIds,
      db_failures: dbFailures,
      simulacion: isSimulacion,
      solver: vrp.solver,
      km_estimado_haversine: vrp.kmEstimado,
      depot_id: depotRow.depot_id,
      depot_nombre: depotRow.nombre,
    }), {
      status: ok ? 200 : 207,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });

    } finally {
      await releaseOptimizerLock(env, tenant_id);
    }

  } 
  catch (err) {
    console.error('[OPTIMIZER_ERROR]', err.message);
    const msg = String(err.message || '');
    const status =
      msg === 'NO_AVAILABLE_DRIVERS' || msg === 'NO_PENDING_ORDERS' ? 409
      : msg === 'OPTIMIZATION_IN_PROGRESS' ? 409
      : 500;
    return new Response(JSON.stringify({ exito: false, error: err.message }), {
      status, headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }
}