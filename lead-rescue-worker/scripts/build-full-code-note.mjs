/**
 * Genera un .md con el código completo (Worker + app) para mandar a otra IA.
 * Uso: node scripts/build-full-code-note.mjs
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const outDir = resolve(__dirname, '../docs/notas-ia');
const stamp = new Date().toISOString().slice(0, 10);
const outFile = resolve(outDir, `OTIF-Sentinel-codigo-completo-${stamp}.md`);

const INCLUDE_EXTS = new Set([
  '.js', '.ts', '.tsx', '.mjs', '.cjs', '.sql', '.md', '.jsonc', '.toml', '.css', '.json',
]);

const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.wrangler', 'dist', 'coverage', '__snapshots__',
  '.cursor', '.expo', 'android', 'ios', 'assets', 'notas-ia', 'archivo',
]);

const SKIP_FILES = new Set([
  'package-lock.json', '.env', '.dev.vars', '.env.local', '.env.production',
]);

const SKIP_NAME_RE = /\.(pem|key|p12|pfx)$/i;

const ROOTS = [
  resolve(repoRoot, 'lead-rescue-worker'),
  resolve(repoRoot, 'logistica-app', 'src'),
  resolve(repoRoot, 'logistica-app', 'App.tsx'),
  resolve(repoRoot, 'logistica-app', 'package.json'),
  resolve(repoRoot, 'logistica-app', 'app.json'),
  resolve(repoRoot, 'logistica-app', 'eas.json'),
  resolve(repoRoot, 'logistica-app', 'proxy-server.mjs'),
  resolve(repoRoot, 'logistica-app', 'qa-demo-server.mjs'),
  resolve(repoRoot, 'logistica-app', 'BUILD-APK.md'),
  resolve(repoRoot, 'README.md'),
];

function shouldSkipDirName(name) {
  if (SKIP_DIR_NAMES.has(name)) return true;
  if (name.startsWith('.')) return true;
  if (name.startsWith('dist-check')) return true;
  return false;
}

function addFile(full, acc) {
  try {
    if (!statSync(full).isFile()) return;
  } catch {
    return;
  }
  if (SKIP_FILES.has(full.split(/[/\\]/).pop()) || SKIP_NAME_RE.test(full)) return;
  const ext = extname(full).toLowerCase();
  if (!INCLUDE_EXTS.has(ext)) return;
  const norm = full.replace(/\\/g, '/');
  if (norm.includes('/dist-check')) return;
  if (norm.includes('/notas-ia/')) return;
  if (!acc.includes(full)) acc.push(full);
}

function walk(dir, acc) {
  let entries;
  try {
    const st = statSync(dir);
    if (st.isFile()) {
      addFile(dir, acc);
      return;
    }
    if (!st.isDirectory()) return;
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (shouldSkipDirName(ent.name)) continue;
      walk(full, acc);
      continue;
    }
    if (!ent.isFile()) continue;
    addFile(full, acc);
  }
}

function langFor(pathRel) {
  if (!pathRel) return 'text';
  if (pathRel.endsWith('.sql')) return 'sql';
  if (pathRel.endsWith('.ts') || pathRel.endsWith('.tsx')) return 'typescript';
  if (pathRel.endsWith('.json') || pathRel.endsWith('.jsonc')) return 'json';
  if (pathRel.endsWith('.css')) return 'css';
  if (pathRel.endsWith('.md')) return 'markdown';
  if (pathRel.endsWith('.toml')) return 'toml';
  return 'javascript';
}

const absFiles = [];
for (const root of ROOTS) {
  try {
    if (statSync(root).isDirectory()) walk(root, absFiles);
  } catch {
    /* missing */
  }
}
absFiles.sort((a, b) => a.localeCompare(b));

const entries = absFiles.map((abs) => ({
  abs,
  rel: relative(repoRoot, abs).replace(/\\/g, '/'),
}));

mkdirSync(outDir, { recursive: true });

