import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyMunicipalPointersToCurrent,
  assertGeometryTreeCoherent,
  assertMunicipalityCellsFileCoherent,
  preserveGeometryTreeFromLive,
  readGeometryCurrent,
} from './geometry.ts';
import { sha256Hex } from './hash.ts';
import { municipalityCellsRelPath } from './municipality-cells.ts';
import type { Manifest } from './types.ts';
import {
  buildSyncState,
  listRetainedVersions,
  writeSyncState,
} from './sync-state.ts';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATIC_HEADERS_SOURCE = path.join(PACKAGE_ROOT, 'static', '_headers');

export interface LiveStoreState {
  rootDir: string;
  liveDir: string;
  stagingDir: string;
  lockPath: string;
}

export function createStorePaths(rootDir: string): LiveStoreState {
  return {
    rootDir,
    liveDir: path.join(rootDir, 'live'),
    stagingDir: path.join(rootDir, 'staging'),
    lockPath: path.join(rootDir, '.publish.lock'),
  };
}

export interface LockHandle {
  runId: string;
  expiresAt: string;
}

export function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export function readLiveManifest(liveDir: string): Manifest | null {
  return readJsonFile<Manifest>(path.join(liveDir, 'manifest.json'));
}

export function readLiveContentHash(liveDir: string): string | null {
  const m = readLiveManifest(liveDir);
  return m?.contentHash ?? null;
}

/**
 * Adquiere un lease exclusivo en disco. Idempotente para el mismo runId.
 * Protege frente a ejecuciones concurrentes.
 */
export function acquireLock(
  lockPath: string,
  runId: string,
  nowIso: string,
  ttlMs: number,
): { ok: true } | { ok: false; reason: string } {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const expiresAt = new Date(Date.parse(nowIso) + ttlMs).toISOString();
  const existing = readJsonFile<LockHandle>(lockPath);
  if (existing) {
    if (existing.runId === runId) {
      fs.writeFileSync(lockPath, `${JSON.stringify({ runId, expiresAt })}\n`, 'utf8');
      return { ok: true };
    }
    if (Date.parse(existing.expiresAt) > Date.parse(nowIso)) {
      return { ok: false, reason: `Lease activo de run ${existing.runId}` };
    }
  }
  fs.writeFileSync(lockPath, `${JSON.stringify({ runId, expiresAt })}\n`, 'utf8');
  return { ok: true };
}

