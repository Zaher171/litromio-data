import { generatePartitionedDataset } from './generate.ts';
import {
  acquireLock,
  assertPublishedTreeCoherent,
  createStorePaths,
  promoteStagingToLive,
  readLiveManifest,
  releaseLock,
} from './publish-local.ts';
import { readSyncState, updateMutableFreshness } from './sync-state.ts';
import { parseAndValidateFuentePayload, parseFuenteFechaToEpoch, ValidationError } from './validate.ts';
import type {
  PipelineConfig,
  PipelineResult,
  RawFuenteResponse,
} from './types.ts';
import { DEFAULT_PIPELINE_CONFIG } from './types.ts';

function emptyMetrics(durationMs: number): PipelineResult['metrics'] {
  return {
    stationCount: null,
    priceCount: null,
    cellCount: null,
    fileCount: null,
    totalBytes: null,
    maxFileBytes: null,
    durationMs,
  };
}

function isCompletenessAcceptable(
  stationCount: number,
  activeStationCount: number | null,
  config: PipelineConfig,
): { ok: true } | { ok: false; reason: string } {
  if (stationCount < config.minStationCountAbsolute) {
    return {
      ok: false,
      reason: `station_count ${stationCount} < mínimo absoluto ${config.minStationCountAbsolute}`,
    };
  }
  if (activeStationCount !== null) {
    const min = Math.floor(activeStationCount * config.minStationCountRatioOfActive);
    if (stationCount < min) {
      return {
        ok: false,
        reason: `station_count ${stationCount} < ${min} (ratio ${config.minStationCountRatioOfActive} de activa ${activeStationCount})`,
      };
    }
  }
  return { ok: true };
}

/**
 * ¿La consulta es más antigua que la última observación aceptada?
 * Compara `Fecha` vía `parseFuenteFechaToEpoch` (Europe/Madrid); sin orden lexicográfico dd/mm.
 * Si alguna fecha no parsea → se considera no aceptable (stale).
 */
function isStaleAgainstLastObserved(
  candidate: { sourceFecha: string; downloadedAt: string },
  baseline: { lastObservedSourceFecha: string; downloadedAt: string },
): boolean {
  const cEpoch = parseFuenteFechaToEpoch(candidate.sourceFecha);
  const bEpoch = parseFuenteFechaToEpoch(baseline.lastObservedSourceFecha);
  if (cEpoch === null || bEpoch === null) return true;
  if (cEpoch < bEpoch) return true;
  if (cEpoch > bEpoch) return false;
  return candidate.downloadedAt < baseline.downloadedAt;
}

export interface RunPipelineInput {
  runId: string;
  outRoot: string;
  payload: string | RawFuenteResponse;
  downloadedAt: string;
  startedAt: string;
  config?: PipelineConfig;
  /** Simula fallo de publicación (conserva live). */
  failPublish?: boolean;
}

/**
 * Pipeline local: validar → generar o sync de frescura → publicar.
 * Ante fallo conserva el conjunto live válido.
 * Sin live previo requiere `allowEmptyPublish` (primer arranque explícito).
 */
