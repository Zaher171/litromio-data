/**
 * Índice idMunicipality (Minetur) → celdas del dataset de precios.
 * Ligado a datasetVersion/contentHash; se regenera solo con el pipeline de precios.
 */
import { createHash } from 'node:crypto';
import type { CellFile, GridConfig, PublicStation } from './types.ts';
import { DEFAULT_GRID } from './types.ts';

export interface MunicipalityCellsDocument {
  schemaVersion: 1;
  datasetVersion: string;
  contentHash: string;
  generatedAt: string;
  grid: GridConfig;
  /** idMunicipality → cellIds ordenados. */
  municipalities: Record<string, string[]>;
  /** IDs Minetur vistos en el dataset (estaciones) al generar. */
  knownMunicipalityIds: string[];
}

export function municipalityCellsRelPath(datasetVersion: string): string {
  return `v/${datasetVersion}/municipality-cells.json`;
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 0)}\n`;
}

/**
 * Construye el índice a partir de las estaciones ya particionadas (mismo dataset).
 */
export function buildMunicipalityCellsDocument(input: {
  datasetVersion: string;
  contentHash: string;
  stations: Iterable<Pick<PublicStation, 'idMunicipality' | 'lat' | 'lon'>>;
  grid?: GridConfig;
  generatedAt?: string;
  /** cellId explícito por estación si ya se conoce (preferible; evita re-particionar). */
  stationCellIds?: Iterable<{ idMunicipality: string; cellId: string }>;
}): MunicipalityCellsDocument {
  const grid = input.grid ?? DEFAULT_GRID;
  const munToCells = new Map<string, Set<string>>();

  if (input.stationCellIds) {
    for (const row of input.stationCellIds) {
      const id = String(row.idMunicipality ?? '').trim();
      if (!id) continue;
      let set = munToCells.get(id);
      if (!set) {
        set = new Set();
        munToCells.set(id, set);
      }
      set.add(row.cellId);
    }
  } else {
    for (const st of input.stations) {
      const id = String(st.idMunicipality ?? '').trim();
      if (!id) continue;
      const lat = Number(st.lat);
      const lon = Number(st.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // Misma cuadrícula que generate/partition (origen + tamaño).
      const iLat = Math.floor((lat - grid.latOrigin) / grid.cellSizeDeg);
      const iLon = Math.floor((lon - grid.lonOrigin) / grid.cellSizeDeg);
      const cellId = `${iLat}_${iLon}`;
      let set = munToCells.get(id);
      if (!set) {
        set = new Set();
        munToCells.set(id, set);
      }
      set.add(cellId);
    }
  }

  const municipalities: Record<string, string[]> = {};
  for (const [id, set] of [...munToCells.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
    municipalities[id] = [...set].sort((a, b) => a.localeCompare(b, 'en'));
  }

  const knownMunicipalityIds = [...munToCells.keys()].sort((a, b) => a.localeCompare(b, 'en'));

  return {
    schemaVersion: 1,
    datasetVersion: input.datasetVersion,
    contentHash: input.contentHash,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    grid,
    municipalities,
    knownMunicipalityIds,
  };
}

export function serializeMunicipalityCellsDocument(doc: MunicipalityCellsDocument): string {
  return stableStringify(doc);
}

export function sha256OfMunicipalityCells(doc: MunicipalityCellsDocument): string {
  return createHash('sha256').update(serializeMunicipalityCellsDocument(doc)).digest('hex');
}

export function parseMunicipalityCellsDocument(
  raw: unknown,
): { ok: true; doc: MunicipalityCellsDocument } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'municipality-cells: no es objeto' };
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== 1) return { ok: false, reason: 'municipality-cells: schemaVersion' };
  if (typeof o.datasetVersion !== 'string' || !/^[a-f0-9]{16}$/.test(o.datasetVersion)) {
    return { ok: false, reason: 'municipality-cells: datasetVersion' };
  }
  if (typeof o.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(o.contentHash)) {
    return { ok: false, reason: 'municipality-cells: contentHash' };
  }
  if (o.datasetVersion !== o.contentHash.slice(0, 16)) {
    return { ok: false, reason: 'municipality-cells: datasetVersion no deriva de contentHash' };
  }
  if (typeof o.generatedAt !== 'string') return { ok: false, reason: 'municipality-cells: generatedAt' };
  if (!o.grid || typeof o.grid !== 'object' || Array.isArray(o.grid)) {
    return { ok: false, reason: 'municipality-cells: grid' };
  }
  if (!o.municipalities || typeof o.municipalities !== 'object' || Array.isArray(o.municipalities)) {
    return { ok: false, reason: 'municipality-cells: municipalities' };
  }
  if (!Array.isArray(o.knownMunicipalityIds)) {
    return { ok: false, reason: 'municipality-cells: knownMunicipalityIds' };
  }

  const municipalities: Record<string, string[]> = {};
  for (const [id, cells] of Object.entries(o.municipalities as Record<string, unknown>)) {
    if (!Array.isArray(cells) || !cells.every((c) => typeof c === 'string')) {
      return { ok: false, reason: `municipality-cells: cellIds inválidos para ${id}` };
    }
    municipalities[id] = cells as string[];
  }

  return {
    ok: true,
    doc: {
      schemaVersion: 1,
      datasetVersion: o.datasetVersion,
      contentHash: o.contentHash,
      generatedAt: o.generatedAt,
      grid: o.grid as GridConfig,
      municipalities,
      knownMunicipalityIds: (o.knownMunicipalityIds as unknown[]).map(String),
    },
  };
}

/**
 * Cobertura completa: cada estación del dataset aparece bajo su idMunicipality
 * en una celda que contiene esa estación.
 */
export function validateMunicipalityCellsCoverage(input: {
  doc: MunicipalityCellsDocument;
  cells: Iterable<Pick<CellFile, 'cellId' | 'stations'>>;
}): { ok: true } | { ok: false; reason: string } {
  const expectedByMun = new Map<string, Set<string>>();
  const stationCell = new Map<string, string>();

  for (const cell of input.cells) {
    for (const st of cell.stations) {
      const mun = String(st.idMunicipality ?? '').trim();
      if (!mun) continue;
      let set = expectedByMun.get(mun);
      if (!set) {
        set = new Set();
        expectedByMun.set(mun, set);
      }
      set.add(st.id);
      stationCell.set(st.id, cell.cellId);
    }
  }

  for (const [mun, stationIds] of expectedByMun) {
    const cellIds = input.doc.municipalities[mun];
    if (!cellIds || cellIds.length === 0) {
      return { ok: false, reason: `municipality-cells: falta cobertura para idMunicipality ${mun}` };
    }
    const recovered = new Set<string>();
    for (const cellId of cellIds) {
      for (const cell of input.cells) {
        if (cell.cellId !== cellId) continue;
        for (const st of cell.stations) {
          if (String(st.idMunicipality) === mun) recovered.add(st.id);
        }
      }
    }
    for (const sid of stationIds) {
      if (!recovered.has(sid)) {
        return {
          ok: false,
          reason: `municipality-cells: estación ${sid} (municipio ${mun}) no cubierta por cellIds`,
        };
      }
      const ownCell = stationCell.get(sid);
      if (ownCell && !cellIds.includes(ownCell)) {
        return {
          ok: false,
          reason: `municipality-cells: celda ${ownCell} de estación ${sid} ausente del índice`,
        };
      }
    }
  }

  if (input.doc.datasetVersion !== input.doc.contentHash.slice(0, 16)) {
    return { ok: false, reason: 'municipality-cells: versión incompatible con contentHash' };
  }

  return { ok: true };
}

/** Une cellIds de varios IDs Minetur (fusiones) y deduplica. */
export function cellIdsForMunicipalityIds(
  idMunicipalities: readonly string[],
  municipalities: Readonly<Record<string, readonly string[]>>,
): string[] {
  const set = new Set<string>();
  for (const id of idMunicipalities) {
    for (const cellId of municipalities[String(id)] ?? []) set.add(cellId);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'en'));
}
