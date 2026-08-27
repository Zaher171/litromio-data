/**
 * Medición local Fase 4D: preparación + recover HTTP del árbol municipal.
 * Distingue mediciones locales de tiempos GitHub/Cloudflare (no medidos aquí).
 *
 * Uso:
 *   node --import tsx scripts/measure-municipal-local.mjs --prices-live <out/live> --geometry-root <dir> --out <metrics.json>
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { recoverPublishedState } from '../src/recover-state.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function countTree(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else {
        files += 1;
        bytes += fs.statSync(abs).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function serveDir(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
      const rel = urlPath.replace(/^\/+/, '');
      const abs = path.join(dir, rel);
      if (!abs.startsWith(dir) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const body = fs.readFileSync(abs);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

const args = process.argv.slice(2);
const pricesLive = path.resolve(argValue(args, '--prices-live') ?? path.join(ROOT, 'out', 'live'));
const geometryRoot = argValue(args, '--geometry-root');
const outMetrics = path.resolve(
  argValue(args, '--out') ?? path.join(ROOT, 'docs', 'metrics', 'fase-4d-municipal-local.json'),
);
const workRoot = path.resolve(argValue(args, '--work') ?? path.join(ROOT, '.tmp', 'fase-4d-measure'));

if (!geometryRoot) {
  console.error('Falta --geometry-root');
  process.exit(2);
}
if (!fs.existsSync(pricesLive)) {
  console.error(`No existe prices-live: ${pricesLive}`);
  process.exit(2);
}

const geoRoot = path.resolve(geometryRoot);
const packsDir = fs.existsSync(path.join(geoRoot, 'geometry-packs'))
  ? path.join(geoRoot, 'geometry-packs')
  : path.join(geoRoot, 'packs');
const sourceManifest = path.join(geoRoot, 'geometry-catalog-manifest.json');
const relations = path.join(geoRoot, 'ine-minetur-relations.json');
if (!fs.existsSync(packsDir) || !fs.existsSync(sourceManifest) || !fs.existsSync(relations)) {
  console.error('geometry-root incompleto (packs + geometry-catalog-manifest.json + ine-minetur-relations.json)');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(sourceManifest, 'utf8'));
const geometryVersion = String(manifest.geometryVersion);
const catalogVersion = String(manifest.catalogVersion);

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(workRoot, 'live'), { recursive: true });

const tCopy0 = Date.now();
copyDir(pricesLive, path.join(workRoot, 'live'));
const copyPricesMs = Date.now() - tCopy0;

const tPrep0 = Date.now();
const pub = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    path.join(ROOT, 'src', 'cli.ts'),
    'geometry-publish',
    '--out',
    workRoot,
    '--packs-dir',
    packsDir,
    '--source-manifest',
    sourceManifest,
    '--relations',
    relations,
    '--geometry-version',
    geometryVersion,
    '--catalog-version',
    catalogVersion,
    '--allow-initial-geometry',
  ],
  { encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
);
const prepareMs = Date.now() - tPrep0;
if (pub.status !== 0) {
  console.error(pub.stdout);
  console.error(pub.stderr);
  process.exit(pub.status ?? 1);
}

const liveAfter = path.join(workRoot, 'live');
const tree = countTree(liveAfter);
const gTree = fs.existsSync(path.join(liveAfter, 'g')) ? countTree(path.join(liveAfter, 'g')) : null;

const served = await serveDir(liveAfter);
const recoverOut = path.join(workRoot, 'recover-out');
fs.rmSync(recoverOut, { recursive: true, force: true });

// Importante: recover en el mismo proceso (no spawnSync) para no bloquear el HTTP server.
const tRec0 = Date.now();
const recovered = await recoverPublishedState({
  publicBaseUrl: served.baseUrl,
  outRoot: recoverOut,
  allowHttpLocal: true,
  timeoutMs: 60_000,
  totalTimeoutMs: 300_000,
  geometryTotalTimeoutMs: 600_000,
  geometryConcurrency: 8,
  maxResponseBytes: 25 * 1024 * 1024,
});
const recoverMs = Date.now() - tRec0;
await served.close();

const recoverTree = recovered.ok ? countTree(path.join(recoverOut, 'live')) : null;

const metrics = {
  measuredAt: new Date().toISOString(),
  kind: 'local_http_measure',
  note: 'Mediciones locales (preparación + recover vía HTTP 127.0.0.1). NO son tiempos de GitHub Actions ni wrangler/Cloudflare.',
  pendingRemote: ['actions_wall_time', 'wrangler_deploy_bytes', 'cloudflare_upload_dedup'],
  geometryVersion,
  catalogVersion,
  timingsMs: {
    copyPricesLive: copyPricesMs,
    geometryPublishPrepare: prepareMs,
    recoverHttpLocal: recoverMs,
  },
  treeAfterPrepare: tree,
  geometrySubtree: gTree,
  recover: {
    ok: recovered.ok,
    fileCount: recovered.ok ? recovered.fileCount : null,
    tree: recoverTree,
    detail: recovered.ok
      ? { datasetVersion: recovered.manifest.datasetVersion, contentHash: recovered.manifest.contentHash }
      : { reason: recovered.reason, code: recovered.code },
  },
  concurrencyNote:
    'Recover de packs: concurrencia 8, timeouts ampliados; validaciones de hash/esquema intactas. Servidor HTTP y recover en el mismo event loop.',
};

fs.mkdirSync(path.dirname(outMetrics), { recursive: true });
fs.writeFileSync(outMetrics, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(metrics, null, 2));
console.error(`Métricas escritas en ${outMetrics}`);
if (!recovered.ok) process.exit(1);
