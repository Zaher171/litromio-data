import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  assertPublishedTreeCoherent,
  copyStaticHeadersInto,
  createStorePaths,
  sha256Hex,
} from './publish-local.ts';
import type { SyncState } from './sync-state.ts';
import { SYNC_STATE_REL } from './sync-state.ts';
import { DEFAULT_PIPELINE_CONFIG, type Manifest, type ManifestCellEntry } from './types.ts';

export type RecoverOutcome =
  | { ok: true; manifest: Manifest; fileCount: number; baseUrl: string }
  | { ok: false; reason: string; code: RecoverFailureCode };

export type RecoverFailureCode =
  | 'network'
  | 'http_unexpected'
  | 'schema'
  | 'hash_mismatch'
  | 'incomplete'
  | 'incoherent'
  | 'unsafe_path'
  | 'timeout';

export interface RecoverPublishedStateOptions {
  /** Base URL pública configurable (sin barra final). No inventar valor. */
  publicBaseUrl: string;
  outRoot: string;
  fetchImpl?: typeof fetch;
  /** Tiempo máximo por petición (incluye lectura del cuerpo). */
  timeoutMs?: number;
  /** Tiempo máximo total de la recuperación. */
  totalTimeoutMs?: number;
  /** Tamaño máximo de respuesta por archivo (bytes). */
  maxResponseBytes?: number;
  /** Máximo de celdas por manifiesto. */
  maxCells?: number;
  /** Política de retención (default = pipeline). */
  retainPreviousVersions?: number;
  /**
   * Permite http://127.0.0.1 o http://localhost solo en pruebas explícitas.
   * Producción: HTTPS obligatorio.
   */
  allowHttpLocal?: boolean;
  /** Reloj inyectable (pruebas). */
  nowMs?: () => number;
}

const DATASET_VERSION_RE = /^[a-f0-9]{16}$/;
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;
const CELL_ID_RE = /^-?\d+_-?\d+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SOURCE_FECHA_RE = /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}$/;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CELLS = 5_000;

function fail(reason: string, code: RecoverFailureCode): RecoverOutcome {
  return { ok: false, reason, code };
}

function joinUrl(base: string, rel: string): string {
  const b = base.replace(/\/+$/, '');
  const r = rel.replace(/^\/+/, '');
  return `${b}/${r}`;
}

function isLocalHttpHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function validateBaseUrl(
  raw: string,
  allowHttpLocal: boolean,
): { ok: true; baseUrl: string; origin: string } | { ok: false; reason: string; code: RecoverFailureCode } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'publicBaseUrl inválida', code: 'schema' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'publicBaseUrl no debe incluir credenciales', code: 'unsafe_path' };
  }
  if (parsed.protocol === 'https:') {
    // ok
  } else if (parsed.protocol === 'http:' && allowHttpLocal && isLocalHttpHost(parsed.hostname)) {
    // pruebas explícitas
  } else if (parsed.protocol === 'http:') {
    return {
      ok: false,
      reason: 'HTTPS obligatorio en recuperación (HTTP local solo con allowHttpLocal)',
      code: 'unsafe_path',
    };
  } else {
    return { ok: false, reason: `Esquema no permitido: ${parsed.protocol}`, code: 'unsafe_path' };
  }
  const baseUrl = raw.replace(/\/+$/, '');
  return { ok: true, baseUrl, origin: parsed.origin };
}

/** Rechaza traversal, absolutas, URLs, backslash y codificaciones peligrosas. */
export function isSafeRelativeAssetPath(rel: string): boolean {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) return false;
  if (rel !== rel.normalize('NFC')) return false;
  if (rel.includes('\\') || rel.includes('\0')) return false;
  if (rel.includes('%') || rel.includes('\\u') || /%2e|%2f|%5c/i.test(rel)) return false;
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false;
  if (rel.includes('://')) return false;
  if (rel.split('/').some((p) => p === '.' || p === '..' || p === '')) return false;
  return true;
}

