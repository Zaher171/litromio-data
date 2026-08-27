import { createHash } from 'node:crypto';
import { normalizeCoordText, normalizePriceText } from './prices.ts';
import {
  PRICE_FIELD_TO_KEY,
  type ParsedDataset,
  type PriceRecord,
  type RawFuenteResponse,
  type StationRecord,
} from './types.ts';

export class ValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function field(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (k in row) return row[k];
  }
  return undefined;
}

function requiredText(row: Record<string, unknown>, keys: string[], label: string): string {
  const v = field(row, ...keys);
  if (v === null || v === undefined) {
    throw new ValidationError('station_field', `Falta ${label}`);
  }
  return String(v).trim();
}

/**
 * Valida y normaliza la respuesta nacional.
 * No interpreta una descarga incompleta como bajas masivas: eso se aplica
 * en el pipeline comparando con la versión activa.
 */
export function parseAndValidateFuentePayload(
  payload: string | RawFuenteResponse,
): ParsedDataset {
  let raw: RawFuenteResponse;
  if (typeof payload === 'string') {
    if (payload.trim() === '') {
      throw new ValidationError('empty_body', 'Cuerpo de respuesta vacío');
    }
    try {
      raw = JSON.parse(payload) as RawFuenteResponse;
    } catch {
      throw new ValidationError('invalid_json', 'JSON inválido');
    }
  } else {
    raw = payload;
  }

  if (raw.ResultadoConsulta !== 'OK') {
    throw new ValidationError(
      'resultado_no_ok',
      `ResultadoConsulta=${String(raw.ResultadoConsulta)}`,
    );
  }

  if (typeof raw.Fecha !== 'string' || raw.Fecha.trim() === '') {
    throw new ValidationError('missing_fecha', 'Falta Fecha de la fuente');
  }

  if (!Array.isArray(raw.ListaEESSPrecio)) {
    throw new ValidationError('missing_lista', 'ListaEESSPrecio ausente o no es array');
  }

  if (raw.ListaEESSPrecio.length === 0) {
    throw new ValidationError('empty_lista', 'ListaEESSPrecio vacía');
  }

  const stations: StationRecord[] = [];
  const prices: PriceRecord[] = [];
  const seen = new Set<string>();

  for (const item of raw.ListaEESSPrecio) {
    const row = asRecord(item);
    if (!row) {
      throw new ValidationError('station_shape', 'Estación con forma inválida');
    }

    const ideess = requiredText(row, ['IDEESS'], 'IDEESS');
    if (ideess === '') {
      throw new ValidationError('missing_ideess', 'IDEESS vacío');
    }
    if (seen.has(ideess)) {
      throw new ValidationError('duplicate_ideess', `IDEESS duplicado: ${ideess}`);
    }
    seen.add(ideess);

    const latitudText = normalizeCoordText(field(row, 'Latitud'));
    const longitudText = normalizeCoordText(field(row, 'Longitud (WGS84)', 'Longitud'));
    if (latitudText === null || longitudText === null) {
      throw new ValidationError('coords', `Coordenadas inválidas en IDEESS ${ideess}`);
    }

    stations.push({
      ideess,
      rotulo: requiredText(row, ['Rótulo', 'Rotulo'], 'Rótulo'),
      direccion: requiredText(row, ['Dirección', 'Direccion'], 'Dirección'),
      codigoPostal: requiredText(row, ['C.P.', 'CP'], 'C.P.'),
      localidad: requiredText(row, ['Localidad'], 'Localidad'),
      municipio: requiredText(row, ['Municipio'], 'Municipio'),
      idMunicipio: requiredText(row, ['IDMunicipio'], 'IDMunicipio'),
      idProvincia: requiredText(row, ['IDProvincia'], 'IDProvincia'),
      idCcaa: requiredText(row, ['IDCCAA'], 'IDCCAA'),
      latitudText,
      longitudText,
      horario: String(field(row, 'Horario') ?? '').trim(),
      tipoVenta: String(field(row, 'Tipo Venta', 'TipoVenta') ?? '').trim(),
      remision: String(field(row, 'Remisión', 'Remision') ?? '').trim(),
      margen: String(field(row, 'Margen') ?? '').trim(),
    });

    for (const [fieldName, productKey] of Object.entries(PRICE_FIELD_TO_KEY)) {
      const parsed = normalizePriceText(field(row, fieldName));
      if (!parsed.ok) continue;
      prices.push({ ideess, productKey, priceText: parsed.priceText });
    }
  }

  const contentHash = hashDataset(stations, prices);

  return {
    sourceFecha: raw.Fecha.trim(),
    nota: typeof raw.Nota === 'string' ? raw.Nota : null,
    stations,
    prices,
    contentHash,
  };
}

/** Hash estable del contenido (no incluye Fecha de cabecera ni downloadedAt). */
export function hashDataset(stations: StationRecord[], prices: PriceRecord[]): string {
  const hash = createHash('sha256');
  const sortedStations = [...stations].sort((a, b) => a.ideess.localeCompare(b.ideess));
  for (const s of sortedStations) {
    hash.update(
      [
        s.ideess,
        s.rotulo,
        s.direccion,
        s.codigoPostal,
        s.localidad,
        s.municipio,
        s.idMunicipio,
        s.idProvincia,
        s.idCcaa,
        s.latitudText,
        s.longitudText,
        s.horario,
        s.tipoVenta,
        s.remision,
        s.margen,
      ].join('\u001f'),
    );
    hash.update('\n');
  }
  const sortedPrices = [...prices].sort((a, b) =>
    a.ideess === b.ideess
      ? a.productKey.localeCompare(b.productKey)
      : a.ideess.localeCompare(b.ideess),
  );
  for (const p of sortedPrices) {
    hash.update([p.ideess, p.productKey, p.priceText].join('\u001f'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** Zona horaria de la `Fecha` oficial del ministerio (península). */
export const FUENTE_TIME_ZONE = 'Europe/Madrid';

/**
 * Parsea `Fecha` de la fuente ("dd/MM/yyyy HH:mm:ss") a epoch ms (UTC),
 * interpretando la hora de pared en `Europe/Madrid` (no comparación lexicográfica).
 * Devuelve null si no se puede interpretar o el instante no existe en esa zona.
 */
export function parseFuenteFechaToEpoch(fecha: string): number | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(fecha.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (![day, month, year, hour, minute, second].every((n) => Number.isFinite(n))) return null;

  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: FUENTE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const partNumber = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number => {
    const v = parts.find((p) => p.type === type)?.value;
    return v === undefined ? Number.NaN : Number(v);
  };

  // Ajuste iterativo: encontrar el UTC cuyo reloj en Madrid coincide con la pared dada.
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i += 1) {
    const parts = dtf.formatToParts(new Date(utc));
    const asUtc = Date.UTC(
      partNumber(parts, 'year'),
      partNumber(parts, 'month') - 1,
      partNumber(parts, 'day'),
      partNumber(parts, 'hour'),
      partNumber(parts, 'minute'),
      partNumber(parts, 'second'),
    );
    if (!Number.isFinite(asUtc)) return null;
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = target - asUtc;
    if (diff === 0) {
      const check = dtf.formatToParts(new Date(utc));
      const ok =
        partNumber(check, 'year') === year &&
        partNumber(check, 'month') === month &&
        partNumber(check, 'day') === day &&
        partNumber(check, 'hour') === hour &&
        partNumber(check, 'minute') === minute &&
        partNumber(check, 'second') === second;
      return ok ? utc : null;
    }
    utc += diff;
  }
  return null;
}
