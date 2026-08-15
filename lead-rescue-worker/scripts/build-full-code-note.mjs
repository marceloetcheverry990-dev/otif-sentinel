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
- Deploy de referencia: Worker \`lead-rescue-pipeline\` (Res.154 Fase 2 + R4; commits \`b3d49a8\` / \`5bbf6f8\`)
- Plan: \`lead-rescue-worker/docs/plan-guia-despacho-res154.md\`

## Changelog relevante (corte ${stamp})

- **Res.154 Fase 2 (mig 016):** R3 \`ts_source\`/\`REVIEW\`; S6 origen depot+GPS SALIDA; S7 ETA/\`fecha_llegada\`; S8 unique OT+trip+patente; S9 late OT (move-stop/rescate); S10 IndTraslado (1/5/6/7)
- **R4:** \`dte_api_token\` AES-GCM \`enc$v1$\`; API \`/api/admin/qa/dte-settings\`
- **Auditoría v2:** R1 retry desde \`guias_despacho\`; R2 sin fallback global identity; S11 match cliente
- **Auditoría S0–S5:** \`evento_ts_device\` + \`server_received_at\`; retry fecha original; lock EMITTING; STUB sin folio; destino real; \`tenant_settings.dte_*\`
- **Base Res.154:** emisión en primera \`SALIDA\`, EmisorDTE stub/SimpleAPI, list/retry, badge Torre (OK/ERR/STUB/REV)
- Migraciones: \`014\`/\`015\`/\`016_res154_phase2.sql\`
- **Pendiente ops:** credenciales SimpleAPI reales + maestro clientes/depots (dirección/comuna)

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
