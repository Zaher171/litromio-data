/**
 * Ciclo A: geometrías municipales + catálogo INE↔Minetur bajo g/{geometryVersion}/.
 * Independiente de datasetVersion de precios. No se regenera en sync ~30 min.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from './hash.ts';
import {
  buildMunicipalityCellsDocument,
  municipalityCellsRelPath,
  parseMunicipalityCellsDocument,
  serializeMunicipalityCellsDocument,
  validateMunicipalityCellsCoverage,
} from './municipality-cells.ts';
import type { CellFile, GridConfig, Manifest } from './types.ts';
import { DEFAULT_GRID } from './types.ts';

export const GEOMETRY_CURRENT_REL = 'g/current.json';
export const IGN_LICENSE = 'CC BY 4.0 ign.es';
export const IGN_LICENSE_URL =
  'https://www.ign.es/resources/licencia/Condiciones_licenciaUso_IGN.pdf';

const VERSION_RE = /^[a-f0-9]{16}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const CELL_ID_RE = /^-?\d+_-?\d+$/;

export interface GeometryPackFileEntry {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface GeometryCatalogManifest {
  schemaVersion: 1;
  geometryVersion: string;
  catalogVersion: string;
  source: {
    name: string;
    filter: string;
    license: string;
    licenseUrl: string;
    fetchedAt: string;
    numberMatched: number;
  };
  grid: GridConfig;
  packs: {
    pathPrefix: string;
    fileCount: number;
    totalBytes: number;
    maxFileBytes: number;
    files: GeometryPackFileEntry[];
  };
  simplification?: {
    toleranceM: number;
    note: string;
  };
}

export interface MunicipalityCatalogDocument {
  schemaVersion: 1;
  catalogVersion: string;
  generatedAt: string;
  ineCount: number;
  /** INE → IDs Minetur (fusiones = arrays >1). */
  relations: Record<string, string[]>;
  /** INE sin correspondencia Minetur. */
  ineWithoutMinetur: string[];
}

