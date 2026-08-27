/**
 * Verificación HTTP post-deploy del árbol litromio-data publicado.
 * Módulo ESM (evita ERR_AMBIGUOUS_MODULE_SYNTAX de require + top-level await).
 *
 * Modo remoto (Actions / CDN): muestreo de contratos + 1 pack geométrico.
 * No sustituye la validación exhaustiva local (`assertPublishedTreeCoherent` en publish).
 *
 * Env requeridas:
 *   PUBLIC_DATA_BASE_URL, EXPECTED_VERSION, EXPECTED_HASH, EXPECTED_FETCH_AT
 * Opcionales:
 *   VERIFY_MAX_ATTEMPTS (default 12), VERIFY_DELAY_MS (default 10000),
 *   VERIFY_REQUEST_TIMEOUT_MS (default 30000),
 *   VERIFY_EXHAUSTIVE_PACKS=1 (opcional: todos los packs del manifiesto activo; costoso en CDN),
 *   GITHUB_OUTPUT
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const base = (process.env.PUBLIC_DATA_BASE_URL || '').replace(/\/$/, '');
const expectedVersion = process.env.EXPECTED_VERSION;
const expectedHash = process.env.EXPECTED_HASH;
const expectedFetchAt = process.env.EXPECTED_FETCH_AT;
const live = path.join('out', 'live');

const maxAttempts = Number(process.env.VERIFY_MAX_ATTEMPTS) || 12;
const delayMs = Number(process.env.VERIFY_DELAY_MS) || 10_000;
const requestTimeoutMs = Number(process.env.VERIFY_REQUEST_TIMEOUT_MS) || 30_000;
const exhaustivePacks = process.env.VERIFY_EXHAUSTIVE_PACKS === '1';

if (!base) {
  console.error('PUBLIC_DATA_BASE_URL ausente');
  process.exit(1);
}
if (typeof expectedVersion !== 'string' || !/^[0-9a-f]{16}$/.test(expectedVersion)) {
  console.error('EXPECTED_VERSION inválido');
  process.exit(1);
}
if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) {
  console.error('EXPECTED_HASH inválido');
  process.exit(1);
}
if (typeof expectedFetchAt !== 'string' || !expectedFetchAt) {
  console.error('EXPECTED_FETCH_AT ausente');
  process.exit(1);
}

const localSync = JSON.parse(fs.readFileSync(path.join(live, 'sync.json'), 'utf8'));
const localCurrent = JSON.parse(fs.readFileSync(path.join(live, 'current.json'), 'utf8'));
const localManifest = JSON.parse(fs.readFileSync(path.join(live, 'manifest.json'), 'utf8'));
const cell = localManifest.cells[0];
if (!cell || typeof cell.path !== 'string' || typeof cell.sha256 !== 'string') {
  console.error('Celda local inválida');
  process.exit(1);
}
const retained = Array.isArray(localSync.retainedVersions) ? localSync.retainedVersions : [];

function sha256Hex(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * fetch + lectura del cuerpo bajo el mismo AbortSignal (timeout incluye el body).
 */
