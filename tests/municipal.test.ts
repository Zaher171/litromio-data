import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPublishedTreeCoherent,
  buildGeometryPublishFiles,
  cellIdsForMunicipalityIds,
  createStorePaths,
  generatePartitionedDataset,
  incorporateGeometryIntoLive,
  municipalityCellsRelPath,
  parseAndValidateFuentePayload,
  parseMunicipalityCatalog,
  readGeometryCurrent,
  readLiveManifest,
  recoverPublishedState,
  runPipeline,
  type RawFuenteResponse,
} from '../src/index.ts';
import { FIXTURE_PIPELINE_CONFIG } from '../src/types.ts';

function station(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    IDEESS: '1001',
    Rótulo: 'DEMO',
    Dirección: 'Calle 1',
    'C.P.': '28001',
    Localidad: 'Madrid',
    Municipio: 'Madrid',
    IDMunicipio: '1',
    IDProvincia: '28',
    IDCCAA: '13',
    Latitud: '40,416800',
    'Longitud (WGS84)': '-3,703800',
    Horario: 'L-D: 24H',
    'Tipo Venta': 'P',
    Remisión: 'OM',
    Margen: 'D',
    'Precio Gasoleo A': '1,499',
    'Precio Gasolina 95 E5': '1,599',
    ...overrides,
  };
}

function payload(stations: Record<string, unknown>[], fecha = '27/08/2026 12:00:00'): RawFuenteResponse {
  return {
    Fecha: fecha,
    Nota: 'test',
    ResultadoConsulta: 'OK',
    ListaEESSPrecio: stations,
  };
}

function manyStations(count: number, priceSuffix = '1,500'): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      station({
        IDEESS: String(10_000 + i),
        IDMunicipio: i % 2 === 0 ? '2144' : '2181',
        Latitud: '40,400000',
        'Longitud (WGS84)': '-3,700000',
        'Precio Gasoleo A': priceSuffix,
        'Precio Gasolina 95 E5': '',
      }),
    );
  }
  return out;
}

const testConfig = {
  ...FIXTURE_PIPELINE_CONFIG,
  minStationCountAbsolute: 2,
  minStationCountRatioOfActive: 0.9,
  retainPreviousVersions: 1,
  retainGeometryVersions: 1,
  allowEmptyPublish: true,
};

const tmpDirs: string[] = [];
const servers: http.Server[] = [];

function tmpOut(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litromio-mun-'));
  tmpDirs.push(dir);
  return dir;
}

function cacheControlForRel(rel: string): string {
  if (rel === 'g/current.json' || rel === 'current.json' || rel === 'manifest.json' || rel === 'sync.json') {
    return 'public, max-age=60, must-revalidate';
  }
  if (rel.startsWith('v/') || rel.startsWith('g/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=60, must-revalidate';
}

async function serveDir(dir: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': cacheControlForRel(rel),
    });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function snapshotVersionTreeBytes(liveDir: string, datasetVersion: string): Map<string, Buffer> {
  const root = path.join(liveDir, 'v', datasetVersion);
  const out = new Map<string, Buffer>();
  const walk = (dir: string, relBase: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = `${relBase}/${entry.name}`.replace(/\\/g, '/');
      if (entry.isDirectory()) walk(abs, rel);
      else out.set(rel, fs.readFileSync(abs));
    }
  };
  if (fs.existsSync(root)) walk(root, `v/${datasetVersion}`);
  return out;
}