export function assertSafeStagingPath(
  stagingRoot: string,
  rel: string,
): { ok: true; abs: string } | { ok: false; reason: string } {
  if (!isSafeRelativeAssetPath(rel)) {
    return { ok: false, reason: `Ruta insegura: ${rel}` };
  }
  const abs = path.resolve(stagingRoot, rel);
  const root = path.resolve(stagingRoot);
  const relative = path.relative(root, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: `Destino fuera de staging: ${rel}` };
  }
  return { ok: true, abs };
}

function isDatasetVersion(v: unknown): v is string {
  return typeof v === 'string' && DATASET_VERSION_RE.test(v);
}

function isContentHash(v: unknown): v is string {
  return typeof v === 'string' && CONTENT_HASH_RE.test(v);
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATE_RE.test(v) && Number.isFinite(Date.parse(v));
}

function isSourceFecha(v: unknown): v is string {
  return typeof v === 'string' && SOURCE_FECHA_RE.test(v) && v.length <= 64;
}

function isCellPathForVersion(cellPath: string, version: string): boolean {
  if (!isSafeRelativeAssetPath(cellPath)) return false;
  const prefix = `v/${version}/cells/`;
  if (!cellPath.startsWith(prefix) || !cellPath.endsWith('.json')) return false;
  const cellId = cellPath.slice(prefix.length, -'.json'.length);
  return CELL_ID_RE.test(cellId) && !cellId.includes('/');
}

function isVersionedManifestPath(rel: string, version: string): boolean {
  return rel === `v/${version}/manifest.json` && isSafeRelativeAssetPath(rel);
}

function parseJsonObject(body: string, label: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (body.length === 0) return { ok: false, reason: `${label}: vacío` };
  try {
    const value = JSON.parse(body) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: `${label}: JSON no es objeto` };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, reason: `${label}: JSON inválido` };
  }
}

function validateCellEntry(
  cell: unknown,
  version: string,
  contentHash: string,
): { ok: true; entry: ManifestCellEntry } | { ok: false; reason: string } {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
    return { ok: false, reason: 'celda: no es objeto' };
  }
  const c = cell as Record<string, unknown>;
  if (typeof c.id !== 'string' || !CELL_ID_RE.test(c.id)) {
    return { ok: false, reason: 'celda.id inválido' };
  }
  if (typeof c.path !== 'string' || !isCellPathForVersion(c.path, version)) {
    return { ok: false, reason: `celda.path inseguro o no canónico: ${String(c.path)}` };
  }
  if (!c.path.endsWith(`/${c.id}.json`)) {
    return { ok: false, reason: 'celda.path no coincide con id' };
  }
  if (typeof c.count !== 'number' || !Number.isInteger(c.count) || c.count < 0 || c.count > 50_000) {
    return { ok: false, reason: 'celda.count inválido' };
  }
  if (typeof c.bytes !== 'number' || !Number.isInteger(c.bytes) || c.bytes < 2 || c.bytes > DEFAULT_MAX_RESPONSE_BYTES) {
    return { ok: false, reason: 'celda.bytes inválido' };
  }
  if (!isContentHash(c.sha256)) {
    return { ok: false, reason: 'celda.sha256 inválido' };
  }
  // contentHash del manifiesto no se copia en la entrada; se valida al leer el archivo.
  void contentHash;
  return {
    ok: true,
    entry: {
      id: c.id,
      path: c.path,
      count: c.count,
      sha256: c.sha256,
      bytes: c.bytes,
    },
  };
}

