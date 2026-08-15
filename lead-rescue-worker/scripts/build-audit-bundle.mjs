/**
 * Genera bundle de archivos clave para auditoría externa (post-crítica).
 * Uso: node scripts/build-audit-bundle.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const outDir = resolve(__dirname, '../docs/notas-ia');
const outFile = resolve(outDir, 'OTIF-Sentinel-bundle-post-critica-2026-07-25.md');

const FILES = [
  'lead-rescue-worker/docs/PLAN-ACCION-AUDITORIA-2026-07-25.md',
  'lead-rescue-worker/docs/CAMBIOS-POST-AUDITORIA-2026-07-25.md',
  'lead-rescue-worker/docs/ADDENDUM-CRITICA-RLS-F2F3-2026-07-25.md',
  'lead-rescue-worker/migrations/007_tenant_settings.sql',
  'lead-rescue-worker/migrations/008_rls_tenant_isolation.sql',
  'lead-rescue-worker/migrations/008_rollback.sql',
  'lead-rescue-worker/migrations/009_travel_error_and_otif_app_role.sql',
  'lead-rescue-worker/migrations/009_rollback.sql',
  'lead-rescue-worker/src/helpers/gps-timestamp.js',
  'lead-rescue-worker/src/helpers/travel-error.js',
  'lead-rescue-worker/src/helpers/travel-error.test.js',
  'lead-rescue-worker/src/helpers/speed-calibration.js',
  'lead-rescue-worker/src/helpers/speed-calibration.test.js',
  'lead-rescue-worker/src/helpers/sla-risk.js',
  'lead-rescue-worker/src/helpers/sla-risk.test.js',
  'lead-rescue-worker/src/helpers/eta-metric.js',
  'lead-rescue-worker/src/helpers/tenant-settings.js',
  'lead-rescue-worker/src/helpers/tenant-discipline.test.js',
  'lead-rescue-worker/src/helpers/driver-auth.js',
  'lead-rescue-worker/src/db.js',
  'lead-rescue-worker/src/config.js',
  'lead-rescue-worker/src/ai.js',
  'lead-rescue-worker/src/api/gps.js',
  'lead-rescue-worker/src/api/lead-rescue.js',
  'lead-rescue-worker/src/api/dashboard.js',
  'lead-rescue-worker/src/api/optimizer.js',
  'lead-rescue-worker/src/api/reoptimizar-midday.js',
  'lead-rescue-worker/src/api/app-chofer-evento.js',
  'lead-rescue-worker/src/api/app-chofer-logout.js',
  'lead-rescue-worker/src/monitoring/middleware.js',
  'lead-rescue-worker/src/ui/templates/layout.js',
  'lead-rescue-worker/src/ui/client/pollingYEventos.js',
  'lead-rescue-worker/wrangler.jsonc',
  'logistica-app/src/config/api.ts',
  'logistica-app/src/store/syncStore.ts',
  'logistica-app/.env.example',
];

mkdirSync(outDir, { recursive: true });

let md = `# OTIF Sentinel — Bundle post-crítica (para auditoría)

- Fecha: 2026-07-25
- Propósito: verificación línea-a-línea (como la evaluación original)
- Alcance: remediación auditoría + correcciones a la crítica del informe (RLS honesto, F2/F3 anti doble conteo, otif_app)
- **Leer primero:** \`ADDENDUM-CRITICA-RLS-F2F3-2026-07-25.md\`

## Índice de archivos

`;

for (const rel of FILES) {
  md += `- \`${rel}\`\n`;
}

md += `\n---\n`;

for (const rel of FILES) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    md += `\n## FILE: ${rel}\n\n_MISSING_\n`;
    continue;
  }
  const body = readFileSync(abs, 'utf8');
  const ext = rel.endsWith('.sql') ? 'sql' : rel.endsWith('.ts') ? 'typescript' : rel.endsWith('.jsonc') ? 'jsonc' : 'javascript';
  md += `\n## FILE: ${rel}\n\n\`\`\`${ext}\n${body}\n\`\`\`\n`;
}

writeFileSync(outFile, md, 'utf8');
console.log('Wrote', relative(root, outFile), `(${Math.round(md.length / 1024)} KB)`);
