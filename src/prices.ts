/**
 * Precisión decimal de precios: se almacenan como texto, nunca como float.
 * La fuente usa coma decimal europea ("1,599").
 * Adaptado del importador de Litromio (Fase 1B); paquete independiente.
 */

export type PriceParseResult =
  | { ok: true; priceText: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'non_positive' };

/**
 * Normaliza un precio de la fuente a texto con punto decimal, preservando dígitos.
 * Ej.: "1,599" → "1.599"
 */
export function normalizePriceText(raw: unknown): PriceParseResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };
  const s = String(raw).trim();
  if (s === '') return { ok: false, reason: 'empty' };

  let normalized: string;
  if (s.includes(',')) {
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = s;
  }

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return { ok: false, reason: 'invalid' };
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return { ok: false, reason: 'invalid' };
  if (n <= 0) return { ok: false, reason: 'non_positive' };

  return { ok: true, priceText: normalized };
}

/** Coordenadas: conserva dígitos; solo cambia coma → punto. */
export function normalizeCoordText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const normalized = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  return normalized;
}
