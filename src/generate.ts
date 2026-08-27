import { createHash } from 'node:crypto';
import { cellForLatLonText } from './partition.ts';
import type {
  GenerateResult,
  GridConfig,
  Manifest,
  ManifestCellEntry,
  ParsedDataset,
  PipelineConfig,
  PublicStation,
  StationRecord,
} from './types.ts';
import { ATTRIBUTION, DEFAULT_PIPELINE_CONFIG } from './types.ts';

function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 0)}\n`;
}

function toPublicStation(s: StationRecord, prices: Record<string, string>): PublicStation {
  const sortedPrices: Record<string, string> = {};
  for (const key of Object.keys(prices).sort()) {
    const v = prices[key];
    if (v !== undefined) sortedPrices[key] = v;
  }
  return {
    id: s.ideess,
    name: s.rotulo,
    address: s.direccion,
    postalCode: s.codigoPostal,
    locality: s.localidad,
    municipality: s.municipio,
    idMunicipality: s.idMunicipio,
    idProvince: s.idProvincia,
    idCcaa: s.idCcaa,
    lat: s.latitudText,
    lon: s.longitudText,
    schedule: s.horario,
    saleType: s.tipoVenta,
    remision: s.remision,
    margen: s.margen,
    prices: sortedPrices,
  };
}

function pricesByStation(dataset: ParsedDataset): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  for (const p of dataset.prices) {
    let row = map.get(p.ideess);
    if (!row) {
      row = {};
      map.set(p.ideess, row);
    }
    row[p.productKey] = p.priceText;
  }
  return map;
}

/**
 * Genera JSON particionado + manifiesto de forma determinista
 * (mismo input → mismos bytes, salvo downloadedAt/publishedAt en el manifiesto).
 */
export function generatePartitionedDataset(
  dataset: ParsedDataset,
  options: {
    downloadedAt: string;
    publishedAt?: string | null;
    config?: PipelineConfig;
  },
): GenerateResult {
  const config = options.config ?? DEFAULT_PIPELINE_CONFIG;
  const grid: GridConfig = config.grid;
  const datasetVersion = dataset.contentHash.slice(0, 16);
  const priceMap = pricesByStation(dataset);

  const buckets = new Map<string, PublicStation[]>();
  for (const s of dataset.stations) {
    const cell = cellForLatLonText(s.latitudText, s.longitudText, grid);
    const station = toPublicStation(s, priceMap.get(s.ideess) ?? {});
    const list = buckets.get(cell.id);
    if (list) list.push(station);
    else buckets.set(cell.id, [station]);
  }

  for (const list of buckets.values()) {
    list.sort((a, b) => a.id.localeCompare(b.id));
  }

  const files = new Map<string, string>();
  const cellEntries: ManifestCellEntry[] = [];
  let totalBytes = 0;
  const sortedCellIds = [...buckets.keys()].sort((a, b) => a.localeCompare(b));

  for (const cellId of sortedCellIds) {
    const stations = buckets.get(cellId) ?? [];
    const cellBody = {
      cellId,
      datasetVersion,
      contentHash: dataset.contentHash,
      stationCount: stations.length,
      stations,
    };
    const path = `v/${datasetVersion}/cells/${cellId}.json`;
    const body = stableStringify(cellBody);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const bytes = Buffer.byteLength(body, 'utf8');
    files.set(path, body);
    cellEntries.push({ id: cellId, path, count: stations.length, sha256, bytes });
    totalBytes += bytes;
  }

  const publishedAt = options.publishedAt === undefined ? null : options.publishedAt;

  const manifest: Manifest = {
    schemaVersion: 1,
    datasetVersion,
    contentHash: dataset.contentHash,
    sourceFecha: dataset.sourceFecha,
    downloadedAt: options.downloadedAt,
    publishedAt,
    nota: dataset.nota,
    attribution: { ...ATTRIBUTION },
    grid,
    stationCount: dataset.stations.length,
    priceCount: dataset.prices.length,
    fileCount: cellEntries.length + 1,
    totalBytes: 0,
    staleAfterMinutes: config.staleAfterMinutes,
    cells: cellEntries,
  };

  // Manifiesto versionado (inmutable) + puntero current.
  const versionedManifestPath = `v/${datasetVersion}/manifest.json`;
  const versionedManifestBody = stableStringify(manifest);
  const versionedBytes = Buffer.byteLength(versionedManifestBody, 'utf8');
  files.set(versionedManifestPath, versionedManifestBody);

  manifest.totalBytes = totalBytes + versionedBytes;
  manifest.fileCount = files.size + 1; // + current.json al publicar

  // Recalcular cuerpo versionado con totalBytes definitivo.
  const versionedFinal = stableStringify(manifest);
  files.set(versionedManifestPath, versionedFinal);
  manifest.totalBytes = totalBytes + Buffer.byteLength(versionedFinal, 'utf8');

  const currentPointer = {
    schemaVersion: 1 as const,
    datasetVersion,
    contentHash: dataset.contentHash,
    sourceFecha: dataset.sourceFecha,
    downloadedAt: options.downloadedAt,
    publishedAt,
    manifestPath: versionedManifestPath,
    staleAfterMinutes: config.staleAfterMinutes,
    attribution: { ...ATTRIBUTION },
  };
  files.set('current.json', stableStringify(currentPointer));
  // También servir manifesto.json como alias del puntero para clientes simples.
  files.set('manifest.json', stableStringify(manifest));

  return {
    datasetVersion,
    contentHash: dataset.contentHash,
    sourceFecha: dataset.sourceFecha,
    stationCount: dataset.stations.length,
    priceCount: dataset.prices.length,
    cellCount: cellEntries.length,
    files,
    manifest,
  };
}

/** Serialización determinista para pruebas de igualdad byte a byte (excluye fechas de reloj). */
export function stripClockFields(
  manifest: Manifest,
): Omit<Manifest, 'downloadedAt' | 'publishedAt' | 'lastSuccessfulFetchAt'> {
  const { downloadedAt: _d, publishedAt: _p, lastSuccessfulFetchAt: _l, ...rest } = manifest;
  return rest;
}
