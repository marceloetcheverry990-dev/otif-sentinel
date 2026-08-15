#!/usr/bin/env node
/**
 * R8.2 — Abuse probes against a live Worker (staging by default).
 *
 * Usage:
 *   $env:R8_BASE_URL = "https://lead-rescue-pipeline-staging.marceloetcheverry990.workers.dev"
 *   node scripts/r8-abuse-probes.mjs
 *
 * Exit 0 if all probes pass; 1 otherwise.
 */

const BASE = (process.env.R8_BASE_URL || 'https://lead-rescue-pipeline-staging.marceloetcheverry990.workers.dev').replace(/\/$/, '');

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}: ${detail}`);
}

async function probe(name, fn) {
  try {
    await fn();
  } catch (e) {
    record(name, false, e.message || String(e));
  }
}

function expectStatus(res, allowed, label) {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (!list.includes(res.status)) {
    throw new Error(`${label}: expected ${list.join('|')}, got ${res.status}`);
  }
}

await probe('health_200', async () => {
  const res = await fetch(`${BASE}/health`);
  expectStatus(res, 200, 'health');
  const body = await res.json();
  if (body?.components?.database?.status !== 'connected') {
    throw new Error(`database not connected: ${body?.components?.database?.status}`);
  }
  record('health_200', true, `database connected (${body.components.database.latency_ms}ms)`);
});

await probe('upload_evidence_no_auth', async () => {
  const res = await fetch(`${BASE}/api/upload-evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photo: 'data:image/jpeg;base64,/9j/4AAQ' }),
  });
  expectStatus(res, [401, 403], 'upload-evidence');
  record('upload_evidence_no_auth', true, `status ${res.status}`);
});

await probe('mobile_sync_no_auth', async () => {
  const res = await fetch(`${BASE}/api/mobile-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: '/viajes/estado',
      payload: { estado: 'EN_RUTA', trip_id: 'fake-trip' },
    }),
  });
  expectStatus(res, [401, 403], 'mobile-sync');
  record('mobile_sync_no_auth', true, `status ${res.status}`);
});

await probe('chofer_rutas_no_auth', async () => {
  const res = await fetch(`${BASE}/api/app-chofer-rutas`);
  expectStatus(res, [401, 403], 'app-chofer-rutas');
  record('chofer_rutas_no_auth', true, `status ${res.status}`);
});

await probe('chofer_evento_no_auth', async () => {
  const res = await fetch(`${BASE}/api/chofer/evento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trip_id: 't1',
      stop_id: 'OT-1',
      tipo_evento: 'ENTREGA',
      foto_url: 'https://example.com/x.jpg',
    }),
  });
  expectStatus(res, [401, 403], 'chofer/evento');
  record('chofer_evento_no_auth', true, `status ${res.status}`);
});

await probe('gps_ping_no_auth', async () => {
  const res = await fetch(`${BASE}/api/gps/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trip_id: 't1', lat: -33.4, lng: -70.6 }),
  });
  expectStatus(res, [401, 403], 'gps/ping');
  record('gps_ping_no_auth', true, `status ${res.status}`);
});

await probe('foreign_bearer_rejected', async () => {
  const res = await fetch(`${BASE}/api/app-chofer-rutas`, {
    headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.invalid' },
  });
  expectStatus(res, [401, 403], 'foreign bearer');
  record('foreign_bearer_rejected', true, `status ${res.status}`);
});

await probe('operator_mutation_no_cookie', async () => {
  const res = await fetch(`${BASE}/api/optimizar-rutas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ clima: 'NORMAL' }),
  });
  // 401/403 unauth, or 302 Access redirect
  expectStatus(res, [401, 403, 302], 'optimizar-rutas');
  record('operator_mutation_no_cookie', true, `status ${res.status}`);
});

await probe('sync_excel_ssrf_shape', async () => {
  const res = await fetch(`${BASE}/api/sync-excel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({
      csv_url: 'http://169.254.169.254/latest/meta-data/',
    }),
  });
  // Unauth/Access first is OK; if 400/422 that also means SSRF rejected after auth layer
  expectStatus(res, [401, 403, 302, 400, 422], 'sync-excel SSRF');
  record('sync_excel_ssrf_shape', true, `status ${res.status}`);
});

await probe('upload_invalid_payload', async () => {
  const res = await fetch(`${BASE}/api/upload-evidence`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer not-a-jwt',
    },
    body: JSON.stringify({ photo: 'not-an-image' }),
  });
  expectStatus(res, [400, 401, 403, 415, 422], 'invalid upload');
  record('upload_invalid_payload', true, `status ${res.status}`);
});

await probe('logout_without_token', async () => {
  const res = await fetch(`${BASE}/api/choferes/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expectStatus(res, [401, 403, 400], 'logout');
  record('logout_without_token', true, `status ${res.status}`);
});

const failed = results.filter((r) => !r.ok);
console.log('\n--- summary ---');
console.log(`base: ${BASE}`);
console.log(`passed: ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.error('FAILED:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
console.log('All abuse probes passed.');
process.exit(0);
