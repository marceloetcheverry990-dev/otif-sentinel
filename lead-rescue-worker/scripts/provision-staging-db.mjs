#!/usr/bin/env node
/**
 * Crea un Hyperdrive apuntando a un Postgres DISTINTO al de producción.
 *
 * Requiere:
 *   STAGING_DATABASE_URL=postgresql://user:pass@host:5432/postgres?sslmode=require
 *
 * Luego:
 *   1. Pegá el id impreso en wrangler.jsonc → env.staging.hyperdrive[0].id
 *   2. Poné SHARED_DATASTORE=false en env.staging.vars
 *   3. wrangler secret put SUPABASE_URL --env staging  (proyecto staging)
 *   4. wrangler secret put SUPABASE_SERVICE_KEY --env staging
 *   5. Aplicá migrations/ al Postgres nuevo
 *   6. npm run deploy:staging
 */
import { spawnSync } from 'node:child_process';

const url = process.env.STAGING_DATABASE_URL || '';
if (!url.startsWith('postgres')) {
  console.error(`
Falta STAGING_DATABASE_URL.

No puedo inventar una base: hay que crear un proyecto Supabase (o Postgres) de staging
y pasar su connection string (URI de la base, no la anon key).

Ejemplo:
  $env:STAGING_DATABASE_URL = "postgresql://postgres.xxxx:CLAVE@aws-0-....pooler.supabase.com:5432/postgres"
  npm run provision:staging-db
`);
  process.exit(1);
}

const result = spawnSync(
  'npx',
  [
    'wrangler',
    'hyperdrive',
    'create',
    'otif-sentinel-staging',
    `--connection-string=${url}`,
  ],
  { stdio: 'inherit', shell: true }
);

process.exit(result.status ?? 1);
