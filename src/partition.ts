import type { GridConfig } from './types.ts';
import { DEFAULT_GRID } from './types.ts';

export interface CellCoord {
  iLat: number;
  iLon: number;
  id: string;
}

/** Identificador estable de celda: `iLat_iLon` (índices enteros desde el origen). */
export function cellIdFromIndices(iLat: number, iLon: number): string {
  return `${iLat}_${iLon}`;
}

export function parseCellId(id: string): { iLat: number; iLon: number } | null {
  const m = /^(-?\d+)_(-?\d+)$/.exec(id);
  if (!m) return null;
  return { iLat: Number(m[1]), iLon: Number(m[2]) };
}

export function cellForLatLon(
  lat: number,
  lon: number,
  grid: GridConfig = DEFAULT_GRID,
): CellCoord {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('lat/lon no finitos');
  }
  const iLat = Math.floor((lat - grid.latOrigin) / grid.cellSizeDeg);
  const iLon = Math.floor((lon - grid.lonOrigin) / grid.cellSizeDeg);
  return { iLat, iLon, id: cellIdFromIndices(iLat, iLon) };
}

export function cellForLatLonText(
  latText: string,
  lonText: string,
  grid: GridConfig = DEFAULT_GRID,
): CellCoord {
  return cellForLatLon(Number(latText), Number(lonText), grid);
}

/**
 * Celdas necesarias para un radio aproximado alrededor de un punto.
 * Incluye siempre la 3×3 (celda + 8 vecinas). Si el radio supera ~cellSize/√2
 * en km, amplía el anillo (conservador).
 *
 * Aprox.: 1° lat ≈ 111 km; lon ≈ 111·cos(lat) km.
 */
export function cellsForNearbySearch(
  lat: number,
  lon: number,
  radiusKm: number,
  grid: GridConfig = DEFAULT_GRID,
): string[] {
  const center = cellForLatLon(lat, lon, grid);
  const latKm = 111;
  const lonKm = 111 * Math.cos((lat * Math.PI) / 180);
  const cellKmLat = grid.cellSizeDeg * latKm;
  const cellKmLon = grid.cellSizeDeg * Math.max(lonKm, 1);
  const ringLat = Math.max(1, Math.ceil(radiusKm / cellKmLat));
  const ringLon = Math.max(1, Math.ceil(radiusKm / cellKmLon));
  const ring = Math.max(ringLat, ringLon);

  const ids: string[] = [];
  for (let dLat = -ring; dLat <= ring; dLat += 1) {
    for (let dLon = -ring; dLon <= ring; dLon += 1) {
      ids.push(cellIdFromIndices(center.iLat + dLat, center.iLon + dLon));
    }
  }
  return ids;
}

/** Vecinas inmediatas (incluye la propia). */
export function neighboringCellIds(cellId: string): string[] {
  const parsed = parseCellId(cellId);
  if (!parsed) return [];
  const ids: string[] = [];
  for (let dLat = -1; dLat <= 1; dLat += 1) {
    for (let dLon = -1; dLon <= 1; dLon += 1) {
      ids.push(cellIdFromIndices(parsed.iLat + dLat, parsed.iLon + dLon));
    }
  }
  return ids;
}