export function runPipeline(input: RunPipelineInput): PipelineResult {
  const t0 = Date.now();
  const config: PipelineConfig = {
    ...DEFAULT_PIPELINE_CONFIG,
    ...input.config,
  };
  const store = createStorePaths(input.outRoot);

  const finish = (
    partial: Omit<PipelineResult, 'metrics' | 'needsDeploy'> & {
      metrics?: PipelineResult['metrics'];
      needsDeploy?: boolean;
    },
  ): PipelineResult => ({
    ...partial,
    needsDeploy: partial.needsDeploy ?? false,
    metrics: partial.metrics ?? emptyMetrics(Date.now() - t0),
  });

  const lock = acquireLock(store.lockPath, input.runId, input.startedAt, config.leaseTtlMs);
  if (!lock.ok) {
    const active = readLiveManifest(store.liveDir);
    return finish({
      outcome: 'abandoned_concurrent',
      detail: lock.reason,
      datasetVersion: null,
      contentHash: null,
      activeDatasetVersion: active?.datasetVersion ?? null,
    });
  }

  try {
    let dataset;
    try {
      dataset = parseAndValidateFuentePayload(input.payload);
    } catch (err) {
      const msg = err instanceof ValidationError ? `${err.code}: ${err.message}` : String(err);
      const active = readLiveManifest(store.liveDir);
      return finish({
        outcome: 'failed_validation',
        detail: msg,
        datasetVersion: null,
        contentHash: null,
        activeDatasetVersion: active?.datasetVersion ?? null,
      });
    }

    const active = readLiveManifest(store.liveDir);

    if (!active && !config.allowEmptyPublish) {
      return finish({
        outcome: 'refused_empty_bootstrap',
        detail:
          'No hay estado live previo. El primer arranque requiere --allow-empty-publish (o allowEmptyPublish). Un fallo al recuperar estado remoto no cuenta como primer arranque.',
        datasetVersion: null,
        contentHash: dataset.contentHash,
        activeDatasetVersion: null,
      });
    }

    const completeness = isCompletenessAcceptable(
      dataset.stations.length,
      active?.stationCount ?? null,
      config,
    );
    if (!completeness.ok) {
      return finish({
        outcome: 'failed_validation',
        detail: completeness.reason,
        datasetVersion: null,
        contentHash: dataset.contentHash,
        activeDatasetVersion: active?.datasetVersion ?? null,
        metrics: {
          ...emptyMetrics(Date.now() - t0),
          stationCount: dataset.stations.length,
          priceCount: dataset.prices.length,
        },
      });
    }

    // Retrocesos de Fecha: antes de decidir sync vs publicación de contenido.
    if (active) {
      const syncState = readSyncState(store.liveDir);
      const lastObservedSourceFecha =
        syncState?.lastObservedSourceFecha ?? syncState?.sourceFecha ?? active.sourceFecha;
      const baselineDownloadedAt =
        syncState?.lastSuccessfulFetchAt ?? active.lastSuccessfulFetchAt ?? active.downloadedAt;
      if (
        isStaleAgainstLastObserved(
          { sourceFecha: dataset.sourceFecha, downloadedAt: input.downloadedAt },
          { lastObservedSourceFecha, downloadedAt: baselineDownloadedAt },
        )
      ) {
        return finish({
          outcome: 'abandoned_stale',
          detail:
            'La consulta es anterior a la última Fecha observada aceptada (o downloaded_at más antiguo a igualdad de Fecha)',
          datasetVersion: null,
          contentHash: dataset.contentHash,
          activeDatasetVersion: active.datasetVersion,
          metrics: {
            ...emptyMetrics(Date.now() - t0),
            stationCount: dataset.stations.length,
            priceCount: dataset.prices.length,
          },
        });
      }
    }

    if (active && active.contentHash === dataset.contentHash) {
      const freshened = updateMutableFreshness(store.liveDir, {
        lastSuccessfulFetchAt: input.downloadedAt,
        observedSourceFecha: dataset.sourceFecha,
      });
      if (!freshened.ok) {
        return finish({
          outcome: 'failed_publish',
          detail: `Sync de frescura fallido: ${freshened.reason}`,
          datasetVersion: active.datasetVersion,
          contentHash: dataset.contentHash,
          activeDatasetVersion: active.datasetVersion,
          metrics: {
            ...emptyMetrics(Date.now() - t0),
            stationCount: dataset.stations.length,
            priceCount: dataset.prices.length,
          },
        });
      }
      const complete = assertPublishedTreeCoherent(store.liveDir);
      if (!complete.ok) {
        return finish({
          outcome: 'failed_publish',
          detail: `synced_unchanged dejó árbol incompleto: ${complete.reason}`,
          datasetVersion: active.datasetVersion,
          contentHash: dataset.contentHash,
          activeDatasetVersion: active.datasetVersion,
        });
      }
      return finish({
        outcome: 'synced_unchanged',
        detail:
          'content_hash idéntico; actualizada evidencia de consulta (sync.json / punteros mutables). Requiere publicar metadatos; no es “sin deploy”. Árbol completo (precios + g/ si existe).',
        datasetVersion: active.datasetVersion,
        contentHash: dataset.contentHash,
        activeDatasetVersion: active.datasetVersion,
        needsDeploy: true,
        metrics: {
          ...emptyMetrics(Date.now() - t0),
          stationCount: dataset.stations.length,
          priceCount: dataset.prices.length,
          cellCount: active.cells.length,
          fileCount: active.fileCount,
          totalBytes: active.totalBytes,
        },
      });
    }

    const publishedAt = new Date().toISOString();
    const generated = generatePartitionedDataset(dataset, {
      downloadedAt: input.downloadedAt,
      publishedAt: null,
      config,
    });

    const promoted = promoteStagingToLive(store, generated.files, {
      retainPreviousVersions: config.retainPreviousVersions,
      publishedAt,
      lastSuccessfulFetchAt: input.downloadedAt,
      failBeforeSwap: input.failPublish === true,
    });

    if (!promoted.ok) {
      return finish({
        outcome: 'failed_publish',
        detail: promoted.reason,
        datasetVersion: generated.datasetVersion,
        contentHash: generated.contentHash,
        activeDatasetVersion: active?.datasetVersion ?? null,
        metrics: {
          ...emptyMetrics(Date.now() - t0),
          stationCount: generated.stationCount,
          priceCount: generated.priceCount,
          cellCount: generated.cellCount,
        },
      });
    }

    const coherent = assertPublishedTreeCoherent(store.liveDir);
    if (!coherent.ok) {
      return finish({
        outcome: 'failed_publish',
        detail: `Post-reemplazo incoherente: ${coherent.reason}`,
        datasetVersion: generated.datasetVersion,
        contentHash: generated.contentHash,
        activeDatasetVersion: generated.datasetVersion,
      });
    }

    return finish({
      outcome: 'published',
      detail: 'Publicación local OK (árbol validado antes del reemplazo)',
      datasetVersion: generated.datasetVersion,
      contentHash: generated.contentHash,
      activeDatasetVersion: generated.datasetVersion,
      needsDeploy: true,
      metrics: {
        stationCount: generated.stationCount,
        priceCount: generated.priceCount,
        cellCount: generated.cellCount,
        fileCount: promoted.metrics.fileCount,
        totalBytes: promoted.metrics.totalBytes,
        maxFileBytes: promoted.metrics.maxFileBytes,
        durationMs: Date.now() - t0,
      },
    });
  } finally {
    releaseLock(store.lockPath, input.runId);
  }
}

/** ¿El manifiesto indica datos antiguos respecto a `now`? Usa lastSuccessfulFetchAt si existe. */
export function isManifestStale(
  downloadedAt: string,
  staleAfterMinutes: number,
  nowMs: number = Date.now(),
): boolean {
  const t = Date.parse(downloadedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > staleAfterMinutes * 60_000;
}
