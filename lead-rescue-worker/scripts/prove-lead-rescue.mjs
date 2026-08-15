/**
 * Prueba artificial end-to-end de Fase 0/1 (Dead Man + Lead Rescue).
 * Usa SUPABASE_* de src/.dev.vars. No imprime secretos.
 *
 * Uso: node scripts/prove-lead-rescue.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { evaluateDeadMan, alertTypeForKind } from '../src/helpers/dead-man-switch.js';
import { rankRescueCandidates } from '../src/helpers/lead-rescue.js';
import { shouldSampleTrail } from '../src/helpers/gps-trail.js';
import { mergeDwellSample, dwellMinutesBetween } from '../src/helpers/dwell-stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPORT_DIR = resolve(ROOT, 'docs/notas-ia');
const TENANT = 'empresa_base';
const DEMO_TRIP = `DEMO-STUCK-${Date.now().toString(36).toUpperCase()}`;
const DEMO_RESCUE = `DEMO-RESCUE-${Date.now().toString(36).toUpperCase()}`;

function loadDevVars(path) {
  const raw = readFileSync(path, 'utf8');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

function ok(name, pass, detail = '') {
  return { name, pass: !!pass, detail };
}

async function main() {
  const results = [];
  const env = loadDevVars(resolve(ROOT, 'src/.dev.vars'));
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en src/.dev.vars');
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch },
  });

  // ── A) Helpers locales (determinísticos) ──────────────────────────────
  const now = Date.now();
  const dms = evaluateDeadMan({
    lastSignificantMoveAt: new Date(now - 45 * 60_000).toISOString(),
    ultimaActualizacion: new Date(now - 60_000).toISOString(),
    hasEnSitio: false,
    nowMs: now,
  });
  results.push(ok('A1 evaluateDeadMan RED stuck 45min', dms.kind === 'stuck' && dms.severity === 'RED', JSON.stringify(dms)));

  const dmsSitio = evaluateDeadMan({
    lastSignificantMoveAt: new Date(now - 60 * 60_000).toISOString(),
    ultimaActualizacion: new Date(now - 60_000).toISOString(),
    hasEnSitio: true,
    nowMs: now,
  });
  results.push(ok('A2 EN_SITIO no dispara alerta', dmsSitio.kind === 'ok', JSON.stringify(dmsSitio)));

  const ranked = rankRescueCandidates({
    stuckLat: -33.45,
    stuckLng: -70.66,
    cargoVolume: 8,
    limit: 2,
    candidates: [
      { trip_id: 'NEAR', lat: -33.46, lng: -70.67, capacity: 100, volume: 10, nombre: 'Cerca' },
      { trip_id: 'FAR', lat: -33.60, lng: -70.80, capacity: 100, volume: 10, nombre: 'Lejos' },
      { trip_id: 'FULL', lat: -33.451, lng: -70.661, capacity: 20, volume: 19, nombre: 'Lleno' },
    ],
  });
  results.push(ok('A3 ranking elige NEAR y excluye FULL', ranked[0]?.trip_id === 'NEAR' && !ranked.find((c) => c.trip_id === 'FULL'), ranked.map((c) => c.trip_id).join(',')));

  const trail = shouldSampleTrail({ lastTrailAtMs: now - 60_000, deltaKm: 0.01, minIntervalSec: 45 });
  results.push(ok('A4 GPS trail heartbeat', trail.sample && trail.isHeartbeat));

  const dwell = dwellMinutesBetween('2026-07-25T12:00:00.000Z', '2026-07-25T12:22:00.000Z');
  const merged = mergeDwellSample(null, dwell);
  results.push(ok('A5 dwell 22 min', dwell === 22 && merged.samples === 1, `dwell=${dwell}`));

  // ── B) Tablas migración 006 en Supabase ───────────────────────────────
  const tables = ['gps_trail', 'stop_dwell_stats', 'fleet_alerts', 'rescue_missions'];
  for (const t of tables) {
    const { error } = await supabase.from(t).select('*').limit(1);
    results.push(ok(`B tabla ${t} existe`, !error, error?.message || 'ok'));
  }

  // ── C) Insert artificial como haría el cron ───────────────────────────
  const stuckLat = -33.4489;
  const stuckLng = -70.6693;
  const alertType = alertTypeForKind(dms.kind);
  const payload = {
    demo: true,
    patente: 'DEMO-LR',
    chofer: 'Prueba Lead Rescue',
    stuck_minutes: dms.stuckMinutes,
    kind: dms.kind,
    note: 'Alerta artificial de verificación — se puede descartar en Torre',
  };

  const { data: alertRow, error: alertErr } = await supabase
    .from('fleet_alerts')
    .insert({
      tenant_id: TENANT,
      trip_id: DEMO_TRIP,
      alert_type: alertType,
      severity: dms.severity,
      status: 'OPEN',
      stuck_minutes: dms.stuckMinutes,
      lat: stuckLat,
      lng: stuckLng,
      payload,
    })
    .select('id, trip_id, severity, status, stuck_minutes, created_at')
    .single();

  results.push(ok('C1 insert fleet_alerts OPEN RED', !alertErr && !!alertRow?.id, alertErr?.message || `id=${alertRow?.id}`));

  const { data: openAlerts, error: openErr } = await supabase
    .from('fleet_alerts')
    .select('id, trip_id, severity, status, stuck_minutes')
    .eq('tenant_id', TENANT)
    .eq('status', 'OPEN')
    .eq('trip_id', DEMO_TRIP);

  results.push(ok('C2 leer alerta abierta', !openErr && openAlerts?.length === 1, openErr?.message || `count=${openAlerts?.length}`));

  // Trail artificial
  const { error: trailErr } = await supabase.from('gps_trail').insert([
    { tenant_id: TENANT, trip_id: DEMO_TRIP, lat: stuckLat, lng: stuckLng, delta_km: 0, is_heartbeat: true },
    { tenant_id: TENANT, trip_id: DEMO_TRIP, lat: stuckLat + 0.0001, lng: stuckLng, delta_km: 0.01, is_heartbeat: true },
  ]);
  results.push(ok('C3 insert gps_trail demo', !trailErr, trailErr?.message || '2 rows'));

  // Dwell artificial
  const { error: dwellErr } = await supabase.from('stop_dwell_stats').upsert({
    tenant_id: TENANT,
    cliente: 'DEMO_CLIENTE_LEAD_RESCUE',
    chofer_id: 'demo-chofer',
    dow: new Date().getDay(),
    hour_bucket: new Date().getHours(),
    ...mergeDwellSample(null, 22),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,cliente,chofer_id,dow,hour_bucket' });
  results.push(ok('C4 upsert stop_dwell_stats', !dwellErr, dwellErr?.message || 'ok'));

  // Ranking con “flota” artificial (igual que API candidatos)
  const candidates = rankRescueCandidates({
    stuckLat,
    stuckLng,
    cargoVolume: 5,
    limit: 2,
    candidates: [
      { trip_id: DEMO_RESCUE, lat: stuckLat + 0.01, lng: stuckLng + 0.01, capacity: 80, volume: 20, nombre: 'Camión Rescate Demo', patente: 'DEMO-R1' },
      { trip_id: 'DEMO-OTHER', lat: stuckLat + 0.05, lng: stuckLng + 0.05, capacity: 80, volume: 10, nombre: 'Otro', patente: 'DEMO-R2' },
    ],
  });
  results.push(ok('C5 candidatos rescate rankeados', candidates.length >= 1 && candidates[0].trip_id === DEMO_RESCUE, JSON.stringify(candidates.map((c) => ({ trip: c.trip_id, km: c.delta_km })))));

  // Misión demo (sin tocar ordenes_pendientes reales)
  let missionId = null;
  if (alertRow?.id && candidates[0]) {
    const { data: mission, error: missionErr } = await supabase
      .from('rescue_missions')
      .insert({
        tenant_id: TENANT,
        alert_id: alertRow.id,
        source_trip_id: DEMO_TRIP,
        rescue_trip_id: candidates[0].trip_id,
        rescue_chofer_id: 'demo-chofer',
        ot_ids: ['DEMO-OT-1', 'DEMO-OT-2'],
        status: 'DISPATCHED',
        delta_km: candidates[0].delta_km,
        created_by: 'prove-lead-rescue.mjs',
      })
      .select('id, status, source_trip_id, rescue_trip_id, delta_km')
      .single();
    missionId = mission?.id ?? null;
    results.push(ok('C6 insert rescue_missions', !missionErr && !!mission?.id, missionErr?.message || `id=${mission?.id}`));

    if (mission?.id) {
      const { error: updErr } = await supabase
        .from('fleet_alerts')
        .update({
          status: 'RESCUING',
          payload: { ...payload, rescue_trip_id: candidates[0].trip_id, mission_id: mission.id },
          updated_at: new Date().toISOString(),
        })
        .eq('id', alertRow.id);
      results.push(ok('C7 alerta → RESCUING', !updErr, updErr?.message || 'ok'));
    }
  } else {
    results.push(ok('C6 insert rescue_missions', false, 'sin alert_id'));
  }

  // ── D) Worker vivo ───────────────────────────────────────────────────
  try {
    const health = await fetch('https://lead-rescue-pipeline.marceloetcheverry990.workers.dev/health');
    results.push(ok('D1 Worker /health responde', health.ok, `status=${health.status}`));
  } catch (e) {
    results.push(ok('D1 Worker /health responde', false, e.message));
  }

  // ── E) Cleanup controlado (deja rastro en reporte, borra demo) ────────
  const cleanup = [];
  if (missionId) {
    const { error } = await supabase.from('rescue_missions').delete().eq('id', missionId);
    cleanup.push(ok('E cleanup rescue_missions', !error, error?.message || `deleted ${missionId}`));
  }
  if (alertRow?.id) {
    const { error } = await supabase.from('fleet_alerts').delete().eq('id', alertRow.id);
    cleanup.push(ok('E cleanup fleet_alerts', !error, error?.message || `deleted ${alertRow.id}`));
  }
  {
    const { error } = await supabase.from('gps_trail').delete().eq('tenant_id', TENANT).eq('trip_id', DEMO_TRIP);
    cleanup.push(ok('E cleanup gps_trail', !error, error?.message || 'ok'));
  }
  {
    const { error } = await supabase
      .from('stop_dwell_stats')
      .delete()
      .eq('tenant_id', TENANT)
      .eq('cliente', 'DEMO_CLIENTE_LEAD_RESCUE');
    cleanup.push(ok('E cleanup dwell demo', !error, error?.message || 'ok'));
  }
  results.push(...cleanup);

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, `PRUEBA-lead-rescue-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`);
  const lines = [
    '# Prueba artificial — Lead Rescue / Dead Man (Fase 0–1)',
    '',
    `- Fecha: ${new Date().toISOString()}`,
    `- Tenant: \`${TENANT}\``,
    `- Viaje demo: \`${DEMO_TRIP}\``,
    `- Resultado: **${failed === 0 ? 'PASS' : 'FAIL'}** (${passed} ok / ${failed} fail)`,
    '',
    '## Qué se demostró',
    '',
    '1. El algoritmo Dead Man detecta camión quieto 45 min → **RED**.',
    '2. Si está `EN_SITIO`, **no** alerta (no es panne).',
    '3. Ranking Lead Rescue elige el camión cercano con cupo.',
    '4. Tablas de migración 006 existen en Supabase.',
    '5. Se pudo **escribir y leer** `fleet_alerts`, `gps_trail`, `stop_dwell_stats`, `rescue_missions`.',
    '6. Flujo alerta OPEN → misión DISPATCHED → alerta RESCUING funciona en DB.',
    '7. Worker en producción responde `/health`.',
    '8. Datos demo fueron **limpiados** al final (no dejan basura operativa).',
    '',
    '## Detalle',
    '',
    '| Check | Pass | Detail |',
    '|-------|------|--------|',
    ...results.map((r) => `| ${r.name} | ${r.pass ? '✅' : '❌'} | ${String(r.detail).replace(/\|/g, '/').slice(0, 120)} |`),
    '',
    '## Nota',
    '',
    'Esta prueba **no mueve órdenes reales** de choferes en calle (evita riesgo operativo).',
    'Demuestra que la detección, persistencia y ranking del rescate funcionan con tu DB y Worker desplegados.',
    'Para ver el banner en Torre con un viaje real: dejá un camión quieto 15+ min o pedí bajar umbrales para demo visual.',
    '',
  ];
  writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log('\n=== PRUEBA LEAD RESCUE ===');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\nTOTAL: ${passed}/${results.length} pass`);
  console.log(`REPORT: ${reportPath}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
