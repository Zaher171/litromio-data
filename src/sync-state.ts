import fs from 'node:fs';
import path from 'node:path';
import {
  applyMunicipalPointersToCurrent,
  assertGeometryTreeCoherent,
  readGeometryCurrent,
} from './geometry.ts';
import type { Manifest } from './types.ts';
import { parseFuenteFechaToEpoch } from './validate.ts';

/**
 * Estado de sincronización mutable (no vive bajo URLs inmutables).
 *
 * Relojes (no confundir):
 * - `sourceFecha`: `Fecha` de la fuente con la que se publicó el contenido activo
 *   (`datasetVersion` / `contentHash`). Se conserva en sync-only.
 * - `lastObservedSourceFecha`: `Fecha` de la última consulta válida aceptada
 *   (puede avanzar sin cambio de precios).
 * - `lastSuccessfulFetchAt`: instante ISO real de esa descarga/validación.
 * - `contentPublishedAt`: instante de publicación del contenido; no cambia si el hash es igual.
 */
export interface SyncState {
  schemaVersion: 1;
  datasetVersion: string;
  contentHash: string;
  /** Fecha de la fuente asociada al contenido activo (congelada con el datasetVersion). */
  sourceFecha: string;
  /** Fecha de la fuente en la última consulta válida aceptada. */
  lastObservedSourceFecha: string;
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
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  return normalizeSyncStateRecord(raw);
}

/**
 * Adapta un sync.json leído (p. ej. formato publicado sin `lastObservedSourceFecha`)
 * al esquema actual. No toca archivos versionados.
 */
export function normalizeSyncStateRecord(raw: Record<string, unknown>): SyncState | null {
  if (raw.schemaVersion !== 1) return null;
  if (typeof raw.datasetVersion !== 'string' || typeof raw.contentHash !== 'string') return null;
  if (typeof raw.sourceFecha !== 'string') return null;
  if (typeof raw.lastSuccessfulFetchAt !== 'string' || typeof raw.contentPublishedAt !== 'string') {
    return null;
  }
  if (typeof raw.staleAfterMinutes !== 'number' || !Array.isArray(raw.retainedVersions)) return null;

  const lastObservedSourceFecha =
    typeof raw.lastObservedSourceFecha === 'string' && raw.lastObservedSourceFecha.trim() !== ''
      ? raw.lastObservedSourceFecha
      : raw.sourceFecha;

  return {
    schemaVersion: 1,
    datasetVersion: raw.datasetVersion,
    contentHash: raw.contentHash,
    sourceFecha: raw.sourceFecha,
    lastObservedSourceFecha,
    lastSuccessfulFetchAt: raw.lastSuccessfulFetchAt,
    contentPublishedAt: raw.contentPublishedAt,
    retainedVersions: raw.retainedVersions.filter((v): v is string => typeof v === 'string'),
    staleAfterMinutes: raw.staleAfterMinutes,
  };
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
  /** Por defecto = `manifest.sourceFecha` (publicación de contenido nuevo). */
  lastObservedSourceFecha?: string;
}): SyncState {
  return {
    schemaVersion: 1,
    datasetVersion: input.manifest.datasetVersion,
    contentHash: input.manifest.contentHash,
    sourceFecha: input.manifest.sourceFecha,
    lastObservedSourceFecha: input.lastObservedSourceFecha ?? input.manifest.sourceFecha,
    lastSuccessfulFetchAt: input.lastSuccessfulFetchAt,
    contentPublishedAt: input.contentPublishedAt,
    retainedVersions: [...input.retainedVersions],
    staleAfterMinutes: input.manifest.staleAfterMinutes,
  };
}

/**
 * Actualiza evidencia de consulta exitosa en archivos mutables.
 * No toca `v/{datasetVersion}/...` (inmutables).
 * Conserva `sourceFecha` del contenido; avanza `lastObservedSourceFecha` si la consulta es ≥.
 */
export function updateMutableFreshness(
  liveDir: string,
  input: {
    lastSuccessfulFetchAt: string;
    /** `Fecha` observada en la consulta actual (puede diferir del contenido si el hash es igual). */
    observedSourceFecha: string;
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
    existingSync?.retainedVersions ?? listRetainedVersions(liveDir, manifest.datasetVersion);

  const baselineFecha =
    existingSync?.lastObservedSourceFecha ?? existingSync?.sourceFecha ?? manifest.sourceFecha;
  const observedEpoch = parseFuenteFechaToEpoch(input.observedSourceFecha);
  const baselineEpoch = parseFuenteFechaToEpoch(baselineFecha);
  if (observedEpoch === null || baselineEpoch === null) {
    return { ok: false, reason: 'Fecha de fuente no interpretable (Europe/Madrid)' };
  }
  if (observedEpoch < baselineEpoch) {
    return { ok: false, reason: 'Fecha de fuente anterior a la última observada aceptada' };
  }

  // sourceFecha del contenido activo se conserva; solo avanza la frescura de consulta.
  manifest.lastSuccessfulFetchAt = input.lastSuccessfulFetchAt;
  manifest.downloadedAt = input.lastSuccessfulFetchAt;

  current.lastSuccessfulFetchAt = input.lastSuccessfulFetchAt;
  current.downloadedAt = input.lastSuccessfulFetchAt;
  // current.sourceFecha permanece asociado al contenido (no a la última observación).
  current.sourceFecha = manifest.sourceFecha;

  const sync = buildSyncState({
    manifest,
    lastSuccessfulFetchAt: input.lastSuccessfulFetchAt,
    contentPublishedAt,
    retainedVersions,
    lastObservedSourceFecha: input.observedSourceFecha,
  });

  // Snapshot de archivos versionados para detectar mutación accidental.
  const versionedSnapshot = snapshotImmutableTree(versionedDir);
  const geometryDir = path.join(liveDir, 'g');
  const geometrySnapshot = fs.existsSync(geometryDir) ? snapshotImmutableTree(geometryDir) : null;

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
  fs.writeFileSync(currentPath, `${JSON.stringify(current)}\n`, 'utf8');
  writeSyncState(liveDir, sync);

  // Reaplicar punteros municipales opcionales (conserva g/ y municipality-cells).
  applyMunicipalPointersToCurrent(liveDir, {
    datasetVersion: manifest.datasetVersion,
    geometry: readGeometryCurrent(liveDir),
  });

  const after = snapshotImmutableTree(versionedDir);
  if (after !== versionedSnapshot) {
    return { ok: false, reason: 'Se mutó un archivo bajo URL inmutable durante freshness' };
  }
  if (geometrySnapshot !== null) {
    const afterGeo = snapshotImmutableTree(geometryDir);
    if (afterGeo !== geometrySnapshot) {
      return { ok: false, reason: 'Se mutó el árbol g/ durante freshness (geometrías son independientes)' };
    }
  }

  const geoCheck = assertGeometryTreeCoherent(liveDir);
  if (!geoCheck.ok) return geoCheck;

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
