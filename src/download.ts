import fs from 'node:fs';
import https from 'node:https';
import { ATTRIBUTION } from './types.ts';

export const SOURCE_URL = ATTRIBUTION.sourceUrl;

export interface DownloadResult {
  body: string;
  bytes: number;
  downloadedAt: string;
  statusCode: number;
  contentType: string | null;
  ms: number;
}

/**
 * Descarga la respuesta nacional con User-Agent identificable.
 * Una sola petición por ciclo (no scraping por estación).
 */
export function downloadFuente(options?: {
  url?: string;
  userAgent?: string;
  timeoutMs?: number;
}): Promise<DownloadResult> {
  const url = options?.url ?? SOURCE_URL;
  const userAgent =
    options?.userAgent ?? 'LitromioData/0.1 (+https://github.com/Zaher171/litromio-data; open-data pipeline)';
  const timeoutMs = options?.timeoutMs ?? 120_000;

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = https.get(
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': userAgent,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`HTTP ${statusCode} al descargar fuente`));
            return;
          }
          resolve({
            body: buf.toString('utf8'),
            bytes: buf.length,
            downloadedAt: new Date().toISOString(),
            statusCode,
            contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null,
            ms: Date.now() - t0,
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

export function readLocalPayload(filePath: string): { body: string; bytes: number; downloadedAt: string } {
  const body = fs.readFileSync(filePath, 'utf8');
  return {
    body,
    bytes: Buffer.byteLength(body, 'utf8'),
    downloadedAt: new Date().toISOString(),
  };
}

export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Reintentos de red; no publica datos parciales. */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<{ value: T; attempts: number }> {
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < options.maxAttempts) {
        await sleep(options.delayMs * attempt);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Reintentos agotados: ${String(lastError)}`);
}
