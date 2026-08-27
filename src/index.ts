export { normalizePriceText, normalizeCoordText } from './prices.ts';
export {
  parseAndValidateFuentePayload,
  parseFuenteFechaToEpoch,
  hashDataset,
  ValidationError,
  FUENTE_TIME_ZONE,
} from './validate.ts';
export {
  cellForLatLon,
  cellForLatLonText,
  cellsForNearbySearch,
  neighboringCellIds,
  cellIdFromIndices,
  parseCellId,
} from './partition.ts';
export { generatePartitionedDataset, stripClockFields } from './generate.ts';
export {
  createStorePaths,
  promoteStagingToLive,
  assertManifestCoherent,
  assertPublishedTreeCoherent,
  readLiveManifest,
  acquireLock,
  releaseLock,
  copyStaticHeadersInto,
  sha256Hex,
} from './publish-local.ts';
export { downloadFuente, readLocalPayload, withRetries, SOURCE_URL } from './download.ts';
export { runPipeline, isManifestStale } from './pipeline.ts';
export {
  recoverPublishedState,
  isSafeRelativeAssetPath,
  assertSafeStagingPath,
} from './recover-state.ts';
export {
  readSyncState,
  updateMutableFreshness,
  buildSyncState,
  normalizeSyncStateRecord,
  SYNC_STATE_REL,
  type SyncState,
} from './sync-state.ts';
export {
  buildMunicipalityCellsDocument,
  municipalityCellsRelPath,
  parseMunicipalityCellsDocument,
  validateMunicipalityCellsCoverage,
  cellIdsForMunicipalityIds,
  serializeMunicipalityCellsDocument,
} from './municipality-cells.ts';
export {
  buildGeometryPublishFiles,
  incorporateGeometryIntoLive,
  preserveGeometryTreeFromLive,
  assertGeometryTreeCoherent,
  readGeometryCurrent,
  GEOMETRY_CURRENT_REL,
  verifyGeometryIndependentOfPrices,
  parseGeometryCurrent,
  parseMunicipalityCatalog,
} from './geometry.ts';
export {
  ATTRIBUTION,
  DEFAULT_GRID,
  DEFAULT_PIPELINE_CONFIG,
  FIXTURE_PIPELINE_CONFIG,
  PRICE_FIELD_TO_KEY,
  type Manifest,
  type ParsedDataset,
  type PipelineResult,
  type PipelineOutcome,
  type RawFuenteResponse,
} from './types.ts';