let md = `# OTIF Sentinel / lead-rescue-worker — Código completo (nota para IA)

- Fecha: ${stamp}
- Propósito: contexto completo para otro asistente de IA / auditoría
- Scope: Worker Cloudflare (\`lead-rescue-worker\`) + app móvil (\`logistica-app/src\`)
- Archivos incluidos: ${entries.length}
- **Sin secretos:** no incluye \`.env\` / \`.dev.vars\` / \`package-lock.json\`
- Deploy de referencia: Worker \`lead-rescue-pipeline-staging\` — último commit \`c6cc1c1\`, **más cambios sin commitear** (auditoría completa + reserva WMS en ingesta), ya desplegados a staging
- Planes: \`lead-rescue-worker/docs/PLAN-WMS-LITE.md\`, \`lead-rescue-worker/docs/plan-guia-despacho-res154.md\`
- Tests rápidos: \`npx vitest run --config vitest.config.node.mjs\` (260 tests) y \`--config vitest.config.ui.js\` (snapshots Torre)

## Changelog relevante (corte ${stamp})

### Auditoría de seguridad/correctitud (sin commitear, desplegado a staging)
- **Admin:** endpoints \`/api/admin/qa/*\` y GPS config exigen \`is_admin\` (antes bastaba estar logueado)
- **Multi-tenant:** \`/reporte\` filtra por tenant; Content-Type falso ya no evade \`verifyOperatorTenant\`; pipeline de colas lleva \`tenant_id\` (mig \`024_queue_pipeline_tenant_id\`) y ackea recién tras el commit
- **Webhooks ERP:** sin fallback a secreto global compartido (\`ORDER_INGEST_ALLOW_GLOBAL_SECRET\` / \`PLATFORM_WEBHOOK_ALLOW_GLOBAL_SECRET\`); upsert de \`clientes\` usa el índice real \`(tenant_id, nombre_cliente_raw)\` — antes el webhook devolvía 500 siempre
- **DTE:** guía no se emite dos veces (claim por \`upsertGuiaRow\` + referencia con \`trip_id\`); reintento promueve STUB; RUT demo solo en stub; clave de cifrado DTE dedicada
- **Ruteo:** segregación HAZMAT/alimentos en solver, flota forzada y mediodía; reoptimización no pisa paradas ENTREGADO/EN_SITIO; orden "riesgo primero" estable en el poll
- **Auth:** rate limit de PIN en KV (cross-isolate, por IP y por cuenta); logout de operador revoca el JWT (jti + KV); comparación de scan token en tiempo constante
- **Otros:** XSS por comillas en \`escapeHTML\`; SSRF por IPv6 mapeado a IPv4; stack traces sanitizados; rate limit en \`/health\` y dashboards; \`FOR UPDATE\` en asignar chofer; velocidad real en el mapa (desde \`gps_trail\`)
- **App chofer:** timeout de GPS en confirmación de entrega; banner visible si falla el tracking en background

### Bodega / WMS-lite
- **Reserva automática en la ingesta:** si el tenant tiene WMS y el pedido trae \`lineas: [{sku, qty}]\`, se reserva stock → \`PENDIENTE_PICKING\` o \`QUIEBRE\` (SAVEPOINT por orden; un fallo de bodega no pierde el batch). Validado E2E en staging: ingesta → picking → packing → ruteable
- \`bodega.js\` usa una sola conexión por request; \`isWmsEnabledForTenant\` centralizado en \`wms-stock.js\`; reserva mergea SKUs repetidos
- **Pendiente:** los mappers de plataforma (\`helpers/integrations/mappers.js\`) aún no traducen \`line_items\` a \`lineas\`

### Pendientes conocidos (decisiones, no código)
- Staging y producción comparten Hyperdrive/KV/R2; el rol de conexión tiene \`BYPASSRLS\` (RLS es cosmético hasta crear \`otif_app_login\`)
- Tiles de Carto piden API key (watermark en el mapa) — cambiar proveedor o conseguir key
- \`client_sla_matrix\` no existe → el reporte IA de riesgo no funciona

### Base previa (commit \`c6cc1c1\`)
- Supabase mig 017–022 (RLS + advisor en cero); cache de poll Torre; E2E chofer; Res.154 Fase 2 (mig 016); R4 token DTE cifrado

## Tabla de contenidos

`;

for (const { rel } of entries) {
  md += `- \`${rel}\`\n`;
}
md += `\n---\n`;

for (const { abs, rel } of entries) {
  let body;
  try {
    body = readFileSync(abs, 'utf8');
  } catch (e) {
    md += `\n## FILE: ${rel}\n\n_ERROR reading: ${e.message}_\n`;
    continue;
  }
  if (body.includes('```')) {
    body = body.replace(/```/g, '``\\`');
  }
  md += `\n## FILE: ${rel}\n\n\`\`\`${langFor(rel)}\n${body}\n\`\`\`\n`;
}

writeFileSync(outFile, md, 'utf8');
console.log(JSON.stringify({
  outFile,
  files: entries.length,
  sizeMB: (Buffer.byteLength(md, 'utf8') / (1024 * 1024)).toFixed(2),
}, null, 2));
