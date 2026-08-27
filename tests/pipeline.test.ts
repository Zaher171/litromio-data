import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertManifestCoherent,
  assertPublishedTreeCoherent,
  cellForLatLon,
  cellsForNearbySearch,
  createStorePaths,
  generatePartitionedDataset,
  isManifestStale,
  neighboringCellIds,
  normalizePriceText,
  parseAndValidateFuentePayload,
  parseFuenteFechaToEpoch,
  readLiveManifest,
  readSyncState,
  recoverPublishedState,
  isSafeRelativeAssetPath,
  assertSafeStagingPath,
  runPipeline,
  stripClockFields,
  type RawFuenteResponse,
} from '../src/index.ts';
import { DEFAULT_PIPELINE_CONFIG, FIXTURE_PIPELINE_CONFIG } from '../src/types.ts';

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
  allowEmptyPublish: true,
};

const productionLike = {
  ...DEFAULT_PIPELINE_CONFIG,
  allowEmptyPublish: false,
};

const tmpDirs: string[] = [];
const servers: http.Server[] = [];

function tmpOut(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litromio-data-'));
  tmpDirs.push(dir);
  return dir;
}

function snapshotImmutable(liveDir: string, datasetVersion: string): Map<string, string> {
  const root = path.join(liveDir, 'v', datasetVersion);
  const map = new Map<string, string>();
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs, child);
      else map.set(child, fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(root, '');
  return map;
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
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
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

describe('normalizePriceText', () => {
  it('preserva dígitos decimales como texto', () => {
    expect(normalizePriceText('1,599')).toEqual({ ok: true, priceText: '1.599' });
    expect(normalizePriceText('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizePriceText('0,000')).toEqual({ ok: false, reason: 'non_positive' });
  });
});

describe('parseAndValidateFuentePayload', () => {
  it('acepta respuesta válida', () => {
    const parsed = parseAndValidateFuentePayload(payload([station(), station({ IDEESS: '1002' })]));
    expect(parsed.stations).toHaveLength(2);
    expect(parsed.prices.some((p) => p.priceText === '1.599')).toBe(true);
    expect(parsed.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rechaza fuente inválida o incompleta', () => {
    expect(() => parseAndValidateFuentePayload('')).toThrow(/vacío|inválido/i);
    expect(() => parseAndValidateFuentePayload('{')).toThrow(/JSON inválido/);
    expect(() =>
      parseAndValidateFuentePayload({ ResultadoConsulta: 'ERROR', ListaEESSPrecio: [] }),
    ).toThrow(/ResultadoConsulta/);
    expect(() =>
      parseAndValidateFuentePayload({
        ResultadoConsulta: 'OK',
        Fecha: '27/08/2026 12:00:00',
        ListaEESSPrecio: [],
      }),
    ).toThrow(/vacía/);
  });
});

describe('partición y borde', () => {
  it('asigna celdas estables', () => {
    const a = cellForLatLon(40.4168, -3.7038);
    const b = cellForLatLon(40.4168, -3.7038);
    expect(a.id).toBe(b.id);
  });

  it('consulta en el borde de dos particiones incluye ambas celdas', () => {
    const south = cellForLatLon(39.999, -3.7);
    const north = cellForLatLon(40.001, -3.7);
    expect(south.id).not.toBe(north.id);

    const nearby = cellsForNearbySearch(40.0, -3.7, 5);
    expect(nearby).toContain(south.id);
    expect(nearby).toContain(north.id);
    expect(neighboringCellIds(south.id)).toContain(north.id);
  });
});

describe('generación determinista', () => {
  it('mismo contenido → mismos hashes de celdas (ignorando reloj)', () => {
    const parsed = parseAndValidateFuentePayload(
      payload([
        station(),
        station({ IDEESS: '1002', Latitud: '41,000000', 'Longitud (WGS84)': '2,000000' }),
      ]),
    );
    const a = generatePartitionedDataset(parsed, { downloadedAt: '2026-08-27T10:00:00.000Z' });
    const b = generatePartitionedDataset(parsed, { downloadedAt: '2026-08-27T11:00:00.000Z' });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.datasetVersion).toBe(b.datasetVersion);
    expect(stripClockFields(a.manifest)).toEqual(stripClockFields(b.manifest));
    for (const [rel, body] of a.files) {
      if (rel === 'manifest.json' || rel === 'current.json') continue;
      if (rel.endsWith('/manifest.json')) continue;
      if (rel.endsWith('/municipality-cells.json')) {
        const left = JSON.parse(body) as Record<string, unknown>;
        const right = JSON.parse(b.files.get(rel)!) as Record<string, unknown>;
        delete left.generatedAt;
        delete right.generatedAt;
        expect(left).toEqual(right);
        continue;
      }
      expect(b.files.get(rel)).toBe(body);
    }
  });
});

describe('pipeline local', () => {
  it('publica descarga válida y mantiene coherencia manifiesto/celdas', () => {
    const out = tmpOut();
    const result = runPipeline({
      runId: 'r1',
      outRoot: out,
      payload: payload(manyStations(5)),
      downloadedAt: '2026-08-27T12:00:00.000Z',
      startedAt: '2026-08-27T12:00:01.000Z',
      config: testConfig,
    });
    expect(result.outcome).toBe('published');
    expect(result.needsDeploy).toBe(true);
    const store = createStorePaths(out);
    expect(assertPublishedTreeCoherent(store.liveDir)).toEqual({ ok: true });
    const m = readLiveManifest(store.liveDir);
    expect(m?.stationCount).toBe(5);
    expect(m?.downloadedAt).toBe('2026-08-27T12:00:00.000Z');
    expect(m?.lastSuccessfulFetchAt).toBe('2026-08-27T12:00:00.000Z');
    expect(m?.publishedAt).toBeTruthy();
    expect(m?.publishedAt).not.toBe(m?.downloadedAt);
    expect(fs.existsSync(path.join(store.liveDir, '_headers'))).toBe(true);
    expect(readSyncState(store.liveDir)?.datasetVersion).toBe(m?.datasetVersion);
  });

  it('rechaza fuente incompleta y conserva activa', () => {
    const out = tmpOut();
    const first = runPipeline({
      runId: 'r1',
      outRoot: out,
      payload: payload(manyStations(10)),
      downloadedAt: '2026-08-27T12:00:00.000Z',
      startedAt: '2026-08-27T12:00:01.000Z',
      config: testConfig,
    });
    expect(first.outcome).toBe('published');
    const activeBefore = readLiveManifest(createStorePaths(out).liveDir)?.datasetVersion;

    const bad = runPipeline({
      runId: 'r2',
      outRoot: out,
      payload: payload(manyStations(2)),
      downloadedAt: '2026-08-27T12:30:00.000Z',
      startedAt: '2026-08-27T12:30:01.000Z',
      config: testConfig,
    });
    expect(bad.outcome).toBe('failed_validation');
    expect(readLiveManifest(createStorePaths(out).liveDir)?.datasetVersion).toBe(activeBefore);
  });

  it('1) respuesta nacional pequeña/incompleta rechazada en producción', () => {
    const out = tmpOut();
    const result = runPipeline({
      runId: 'prod-small',
      outRoot: out,
      payload: payload(manyStations(50)),
      downloadedAt: '2026-08-27T12:00:00.000Z',
      startedAt: '2026-08-27T12:00:01.000Z',
      config: { ...productionLike, allowEmptyPublish: true },
    });
    expect(result.outcome).toBe('failed_validation');
    expect(result.detail).toMatch(/mínimo absoluto/);
    expect(result.needsDeploy).toBe(false);
    expect(fs.existsSync(createStorePaths(out).liveDir)).toBe(false);
  });

  it('2) primer arranque solo con allowEmptyPublish explícito', () => {
    const outRefuse = tmpOut();
    const refused = runPipeline({
      runId: 'boot-refuse',
      outRoot: outRefuse,
      payload: payload(manyStations(5)),
      downloadedAt: '2026-08-27T12:00:00.000Z',
      startedAt: '2026-08-27T12:00:01.000Z',
      config: { ...testConfig, allowEmptyPublish: false },
    });
    expect(refused.outcome).toBe('refused_empty_bootstrap');
    expect(refused.needsDeploy).toBe(false);

    const outOk = tmpOut();
    const ok = runPipeline({
      runId: 'boot-ok',
      outRoot: outOk,
      payload: payload(manyStations(5)),
      downloadedAt: '2026-08-27T12:00:00.000Z',
      startedAt: '2026-08-27T12:00:01.000Z',
      config: { ...testConfig, allowEmptyPublish: true },
    });
    expect(ok.outcome).toBe('published');
  });

  it('3) fallo al recuperar estado previo: no publicar', async () => {
    const out = tmpOut();
    const recovered = await recoverPublishedState({
      publicBaseUrl: 'http://127.0.0.1:1',
      outRoot: out,
      timeoutMs: 500,
      allowHttpLocal: true,
    });
    expect(recovered.ok).toBe(false);
    if (recovered.ok) throw new Error('expected failure');
    expect(['network', 'http_unexpected']).toContain(recovered.code);

    const published = runPipeline({
      runId: 'after-fail-recover',
      outRoot: out,
      payload: payload(manyStations(5)),
      downloadedAt: '2026-08-27T12:00:00.000Z',
      startedAt: '2026-08-27T12:00:01.000Z',
      config: { ...testConfig, allowEmptyPublish: false },
    });
    expect(published.outcome).toBe('refused_empty_bootstrap');
    expect(fs.existsSync(path.join(createStorePaths(out).liveDir, 'manifest.json'))).toBe(false);
  });

  it('4) dos runners independientes con datos iguales', async () => {
    const runnerA = tmpOut();
    const runnerB = tmpOut();
    const p = payload(manyStations(5, '1,500'));

    expect(
      runPipeline({
        runId: 'a1',
        outRoot: runnerA,
        payload: p,
        downloadedAt: '2026-08-27T12:00:00.000Z',
        startedAt: '2026-08-27T12:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');

    const liveA = createStorePaths(runnerA).liveDir;
    const { baseUrl, close } = await serveDir(liveA);
    const recovered = await recoverPublishedState({
      publicBaseUrl: baseUrl,
      outRoot: runnerB,
      allowHttpLocal: true,
    });
    expect(recovered.ok).toBe(true);
    await close();

    const same = runPipeline({
      runId: 'b1',
      outRoot: runnerB,
      payload: p,
      downloadedAt: '2026-08-27T12:30:00.000Z',
      startedAt: '2026-08-27T12:30:01.000Z',
      config: { ...testConfig, allowEmptyPublish: false },
    });
    expect(same.outcome).toBe('synced_unchanged');
    expect(same.needsDeploy).toBe(true);
    expect(readLiveManifest(createStorePaths(runnerB).liveDir)?.datasetVersion).toBe(
      readLiveManifest(liveA)?.datasetVersion,
    );
  });

  it('5) dos runners independientes con cambio de precio y retención', async () => {
    const runnerA = tmpOut();
    const runnerB = tmpOut();

    expect(
      runPipeline({
        runId: 'a1',
        outRoot: runnerA,
        payload: payload(manyStations(5, '1,500')),
        downloadedAt: '2026-08-27T12:00:00.000Z',
        startedAt: '2026-08-27T12:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');
    const v1 = readLiveManifest(createStorePaths(runnerA).liveDir)?.datasetVersion;
    expect(v1).toBeTruthy();

    const { baseUrl, close } = await serveDir(createStorePaths(runnerA).liveDir);
    expect(
      (
        await recoverPublishedState({
          publicBaseUrl: baseUrl,
          outRoot: runnerB,
          allowHttpLocal: true,
        })
      ).ok,
    ).toBe(true);
    await close();

    const changed = runPipeline({
      runId: 'b1',
      outRoot: runnerB,
      payload: payload(manyStations(5, '1,510')),
      downloadedAt: '2026-08-27T12:30:00.000Z',
      startedAt: '2026-08-27T12:30:01.000Z',
      config: { ...testConfig, allowEmptyPublish: false },
    });
    expect(changed.outcome).toBe('published');
    const liveB = createStorePaths(runnerB).liveDir;
    const v2 = readLiveManifest(liveB)?.datasetVersion;
    expect(v2).not.toBe(v1);
    expect(fs.existsSync(path.join(liveB, 'v', v1!))).toBe(true);
    expect(readSyncState(liveB)?.retainedVersions).toContain(v1);
  });

  it('6) fuente más antigua rechazada', () => {
    const out = tmpOut();
    expect(
      runPipeline({
        runId: 'r1',
        outRoot: out,
        payload: payload(manyStations(5, '1,500'), '27/08/2026 14:00:00'),
        downloadedAt: '2026-08-27T14:00:00.000Z',
        startedAt: '2026-08-27T14:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');

    const stale = runPipeline({
      runId: 'r2',
      outRoot: out,
      payload: payload(manyStations(5, '1,999'), '27/08/2026 12:00:00'),
      downloadedAt: '2026-08-27T14:05:00.000Z',
      startedAt: '2026-08-27T14:05:01.000Z',
      config: testConfig,
    });
    expect(stale.outcome).toBe('abandoned_stale');
    expect(stale.needsDeploy).toBe(false);
  });

  it('7) consulta correcta sin cambios: frescura sin mutar inmutables', () => {
    const out = tmpOut();
    const p = payload(manyStations(5));
    expect(
      runPipeline({
        runId: 'r1',
        outRoot: out,
        payload: p,
        downloadedAt: '2026-08-27T12:00:00.000Z',
        startedAt: '2026-08-27T12:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');

    const live = createStorePaths(out).liveDir;
    const version = readLiveManifest(live)!.datasetVersion;
    const before = snapshotImmutable(live, version);
    const contentPublishedAt = readSyncState(live)!.contentPublishedAt;
    const contentSourceFecha = readSyncState(live)!.sourceFecha;

    const sync = runPipeline({
      runId: 'r2',
      outRoot: out,
      payload: p,
      downloadedAt: '2026-08-27T12:30:00.000Z',
      startedAt: '2026-08-27T12:30:01.000Z',
      config: testConfig,
    });
    expect(sync.outcome).toBe('synced_unchanged');
    expect(sync.needsDeploy).toBe(true);
    expect(sync.metrics.stationCount).toBe(5);
    expect(sync.metrics.priceCount).toBeGreaterThan(0);

    const after = snapshotImmutable(live, version);
    expect(after).toEqual(before);
    expect(readSyncState(live)?.lastSuccessfulFetchAt).toBe('2026-08-27T12:30:00.000Z');
    expect(readSyncState(live)?.contentPublishedAt).toBe(contentPublishedAt);
    expect(readSyncState(live)?.sourceFecha).toBe(contentSourceFecha);
    expect(readSyncState(live)?.lastObservedSourceFecha).toBe(contentSourceFecha);
    expect(readLiveManifest(live)?.lastSuccessfulFetchAt).toBe('2026-08-27T12:30:00.000Z');
  });

  it('8) manifiesto o partición corruptos: no publicar', async () => {
    const publisher = tmpOut();
    expect(
      runPipeline({
        runId: 'r1',
        outRoot: publisher,
        payload: payload(manyStations(5)),
        downloadedAt: '2026-08-27T12:00:00.000Z',
        startedAt: '2026-08-27T12:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');

    const live = createStorePaths(publisher).liveDir;
    const m = readLiveManifest(live)!;
    const cellPath = path.join(live, m.cells[0]!.path);
    fs.writeFileSync(cellPath, '{"corrupt":true}\n', 'utf8');
    expect(assertManifestCoherent(live).ok).toBe(false);

    const runner = tmpOut();
    const { baseUrl, close } = await serveDir(live);
    const recovered = await recoverPublishedState({
      publicBaseUrl: baseUrl,
      outRoot: runner,
      allowHttpLocal: true,
    });
    await close();
    expect(recovered.ok).toBe(false);
    if (recovered.ok) throw new Error('expected hash failure');
    expect(recovered.code).toBe('hash_mismatch');

    const refused = runPipeline({
      runId: 'no-publish',
      outRoot: runner,
      payload: payload(manyStations(5, '1,777')),
      downloadedAt: '2026-08-27T13:00:00.000Z',
      startedAt: '2026-08-27T13:00:01.000Z',
      config: { ...testConfig, allowEmptyPublish: false },
    });
    expect(refused.outcome).toBe('refused_empty_bootstrap');
  });

  it('fallo de publicación simulado conserva versión válida', () => {
    const out = tmpOut();
    expect(
      runPipeline({
        runId: 'r1',
        outRoot: out,
        payload: payload(manyStations(5, '1,500')),
        downloadedAt: '2026-08-27T12:00:00.000Z',
        startedAt: '2026-08-27T12:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');
    const before = readLiveManifest(createStorePaths(out).liveDir);

    const fail = runPipeline({
      runId: 'r2',
      outRoot: out,
      payload: payload(manyStations(5, '1,999')),
      downloadedAt: '2026-08-27T12:30:00.000Z',
      startedAt: '2026-08-27T12:30:01.000Z',
      config: testConfig,
      failPublish: true,
    });
    expect(fail.outcome).toBe('failed_publish');
    const after = readLiveManifest(createStorePaths(out).liveDir);
    expect(after?.contentHash).toBe(before?.contentHash);
    expect(after?.datasetVersion).toBe(before?.datasetVersion);
  });

  it('concurrencia: segundo run abandona si hay lease', () => {
    const out = tmpOut();
    const store = createStorePaths(out);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      store.lockPath,
      `${JSON.stringify({ runId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })}\n`,
    );
    const r = runPipeline({
      runId: 'r1',
      outRoot: out,
      payload: payload(manyStations(5)),
      downloadedAt: '2026-08-27T12:00:00.000Z',
      startedAt: '2026-08-27T12:00:01.000Z',
      config: testConfig,
    });
    expect(r.outcome).toBe('abandoned_concurrent');
  });

  it('detecta stale por edad del manifiesto (sin depender del workflow)', () => {
    expect(isManifestStale('2026-08-27T10:00:00.000Z', 90, Date.parse('2026-08-27T12:00:00.000Z'))).toBe(
      true,
    );
    expect(isManifestStale('2026-08-27T11:00:00.000Z', 90, Date.parse('2026-08-27T12:00:00.000Z'))).toBe(
      false,
    );
  });
});

describe('parseFuenteFechaToEpoch (Europe/Madrid)', () => {
  it('parsea Fecha y ordena por instante, no por lexicografía dd/mm', () => {
    const jan2 = parseFuenteFechaToEpoch('02/01/2026 12:00:00');
    const feb1 = parseFuenteFechaToEpoch('01/02/2026 12:00:00');
    expect(jan2).not.toBeNull();
    expect(feb1).not.toBeNull();
    expect(feb1!).toBeGreaterThan(jan2!);
    // Lexicográficamente "01/02..." < "02/01..."; cronológicamente es al revés.
    expect('01/02/2026 12:00:00' < '02/01/2026 12:00:00').toBe(true);
  });

  it('acepta hora sin cero (formato real de la API tras medianoche)', () => {
    const unpadded = parseFuenteFechaToEpoch('28/08/2026 1:04:32');
    const padded = parseFuenteFechaToEpoch('28/08/2026 01:04:32');
    expect(unpadded).not.toBeNull();
    expect(padded).not.toBeNull();
    expect(unpadded).toBe(padded);
    expect(new Date(unpadded!).toISOString()).toBe('2026-08-27T23:04:32.000Z');
    const midnight = parseFuenteFechaToEpoch('28/08/2026 0:59:00');
    expect(midnight).not.toBeNull();
    expect(new Date(midnight!).toISOString()).toBe('2026-08-27T22:59:00.000Z');
  });

  it('rechaza formato inválido y componentes fuera de rango', () => {
    expect(parseFuenteFechaToEpoch('2026-08-27T12:00:00')).toBeNull();
    expect(parseFuenteFechaToEpoch('27-08-2026 12:00:00')).toBeNull();
    expect(parseFuenteFechaToEpoch('32/08/2026 1:00:00')).toBeNull();
    expect(parseFuenteFechaToEpoch('28/13/2026 1:00:00')).toBeNull();
    expect(parseFuenteFechaToEpoch('28/08/2026 24:00:00')).toBeNull();
    expect(parseFuenteFechaToEpoch('28/08/2026 1:60:00')).toBeNull();
  });
});

describe('cambio de día Madrid: hora sin pad no es retroceso', () => {
  it('Fecha posterior con hora 1 dígito no produce abandoned_stale', () => {
    const out = tmpOut();
    expect(
      runPipeline({
        runId: 'r1',
        outRoot: out,
        payload: payload(manyStations(5, '1,500'), '27/08/2026 20:56:28'),
        downloadedAt: '2026-08-27T18:56:50.773Z',
        startedAt: '2026-08-27T18:56:51.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');

    const next = runPipeline({
      runId: 'r2',
      outRoot: out,
      payload: payload(manyStations(5, '1,510'), '28/08/2026 1:00:07'),
      downloadedAt: '2026-08-27T23:00:07.000Z',
      startedAt: '2026-08-27T23:00:08.000Z',
      config: testConfig,
    });
    expect(next.outcome).not.toBe('abandoned_stale');
    expect(next.outcome).not.toBe('failed_validation');
    expect(['published', 'synced_unchanged']).toContain(next.outcome);
  });
});

describe('frescura con Fecha distinta y mismo contentHash', () => {
  it('mismo contenido y fecha posterior: sincroniza frescura', () => {
    const out = tmpOut();
    const stations = manyStations(5, '1,500');
    expect(
      runPipeline({
        runId: 'r1',
        outRoot: out,
        payload: payload(stations, '27/08/2026 16:54:39'),
        downloadedAt: '2026-08-27T14:54:44.119Z',
        startedAt: '2026-08-27T14:54:45.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');

    const live = createStorePaths(out).liveDir;
    const version = readLiveManifest(live)!.datasetVersion;
    const before = snapshotImmutable(live, version);
    const contentPublishedAt = readSyncState(live)!.contentPublishedAt;
    const contentSourceFecha = '27/08/2026 16:54:39';

    const sync = runPipeline({
      runId: 'r2',
      outRoot: out,
      payload: payload(stations, '27/08/2026 17:00:40'),
      downloadedAt: '2026-08-27T15:01:00.000Z',
      startedAt: '2026-08-27T15:01:01.000Z',
      config: testConfig,
    });
    expect(sync.outcome).toBe('synced_unchanged');
    expect(sync.needsDeploy).toBe(true);
    expect(sync.datasetVersion).toBe(version);
    expect(sync.metrics.stationCount).toBe(5);
    expect(sync.metrics.priceCount).toBeGreaterThan(0);

    expect(snapshotImmutable(live, version)).toEqual(before);
    const state = readSyncState(live)!;
    expect(state.sourceFecha).toBe(contentSourceFecha);
    expect(state.lastObservedSourceFecha).toBe('27/08/2026 17:00:40');
    expect(state.lastSuccessfulFetchAt).toBe('2026-08-27T15:01:00.000Z');
    expect(state.contentPublishedAt).toBe(contentPublishedAt);
    expect(readLiveManifest(live)?.sourceFecha).toBe(contentSourceFecha);
    const current = JSON.parse(fs.readFileSync(path.join(live, 'current.json'), 'utf8')) as {
      sourceFecha: string;
    };
    expect(current.sourceFecha).toBe(contentSourceFecha);
  });

  it('mismo contenido y fecha anterior: rechazada sin mutación', () => {
    const out = tmpOut();
    const stations = manyStations(5, '1,500');
    expect(
      runPipeline({
        runId: 'r1',
        outRoot: out,
        payload: payload(stations, '27/08/2026 17:00:40'),
        downloadedAt: '2026-08-27T15:00:00.000Z',
        startedAt: '2026-08-27T15:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');

    const live = createStorePaths(out).liveDir;
    const version = readLiveManifest(live)!.datasetVersion;
    const beforeImm = snapshotImmutable(live, version);
    const beforeSync = fs.readFileSync(path.join(live, 'sync.json'), 'utf8');
    const beforeManifest = fs.readFileSync(path.join(live, 'manifest.json'), 'utf8');

    const stale = runPipeline({
      runId: 'r2',
      outRoot: out,
      payload: payload(stations, '27/08/2026 16:54:39'),
      downloadedAt: '2026-08-27T15:05:00.000Z',
      startedAt: '2026-08-27T15:05:01.000Z',
      config: testConfig,
    });
    expect(stale.outcome).toBe('abandoned_stale');
    expect(stale.needsDeploy).toBe(false);
    expect(snapshotImmutable(live, version)).toEqual(beforeImm);
    expect(fs.readFileSync(path.join(live, 'sync.json'), 'utf8')).toBe(beforeSync);
    expect(fs.readFileSync(path.join(live, 'manifest.json'), 'utf8')).toBe(beforeManifest);
  });

  it('contenido distinto con fecha anterior a lastObservedSourceFecha: rechazado', () => {
    const out = tmpOut();
    expect(
      runPipeline({
        runId: 'r1',
        outRoot: out,
        payload: payload(manyStations(5, '1,500'), '27/08/2026 17:00:40'),
        downloadedAt: '2026-08-27T15:00:00.000Z',
        startedAt: '2026-08-27T15:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');
    const live = createStorePaths(out).liveDir;
    const v1 = readLiveManifest(live)!.datasetVersion;

    // Avanza lastObserved sin cambiar precios.
    expect(
      runPipeline({
        runId: 'r2',
        outRoot: out,
        payload: payload(manyStations(5, '1,500'), '27/08/2026 17:30:00'),
        downloadedAt: '2026-08-27T15:30:00.000Z',
        startedAt: '2026-08-27T15:30:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('synced_unchanged');
    expect(readSyncState(live)?.lastObservedSourceFecha).toBe('27/08/2026 17:30:00');

    const staleChange = runPipeline({
      runId: 'r3',
      outRoot: out,
      payload: payload(manyStations(5, '1,999'), '27/08/2026 17:10:00'),
      downloadedAt: '2026-08-27T15:35:00.000Z',
      startedAt: '2026-08-27T15:35:01.000Z',
      config: testConfig,
    });
    expect(staleChange.outcome).toBe('abandoned_stale');
    expect(readLiveManifest(live)?.datasetVersion).toBe(v1);
  });

  it('no usa orden lexicográfico dd/mm al decidir stale', () => {
    const out = tmpOut();
    // 2 de enero publicado; 1 de febrero (lexicográficamente "menor") debe aceptarse.
    expect(
      runPipeline({
        runId: 'r1',
        outRoot: out,
        payload: payload(manyStations(5, '1,500'), '02/01/2026 12:00:00'),
        downloadedAt: '2026-01-02T11:00:00.000Z',
        startedAt: '2026-01-02T11:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');

    const later = runPipeline({
      runId: 'r2',
      outRoot: out,
      payload: payload(manyStations(5, '1,510'), '01/02/2026 12:00:00'),
      downloadedAt: '2026-02-01T11:00:00.000Z',
      startedAt: '2026-02-01T11:00:01.000Z',
      config: testConfig,
    });
    expect(later.outcome).toBe('published');
  });
});

describe('recover sync legacy y formato nuevo', () => {
  it('recover del formato publicado sin lastObservedSourceFecha y actualización al nuevo', async () => {
    const publisher = tmpOut();
    expect(
      runPipeline({
        runId: 'pub',
        outRoot: publisher,
        payload: payload(manyStations(5, '1,500'), '27/08/2026 16:54:39'),
        downloadedAt: '2026-08-27T14:54:44.119Z',
        startedAt: '2026-08-27T14:54:45.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');

    const livePub = createStorePaths(publisher).liveDir;
    const versionedBefore = snapshotImmutable(livePub, readLiveManifest(livePub)!.datasetVersion);

    // Simula sync ya publicado (sin el campo nuevo).
    const legacySync = JSON.parse(fs.readFileSync(path.join(livePub, 'sync.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    delete legacySync.lastObservedSourceFecha;
    expect(legacySync.lastObservedSourceFecha).toBeUndefined();
    fs.writeFileSync(path.join(livePub, 'sync.json'), `${JSON.stringify(legacySync)}\n`, 'utf8');

    const runner = tmpOut();
    const { baseUrl, close } = await serveDir(livePub);
    const recovered = await recoverPublishedState({
      publicBaseUrl: baseUrl,
      outRoot: runner,
      allowHttpLocal: true,
    });
    await close();
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.reason);

    const liveRunner = createStorePaths(runner).liveDir;
    const adapted = readSyncState(liveRunner)!;
    expect(adapted.lastObservedSourceFecha).toBe('27/08/2026 16:54:39');
    expect(adapted.sourceFecha).toBe('27/08/2026 16:54:39');
    expect(assertPublishedTreeCoherent(liveRunner)).toEqual({ ok: true });
    // Adaptación no toca versionados del origen (servidos intactos) ni del runner.
    expect(snapshotImmutable(liveRunner, adapted.datasetVersion)).toEqual(versionedBefore);

    const syncLater = runPipeline({
      runId: 'after-recover',
      outRoot: runner,
      payload: payload(manyStations(5, '1,500'), '27/08/2026 17:00:40'),
      downloadedAt: '2026-08-27T15:01:00.000Z',
      startedAt: '2026-08-27T15:01:01.000Z',
      config: { ...testConfig, allowEmptyPublish: false },
    });
    expect(syncLater.outcome).toBe('synced_unchanged');
    expect(readSyncState(liveRunner)?.lastObservedSourceFecha).toBe('27/08/2026 17:00:40');
    expect(snapshotImmutable(liveRunner, adapted.datasetVersion)).toEqual(versionedBefore);
  });

  it('recuperación posterior del nuevo formato', async () => {
    const publisher = tmpOut();
    const stations = manyStations(5, '1,500');
    expect(
      runPipeline({
        runId: 'pub',
        outRoot: publisher,
        payload: payload(stations, '27/08/2026 16:54:39'),
        downloadedAt: '2026-08-27T14:54:44.119Z',
        startedAt: '2026-08-27T14:54:45.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');
    expect(
      runPipeline({
        runId: 'freshen',
        outRoot: publisher,
        payload: payload(stations, '27/08/2026 17:00:40'),
        downloadedAt: '2026-08-27T15:01:00.000Z',
        startedAt: '2026-08-27T15:01:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('synced_unchanged');

    const livePub = createStorePaths(publisher).liveDir;
    expect(readSyncState(livePub)?.lastObservedSourceFecha).toBe('27/08/2026 17:00:40');

    const runner = tmpOut();
    const { baseUrl, close } = await serveDir(livePub);
    const recovered = await recoverPublishedState({
      publicBaseUrl: baseUrl,
      outRoot: runner,
      allowHttpLocal: true,
    });
    await close();
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.reason);
    const sync = readSyncState(createStorePaths(runner).liveDir)!;
    expect(sync.lastObservedSourceFecha).toBe('27/08/2026 17:00:40');
    expect(sync.sourceFecha).toBe('27/08/2026 16:54:39');
  });
});

describe('recoverPublishedState seguridad', () => {
  async function publishFixture(): Promise<{ liveDir: string; outRoot: string }> {
    const outRoot = tmpOut();
    expect(
      runPipeline({
        runId: 'pub',
        outRoot,
        payload: payload(manyStations(5)),
        downloadedAt: '2026-08-27T12:00:00.000Z',
        startedAt: '2026-08-27T12:00:01.000Z',
        config: testConfig,
      }).outcome,
    ).toBe('published');
    return { liveDir: createStorePaths(outRoot).liveDir, outRoot };
  }

  it('rechaza traversal y rutas externas sin escribir fuera de staging', async () => {
    expect(isSafeRelativeAssetPath('../etc/passwd')).toBe(false);
    expect(isSafeRelativeAssetPath('v/abc/../../../tmp/x')).toBe(false);
    expect(isSafeRelativeAssetPath('https://evil.example/a.json')).toBe(false);
    expect(isSafeRelativeAssetPath('v/0123456789abcdef/cells/10_-8.json')).toBe(true);

    const staging = tmpOut();
    const outsideProbe = path.join(path.dirname(staging), 'outside-should-not-exist.txt');
    fs.rmSync(outsideProbe, { force: true });
    expect(assertSafeStagingPath(staging, '../outside-should-not-exist.txt').ok).toBe(false);
    expect(fs.existsSync(outsideProbe)).toBe(false);

    const { liveDir } = await publishFixture();
    const current = JSON.parse(fs.readFileSync(path.join(liveDir, 'current.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    current.manifestPath = '../evil/manifest.json';
    fs.writeFileSync(path.join(liveDir, 'current.json'), `${JSON.stringify(current)}\n`, 'utf8');

    const runner = tmpOut();
    const markerOutside = path.join(runner, '..', `escape-${Date.now()}.txt`);
    const { baseUrl, close } = await serveDir(liveDir);
    const recovered = await recoverPublishedState({
      publicBaseUrl: baseUrl,
      outRoot: runner,
      allowHttpLocal: true,
    });
    await close();
    expect(recovered.ok).toBe(false);
    if (recovered.ok) throw new Error('expected reject');
    expect(recovered.code).toBe('schema');
    expect(fs.existsSync(markerOutside)).toBe(false);
    expect(fs.existsSync(path.join(createStorePaths(runner).liveDir, 'manifest.json'))).toBe(false);
  });

  it('rechaza versiones o hashes incoherentes', async () => {
    const { liveDir } = await publishFixture();
    const sync = JSON.parse(fs.readFileSync(path.join(liveDir, 'sync.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    sync.contentHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    sync.datasetVersion = 'ffffffffffffffff';
    fs.writeFileSync(path.join(liveDir, 'sync.json'), `${JSON.stringify(sync)}\n`, 'utf8');

    const runner = tmpOut();
    const { baseUrl, close } = await serveDir(liveDir);
    const recovered = await recoverPublishedState({
      publicBaseUrl: baseUrl,
      outRoot: runner,
      allowHttpLocal: true,
    });
    await close();
    expect(recovered.ok).toBe(false);
    if (recovered.ok) throw new Error('expected reject');
    expect(recovered.code).toBe('incoherent');
  });

  it('sync.json ausente bloquea recuperación', async () => {
    const { liveDir } = await publishFixture();
    fs.rmSync(path.join(liveDir, 'sync.json'), { force: true });

    const runner = tmpOut();
    const { baseUrl, close } = await serveDir(liveDir);
    const recovered = await recoverPublishedState({
      publicBaseUrl: baseUrl,
      outRoot: runner,
      allowHttpLocal: true,
    });
    await close();
    expect(recovered.ok).toBe(false);
    if (recovered.ok) throw new Error('expected reject');
    expect(recovered.code).toBe('incomplete');
    expect(recovered.reason).toMatch(/sync\.json ausente/i);
  });

  it('cuerpo de respuesta lento agota el timeout', async () => {
    const { liveDir } = await publishFixture();
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
      const rel = urlPath.replace(/^\/+/, '');
      if (rel === 'current.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        // Empieza la respuesta y nunca termina el cuerpo a tiempo.
        res.write('{');
        return;
      }
      const abs = path.join(liveDir, rel);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fs.readFileSync(abs));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const runner = tmpOut();
    const recovered = await recoverPublishedState({
      publicBaseUrl: baseUrl,
      outRoot: runner,
      allowHttpLocal: true,
      timeoutMs: 200,
      totalTimeoutMs: 400,
    });
    expect(recovered.ok).toBe(false);
    if (recovered.ok) throw new Error('expected timeout');
    expect(recovered.code).toBe('timeout');
  });

  it('recuperación válida entre runners independientes sigue funcionando', async () => {
    const { liveDir } = await publishFixture();
    const runner = tmpOut();
    const { baseUrl, close } = await serveDir(liveDir);
    const recovered = await recoverPublishedState({
      publicBaseUrl: baseUrl,
      outRoot: runner,
      allowHttpLocal: true,
    });
    await close();
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.reason);
    expect(assertPublishedTreeCoherent(createStorePaths(runner).liveDir)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(createStorePaths(runner).liveDir, '_headers'))).toBe(true);
    expect(readSyncState(createStorePaths(runner).liveDir)?.datasetVersion).toBe(
      recovered.manifest.datasetVersion,
    );
  });
});