/** Muestreo de contratos municipales (como verify-published remoto, sin env de Actions). */
async function sampleMunicipalHttpContracts(baseUrl: string, liveDir: string): Promise<void> {
  const current = JSON.parse(fs.readFileSync(path.join(liveDir, 'current.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const fetchJson = async (rel: string) => {
    const res = await fetch(`${baseUrl}/${rel.replace(/^\//, '')}`);
    if (!res.ok) throw new Error(`${rel} HTTP ${res.status}`);
    return JSON.parse(await res.text()) as Record<string, unknown>;
  };
  const remoteCurrent = await fetchJson('current.json');
  expect(remoteCurrent.datasetVersion).toBe(current.datasetVersion);
  expect(remoteCurrent.contentHash).toBe(current.contentHash);

  if (typeof current.municipalityCellsPath === 'string') {
    const cells = await fetchJson(current.municipalityCellsPath);
    expect(cells.datasetVersion).toBe(current.datasetVersion);
    expect(cells.contentHash).toBe(current.contentHash);
  }
  if (typeof current.geometryCurrentPath === 'string') {
    const geo = await fetchJson('g/current.json');
    expect(current.geometryCatalogPath).toBe(geo.manifestPath);
    const manifest = await fetchJson(String(geo.manifestPath));
    expect(manifest.geometryVersion).toBe(geo.geometryVersion);
    const catalog = await fetchJson(String(geo.catalogPath));
    expect(catalog.catalogVersion).toBe(geo.catalogVersion);
    const packs = (manifest.packs as { files: { path: string; sha256: string }[] }).files;
    expect(packs.length).toBeGreaterThan(0);
    const packRes = await fetch(`${baseUrl}/${packs[0]!.path}`);
    expect(packRes.ok).toBe(true);
    const body = await packRes.text();
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256')
      .update(body.endsWith('\n') ? body : `${body}\n`, 'utf8')
      .digest('hex');
    const shaRaw = createHash('sha256').update(body, 'utf8').digest('hex');
    expect([sha, shaRaw]).toContain(packs[0]!.sha256);
  }
}

function writeMiniGeometrySource(root: string): {
  packsDir: string;
  sourceManifestPath: string;
  relationsPath: string;
  geometryVersion: string;
  catalogVersion: string;
} {
  const packsDir = path.join(root, 'packs');
  fs.mkdirSync(packsDir, { recursive: true });
  const packBody = {
    schemaVersion: 1,
    cellId: '10_12',
    municipalities: [
      {
        ineCode: '15902',
        name: 'Oza-Cesuras',
        idMunicipality: '2144',
        idMunicipalities: ['2144', '2181'],
        geometry: [
          [
            [
              [-8.2, 43.2],
              [-8.1, 43.2],
              [-8.1, 43.3],
              [-8.2, 43.3],
              [-8.2, 43.2],
            ],
          ],
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(packsDir, '10_12.json'), `${JSON.stringify(packBody)}\n`, 'utf8');

  const geometryVersion = 'a1b2c3d4e5f60718';
  const catalogVersion = 'b2c3d4e5f6071829';
  const sourceManifest = {
    schemaVersion: 1,
    geometryVersion,
    catalogVersion,
    source: {
      name: 'IGN API-Features administrativeunit',
      filter: "nationallevelname='Municipio'",
      license: 'CC BY 4.0 ign.es',
      licenseUrl: 'https://www.ign.es/resources/licencia/Condiciones_licenciaUso_IGN.pdf',
      fetchedAt: '2026-08-27T17:26:42.188Z',
      numberMatched: 1,
    },
    grid: { cellSizeDeg: 0.5, latOrigin: 35, lonOrigin: -10 },
  };
  const sourceManifestPath = path.join(root, 'source-manifest.json');
  fs.writeFileSync(sourceManifestPath, `${JSON.stringify(sourceManifest)}\n`, 'utf8');

  const relations = {
    schemaVersion: 1,
    catalogVersion,
    generatedAt: '2026-08-27T17:30:00.000Z',
    ineCount: 3,
    stats: { ineCount: 3, withMinetur: 2, withoutMinetur: 1 },
    relations: {
      '15902': ['2144', '2181'],
      '28079': ['1'],
    },
    ineWithoutMinetur: ['10902'],
  };
  const relationsPath = path.join(root, 'relations.json');
  fs.writeFileSync(relationsPath, `${JSON.stringify(relations)}\n`, 'utf8');

  return { packsDir, sourceManifestPath, relationsPath, geometryVersion, catalogVersion };
}

function publishPrices(out: string, stations = manyStations(4), fecha = '27/08/2026 12:00:00') {
  return runPipeline({
    runId: `p-${Date.now()}-${Math.random()}`,
    outRoot: out,
    payload: payload(stations, fecha),
    downloadedAt: '2026-08-27T12:00:00.000Z',
    startedAt: '2026-08-27T12:00:01.000Z',
    config: testConfig,
  });
}

function incorporateGeometry(out: string, src: ReturnType<typeof writeMiniGeometrySource>, allowInitial = true) {
  const store = createStorePaths(out);
  const relationsRaw = JSON.parse(fs.readFileSync(src.relationsPath, 'utf8')) as {
    relations: Record<string, string[]>;
    ineWithoutMinetur: string[];
    stats?: { ineCount?: number };
    generatedAt?: string;
  };
  const existing = readGeometryCurrent(store.liveDir);
  const built = buildGeometryPublishFiles({
    geometryVersion: src.geometryVersion,
    catalogVersion: src.catalogVersion,
    packsDir: src.packsDir,
    sourceManifest: JSON.parse(fs.readFileSync(src.sourceManifestPath, 'utf8')) as Record<string, unknown>,
    relations: {
      relations: relationsRaw.relations,
      ineWithoutMinetur: relationsRaw.ineWithoutMinetur,
      ...(relationsRaw.stats?.ineCount !== undefined ? { ineCount: relationsRaw.stats.ineCount } : {}),
      ...(relationsRaw.generatedAt !== undefined ? { generatedAt: relationsRaw.generatedAt } : {}),
    },
    publishedAt: '2026-08-27T13:00:00.000Z',
    previousGeometryVersion: existing?.geometryVersion ?? null,
    retainGeometryVersions: 1,
  });
  if (!built.ok) throw new Error(built.reason);
  return incorporateGeometryIntoLive({
    liveDir: store.liveDir,
    geometryFiles: built.files,
    geometryCurrent: built.current,
    retainGeometryVersions: 1,
    allowInitialGeometry: allowInitial,
  });
}

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  while (servers.length) {
    const s = servers.pop();
    if (!s) break;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('Fase 4D municipal', () => {
  it('genera municipality-cells ligado al dataset y con cobertura completa', () => {
    const parsed = parseAndValidateFuentePayload(
      payload([
        station({ IDEESS: '1', IDMunicipio: '2144' }),
        station({ IDEESS: '2', IDMunicipio: '2181', Latitud: '40,400000', 'Longitud (WGS84)': '-3,700000' }),
      ]),
    );
    const gen = generatePartitionedDataset(parsed, { downloadedAt: '2026-08-27T12:00:00.000Z' });
    const rel = municipalityCellsRelPath(gen.datasetVersion);
    expect(gen.files.has(rel)).toBe(true);
    const doc = JSON.parse(gen.files.get(rel)!);
    expect(doc.datasetVersion).toBe(gen.datasetVersion);
    expect(doc.contentHash).toBe(gen.contentHash);
    expect(doc.municipalities['2144']?.length).toBeGreaterThan(0);
    expect(JSON.parse(gen.files.get('current.json')!).municipalityCellsPath).toBe(rel);
  });

  it('recupera formato antiguo sin geometrías', async () => {
    const publisher = tmpOut();
    expect(publishPrices(publisher).outcome).toBe('published');
    const store = createStorePaths(publisher);
    // Simular CDN antiguo: quitar municipality-cells y puntero.
    const m = readLiveManifest(store.liveDir)!;
    const cellsPath = path.join(store.liveDir, municipalityCellsRelPath(m.datasetVersion));
    fs.rmSync(cellsPath, { force: true });
    const current = JSON.parse(fs.readFileSync(path.join(store.liveDir, 'current.json'), 'utf8'));
    delete current.municipalityCellsPath;
    fs.writeFileSync(path.join(store.liveDir, 'current.json'), `${JSON.stringify(current)}\n`);

    const served = await serveDir(store.liveDir);
    const runner = tmpOut();
    const recovered = await recoverPublishedState({
      publicBaseUrl: served.baseUrl,
      outRoot: runner,
      allowHttpLocal: true,
      timeoutMs: 5_000,
      totalTimeoutMs: 30_000,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.reason);
    expect(fs.existsSync(path.join(createStorePaths(runner).liveDir, 'g'))).toBe(false);
    await served.close();
  });

  it('incorporación municipal inicial explícita; sin flag falla', () => {
    const out = tmpOut();
    expect(publishPrices(out).outcome).toBe('published');
    const src = writeMiniGeometrySource(tmpOut());
    const refused = incorporateGeometry(out, src, false);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected fail');
    expect(refused.reason).toMatch(/allow-initial-geometry/i);

    const ok = incorporateGeometry(out, src, true);
    expect(ok.ok).toBe(true);
    const store = createStorePaths(out);
    expect(assertPublishedTreeCoherent(store.liveDir)).toEqual({ ok: true });
    const current = JSON.parse(fs.readFileSync(path.join(store.liveDir, 'current.json'), 'utf8'));
    expect(current.geometryCurrentPath).toBe('g/current.json');
    expect(current.municipalityCellsPath).toBeTruthy();
    expect(readGeometryCurrent(store.liveDir)?.geometryVersion).toBe(src.geometryVersion);
  });

  it('actualización de precios conserva geometrías y no las regenera', () => {
    const out = tmpOut();
    expect(publishPrices(out, manyStations(4, '1,500'), '27/08/2026 12:00:00').outcome).toBe('published');
    const src = writeMiniGeometrySource(tmpOut());
    expect(incorporateGeometry(out, src).ok).toBe(true);
    const store = createStorePaths(out);
    const geoBefore = fs.readFileSync(path.join(store.liveDir, 'g', src.geometryVersion, 'packs', '10_12.json'));

    const next = runPipeline({
      runId: 'price-2',
      outRoot: out,
      payload: payload(manyStations(4, '1,510'), '27/08/2026 12:30:00'),
      downloadedAt: '2026-08-27T12:30:00.000Z',
      startedAt: '2026-08-27T12:30:01.000Z',
      config: testConfig,
    });
    expect(next.outcome).toBe('published');
    const geoAfter = fs.readFileSync(path.join(store.liveDir, 'g', src.geometryVersion, 'packs', '10_12.json'));
    expect(geoAfter.equals(geoBefore)).toBe(true);
    expect(readGeometryCurrent(store.liveDir)?.geometryVersion).toBe(src.geometryVersion);
    const current = JSON.parse(fs.readFileSync(path.join(store.liveDir, 'current.json'), 'utf8'));
    expect(current.geometryCatalogPath).toContain(src.geometryVersion);
    expect(fs.existsSync(path.join(store.liveDir, current.municipalityCellsPath))).toBe(true);
  });

  it('synced_unchanged deja árbol completo con geometría', () => {
    const out = tmpOut();
    const p = payload(manyStations(4, '1,500'), '27/08/2026 12:00:00');
    expect(
      runPipeline({
        runId: 's1',
        outRoot: out,
        payload: p,
        downloadedAt: '2026-08-27T12:00:00.000Z',
        startedAt: '2026-08-27T12:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');
    expect(incorporateGeometry(out, writeMiniGeometrySource(tmpOut())).ok).toBe(true);

    const sync = runPipeline({
      runId: 's2',
      outRoot: out,
      payload: p,
      downloadedAt: '2026-08-27T12:20:00.000Z',
      startedAt: '2026-08-27T12:20:01.000Z',
      config: testConfig,
    });
    expect(sync.outcome).toBe('synced_unchanged');
    expect(assertPublishedTreeCoherent(createStorePaths(out).liveDir)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(createStorePaths(out).liveDir, 'g', 'current.json'))).toBe(true);
  });

  it('cambio de geometría retiene la versión previa referenciada', () => {
    const out = tmpOut();
    expect(publishPrices(out).outcome).toBe('published');
    const src1 = writeMiniGeometrySource(tmpOut());
    expect(incorporateGeometry(out, src1).ok).toBe(true);

    const src2Root = tmpOut();
    const src2 = writeMiniGeometrySource(src2Root);
    // Nueva versión distinta
    src2.geometryVersion = 'c3d4e5f60718293a';
    const manifest = JSON.parse(fs.readFileSync(src2.sourceManifestPath, 'utf8'));
    manifest.geometryVersion = src2.geometryVersion;
    fs.writeFileSync(src2.sourceManifestPath, `${JSON.stringify(manifest)}\n`);

    expect(incorporateGeometry(out, src2, true).ok).toBe(true);
    const geo = readGeometryCurrent(createStorePaths(out).liveDir)!;
    expect(geo.geometryVersion).toBe(src2.geometryVersion);
    expect(geo.retainedVersions).toContain(src1.geometryVersion);
    expect(
      fs.existsSync(path.join(createStorePaths(out).liveDir, 'g', src1.geometryVersion, 'packs', '10_12.json')),
    ).toBe(true);
  });

  it('archivo geométrico ausente / hash incorrecto / versión incompatible abortan recover', async () => {
    const publisher = tmpOut();
    expect(publishPrices(publisher).outcome).toBe('published');
    expect(incorporateGeometry(publisher, writeMiniGeometrySource(tmpOut())).ok).toBe(true);
    const live = createStorePaths(publisher).liveDir;

    // Hash incorrecto
    const packPath = path.join(live, 'g', readGeometryCurrent(live)!.geometryVersion, 'packs', '10_12.json');
    const good = fs.readFileSync(packPath);
    fs.writeFileSync(packPath, `${good.toString('utf8').trim()} \n`);
    const servedBadHash = await serveDir(live);
    const badHash = await recoverPublishedState({
      publicBaseUrl: servedBadHash.baseUrl,
      outRoot: tmpOut(),
      allowHttpLocal: true,
      timeoutMs: 5_000,
      geometryTotalTimeoutMs: 15_000,
    });
    expect(badHash.ok).toBe(false);
    if (badHash.ok) throw new Error('expected fail');
    expect(badHash.code).toBe('hash_mismatch');
    await servedBadHash.close();
    fs.writeFileSync(packPath, good);

    // Archivo ausente (declarado)
    fs.rmSync(packPath);
    const servedMissing = await serveDir(live);
    const missing = await recoverPublishedState({
      publicBaseUrl: servedMissing.baseUrl,
      outRoot: tmpOut(),
      allowHttpLocal: true,
      timeoutMs: 5_000,
      geometryTotalTimeoutMs: 15_000,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected fail');
    expect(['incomplete', 'incoherent']).toContain(missing.code);
    await servedMissing.close();
  });

  it('fusión municipal une IDs; municipio sin Minetur queda listado', () => {
    const src = writeMiniGeometrySource(tmpOut());
    const relations = parseMunicipalityCatalog(JSON.parse(fs.readFileSync(src.relationsPath, 'utf8')));
    expect(relations.ok).toBe(true);
    if (!relations.ok) throw new Error(relations.reason);
    expect(relations.value.relations['15902']).toEqual(['2144', '2181']);
    expect(relations.value.ineWithoutMinetur).toContain('10902');

    const out = tmpOut();
    expect(publishPrices(out).outcome).toBe('published');
    expect(incorporateGeometry(out, src).ok).toBe(true);
    const m = readLiveManifest(createStorePaths(out).liveDir)!;
    const cellsDoc = JSON.parse(
      fs.readFileSync(path.join(createStorePaths(out).liveDir, municipalityCellsRelPath(m.datasetVersion)), 'utf8'),
    );
    const union = cellIdsForMunicipalityIds(['2144', '2181'], cellsDoc.municipalities);
    expect(union.length).toBeGreaterThan(0);
  });

  it('fallo durante preparación conserva publicación anterior', () => {
    const out = tmpOut();
    expect(publishPrices(out, manyStations(4, '1,500')).outcome).toBe('published');
    expect(incorporateGeometry(out, writeMiniGeometrySource(tmpOut())).ok).toBe(true);
    const store = createStorePaths(out);
    const beforeGeo = fs.readFileSync(path.join(store.liveDir, 'g', 'current.json'), 'utf8');
    const beforeVersion = readLiveManifest(store.liveDir)!.datasetVersion;

    const failed = runPipeline({
      runId: 'fail',
      outRoot: out,
      payload: payload(manyStations(4, '1,520'), '27/08/2026 13:00:00'),
      downloadedAt: '2026-08-27T13:00:00.000Z',
      startedAt: '2026-08-27T13:00:01.000Z',
      config: testConfig,
      failPublish: true,
    });
    expect(failed.outcome).toBe('failed_publish');
    expect(readLiveManifest(store.liveDir)?.datasetVersion).toBe(beforeVersion);
    expect(fs.readFileSync(path.join(store.liveDir, 'g', 'current.json'), 'utf8')).toBe(beforeGeo);
  });

  it('cliente antiguo: current sin campos municipales sigue siendo usable', () => {
    const out = tmpOut();
    expect(publishPrices(out).outcome).toBe('published');
    const store = createStorePaths(out);
    const current = JSON.parse(fs.readFileSync(path.join(store.liveDir, 'current.json'), 'utf8'));
    // Cliente antiguo solo lee estos campos
    expect(current.schemaVersion).toBe(1);
    expect(current.datasetVersion).toMatch(/^[a-f0-9]{16}$/);
    expect(current.manifestPath).toBe(`v/${current.datasetVersion}/manifest.json`);
    expect(current.contentHash).toMatch(/^[a-f0-9]{64}$/);
    // Campos opcionales pueden existir; ignorarlos no rompe
    const { municipalityCellsPath: _m, geometryCatalogPath: _g, geometryCurrentPath: _c, ...legacy } = current;
    expect(legacy.manifestPath).toBeTruthy();
  });

  it('recover con geometría declarada corrupta no se interpreta como ausencia inicial', async () => {
    const publisher = tmpOut();
    expect(publishPrices(publisher).outcome).toBe('published');
    expect(incorporateGeometry(publisher, writeMiniGeometrySource(tmpOut())).ok).toBe(true);
    const live = createStorePaths(publisher).liveDir;
    fs.rmSync(path.join(live, 'g'), { recursive: true, force: true });
    // current sigue declarando geometría
    const served = await serveDir(live);
    const recovered = await recoverPublishedState({
      publicBaseUrl: served.baseUrl,
      outRoot: tmpOut(),
      allowHttpLocal: true,
      timeoutMs: 5_000,
      geometryTotalTimeoutMs: 10_000,
    });
    expect(recovered.ok).toBe(false);
    if (recovered.ok) throw new Error('expected fail');
    expect(recovered.reason).toMatch(/declara geometría|ausente|incomplet/i);
    await served.close();
  });

  it('migración precios idénticos: índice municipal sin mutar inmutables preexistentes', async () => {
    const publisher = tmpOut();
    const stations = manyStations(4, '1,500');
    const fecha = '27/08/2026 12:00:00';
    expect(publishPrices(publisher, stations, fecha).outcome).toBe('published');
    const store = createStorePaths(publisher);
    const m = readLiveManifest(store.liveDir)!;
    // Estado antiguo sin soporte municipal
    const cellsPath = path.join(store.liveDir, municipalityCellsRelPath(m.datasetVersion));
    fs.rmSync(cellsPath, { force: true });
    const current = JSON.parse(fs.readFileSync(path.join(store.liveDir, 'current.json'), 'utf8'));
    delete current.municipalityCellsPath;
    delete current.geometryCurrentPath;
    delete current.geometryCatalogPath;
    fs.writeFileSync(path.join(store.liveDir, 'current.json'), `${JSON.stringify(current)}\n`);

    const before = snapshotVersionTreeBytes(store.liveDir, m.datasetVersion);
    expect([...before.keys()].some((k) => k.endsWith('municipality-cells.json'))).toBe(false);

    // Mismos precios → synced_unchanged (no reescribe v/)
    const same = runPipeline({
      runId: 'same-prices',
      outRoot: publisher,
      payload: payload(stations, fecha),
      downloadedAt: '2026-08-27T12:10:00.000Z',
      startedAt: '2026-08-27T12:10:01.000Z',
      config: testConfig,
    });
    expect(same.outcome).toBe('synced_unchanged');
    const mid = snapshotVersionTreeBytes(store.liveDir, m.datasetVersion);
    expect(mid.size).toBe(before.size);
    for (const [rel, bytes] of before) {
      expect(mid.get(rel)?.equals(bytes)).toBe(true);
    }

    expect(incorporateGeometry(publisher, writeMiniGeometrySource(tmpOut()), true).ok).toBe(true);
    const after = snapshotVersionTreeBytes(store.liveDir, m.datasetVersion);
    for (const [rel, bytes] of before) {
      expect(after.get(rel)?.equals(bytes), rel).toBe(true);
    }
    const added = [...after.keys()].filter((k) => !before.has(k));
    expect(added).toEqual([municipalityCellsRelPath(m.datasetVersion)]);
    expect(assertPublishedTreeCoherent(store.liveDir)).toEqual({ ok: true });

    const served = await serveDir(store.liveDir);
    const recovered = await recoverPublishedState({
      publicBaseUrl: served.baseUrl,
      outRoot: tmpOut(),
      allowHttpLocal: true,
      timeoutMs: 5_000,
      geometryTotalTimeoutMs: 15_000,
      maxResponseBytes: 25 * 1024 * 1024,
      geometryConcurrency: 8,
    });
    expect(recovered.ok).toBe(true);
    await sampleMunicipalHttpContracts(served.baseUrl, store.liveDir);
    await served.close();
  });

  it('no sobrescribe municipality-cells ya publicado al reincorporar geometría', () => {
    const out = tmpOut();
    expect(publishPrices(out).outcome).toBe('published');
    const store = createStorePaths(out);
    const m = readLiveManifest(store.liveDir)!;
    const cellsRel = municipalityCellsRelPath(m.datasetVersion);
    const beforeCells = fs.readFileSync(path.join(store.liveDir, cellsRel));
    expect(incorporateGeometry(out, writeMiniGeometrySource(tmpOut())).ok).toBe(true);
    const afterCells = fs.readFileSync(path.join(store.liveDir, cellsRel));
    expect(afterCells.equals(beforeCells)).toBe(true);
  });

  it('geometría sin cambio de precios avanza punteros de forma coherente', () => {
    const out = tmpOut();
    expect(publishPrices(out, manyStations(4, '1,500')).outcome).toBe('published');
    const src1 = writeMiniGeometrySource(tmpOut());
    expect(incorporateGeometry(out, src1).ok).toBe(true);
    const store = createStorePaths(out);
    const priceVersion = readLiveManifest(store.liveDir)!.datasetVersion;
    const beforePrices = snapshotVersionTreeBytes(store.liveDir, priceVersion);

    const src2 = writeMiniGeometrySource(tmpOut());
    src2.geometryVersion = 'c3d4e5f60718293a';
    const manifest = JSON.parse(fs.readFileSync(src2.sourceManifestPath, 'utf8'));
    manifest.geometryVersion = src2.geometryVersion;
    fs.writeFileSync(src2.sourceManifestPath, `${JSON.stringify(manifest)}\n`);
    expect(incorporateGeometry(out, src2, true).ok).toBe(true);

    const afterPrices = snapshotVersionTreeBytes(store.liveDir, priceVersion);
    expect(afterPrices.size).toBe(beforePrices.size);
    for (const [rel, bytes] of beforePrices) {
      expect(afterPrices.get(rel)?.equals(bytes)).toBe(true);
    }
    const current = JSON.parse(fs.readFileSync(path.join(store.liveDir, 'current.json'), 'utf8'));
    const geo = readGeometryCurrent(store.liveDir)!;
    expect(current.datasetVersion).toBe(priceVersion);
    expect(current.geometryCatalogPath).toBe(geo.manifestPath);
    expect(geo.geometryVersion).toBe(src2.geometryVersion);
    expect(assertPublishedTreeCoherent(store.liveDir)).toEqual({ ok: true });
  });

  it('dos actualizaciones sucesivas precios+geometría retienen archivos referenciados', () => {
    const out = tmpOut();
    expect(publishPrices(out, manyStations(4, '1,500'), '27/08/2026 12:00:00').outcome).toBe('published');
    const g1 = writeMiniGeometrySource(tmpOut());
    expect(incorporateGeometry(out, g1).ok).toBe(true);
    const store = createStorePaths(out);
    const v1 = readLiveManifest(store.liveDir)!.datasetVersion;

    expect(
      runPipeline({
        runId: 'p2',
        outRoot: out,
        payload: payload(manyStations(4, '1,510'), '27/08/2026 12:30:00'),
        downloadedAt: '2026-08-27T12:30:00.000Z',
        startedAt: '2026-08-27T12:30:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');
    const v2 = readLiveManifest(store.liveDir)!.datasetVersion;
    expect(v2).not.toBe(v1);

    const g2 = writeMiniGeometrySource(tmpOut());
    g2.geometryVersion = 'c3d4e5f60718293a';
    const man2 = JSON.parse(fs.readFileSync(g2.sourceManifestPath, 'utf8'));
    man2.geometryVersion = g2.geometryVersion;
    fs.writeFileSync(g2.sourceManifestPath, `${JSON.stringify(man2)}\n`);
    expect(incorporateGeometry(out, g2, true).ok).toBe(true);

    expect(
      runPipeline({
        runId: 'p3',
        outRoot: out,
        payload: payload(manyStations(4, '1,520'), '27/08/2026 13:00:00'),
        downloadedAt: '2026-08-27T13:00:00.000Z',
        startedAt: '2026-08-27T13:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');

    const g3 = writeMiniGeometrySource(tmpOut());
    g3.geometryVersion = 'd4e5f60718293a4b';
    const man3 = JSON.parse(fs.readFileSync(g3.sourceManifestPath, 'utf8'));
    man3.geometryVersion = g3.geometryVersion;
    fs.writeFileSync(g3.sourceManifestPath, `${JSON.stringify(man3)}\n`);
    expect(incorporateGeometry(out, g3, true).ok).toBe(true);

    expect(assertPublishedTreeCoherent(store.liveDir)).toEqual({ ok: true });
    const sync = JSON.parse(fs.readFileSync(path.join(store.liveDir, 'sync.json'), 'utf8')) as {
      retainedVersions: string[];
      datasetVersion: string;
    };
    const geo = readGeometryCurrent(store.liveDir)!;
    // default 1 = una anterior además de la activa
    expect(sync.retainedVersions.length).toBe(1);
    expect(geo.retainedVersions.length).toBe(1);
    expect(sync.retainedVersions[0]).not.toBe(sync.datasetVersion);
    expect(geo.retainedVersions[0]).not.toBe(geo.geometryVersion);

    for (const version of [sync.datasetVersion, ...sync.retainedVersions]) {
      const vm = JSON.parse(
        fs.readFileSync(path.join(store.liveDir, 'v', version, 'manifest.json'), 'utf8'),
      ) as { cells: { path: string }[] };
      for (const cell of vm.cells) {
        expect(fs.existsSync(path.join(store.liveDir, cell.path))).toBe(true);
      }
    }
    for (const version of [geo.geometryVersion, ...geo.retainedVersions]) {
      expect(fs.existsSync(path.join(store.liveDir, 'g', version, 'packs', '10_12.json'))).toBe(true);
      expect(
        fs.existsSync(path.join(store.liveDir, 'g', version, 'geometry-catalog-manifest.json')),
      ).toBe(true);
      expect(fs.existsSync(path.join(store.liveDir, 'g', version, 'municipality-catalog.json'))).toBe(true);
    }
  });

  it('verificador HTTP falla ante catálogo, índice o pack incorrecto', async () => {
    const publisher = tmpOut();
    expect(publishPrices(publisher).outcome).toBe('published');
    expect(incorporateGeometry(publisher, writeMiniGeometrySource(tmpOut())).ok).toBe(true);
    const live = createStorePaths(publisher).liveDir;

    const catalogPath = path.join(
      live,
      'g',
      readGeometryCurrent(live)!.geometryVersion,
      'municipality-catalog.json',
    );
    const goodCatalog = fs.readFileSync(catalogPath);
    fs.writeFileSync(catalogPath, `${JSON.stringify({ schemaVersion: 1, broken: true })}\n`);
    expect(assertPublishedTreeCoherent(live).ok).toBe(false);
    fs.writeFileSync(catalogPath, goodCatalog);

    const current = JSON.parse(fs.readFileSync(path.join(live, 'current.json'), 'utf8'));
    const cellsAbs = path.join(live, current.municipalityCellsPath);
    const goodCells = fs.readFileSync(cellsAbs);
    const badCells = JSON.parse(goodCells.toString('utf8'));
    badCells.contentHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    badCells.datasetVersion = 'ffffffffffffffff';
    fs.writeFileSync(cellsAbs, `${JSON.stringify(badCells)}\n`);
    expect(assertPublishedTreeCoherent(live).ok).toBe(false);
    const servedBadIndex = await serveDir(live);
    await expect(sampleMunicipalHttpContracts(servedBadIndex.baseUrl, live)).rejects.toThrow();
    await servedBadIndex.close();
    fs.writeFileSync(cellsAbs, goodCells);

    const packPath = path.join(live, 'g', readGeometryCurrent(live)!.geometryVersion, 'packs', '10_12.json');
    const goodPack = fs.readFileSync(packPath);
    fs.writeFileSync(packPath, `${goodPack.toString('utf8').trim()} tampered\n`);
    expect(assertPublishedTreeCoherent(live).ok).toBe(false);
    fs.writeFileSync(packPath, goodPack);

    expect(assertPublishedTreeCoherent(live)).toEqual({ ok: true });
    const servedOk = await serveDir(live);
    await sampleMunicipalHttpContracts(servedOk.baseUrl, live);
    await servedOk.close();
  });
});
