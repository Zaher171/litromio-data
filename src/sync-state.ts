import fs from 'node:fs';
import path from 'node:path';
import type { Manifest } from './types.ts';

/** Estado de sincronización mutable (no vive bajo URLs inmutables). */
export interface SyncState {
  schemaVersion: 1;
  datasetVersion: string;
  contentHash: string;
  /** Fecha/hora global de la respuesta oficial (`Fecha`). */
  sourceFecha: string;
  /** Última descarga y validación exitosa (aunque el contenido no cambie). */
  lastSuccessfulFetchAt: string;
  /** Cuándo se publicó el contenido de `datasetVersion` (no se mueve en sync-only). */
  contentPublishedAt: string;
  /** Versiones anteriores aún retenidas en el árbol publicado. */
  retainedVersions: string[];
  staleAfterMinutes: number;
}

export const SYNC_STATE_REL = 'sync.json';

export function syncStatePath(liveDir: string): string {
  return path.join(liveDir, SYNC_STATE_REL);
}

export function readSyncState(liveDir: string): SyncState | null {
  const p = syncStatePath(liveDir);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as SyncState;
}

export function writeSyncState(liveDir: string, state: SyncState): void {
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(syncStatePath(liveDir), `${JSON.stringify(state)}\n`, 'utf8');
}

export function buildSyncState(input: {
  manifest: Manifest;
  lastSuccessfulFetchAt: string;
  contentPublishedAt: string;
  retainedVersions: string[];
}): SyncState {
  return {
    schemaVersion: 1,
    datasetVersion: input.manifest.datasetVersion,
    contentHash: input.manifest.contentHash,
    sourceFecha: input.manifest.sourceFecha,
    lastSuccessfulFetchAt: input.lastSuccessfulFetchAt,
    contentPublishedAt: input.contentPublishedAt,
    retainedVersions: [...input.retainedVersions],
    staleAfterMinutes: input.manifest.staleAfterMinutes,
  };
}

/**
 * Actualiza evidencia de consulta exitosa en archivos mutables.
 * No toca `v/{datasetVersion}/...` (inmutables).
 */
export function updateMutableFreshness(
  liveDir: string,
  input: {
    lastSuccessfulFetchAt: string;
    sourceFecha: string;
  },
): { ok: true; sync: SyncState } | { ok: false; reason: string } {
  const manifestPath = path.join(liveDir, 'manifest.json');
  const currentPath = path.join(liveDir, 'current.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(currentPath)) {
    return { ok: false, reason: 'Faltan manifest.json o current.json mutables' };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest & {
    lastSuccessfulFetchAt?: string;
  };
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as Record<string, unknown>;

  const versionedDir = path.join(liveDir, 'v', manifest.datasetVersion);
  if (!fs.existsSync(versionedDir)) {
    return { ok: false, reason: `Falta árbol inmutable v/${manifest.datasetVersion}` };
  }

  const existingSync = readSyncState(liveDir);
  const contentPublishedAt =
    existingSync?.contentPublishedAt ??
    (typeof manifest.publishedAt === 'string' ? manifest.publishedAt : null) ??
    input.lastSuccessfulFetchAt;

  const retainedVersions =
    existingSync?.retainedVersions ??
    listRetainedVersions(liveDir, manifest.datasetVersion);

  manifest.lastSuccessfulFetchAt = input.lastSuccessfulFetchAt;
  manifest.downloadedAt = input.lastSuccessfulFetchAt;
  // sourceFecha del contenido activo no se inventa; se confirma con la consulta.
  if (manifest.sourceFecha !== input.sourceFecha) {
    return {
      ok: false,
      reason: 'sourceFecha de la consulta no coincide con el manifiesto activo (hash debería haber cambiado)',
    };
  }

  current.lastSuccessfulFetchAt = input.lastSuccessfulFetchAt;
  current.downloadedAt = input.lastSuccessfulFetchAt;
  current.sourceFecha = input.sourceFecha;

  const sync = buildSyncState({
    manifest,
    lastSuccessfulFetchAt: input.lastSuccessfulFetchAt,
    contentPublishedAt,
    retainedVersions,
  });

  // Snapshot de archivos versionados para detectar mutación accidental.
  const versionedSnapshot = snapshotImmutableTree(versionedDir);

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
  fs.writeFileSync(currentPath, `${JSON.stringify(current)}\n`, 'utf8');
  writeSyncState(liveDir, sync);

  const after = snapshotImmutableTree(versionedDir);
  if (after !== versionedSnapshot) {
    return { ok: false, reason: 'Se mutó un archivo bajo URL inmutable durante freshness' };
  }

  return { ok: true, sync };
}

export function listRetainedVersions(liveDir: string, activeVersion: string): string[] {
  const vRoot = path.join(liveDir, 'v');
  if (!fs.existsSync(vRoot)) return [];
  return fs
    .readdirSync(vRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== activeVersion)
    .map((e) => e.name)
    .sort();
}

function snapshotImmutableTree(dir: string): string {
  const lines: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs, childRel);
      else {
        const st = fs.statSync(abs);
        lines.push(`${childRel}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir, '');
  return lines.join('|');
}