export interface GeometryCurrent {
  schemaVersion: 1;
  geometryVersion: string;
  catalogVersion: string;
  manifestPath: string;
  catalogPath: string;
  publishedAt: string;
  retainedVersions: string[];
  attribution: {
    sourceName: string;
    license: string;
    licenseUrl: string;
  };
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 0)}\n`;
}

export function geometryVersionDir(geometryVersion: string): string {
  return `g/${geometryVersion}`;
}

export function geometryManifestRel(geometryVersion: string): string {
  return `g/${geometryVersion}/geometry-catalog-manifest.json`;
}

export function geometryCatalogRel(geometryVersion: string): string {
  return `g/${geometryVersion}/municipality-catalog.json`;
}

export function geometryPackRel(geometryVersion: string, cellId: string): string {
  return `g/${geometryVersion}/packs/${cellId}.json`;
}

export function isGeometryVersion(v: unknown): v is string {
  return typeof v === 'string' && VERSION_RE.test(v);
}

export function parseGeometryCurrent(
  raw: unknown,
): { ok: true; value: GeometryCurrent } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'g/current.json: no es objeto' };
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== 1) return { ok: false, reason: 'g/current.json: schemaVersion' };
  if (!isGeometryVersion(o.geometryVersion)) return { ok: false, reason: 'g/current.json: geometryVersion' };
  if (typeof o.catalogVersion !== 'string' || !VERSION_RE.test(o.catalogVersion)) {
    return { ok: false, reason: 'g/current.json: catalogVersion' };
  }
  if (o.manifestPath !== geometryManifestRel(o.geometryVersion)) {
    return { ok: false, reason: 'g/current.json: manifestPath no canónico' };
  }
  if (o.catalogPath !== geometryCatalogRel(o.geometryVersion)) {
    return { ok: false, reason: 'g/current.json: catalogPath no canónico' };
  }
  if (typeof o.publishedAt !== 'string') return { ok: false, reason: 'g/current.json: publishedAt' };
  if (!Array.isArray(o.retainedVersions)) return { ok: false, reason: 'g/current.json: retainedVersions' };
  const retained: string[] = [];
  for (const v of o.retainedVersions) {
    if (!isGeometryVersion(v)) return { ok: false, reason: 'g/current.json: retainedVersions inválida' };
    if (v === o.geometryVersion) {
      return { ok: false, reason: 'g/current.json: retainedVersions no puede incluir la activa' };
    }
    retained.push(v);
  }
  if (!o.attribution || typeof o.attribution !== 'object' || Array.isArray(o.attribution)) {
    return { ok: false, reason: 'g/current.json: attribution' };
  }
  const attr = o.attribution as Record<string, unknown>;
  if (typeof attr.license !== 'string' || !attr.license.includes('CC BY')) {
    return { ok: false, reason: 'g/current.json: attribution.license' };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      geometryVersion: o.geometryVersion,
      catalogVersion: o.catalogVersion,
      manifestPath: o.manifestPath,
      catalogPath: o.catalogPath,
      publishedAt: o.publishedAt,
      retainedVersions: retained,
      attribution: {
        sourceName: String(attr.sourceName ?? 'IGN'),
        license: String(attr.license),
        licenseUrl: String(attr.licenseUrl ?? IGN_LICENSE_URL),
      },
    },
  };
}

export function parseGeometryCatalogManifest(
  raw: unknown,
): { ok: true; value: GeometryCatalogManifest } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'geometry-catalog-manifest: no es objeto' };
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== 1) return { ok: false, reason: 'geometry-catalog-manifest: schemaVersion' };
  if (!isGeometryVersion(o.geometryVersion)) {
    return { ok: false, reason: 'geometry-catalog-manifest: geometryVersion' };
  }
  if (typeof o.catalogVersion !== 'string' || !VERSION_RE.test(o.catalogVersion)) {
    return { ok: false, reason: 'geometry-catalog-manifest: catalogVersion' };
  }
  if (!o.source || typeof o.source !== 'object' || Array.isArray(o.source)) {
    return { ok: false, reason: 'geometry-catalog-manifest: source' };
  }
  const source = o.source as Record<string, unknown>;
  if (typeof source.license !== 'string' || !String(source.license).includes('CC BY')) {
    return { ok: false, reason: 'geometry-catalog-manifest: source.license' };
  }
  if (!o.packs || typeof o.packs !== 'object' || Array.isArray(o.packs)) {
    return { ok: false, reason: 'geometry-catalog-manifest: packs' };
  }
  const packs = o.packs as Record<string, unknown>;
  if (!Array.isArray(packs.files) || packs.files.length === 0) {
    return { ok: false, reason: 'geometry-catalog-manifest: packs.files' };
  }
  if (typeof packs.fileCount !== 'number' || packs.fileCount !== packs.files.length) {
    return { ok: false, reason: 'geometry-catalog-manifest: packs.fileCount' };
  }
  const files: GeometryPackFileEntry[] = [];
  const seen = new Set<string>();
  for (const rawFile of packs.files) {
    if (!rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile)) {
      return { ok: false, reason: 'geometry-catalog-manifest: file entry' };
    }
    const f = rawFile as Record<string, unknown>;
    if (typeof f.id !== 'string' || !CELL_ID_RE.test(f.id)) {
      return { ok: false, reason: 'geometry-catalog-manifest: pack id' };
    }
    const expectedPath = geometryPackRel(o.geometryVersion, f.id);
    if (f.path !== expectedPath) {
      return { ok: false, reason: `geometry-catalog-manifest: path no canónico ${String(f.path)}` };
    }
    if (typeof f.sha256 !== 'string' || !HASH_RE.test(f.sha256)) {
      return { ok: false, reason: 'geometry-catalog-manifest: sha256' };
    }
    if (typeof f.bytes !== 'number' || !Number.isInteger(f.bytes) || f.bytes < 2) {
      return { ok: false, reason: 'geometry-catalog-manifest: bytes' };
    }
    if (seen.has(f.id)) return { ok: false, reason: 'geometry-catalog-manifest: pack duplicado' };
    seen.add(f.id);
    files.push({ id: f.id, path: expectedPath, sha256: f.sha256, bytes: f.bytes });
  }
  const value: GeometryCatalogManifest = {
    schemaVersion: 1,
    geometryVersion: o.geometryVersion,
    catalogVersion: o.catalogVersion,
    source: {
      name: String(source.name ?? ''),
      filter: String(source.filter ?? ''),
      license: String(source.license),
      licenseUrl: String(source.licenseUrl ?? IGN_LICENSE_URL),
      fetchedAt: String(source.fetchedAt ?? ''),
      numberMatched: Number(source.numberMatched ?? 0),
    },
    grid: (o.grid as GridConfig) ?? DEFAULT_GRID,
    packs: {
      pathPrefix: String(packs.pathPrefix ?? `g/${o.geometryVersion}/packs/`),
      fileCount: files.length,
      totalBytes: Number(packs.totalBytes ?? 0),
      maxFileBytes: Number(packs.maxFileBytes ?? 0),
      files,
    },
  };
  if (o.simplification && typeof o.simplification === 'object' && !Array.isArray(o.simplification)) {
    const s = o.simplification as { toleranceM?: unknown; note?: unknown };
    if (typeof s.toleranceM === 'number' && typeof s.note === 'string') {
      value.simplification = { toleranceM: s.toleranceM, note: s.note };
    }
  }
  return { ok: true, value };
}

export function parseMunicipalityCatalog(
  raw: unknown,
): { ok: true; value: MunicipalityCatalogDocument } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'municipality-catalog: no es objeto' };
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== 1) return { ok: false, reason: 'municipality-catalog: schemaVersion' };
  if (typeof o.catalogVersion !== 'string' || !VERSION_RE.test(o.catalogVersion)) {
    return { ok: false, reason: 'municipality-catalog: catalogVersion' };
  }
  if (typeof o.generatedAt !== 'string') return { ok: false, reason: 'municipality-catalog: generatedAt' };
  if (typeof o.ineCount !== 'number' || !Number.isInteger(o.ineCount) || o.ineCount < 1) {
    return { ok: false, reason: 'municipality-catalog: ineCount' };
  }
  if (!o.relations || typeof o.relations !== 'object' || Array.isArray(o.relations)) {
    return { ok: false, reason: 'municipality-catalog: relations' };
  }
  if (!Array.isArray(o.ineWithoutMinetur)) {
    return { ok: false, reason: 'municipality-catalog: ineWithoutMinetur' };
  }
  const relations: Record<string, string[]> = {};
  for (const [ine, ids] of Object.entries(o.relations as Record<string, unknown>)) {
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === 'string')) {
      return { ok: false, reason: `municipality-catalog: relations[${ine}]` };
    }
    // Dedup preservando orden estable
    relations[ine] = [...new Set(ids.map(String))];
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      catalogVersion: o.catalogVersion,
      generatedAt: o.generatedAt,
      ineCount: o.ineCount,
      relations,
      ineWithoutMinetur: (o.ineWithoutMinetur as unknown[]).map(String),
    },
  };
}

export function verifyGeometryIndependentOfPrices(input: {
  geometryVersion: string;
  stationsDatasetVersion: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.geometryVersion || input.geometryVersion === input.stationsDatasetVersion) {
    return {
      ok: false,
      reason: 'geometryVersion debe ser independiente del datasetVersion de precios',
    };
  }
  return { ok: true };
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

/** Copia g/ completo desde live → staging (preserva entre syncs de precios). */
export function preserveGeometryTreeFromLive(liveDir: string, stagingDir: string): void {
  const src = path.join(liveDir, 'g');
  if (!fs.existsSync(src)) return;
  const dest = path.join(stagingDir, 'g');
  if (fs.existsSync(dest)) return;
  copyDir(src, dest);
}

export function readGeometryCurrent(rootDir: string): GeometryCurrent | null {
  const p = path.join(rootDir, GEOMETRY_CURRENT_REL);
  if (!fs.existsSync(p)) return null;
  const parsed = parseGeometryCurrent(JSON.parse(fs.readFileSync(p, 'utf8')));
  return parsed.ok ? parsed.value : null;
}

/**
 * Valida el árbol g/ presente en rootDir (activo + retenidas declaradas).
 */
export function assertGeometryTreeCoherent(
  rootDir: string,
  options?: { requirePresent?: boolean },
): { ok: true; current: GeometryCurrent | null } | { ok: false; reason: string } {
  const currentPath = path.join(rootDir, GEOMETRY_CURRENT_REL);
  const currentExists = fs.existsSync(currentPath);

  if (!currentExists) {
    if (options?.requirePresent) {
      return { ok: false, reason: 'Geometría declarada como requerida pero g/current.json ausente' };
    }
    // Legacy / sin municipal: OK
    return { ok: true, current: null };
  }

  const currentParsed = parseGeometryCurrent(JSON.parse(fs.readFileSync(currentPath, 'utf8')));
  if (!currentParsed.ok) return { ok: false, reason: currentParsed.reason };
  const current = currentParsed.value;

  const versions = [current.geometryVersion, ...current.retainedVersions];
  for (const version of versions) {
    const manifestPath = path.join(rootDir, geometryManifestRel(version));
    const catalogPath = path.join(rootDir, geometryCatalogRel(version));
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, reason: `Falta manifiesto de geometría ${version}` };
    }
    if (!fs.existsSync(catalogPath)) {
      return { ok: false, reason: `Falta municipality-catalog ${version}` };
    }
    const manifestParsed = parseGeometryCatalogManifest(
      JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    );
    if (!manifestParsed.ok) return { ok: false, reason: manifestParsed.reason };
    if (manifestParsed.value.geometryVersion !== version) {
      return { ok: false, reason: `geometryVersion de carpeta ${version} no coincide` };
    }
    const catalogParsed = parseMunicipalityCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf8')));
    if (!catalogParsed.ok) return { ok: false, reason: catalogParsed.reason };
    if (catalogParsed.value.catalogVersion !== manifestParsed.value.catalogVersion) {
      return { ok: false, reason: `catalogVersion incoherente en ${version}` };
    }

    for (const file of manifestParsed.value.packs.files) {
      const abs = path.join(rootDir, file.path);
      if (!fs.existsSync(abs)) {
        return { ok: false, reason: `Falta pack geométrico ${file.path}` };
      }
      const body = fs.readFileSync(abs);
      if (sha256Hex(body) !== file.sha256) {
        return { ok: false, reason: `Hash distinto en pack ${file.path}` };
      }
    }
  }

  return { ok: true, current };
}

/**
 * Aplica punteros municipales opcionales en current.json del staging/live
 * sin mutar archivos bajo v/{datasetVersion}/cells.
 */
export function applyMunicipalPointersToCurrent(
  rootDir: string,
  input: {
    datasetVersion: string;
    geometry?: GeometryCurrent | null;
  },
): void {
  const currentPath = path.join(rootDir, 'current.json');
  if (!fs.existsSync(currentPath)) return;
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as Record<string, unknown>;
  const cellsRel = municipalityCellsRelPath(input.datasetVersion);
  if (fs.existsSync(path.join(rootDir, cellsRel))) {
    current.municipalityCellsPath = cellsRel;
  } else {
    delete current.municipalityCellsPath;
  }
  if (input.geometry) {
    current.geometryCurrentPath = GEOMETRY_CURRENT_REL;
    current.geometryCatalogPath = input.geometry.manifestPath;
  } else {
    delete current.geometryCurrentPath;
    delete current.geometryCatalogPath;
  }
  fs.writeFileSync(currentPath, `${JSON.stringify(current)}\n`, 'utf8');
}

export function assertMunicipalityCellsFileCoherent(
  rootDir: string,
  manifest: Manifest,
): { ok: true } | { ok: false; reason: string } {
  const rel = municipalityCellsRelPath(manifest.datasetVersion);
  const abs = path.join(rootDir, rel);
  if (!fs.existsSync(abs)) {
    // Opcional en árboles legacy; si current lo declara, falla abajo.
    return { ok: true };
  }
  const parsed = parseMunicipalityCellsDocument(JSON.parse(fs.readFileSync(abs, 'utf8')));
  if (!parsed.ok) return parsed;
  if (
    parsed.doc.datasetVersion !== manifest.datasetVersion ||
    parsed.doc.contentHash !== manifest.contentHash
  ) {
    return { ok: false, reason: 'municipality-cells no coincide con dataset activo' };
  }

  const cells: CellFile[] = [];
  for (const entry of manifest.cells) {
    const cellAbs = path.join(rootDir, entry.path);
    if (!fs.existsSync(cellAbs)) {
      return { ok: false, reason: `Falta celda para validar municipality-cells: ${entry.path}` };
    }
    cells.push(JSON.parse(fs.readFileSync(cellAbs, 'utf8')) as CellFile);
  }
  return validateMunicipalityCellsCoverage({ doc: parsed.doc, cells });
}

/**
 * Construye el árbol publicado g/{version}/ a partir de un directorio fuente local
 * (packs + manifiesto/relaciones de build offline). No descarga IGN.
 */
export function buildGeometryPublishFiles(input: {
  geometryVersion: string;
  catalogVersion: string;
  packsDir: string;
  sourceManifest: Record<string, unknown>;
  relations: {
    relations: Record<string, string[]>;
    ineWithoutMinetur: string[];
    ineCount?: number;
    generatedAt?: string;
  };
  publishedAt: string;
  previousGeometryVersion?: string | null;
  retainGeometryVersions?: number;
}): { ok: true; files: Map<string, string>; current: GeometryCurrent } | { ok: false; reason: string } {
  if (!isGeometryVersion(input.geometryVersion)) {
    return { ok: false, reason: 'geometryVersion inválida' };
  }
  if (!VERSION_RE.test(input.catalogVersion)) {
    return { ok: false, reason: 'catalogVersion inválida' };
  }
  if (!fs.existsSync(input.packsDir)) {
    return { ok: false, reason: `packsDir inexistente: ${input.packsDir}` };
  }

  const packFiles = fs
    .readdirSync(input.packsDir)
    .filter((n) => n.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (packFiles.length === 0) return { ok: false, reason: 'Sin packs en packsDir' };

  const files = new Map<string, string>();
  const entries: GeometryPackFileEntry[] = [];
  let totalBytes = 0;
  let maxFileBytes = 0;

  for (const name of packFiles) {
    const cellId = name.replace(/\.json$/, '');
    if (!CELL_ID_RE.test(cellId)) {
      return { ok: false, reason: `Nombre de pack inválido: ${name}` };
    }
    const body = fs.readFileSync(path.join(input.packsDir, name));
    const text = body.toString('utf8');
    const normalized = text.endsWith('\n') ? text : `${text}\n`;
    const rel = geometryPackRel(input.geometryVersion, cellId);
    const sha = sha256Hex(normalized);
    const bytes = Buffer.byteLength(normalized, 'utf8');
    files.set(rel, normalized);
    entries.push({ id: cellId, path: rel, sha256: sha, bytes });
    totalBytes += bytes;
    if (bytes > maxFileBytes) maxFileBytes = bytes;
  }

  const src = input.sourceManifest;
  const sourceObj = (src.source as Record<string, unknown>) ?? {};
  const manifest: GeometryCatalogManifest = {
    schemaVersion: 1,
    geometryVersion: input.geometryVersion,
    catalogVersion: input.catalogVersion,
    source: {
      name: String(sourceObj.name ?? 'IGN API-Features administrativeunit'),
      filter: String(sourceObj.filter ?? "nationallevelname='Municipio'"),
      license: String(sourceObj.license ?? IGN_LICENSE),
      licenseUrl: String(sourceObj.licenseUrl ?? IGN_LICENSE_URL),
      fetchedAt: String(sourceObj.fetchedAt ?? input.publishedAt),
      numberMatched: Number(sourceObj.numberMatched ?? entries.length),
    },
    grid: (src.grid as GridConfig) ?? DEFAULT_GRID,
    packs: {
      pathPrefix: `g/${input.geometryVersion}/packs/`,
      fileCount: entries.length,
      totalBytes,
      maxFileBytes,
      files: entries,
    },
  };
  if (src.simplification && typeof src.simplification === 'object' && !Array.isArray(src.simplification)) {
    const s = src.simplification as { toleranceM?: unknown; note?: unknown };
    if (typeof s.toleranceM === 'number' && typeof s.note === 'string') {
      manifest.simplification = { toleranceM: s.toleranceM, note: s.note };
    }
  }

  if (!manifest.source.license.includes('CC BY')) {
    return { ok: false, reason: 'Atribución IGN CC BY obligatoria' };
  }

  const relations: Record<string, string[]> = {};
  const without = new Set(input.relations.ineWithoutMinetur.map(String));
  for (const [ine, ids] of Object.entries(input.relations.relations)) {
    const deduped = [...new Set(ids.map(String).filter((x) => x.length > 0))];
    if (deduped.length === 0) {
      without.add(ine);
      continue;
    }
    relations[ine] = deduped;
  }

  const catalog: MunicipalityCatalogDocument = {
    schemaVersion: 1,
    catalogVersion: input.catalogVersion,
    generatedAt: input.relations.generatedAt ?? input.publishedAt,
    ineCount: input.relations.ineCount ?? Object.keys(input.relations.relations).length,
    relations,
    ineWithoutMinetur: [...without].sort((a, b) => a.localeCompare(b, 'en')),
  };

  files.set(geometryManifestRel(input.geometryVersion), stableStringify(manifest));
  files.set(geometryCatalogRel(input.geometryVersion), stableStringify(catalog));

  const retainN = input.retainGeometryVersions ?? 1;
  const retained: string[] = [];
  if (
    retainN > 0 &&
    input.previousGeometryVersion &&
    isGeometryVersion(input.previousGeometryVersion) &&
    input.previousGeometryVersion !== input.geometryVersion
  ) {
    retained.push(input.previousGeometryVersion);
  }

  const current: GeometryCurrent = {
    schemaVersion: 1,
    geometryVersion: input.geometryVersion,
    catalogVersion: input.catalogVersion,
    manifestPath: geometryManifestRel(input.geometryVersion),
    catalogPath: geometryCatalogRel(input.geometryVersion),
    publishedAt: input.publishedAt,
    retainedVersions: retained,
    attribution: {
      sourceName: manifest.source.name,
      license: manifest.source.license,
      licenseUrl: manifest.source.licenseUrl,
    },
  };
  files.set(GEOMETRY_CURRENT_REL, stableStringify(current));

  return { ok: true, files, current };
}

/**
 * Incorporación explícita de geometría al live de precios (no bootstrap ante fallo).
 * - Escribe g/{version}/
 * - Retiene geometría previa acotada
 * - Añade municipality-cells al dataset activo sin mutar celdas/manifiesto de precios
 */
export function incorporateGeometryIntoLive(input: {
  liveDir: string;
  geometryFiles: Map<string, string>;
  geometryCurrent: GeometryCurrent;
  retainGeometryVersions: number;
  allowInitialGeometry: boolean;
}): { ok: true; metrics: { fileCount: number; totalBytes: number } } | { ok: false; reason: string } {
  if (!fs.existsSync(path.join(input.liveDir, 'manifest.json'))) {
    return { ok: false, reason: 'No hay live de precios; incorpora geometría solo sobre CDN de precios válido' };
  }

  const existing = readGeometryCurrent(input.liveDir);
  if (!existing && !input.allowInitialGeometry) {
    return {
      ok: false,
      reason:
        'Incorporación inicial de geometría requiere --allow-initial-geometry (explícita). Un fallo de recover no cuenta como primera geometría.',
    };
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(input.liveDir, 'manifest.json'), 'utf8')) as Manifest;
  const indep = verifyGeometryIndependentOfPrices({
    geometryVersion: input.geometryCurrent.geometryVersion,
    stationsDatasetVersion: manifest.datasetVersion,
  });
  if (!indep.ok) return indep;

  const staging = `${input.liveDir}.geometry-staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  copyDir(input.liveDir, staging);

  // Eliminar g/ del staging y escribir la nueva (más retención).
  fs.rmSync(path.join(staging, 'g'), { recursive: true, force: true });

  for (const [rel, body] of input.geometryFiles) {
    const abs = path.join(staging, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }

  // Retener versión geométrica anterior desde live si se declara.
  if (input.retainGeometryVersions > 0 && existing) {
    const prev = existing.geometryVersion;
    if (prev !== input.geometryCurrent.geometryVersion) {
      const prevSrc = path.join(input.liveDir, 'g', prev);
      const prevDest = path.join(staging, 'g', prev);
      if (fs.existsSync(prevSrc) && !fs.existsSync(prevDest)) {
        copyDir(prevSrc, prevDest);
      }
    }
  }

  // municipality-cells: solo se añade si falta (migración legacy).
  // Si ya existe bajo v/{datasetVersion}/ es URL inmutable → no regenerar ni sobrescribir.
  const cells: CellFile[] = [];
  const stationCellIds: { idMunicipality: string; cellId: string }[] = [];
  for (const entry of manifest.cells) {
    const cell = JSON.parse(fs.readFileSync(path.join(staging, entry.path), 'utf8')) as CellFile;
    cells.push(cell);
    for (const st of cell.stations) {
      stationCellIds.push({ idMunicipality: st.idMunicipality, cellId: cell.cellId });
    }
  }
  const cellsRel = municipalityCellsRelPath(manifest.datasetVersion);
  const cellsAbsLive = path.join(input.liveDir, cellsRel);
  const cellsAbsStaging = path.join(staging, cellsRel);
  if (fs.existsSync(cellsAbsLive)) {
    // Conservar bytes publicados; validar cobertura más abajo.
    if (!fs.existsSync(cellsAbsStaging)) {
      fs.mkdirSync(path.dirname(cellsAbsStaging), { recursive: true });
      fs.copyFileSync(cellsAbsLive, cellsAbsStaging);
    }
  } else {
    const cellsDoc = buildMunicipalityCellsDocument({
      datasetVersion: manifest.datasetVersion,
      contentHash: manifest.contentHash,
      stations: cells.flatMap((c) => c.stations),
      stationCellIds,
      grid: manifest.grid,
      generatedAt: input.geometryCurrent.publishedAt,
    });
    const cov = validateMunicipalityCellsCoverage({ doc: cellsDoc, cells });
    if (!cov.ok) {
      fs.rmSync(staging, { recursive: true, force: true });
      return cov;
    }
    fs.mkdirSync(path.dirname(cellsAbsStaging), { recursive: true });
    fs.writeFileSync(cellsAbsStaging, serializeMunicipalityCellsDocument(cellsDoc), 'utf8');
  }

  applyMunicipalPointersToCurrent(staging, {
    datasetVersion: manifest.datasetVersion,
    geometry: input.geometryCurrent,
  });

  const geoCheck = assertGeometryTreeCoherent(staging, { requirePresent: true });
  if (!geoCheck.ok) {
    fs.rmSync(staging, { recursive: true, force: true });
    return geoCheck;
  }
  const cellsCheck = assertMunicipalityCellsFileCoherent(staging, manifest);
  if (!cellsCheck.ok) {
    fs.rmSync(staging, { recursive: true, force: true });
    return cellsCheck;
  }

  // Inmutabilidad: ningún archivo preexistente bajo v/{datasetVersion}/ puede cambiar de bytes.
  // Solo se permite añadir municipality-cells.json si antes no existía.
  const versionDirRel = `v/${manifest.datasetVersion}`;
  const liveVersionDir = path.join(input.liveDir, versionDirRel);
  const stagingVersionDir = path.join(staging, versionDirRel);
  if (fs.existsSync(liveVersionDir)) {
    const walkImmutable = (dir: string, relBase: string, out: Map<string, Buffer>): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walkImmutable(abs, rel, out);
        else out.set(rel.replace(/\\/g, '/'), fs.readFileSync(abs));
      }
    };
    const beforeFiles = new Map<string, Buffer>();
    const afterFiles = new Map<string, Buffer>();
    walkImmutable(liveVersionDir, versionDirRel, beforeFiles);
    walkImmutable(stagingVersionDir, versionDirRel, afterFiles);
    for (const [rel, before] of beforeFiles) {
      const after = afterFiles.get(rel);
      if (!after) {
        fs.rmSync(staging, { recursive: true, force: true });
        return { ok: false, reason: `Desapareció archivo inmutable ${rel}` };
      }
      if (!before.equals(after)) {
        fs.rmSync(staging, { recursive: true, force: true });
        return { ok: false, reason: `Se mutó archivo inmutable preexistente ${rel}` };
      }
    }
    for (const rel of afterFiles.keys()) {
      if (beforeFiles.has(rel)) continue;
      if (rel !== cellsRel) {
        fs.rmSync(staging, { recursive: true, force: true });
        return {
          ok: false,
          reason: `Archivo nuevo inesperado bajo ${versionDirRel}: ${rel} (solo se permite municipality-cells)`,
        };
      }
    }
  }

  const bak = `${input.liveDir}.bak`;
  fs.rmSync(bak, { recursive: true, force: true });
  try {
    copyDir(input.liveDir, bak);
    fs.rmSync(input.liveDir, { recursive: true, force: true });
    copyDir(staging, input.liveDir);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(bak, { recursive: true, force: true });
  } catch (err) {
    if (!fs.existsSync(input.liveDir) && fs.existsSync(bak)) {
      try {
        copyDir(bak, input.liveDir);
      } catch {
        /* ignore */
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Fallo al incorporar geometría (live previo restaurado si era posible): ${msg}` };
  }

  let totalBytes = 0;
  for (const body of input.geometryFiles.values()) totalBytes += Buffer.byteLength(body, 'utf8');
  return { ok: true, metrics: { fileCount: input.geometryFiles.size, totalBytes } };
}