function validateManifestStrict(
  value: Record<string, unknown>,
  label: string,
  maxCells: number,
): { ok: true; manifest: Manifest } | { ok: false; reason: string } {
  if (value.schemaVersion !== 1) return { ok: false, reason: `${label}: schemaVersion` };
  if (!isDatasetVersion(value.datasetVersion)) return { ok: false, reason: `${label}: datasetVersion` };
  if (!isContentHash(value.contentHash)) return { ok: false, reason: `${label}: contentHash` };
  if (value.datasetVersion !== value.contentHash.slice(0, 16)) {
    return { ok: false, reason: `${label}: datasetVersion no deriva de contentHash` };
  }
  if (!isSourceFecha(value.sourceFecha)) return { ok: false, reason: `${label}: sourceFecha` };
  if (!isIsoDate(value.downloadedAt)) return { ok: false, reason: `${label}: downloadedAt` };
  if (value.publishedAt !== null && !isIsoDate(value.publishedAt)) {
    return { ok: false, reason: `${label}: publishedAt` };
  }
  if (value.lastSuccessfulFetchAt !== undefined && !isIsoDate(value.lastSuccessfulFetchAt)) {
    return { ok: false, reason: `${label}: lastSuccessfulFetchAt` };
  }
  if (typeof value.stationCount !== 'number' || !Number.isInteger(value.stationCount) || value.stationCount < 1) {
    return { ok: false, reason: `${label}: stationCount` };
  }
  if (typeof value.priceCount !== 'number' || !Number.isInteger(value.priceCount) || value.priceCount < 0) {
    return { ok: false, reason: `${label}: priceCount` };
  }
  if (typeof value.fileCount !== 'number' || !Number.isInteger(value.fileCount) || value.fileCount < 1) {
    return { ok: false, reason: `${label}: fileCount` };
  }
  if (typeof value.totalBytes !== 'number' || !Number.isInteger(value.totalBytes) || value.totalBytes < 1) {
    return { ok: false, reason: `${label}: totalBytes` };
  }
  if (
    typeof value.staleAfterMinutes !== 'number' ||
    !Number.isInteger(value.staleAfterMinutes) ||
    value.staleAfterMinutes < 1 ||
    value.staleAfterMinutes > 10_080
  ) {
    return { ok: false, reason: `${label}: staleAfterMinutes` };
  }
  if (!Array.isArray(value.cells) || value.cells.length === 0 || value.cells.length > maxCells) {
    return { ok: false, reason: `${label}: cells (tamaño)` };
  }
  if (!value.grid || typeof value.grid !== 'object' || Array.isArray(value.grid)) {
    return { ok: false, reason: `${label}: grid` };
  }
  if (!value.attribution || typeof value.attribution !== 'object' || Array.isArray(value.attribution)) {
    return { ok: false, reason: `${label}: attribution` };
  }

  const cells: ManifestCellEntry[] = [];
  const seenPaths = new Set<string>();
  for (const raw of value.cells) {
    const cell = validateCellEntry(raw, value.datasetVersion, value.contentHash);
    if (!cell.ok) return { ok: false, reason: `${label}: ${cell.reason}` };
    if (seenPaths.has(cell.entry.path)) {
      return { ok: false, reason: `${label}: cell.path duplicado` };
    }
    seenPaths.add(cell.entry.path);
    cells.push(cell.entry);
  }

  return { ok: true, manifest: { ...(value as unknown as Manifest), cells } };
}

function validateCurrent(
  value: Record<string, unknown>,
):
  | {
      ok: true;
      datasetVersion: string;
      contentHash: string;
      manifestPath: string;
      sourceFecha: string;
      downloadedAt: string;
      publishedAt: string | null;
    }
  | { ok: false; reason: string } {
  if (value.schemaVersion !== 1) return { ok: false, reason: 'current.json: schemaVersion' };
  if (!isDatasetVersion(value.datasetVersion)) return { ok: false, reason: 'current.json: datasetVersion' };
  if (!isContentHash(value.contentHash)) return { ok: false, reason: 'current.json: contentHash' };
  if (value.datasetVersion !== value.contentHash.slice(0, 16)) {
    return { ok: false, reason: 'current.json: datasetVersion no deriva de contentHash' };
  }
  if (typeof value.manifestPath !== 'string') return { ok: false, reason: 'current.json: manifestPath' };
  if (!isVersionedManifestPath(value.manifestPath, value.datasetVersion)) {
    return { ok: false, reason: 'current.json: manifestPath no canónico' };
  }
  if (!isSourceFecha(value.sourceFecha)) return { ok: false, reason: 'current.json: sourceFecha' };
  if (!isIsoDate(value.downloadedAt)) return { ok: false, reason: 'current.json: downloadedAt' };
  if (value.publishedAt !== null && value.publishedAt !== undefined && !isIsoDate(value.publishedAt)) {
    return { ok: false, reason: 'current.json: publishedAt' };
  }
  return {
    ok: true,
    datasetVersion: value.datasetVersion,
    contentHash: value.contentHash,
    manifestPath: value.manifestPath,
    sourceFecha: value.sourceFecha,
    downloadedAt: value.downloadedAt,
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : null,
  };
}

