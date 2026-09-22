#!/usr/bin/env node
/**
 * Smoke/regression contra staging: health + abuse probes + unit tests node.
 *
 * Usage:
 *   npm run regression:staging
 *   $env:R8_BASE_URL = "https://..." ; npm run regression:staging
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const base =
  process.env.R8_BASE_URL ||
  'https://lead-rescue-pipeline-staging.marceloetcheverry990.workers.dev';

function run(label, cmd, args, extraEnv = {}) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) {
    console.error(`\n[FAIL] ${label} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
  console.log(`[OK] ${label}`);
}

console.log(`Regression staging → ${base.replace(/\/$/, '')}`);

run('vitest node', 'npx', ['vitest', 'run', '--config', 'vitest.config.node.mjs']);
run('r8 abuse probes', 'node', ['scripts/r8-abuse-probes.mjs'], { R8_BASE_URL: base });

console.log('\nAll regression:staging checks passed.');