async function fetchOnce(url, { bust = false } = {}) {
  const u = bust ? `${url}${url.includes('?') ? '&' : '?'}cb=${Date.now()}` : url;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), requestTimeoutMs);
  try {
    const res = await fetch(u, {
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      redirect: 'follow',
      signal: ac.signal,
    });
    const text = await res.text();
    return { res, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

function headerOf(headers, name) {
  return headers.get(name) || headers.get(name.toLowerCase()) || '';
}

function assertCors(headers, label) {
  const acao = headerOf(headers, 'access-control-allow-origin');
  if (acao.trim() !== '*') {
    throw new Error(`${label}: CORS Access-Control-Allow-Origin esperado "*", got "${acao}"`);
  }
}

function assertCache(headers, label, expected) {
  const cc = headerOf(headers, 'cache-control').toLowerCase().replace(/\s+/g, '');
  const exp = expected.toLowerCase().replace(/\s+/g, '');
  // Aceptar el valor exacto o un superconjunto que lo contenga en el mismo orden de tokens clave.
  if (!cc.includes('public') || !cc.includes(exp.includes('immutable') ? 'immutable' : 'must-revalidate')) {
    throw new Error(`${label}: Cache-Control inesperado "${headerOf(headers, 'cache-control')}" (esperado ~ ${expected})`);
  }
  if (exp.includes('max-age=60') && !cc.includes('max-age=60')) {
    throw new Error(`${label}: falta max-age=60`);
  }
  if (exp.includes('max-age=31536000') && !cc.includes('max-age=31536000')) {
    throw new Error(`${label}: falta max-age=31536000`);
  }
}

function assertShaMatches(text, expectedSha, label) {
  const withNl = text.endsWith('\n') ? text : `${text}\n`;
  const shaNl = sha256Hex(withNl);
  const shaRaw = sha256Hex(text);
  if (shaNl !== expectedSha && shaRaw !== expectedSha) {
    throw new Error(`${label}: hash remoto no coincide (${expectedSha})`);
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function verifyPackFile(baseUrl, pack) {
  if (!pack || typeof pack.path !== 'string' || typeof pack.sha256 !== 'string') {
    throw new Error('pack geométrico inválido en manifiesto');
  }
  if (typeof pack.bytes === 'number' && pack.bytes > 25 * 1024 * 1024) {
    throw new Error(`pack geométrico ${pack.id ?? pack.path} supera 25 MiB/archivo`);
  }
  const packRes = await fetchOnce(`${baseUrl}/${pack.path.replace(/^\//, '')}`);
  if (!packRes.res.ok) throw new Error(`pack geométrico HTTP ${packRes.res.status} ${pack.path}`);
  assertCors(packRes.headers, 'pack geométrico');
  assertCache(packRes.headers, 'pack geométrico', 'public, max-age=31536000, immutable');
  assertShaMatches(packRes.text, pack.sha256, `hash pack ${pack.id ?? pack.path}`);
}

/**
 * Frescura según contrato:
 * - sync.json: lastSuccessfulFetchAt obligatorio (evidencia de consulta).
 * - current.json / manifest.json raíz: mutables; lastSuccessfulFetchAt se alinea en publish/sync.
 * - v/{version}/…: inmutable; no exige lastSuccessfulFetchAt == EXPECTED_FETCH_AT.
 * - sourceFecha del contenido no se usa como reloj de frescura.
 *
 * Municipal (si current lo declara): índice, g/current, manifiesto IGN, catálogo, pack(s)+hash.
 * Fallo ante catálogo / índice / pack incorrecto.
 */
async function verifyOnce() {
  const current = await fetchOnce(`${base}/current.json`, { bust: true });
  if (!current.res.ok) throw new Error(`current.json HTTP ${current.res.status}`);
  assertCors(current.headers, 'current.json');
  assertCache(current.headers, 'current.json', 'public, max-age=60, must-revalidate');
  const currentJson = JSON.parse(current.text);
  if (currentJson.datasetVersion !== expectedVersion) {
    throw new Error(`current.datasetVersion=${currentJson.datasetVersion} != ${expectedVersion}`);
  }
  if (currentJson.contentHash !== expectedHash) {
    throw new Error('current.contentHash no coincide');
  }
  if (currentJson.lastSuccessfulFetchAt !== expectedFetchAt) {
    throw new Error(`current.lastSuccessfulFetchAt=${currentJson.lastSuccessfulFetchAt} != ${expectedFetchAt}`);
  }

  const sync = await fetchOnce(`${base}/sync.json`, { bust: true });
  if (!sync.res.ok) throw new Error(`sync.json HTTP ${sync.res.status}`);
  assertCors(sync.headers, 'sync.json');
  assertCache(sync.headers, 'sync.json', 'public, max-age=60, must-revalidate');
  const syncJson = JSON.parse(sync.text);
  if (syncJson.datasetVersion !== expectedVersion || syncJson.contentHash !== expectedHash) {
    throw new Error('sync.json no coherente con resultado local');
  }
  if (syncJson.lastSuccessfulFetchAt !== expectedFetchAt) {
    throw new Error(`sync.lastSuccessfulFetchAt=${syncJson.lastSuccessfulFetchAt} != ${expectedFetchAt}`);
  }
  if (syncJson.lastSuccessfulFetchAt !== localSync.lastSuccessfulFetchAt) {
    throw new Error('sync remoto != sync local (lastSuccessfulFetchAt)');
  }

  const rootManifest = await fetchOnce(`${base}/manifest.json`, { bust: true });
  if (!rootManifest.res.ok) throw new Error(`manifest.json HTTP ${rootManifest.res.status}`);
  assertCors(rootManifest.headers, 'manifest.json');
  assertCache(rootManifest.headers, 'manifest.json', 'public, max-age=60, must-revalidate');
  const rootManifestJson = JSON.parse(rootManifest.text);
  if (rootManifestJson.datasetVersion !== expectedVersion || rootManifestJson.contentHash !== expectedHash) {
    throw new Error('manifest.json raíz no coherente');
  }
  // Campo opcional en esquema; si el mutable lo publica, debe coincidir con la frescura esperada.
  if (rootManifestJson.lastSuccessfulFetchAt && rootManifestJson.lastSuccessfulFetchAt !== expectedFetchAt) {
    throw new Error('manifest.root lastSuccessfulFetchAt distinto');
  }

  const versionedUrl = `${base}/v/${expectedVersion}/manifest.json`;
  const versioned = await fetchOnce(versionedUrl);
  if (!versioned.res.ok) throw new Error(`manifest versionado HTTP ${versioned.res.status}`);
  assertCors(versioned.headers, 'manifest versionado');
  assertCache(versioned.headers, 'manifest versionado', 'public, max-age=31536000, immutable');
  const versionedJson = JSON.parse(versioned.text);
  if (versionedJson.datasetVersion !== expectedVersion || versionedJson.contentHash !== expectedHash) {
    throw new Error('manifest versionado no coherente');
  }

  const cellUrl = `${base}/${cell.path.replace(/^\//, '')}`;
  const cellRes = await fetchOnce(cellUrl);
  if (!cellRes.res.ok) throw new Error(`celda HTTP ${cellRes.res.status} ${cell.path}`);
  assertCors(cellRes.headers, 'celda');
  assertCache(cellRes.headers, 'celda', 'public, max-age=31536000, immutable');
  assertShaMatches(cellRes.text, cell.sha256, `hash celda ${cell.id}`);

  if (retained.length > 0) {
    const prev = retained[0];
    if (typeof prev !== 'string' || !/^[0-9a-f]{16}$/.test(prev)) {
      throw new Error(`retainedVersions[0] inválido: ${prev}`);
    }
    if (prev !== expectedVersion) {
      const prevRes = await fetchOnce(`${base}/v/${prev}/manifest.json`);
      if (!prevRes.res.ok) {
        throw new Error(`versión anterior ${prev} no accesible: HTTP ${prevRes.res.status}`);
      }
      assertCors(prevRes.headers, 'manifest anterior');
      assertCache(prevRes.headers, 'manifest anterior', 'public, max-age=31536000, immutable');
      const prevJson = JSON.parse(prevRes.text);
      if (prevJson.datasetVersion !== prev) {
        throw new Error('manifest anterior datasetVersion distinto');
      }
    }
  }

  // Contratos municipales opcionales (clientes antiguos ignoran; si se declaran, validar).
  if (typeof currentJson.municipalityCellsPath === 'string') {
    const cellsUrl = `${base}/${currentJson.municipalityCellsPath.replace(/^\//, '')}`;
    const cellsRes = await fetchOnce(cellsUrl);
    if (!cellsRes.res.ok) {
      throw new Error(`municipality-cells HTTP ${cellsRes.res.status}`);
    }
    assertCors(cellsRes.headers, 'municipality-cells');
    assertCache(cellsRes.headers, 'municipality-cells', 'public, max-age=31536000, immutable');
    const cellsJson = JSON.parse(cellsRes.text);
    if (cellsJson.schemaVersion !== 1) {
      throw new Error('municipality-cells schemaVersion inválido');
    }
    if (cellsJson.datasetVersion !== expectedVersion || cellsJson.contentHash !== expectedHash) {
      throw new Error('municipality-cells no ligado al dataset activo');
    }
    if (!cellsJson.municipalities || typeof cellsJson.municipalities !== 'object') {
      throw new Error('municipality-cells sin municipalities');
    }
    if (currentJson.municipalityCellsPath !== `v/${expectedVersion}/municipality-cells.json`) {
      throw new Error('municipalityCellsPath no canónico');
    }
  }

  if (typeof currentJson.geometryCurrentPath === 'string' || typeof currentJson.geometryCatalogPath === 'string') {
    if (currentJson.geometryCurrentPath !== 'g/current.json') {
      throw new Error('geometryCurrentPath no canónico');
    }
    const geoCurrent = await fetchOnce(`${base}/g/current.json`, { bust: true });
    if (!geoCurrent.res.ok) throw new Error(`g/current.json HTTP ${geoCurrent.res.status}`);
    assertCors(geoCurrent.headers, 'g/current.json');
    assertCache(geoCurrent.headers, 'g/current.json', 'public, max-age=60, must-revalidate');
    const geoJson = JSON.parse(geoCurrent.text);
    if (!geoJson.geometryVersion || !/^[0-9a-f]{16}$/.test(geoJson.geometryVersion)) {
      throw new Error('g/current.json geometryVersion inválido');
    }
    if (geoJson.manifestPath !== `g/${geoJson.geometryVersion}/geometry-catalog-manifest.json`) {
      throw new Error('g/current.json manifestPath no canónico');
    }
    if (geoJson.catalogPath !== `g/${geoJson.geometryVersion}/municipality-catalog.json`) {
      throw new Error('g/current.json catalogPath no canónico');
    }
    if (currentJson.geometryCatalogPath !== geoJson.manifestPath) {
      throw new Error('geometryCatalogPath no coincide con g/current.json (posible lectura cruzada; reintentar)');
    }

    const geoManifest = await fetchOnce(`${base}/${geoJson.manifestPath.replace(/^\//, '')}`);
    if (!geoManifest.res.ok) throw new Error(`geometry-catalog-manifest HTTP ${geoManifest.res.status}`);
    assertCors(geoManifest.headers, 'geometry-catalog-manifest');
    assertCache(geoManifest.headers, 'geometry-catalog-manifest', 'public, max-age=31536000, immutable');
    const geoManifestJson = JSON.parse(geoManifest.text);
    if (geoManifestJson.geometryVersion !== geoJson.geometryVersion) {
      throw new Error('geometry-catalog-manifest geometryVersion distinto de g/current');
    }
    if (geoManifestJson.catalogVersion !== geoJson.catalogVersion) {
      throw new Error('geometry-catalog-manifest catalogVersion distinto de g/current');
    }
    if (!String(geoManifestJson?.source?.license || '').includes('CC BY')) {
      throw new Error('geometry-catalog-manifest sin licencia CC BY');
    }
    const packs = Array.isArray(geoManifestJson?.packs?.files) ? geoManifestJson.packs.files : [];
    if (packs.length === 0) {
      throw new Error('geometry-catalog-manifest sin packs.files');
    }
    if (geoManifestJson.packs.fileCount !== packs.length) {
      throw new Error('geometry-catalog-manifest packs.fileCount incoherente');
    }

    const catalogRes = await fetchOnce(`${base}/${geoJson.catalogPath.replace(/^\//, '')}`);
    if (!catalogRes.res.ok) throw new Error(`municipality-catalog HTTP ${catalogRes.res.status}`);
    assertCors(catalogRes.headers, 'municipality-catalog');
    assertCache(catalogRes.headers, 'municipality-catalog', 'public, max-age=31536000, immutable');
    const catalogJson = JSON.parse(catalogRes.text);
    if (catalogJson.schemaVersion !== 1) {
      throw new Error('municipality-catalog schemaVersion inválido');
    }
    if (catalogJson.catalogVersion !== geoJson.catalogVersion) {
      throw new Error('municipality-catalog catalogVersion no coincide con g/current');
    }
    if (!catalogJson.relations || typeof catalogJson.relations !== 'object') {
      throw new Error('municipality-catalog sin relations');
    }
    if (!Array.isArray(catalogJson.ineWithoutMinetur)) {
      throw new Error('municipality-catalog sin ineWithoutMinetur');
    }

    if (exhaustivePacks) {
      for (const pack of packs) {
        await verifyPackFile(base, pack);
      }
    } else {
      // Muestreo remoto: primer pack + hash (validación exhaustiva = publish local / VERIFY_EXHAUSTIVE_PACKS).
      await verifyPackFile(base, packs[0]);
    }
  }

  // Coherencia con current/local pointers
  if (localCurrent.datasetVersion !== currentJson.datasetVersion) {
    throw new Error('current local/remoto divergente');
  }
}

async function main() {
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `verify attempt ${attempt}/${maxAttempts}` +
          (exhaustivePacks ? ' (exhaustive packs)' : ' (remote sample)'),
      );
      await verifyOnce();
      console.log('verify ok');
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, 'verified=true\n');
      }
      return 0;
    } catch (err) {
      lastErr = err;
      console.error(`verify attempt ${attempt} failed:`, err && err.message ? err.message : err);
      if (attempt < maxAttempts) await sleep(delayMs);
    }
  }

  console.error(
    'Verificación HTTP fallida tras reintentos:',
    lastErr && lastErr.message ? lastErr.message : lastErr,
  );
  return 1;
}

process.exitCode = await main();