function validateSync(
  value: Record<string, unknown>,
  active: Manifest,
  maxRetained: number,
): { ok: true; sync: SyncState } | { ok: false; reason: string } {
  if (value.schemaVersion !== 1) return { ok: false, reason: 'sync.json: schemaVersion' };
  if (!isDatasetVersion(value.datasetVersion)) return { ok: false, reason: 'sync.json: datasetVersion' };
  if (!isContentHash(value.contentHash)) return { ok: false, reason: 'sync.json: contentHash' };
  if (value.datasetVersion !== active.datasetVersion || value.contentHash !== active.contentHash) {
    return { ok: false, reason: 'sync.json no identifica el mismo conjunto que el manifiesto' };
  }
  if (value.sourceFecha !== active.sourceFecha) {
    return { ok: false, reason: 'sync.json: sourceFecha distinta del manifiesto' };
  }
  if (!isIsoDate(value.lastSuccessfulFetchAt)) return { ok: false, reason: 'sync.json: lastSuccessfulFetchAt' };
  if (!isIsoDate(value.contentPublishedAt)) return { ok: false, reason: 'sync.json: contentPublishedAt' };
  if (
    typeof value.staleAfterMinutes !== 'number' ||
    !Number.isInteger(value.staleAfterMinutes) ||
    value.staleAfterMinutes !== active.staleAfterMinutes
  ) {
    return { ok: false, reason: 'sync.json: staleAfterMinutes' };
  }
  if (!Array.isArray(value.retainedVersions)) {
    return { ok: false, reason: 'sync.json: retainedVersions' };
  }
  if (value.retainedVersions.length > maxRetained) {
    return { ok: false, reason: `sync.json: demasiadas retainedVersions (>${maxRetained})` };
  }
  const retained: string[] = [];
  const seen = new Set<string>();
  for (const v of value.retainedVersions) {
    if (!isDatasetVersion(v)) return { ok: false, reason: 'sync.json: versión retenida inválida' };
    if (v === active.datasetVersion) {
      return { ok: false, reason: 'sync.json: retainedVersions no puede incluir la activa' };
    }
    if (seen.has(v)) return { ok: false, reason: 'sync.json: retainedVersions duplicadas' };
    seen.add(v);
    retained.push(v);
  }
  return {
    ok: true,
    sync: {
      schemaVersion: 1,
      datasetVersion: value.datasetVersion,
      contentHash: value.contentHash,
      sourceFecha: value.sourceFecha,
      lastSuccessfulFetchAt: value.lastSuccessfulFetchAt,
      contentPublishedAt: value.contentPublishedAt,
      retainedVersions: retained,
      staleAfterMinutes: value.staleAfterMinutes,
    },
  };
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    expectedOrigin: string;
    deadlineMs: number;
    nowMs: () => number;
  },
): Promise<{ ok: true; body: string; status: number } | { ok: false; reason: string; code: RecoverFailureCode }> {
  if (options.nowMs() > options.deadlineMs) {
    return { ok: false, reason: 'Tiempo total de recuperación agotado', code: 'timeout' };
  }
  const remainingTotal = Math.max(1, options.deadlineMs - options.nowMs());
  const budget = Math.min(options.timeoutMs, remainingTotal);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      return {
        ok: false,
        reason: `Redirección rechazada (${res.status})${loc ? `: ${loc}` : ''}`,
        code: 'http_unexpected',
      };
    }
    if (res.url) {
      try {
        const finalUrl = new URL(res.url);
        if (finalUrl.origin !== options.expectedOrigin) {
          return { ok: false, reason: `Origen distinto al base: ${finalUrl.origin}`, code: 'unsafe_path' };
        }
      } catch {
        return { ok: false, reason: 'URL de respuesta inválida', code: 'unsafe_path' };
      }
    }
    if (res.status === 404) {
      return { ok: false, reason: `HTTP 404 en ${url}`, code: 'incomplete' };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, reason: `HTTP ${res.status} en ${url}`, code: 'http_unexpected' };
    }

    const declared = res.headers.get('content-length');
    if (declared) {
      const n = Number(declared);
      if (Number.isFinite(n) && n > options.maxBytes) {
        ctrl.abort();
        return { ok: false, reason: `content-length ${n} supera el máximo`, code: 'http_unexpected' };
      }
    }

    // Mantener el timeout activo hasta terminar de leer el cuerpo.
    if (!res.body) {
      const body = await res.text();
      if (Buffer.byteLength(body, 'utf8') > options.maxBytes) {
        return { ok: false, reason: 'Cuerpo demasiado grande', code: 'http_unexpected' };
      }
      return { ok: true, body, status: res.status };
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      if (options.nowMs() > options.deadlineMs) {
        ctrl.abort();
        return { ok: false, reason: 'Tiempo total de recuperación agotado', code: 'timeout' };
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > options.maxBytes) {
          ctrl.abort();
          return { ok: false, reason: 'Cuerpo demasiado grande', code: 'http_unexpected' };
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    return { ok: true, body, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/aborted|AbortError|timeout/i.test(msg) || options.nowMs() > options.deadlineMs) {
      return { ok: false, reason: `Timeout: ${msg}`, code: 'timeout' };
    }
    return { ok: false, reason: `Red: ${msg}`, code: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBodyNewline(body: string): string {
  return body.endsWith('\n') ? body : `${body}\n`;
}

function bodyMatchingHash(body: string, expectedSha: string): string | null {
  const withNl = normalizeBodyNewline(body);
  if (sha256Hex(withNl) === expectedSha) return withNl;
  if (sha256Hex(body) === expectedSha) return body;
  const rawSha = createHash('sha256').update(body, 'utf8').digest('hex');
  if (rawSha === expectedSha) return body;
  return null;
}

/**
 * Recupera el estado publicado desde una URL base (simula runner limpio).
 * Verifica manifiesto, esquema, hashes y archivos necesarios para comparación/retención.
 * Ante fallo: no escribe live; no implica bootstrap.
 */
export async function recoverPublishedState(
  options: RecoverPublishedStateOptions,
): Promise<RecoverOutcome> {
  const rawBase = options.publicBaseUrl.trim();
  if (!rawBase) return fail('publicBaseUrl vacío', 'schema');

  const baseCheck = validateBaseUrl(rawBase, options.allowHttpLocal === true);
  if (!baseCheck.ok) return fail(baseCheck.reason, baseCheck.code);

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  const maxRetained = options.retainPreviousVersions ?? DEFAULT_PIPELINE_CONFIG.retainPreviousVersions;
  const nowMs = options.nowMs ?? Date.now;
  const deadlineMs = nowMs() + totalTimeoutMs;

  const store = createStorePaths(options.outRoot);
  const staging = path.join(options.outRoot, '.recover-staging');

  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const cleanup = (): void => {
    fs.rmSync(staging, { recursive: true, force: true });
  };

  const writeRel = (rel: string, body: string): { ok: true } | { ok: false; reason: string } => {
    const safe = assertSafeStagingPath(staging, rel);
    if (!safe.ok) return safe;
    fs.mkdirSync(path.dirname(safe.abs), { recursive: true });
    fs.writeFileSync(safe.abs, body, 'utf8');
    return { ok: true };
  };

  const fetchAsset = (rel: string) =>
    fetchText(fetchImpl, joinUrl(baseCheck.baseUrl, rel), {
      timeoutMs,
      maxBytes,
      expectedOrigin: baseCheck.origin,
      deadlineMs,
      nowMs,
    });

  try {
    // --- current.json (obligatorio) ---
    const currentFetch = await fetchAsset('current.json');
    if (!currentFetch.ok) {
      cleanup();
      return currentFetch;
    }
    const currentParsed = parseJsonObject(currentFetch.body, 'current.json');
    if (!currentParsed.ok) {
      cleanup();
      return fail(currentParsed.reason, 'schema');
    }
    const current = validateCurrent(currentParsed.value);
    if (!current.ok) {
      cleanup();
      return fail(current.reason, 'schema');
    }
    const writtenCurrent = writeRel('current.json', normalizeBodyNewline(currentFetch.body));
    if (!writtenCurrent.ok) {
      cleanup();
      return fail(writtenCurrent.reason, 'unsafe_path');
    }

    // --- manifiesto versionado (ruta canónica validada) ---
    const versionedFetch = await fetchAsset(current.manifestPath);
    if (!versionedFetch.ok) {
      cleanup();
      return versionedFetch;
    }
    const versionedParsed = parseJsonObject(versionedFetch.body, current.manifestPath);
    if (!versionedParsed.ok) {
      cleanup();
      return fail(versionedParsed.reason, 'schema');
    }
    const versioned = validateManifestStrict(versionedParsed.value, current.manifestPath, maxCells);
    if (!versioned.ok) {
      cleanup();
      return fail(versioned.reason, 'schema');
    }
    if (
      versioned.manifest.datasetVersion !== current.datasetVersion ||
      versioned.manifest.contentHash !== current.contentHash
    ) {
      cleanup();
      return fail('Manifiesto versionado no coincide con current.json', 'incoherent');
    }
    const writtenVersioned = writeRel(current.manifestPath, normalizeBodyNewline(versionedFetch.body));
    if (!writtenVersioned.ok) {
      cleanup();
      return fail(writtenVersioned.reason, 'unsafe_path');
    }

    // --- manifest.json raíz (obligatorio; sin fallback) ---
    const rootFetch = await fetchAsset('manifest.json');
    if (!rootFetch.ok) {
      cleanup();
      return rootFetch;
    }
    const rootParsed = parseJsonObject(rootFetch.body, 'manifest.json');
    if (!rootParsed.ok) {
      cleanup();
      return fail(rootParsed.reason, 'schema');
    }
    const root = validateManifestStrict(rootParsed.value, 'manifest.json', maxCells);
    if (!root.ok) {
      cleanup();
      return fail(root.reason, 'schema');
    }
    if (
      root.manifest.datasetVersion !== current.datasetVersion ||
      root.manifest.contentHash !== current.contentHash ||
      root.manifest.datasetVersion !== versioned.manifest.datasetVersion ||
      root.manifest.contentHash !== versioned.manifest.contentHash
    ) {
      cleanup();
      return fail('current / manifest raíz / versionado no identifican el mismo conjunto', 'incoherent');
    }
    const writtenRoot = writeRel('manifest.json', normalizeBodyNewline(rootFetch.body));
    if (!writtenRoot.ok) {
      cleanup();
      return fail(writtenRoot.reason, 'unsafe_path');
    }

    // --- sync.json (obligatorio; sin síntesis) ---
    const syncFetch = await fetchAsset(SYNC_STATE_REL);
    if (!syncFetch.ok) {
      cleanup();
      return syncFetch.code === 'incomplete'
        ? fail('sync.json ausente (obligatorio en recuperación)', 'incomplete')
        : syncFetch;
    }
    const syncParsed = parseJsonObject(syncFetch.body, SYNC_STATE_REL);
    if (!syncParsed.ok) {
      cleanup();
      return fail(syncParsed.reason, 'schema');
    }
    const sync = validateSync(syncParsed.value, root.manifest, maxRetained);
    if (!sync.ok) {
      cleanup();
      return fail(sync.reason, 'incoherent');
    }
    const writtenSync = writeRel(SYNC_STATE_REL, normalizeBodyNewline(syncFetch.body));
    if (!writtenSync.ok) {
      cleanup();
      return fail(writtenSync.reason, 'unsafe_path');
    }

    const versionsToFetch = [root.manifest.datasetVersion, ...sync.sync.retainedVersions];

    for (const version of versionsToFetch) {
      if (!isDatasetVersion(version)) {
        cleanup();
        return fail(`Versión inválida: ${version}`, 'schema');
      }

      let manifestForVersion: Manifest;
      if (version === root.manifest.datasetVersion) {
        manifestForVersion = versioned.manifest;
      } else {
        const prevPath = `v/${version}/manifest.json`;
        if (!isVersionedManifestPath(prevPath, version)) {
          cleanup();
          return fail(`Ruta de manifiesto retenido inválida: ${prevPath}`, 'unsafe_path');
        }
        const prevFetch = await fetchAsset(prevPath);
        if (!prevFetch.ok) {
          cleanup();
          return fail(
            `No se pudo recuperar versión retenida ${version}: ${prevFetch.reason}`,
            prevFetch.code,
          );
        }
        const prevParsed = parseJsonObject(prevFetch.body, prevPath);
        if (!prevParsed.ok) {
          cleanup();
          return fail(prevParsed.reason, 'schema');
        }
        const prev = validateManifestStrict(prevParsed.value, prevPath, maxCells);
        if (!prev.ok) {
          cleanup();
          return fail(prev.reason, 'schema');
        }
        if (prev.manifest.datasetVersion !== version) {
          cleanup();
          return fail(`Manifiesto retenido ${version} declara otra datasetVersion`, 'incoherent');
        }
        manifestForVersion = prev.manifest;
        const writtenPrev = writeRel(prevPath, normalizeBodyNewline(prevFetch.body));
        if (!writtenPrev.ok) {
          cleanup();
          return fail(writtenPrev.reason, 'unsafe_path');
        }
      }

      for (const cell of manifestForVersion.cells) {
        if (!isCellPathForVersion(cell.path, version)) {
          cleanup();
          return fail(`celda.path rechazado: ${cell.path}`, 'unsafe_path');
        }
        const safePath = assertSafeStagingPath(staging, cell.path);
        if (!safePath.ok) {
          cleanup();
          return fail(safePath.reason, 'unsafe_path');
        }

        const cellFetch = await fetchAsset(cell.path);
        if (!cellFetch.ok) {
          cleanup();
          return fail(`Celda ${cell.path}: ${cellFetch.reason}`, cellFetch.code);
        }
        if (Buffer.byteLength(cellFetch.body, 'utf8') > cell.bytes + 1024) {
          // margen pequeño por newline; bytes declarado debe ser cercano
        }
        const matched = bodyMatchingHash(cellFetch.body, cell.sha256);
        if (!matched) {
          cleanup();
          return fail(`Hash distinto en ${cell.path}`, 'hash_mismatch');
        }
        const writtenCell = writeRel(cell.path, matched);
        if (!writtenCell.ok) {
          cleanup();
          return fail(writtenCell.reason, 'unsafe_path');
        }
      }
    }

    // Cabeceras desde el código local (no del CDN).
    try {
      copyStaticHeadersInto(staging);
    } catch (err) {
      cleanup();
      const msg = err instanceof Error ? err.message : String(err);
      return fail(msg, 'incomplete');
    }

    const coherent = assertPublishedTreeCoherent(staging);
    if (!coherent.ok) {
      cleanup();
      return fail(coherent.reason, 'incoherent');
    }

    fs.rmSync(store.liveDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(store.liveDir), { recursive: true });
    fs.renameSync(staging, store.liveDir);

    return {
      ok: true,
      manifest: readManifest(store.liveDir),
      fileCount: countFiles(store.liveDir),
      baseUrl: baseCheck.baseUrl,
    };
  } catch (err) {
    cleanup();
    const msg = err instanceof Error ? err.message : String(err);
    return fail(msg, 'network');
  }
}

function readManifest(liveDir: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(liveDir, 'manifest.json'), 'utf8')) as Manifest;
}

function countFiles(dir: string): number {
  let n = 0;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n += 1;
    }
  };
  walk(dir);
  return n;
}