export function releaseLock(lockPath: string, runId: string): void {
  const existing = readJsonFile<LockHandle>(lockPath);
  if (existing && existing.runId === runId) {
    fs.rmSync(lockPath, { force: true });
  }
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * Escribe archivos a staging. No toca live.
 */
export function writeStaging(
  stagingDir: string,
  files: Map<string, string>,
): { totalBytes: number; maxFileBytes: number; fileCount: number } {
  rmrf(stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });
  let totalBytes = 0;
  let maxFileBytes = 0;
  for (const [rel, body] of files) {
    const abs = path.join(stagingDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
    const bytes = Buffer.byteLength(body, 'utf8');
    totalBytes += bytes;
    if (bytes > maxFileBytes) maxFileBytes = bytes;
  }
  return { totalBytes, maxFileBytes, fileCount: files.size };
}

export function copyStaticHeadersInto(targetDir: string): void {
  if (!fs.existsSync(STATIC_HEADERS_SOURCE)) {
    throw new Error(`Falta plantilla de cabeceras: ${STATIC_HEADERS_SOURCE}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(STATIC_HEADERS_SOURCE, path.join(targetDir, '_headers'));
}

export interface PromoteOptions {
  retainPreviousVersions: number;
  publishedAt: string;
  lastSuccessfulFetchAt: string;
  /** Si true, simula fallo antes del reemplazo de live. */
  failBeforeSwap?: boolean;
}

/**
 * Publicación local del árbol staging → live.
 *
 * Pasos:
 * 1) staging completo + retención de versión anterior de precios
 * 2) conservación de g/ (geometrías) desde live — sin regenerar
 * 3) metadatos mutables (publishedAt, sync.json, _headers, punteros municipales)
 * 4) validación de TODO el árbol staging
 * 5) reemplazo de live (copia + restauración en Windows; NO es atómico para lectores concurrentes)
 *
 * Ante fallo de validación o de copia: conserva live previo si existía.
 */
export function promoteStagingToLive(
  store: LiveStoreState,
  files: Map<string, string>,
  options: PromoteOptions,
): { ok: true; metrics: { totalBytes: number; maxFileBytes: number; fileCount: number } } | { ok: false; reason: string } {
  const written = writeStaging(store.stagingDir, files);

  // Retener versión anterior de precios: copiar v/{old}/ desde live si existe y no está en staging.
  if (options.retainPreviousVersions > 0 && fs.existsSync(store.liveDir)) {
    const prevManifest = readLiveManifest(store.liveDir);
    if (prevManifest) {
      const prevDir = path.join(store.liveDir, 'v', prevManifest.datasetVersion);
      const destPrev = path.join(store.stagingDir, 'v', prevManifest.datasetVersion);
      if (fs.existsSync(prevDir) && !fs.existsSync(destPrev)) {
        copyDir(prevDir, destPrev);
      }
    }
  }

  // Conservar geometrías municipales entre syncs de precios (ciclo A independiente).
  if (fs.existsSync(store.liveDir)) {
    preserveGeometryTreeFromLive(store.liveDir, store.stagingDir);
  }

  // Actualizar publishedAt / lastSuccessfulFetchAt en punteros del staging.
  const manifestPath = path.join(store.stagingDir, 'manifest.json');
  const currentPath = path.join(store.stagingDir, 'current.json');
  let activeManifest: Manifest | null = null;
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest & {
      lastSuccessfulFetchAt?: string;
    };
    m.publishedAt = options.publishedAt;
    m.lastSuccessfulFetchAt = options.lastSuccessfulFetchAt;
    m.downloadedAt = options.lastSuccessfulFetchAt;
    fs.writeFileSync(manifestPath, `${JSON.stringify(m)}\n`, 'utf8');
    const versioned = path.join(store.stagingDir, 'v', m.datasetVersion, 'manifest.json');
    if (fs.existsSync(versioned)) {
      // El manifiesto versionado queda congelado en el momento de publicación del contenido.
      fs.writeFileSync(versioned, `${JSON.stringify(m)}\n`, 'utf8');
    }
    activeManifest = m;
  }
  if (fs.existsSync(currentPath)) {
    const c = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as Record<string, unknown>;
    c.publishedAt = options.publishedAt;
    c.lastSuccessfulFetchAt = options.lastSuccessfulFetchAt;
    c.downloadedAt = options.lastSuccessfulFetchAt;
    fs.writeFileSync(currentPath, `${JSON.stringify(c)}\n`, 'utf8');
  }

  if (activeManifest) {
    const retained = listRetainedVersions(store.stagingDir, activeManifest.datasetVersion);
    writeSyncState(
      store.stagingDir,
      buildSyncState({
        manifest: activeManifest,
        lastSuccessfulFetchAt: options.lastSuccessfulFetchAt,
        contentPublishedAt: options.publishedAt,
        retainedVersions: retained,
      }),
    );
    applyMunicipalPointersToCurrent(store.stagingDir, {
      datasetVersion: activeManifest.datasetVersion,
      geometry: readGeometryCurrent(store.stagingDir),
    });
  }

  try {
    copyStaticHeadersInto(store.stagingDir);
  } catch (err) {
    rmrf(store.stagingDir);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }

  const coherent = assertPublishedTreeCoherent(store.stagingDir);
  if (!coherent.ok) {
    rmrf(store.stagingDir);
    return { ok: false, reason: `Árbol staging inválido: ${coherent.reason}` };
  }

  if (options.failBeforeSwap) {
    rmrf(store.stagingDir);
    return { ok: false, reason: 'Fallo simulado de publicación antes del reemplazo' };
  }

  const bak = `${store.liveDir}.bak`;
  rmrf(bak);
  try {
    // En Windows/Desktop/OneDrive, rename de directorios grandes puede fallar (EPERM).
    // Se usa copia + reemplazo con restauración desde .bak si falla a mitad.
    // Esto NO es atómico para lectores concurrentes del directorio live.
    if (fs.existsSync(store.liveDir)) {
      copyDir(store.liveDir, bak);
      rmrf(store.liveDir);
    }
    copyDir(store.stagingDir, store.liveDir);
    rmrf(store.stagingDir);
    rmrf(bak);
  } catch (err) {
    if (!fs.existsSync(store.liveDir) && fs.existsSync(bak)) {
      try {
        copyDir(bak, store.liveDir);
      } catch {
        /* ignore secondary */
      }
    }
    rmrf(store.stagingDir);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Reemplazo de live fallido: ${msg}` };
  }

  return { ok: true, metrics: written };
}

export { sha256Hex } from './hash.ts';

export function sha256File(filePath: string): string {
  const body = fs.readFileSync(filePath);
  return sha256Hex(body);
}

/** Verifica coherencia manifiesto activo ↔ archivos de celdas. */
export function assertManifestCoherent(rootDir: string): { ok: true } | { ok: false; reason: string } {
  const manifest = readLiveManifest(rootDir);
  if (!manifest) return { ok: false, reason: 'manifest.json ausente' };

  for (const cell of manifest.cells) {
    const abs = path.join(rootDir, cell.path);
    if (!fs.existsSync(abs)) {
      return { ok: false, reason: `Falta celda ${cell.path}` };
    }
    const sha = sha256File(abs);
    if (sha !== cell.sha256) {
      return { ok: false, reason: `Hash distinto en ${cell.path}` };
    }
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as {
      datasetVersion?: string;
      contentHash?: string;
      stationCount?: number;
    };
    if (parsed.datasetVersion !== manifest.datasetVersion) {
      return { ok: false, reason: `datasetVersion mezclado en ${cell.path}` };
    }
    if (parsed.contentHash !== manifest.contentHash) {
      return { ok: false, reason: `contentHash mezclado en ${cell.path}` };
    }
    if (parsed.stationCount !== cell.count) {
      return { ok: false, reason: `count inconsistente en ${cell.path}` };
    }
  }
  return { ok: true };
}

/**
 * Valida el árbol completo a publicar: punteros, sync, versión activa,
 * versiones retenidas, cabeceras y assets municipales si están declarados.
 */
export function assertPublishedTreeCoherent(rootDir: string): { ok: true } | { ok: false; reason: string } {
  const active = assertManifestCoherent(rootDir);
  if (!active.ok) return active;

  const manifest = readLiveManifest(rootDir)!;
  const currentPath = path.join(rootDir, 'current.json');
  if (!fs.existsSync(currentPath)) {
    return { ok: false, reason: 'current.json ausente' };
  }
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as Record<string, unknown>;
  if (current.datasetVersion !== manifest.datasetVersion || current.contentHash !== manifest.contentHash) {
    return { ok: false, reason: 'current.json no coincide con manifest.json' };
  }

  const versionedManifestPath = path.join(rootDir, 'v', manifest.datasetVersion, 'manifest.json');
  if (!fs.existsSync(versionedManifestPath)) {
    return { ok: false, reason: `Falta manifiesto versionado v/${manifest.datasetVersion}/manifest.json` };
  }
  const versioned = JSON.parse(fs.readFileSync(versionedManifestPath, 'utf8')) as Manifest;
  if (versioned.datasetVersion !== manifest.datasetVersion || versioned.contentHash !== manifest.contentHash) {
    return { ok: false, reason: 'Manifiesto versionado incoherente con el activo' };
  }

  const headersPath = path.join(rootDir, '_headers');
  if (!fs.existsSync(headersPath)) {
    return { ok: false, reason: '_headers ausente (CORS/Cache-Control)' };
  }

  const vRoot = path.join(rootDir, 'v');
  if (fs.existsSync(vRoot)) {
    for (const entry of fs.readdirSync(vRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const version = entry.name;
      const vmPath = path.join(vRoot, version, 'manifest.json');
      if (!fs.existsSync(vmPath)) {
        return { ok: false, reason: `Versión retenida sin manifiesto: ${version}` };
      }
      const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8')) as Manifest;
      if (vm.datasetVersion !== version) {
        return { ok: false, reason: `datasetVersion de carpeta ${version} no coincide` };
      }
      for (const cell of vm.cells) {
        const abs = path.join(rootDir, cell.path);
        if (!fs.existsSync(abs)) {
          return { ok: false, reason: `Falta celda retenida ${cell.path}` };
        }
        if (sha256File(abs) !== cell.sha256) {
          return { ok: false, reason: `Hash distinto en celda retenida ${cell.path}` };
        }
      }
    }
  }

  // municipality-cells: si current lo declara, debe existir y ligarse al dataset activo.
  if (typeof current.municipalityCellsPath === 'string') {
    const expected = municipalityCellsRelPath(manifest.datasetVersion);
    if (current.municipalityCellsPath !== expected) {
      return { ok: false, reason: 'municipalityCellsPath no canónico para dataset activo' };
    }
    const cellsAbs = path.join(rootDir, expected);
    if (!fs.existsSync(cellsAbs)) {
      return { ok: false, reason: 'municipalityCellsPath declarado pero archivo ausente' };
    }
    const cellsCheck = assertMunicipalityCellsFileCoherent(rootDir, manifest);
    if (!cellsCheck.ok) return cellsCheck;
  } else {
    // Si el archivo existe sin declaración, aún debe ser coherente.
    const cellsCheck = assertMunicipalityCellsFileCoherent(rootDir, manifest);
    if (!cellsCheck.ok) return cellsCheck;
  }

  const geometryDeclared =
    typeof current.geometryCurrentPath === 'string' || typeof current.geometryCatalogPath === 'string';
  const geo = assertGeometryTreeCoherent(rootDir, { requirePresent: geometryDeclared });
  if (!geo.ok) return geo;

  if (geometryDeclared) {
    if (current.geometryCurrentPath !== 'g/current.json') {
      return { ok: false, reason: 'geometryCurrentPath no canónico' };
    }
    if (!geo.current) {
      return { ok: false, reason: 'Geometría declarada en current.json pero g/ ausente' };
    }
    if (current.geometryCatalogPath !== geo.current.manifestPath) {
      return { ok: false, reason: 'geometryCatalogPath no coincide con g/current.json' };
    }
  }

  return { ok: true };
}
