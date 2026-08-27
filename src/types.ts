/** Tipos del pipeline público litromio-data (Fase 1C). */

export interface RawFuenteResponse {
  Fecha?: unknown;
  Nota?: unknown;
  ResultadoConsulta?: unknown;
  ListaEESSPrecio?: unknown;
}

export interface StationRecord {
  ideess: string;
  rotulo: string;
  direccion: string;
  codigoPostal: string;
  localidad: string;
  municipio: string;
  idMunicipio: string;
  idProvincia: string;
  idCcaa: string;
  /** Coordenada como texto con punto decimal; conserva dígitos de la fuente. */
  latitudText: string;
  longitudText: string;
  horario: string;
  tipoVenta: string;
  remision: string;
  margen: string;
}

export interface PriceRecord {
  ideess: string;
  productKey: string;
  /** Precio como texto decimal con punto; nunca float. */
  priceText: string;
}

export interface ParsedDataset {
  sourceFecha: string;
  nota: string | null;
  stations: StationRecord[];
  prices: PriceRecord[];
  contentHash: string;
}

/** Campos de precio observados en la fuente (Accept: application/json). */
export const PRICE_FIELD_TO_KEY: Record<string, string> = {
  'Precio Adblue': 'adblue',
  'Precio Amoniaco': 'amoniaco',
  'Precio Biodiesel': 'biodiesel',
  'Precio Bioetanol': 'bioetanol',
  'Precio Biogas Natural Comprimido': 'biogas_natural_comprimido',
  'Precio Biogas Natural Licuado': 'biogas_natural_licuado',
  'Precio Diésel Renovable': 'diesel_renovable',
  'Precio Gas Natural Comprimido': 'gas_natural_comprimido',
  'Precio Gas Natural Licuado': 'gas_natural_licuado',
  'Precio Gases licuados del petróleo': 'glp',
  'Precio Gasoleo A': 'gasoleo_a',
  'Precio Gasoleo B': 'gasoleo_b',
  'Precio Gasoleo Premium': 'gasoleo_premium',
  'Precio Gasolina 95 E10': 'gasolina_95_e10',
  'Precio Gasolina 95 E25': 'gasolina_95_e25',
  'Precio Gasolina 95 E5': 'gasolina_95_e5',
  'Precio Gasolina 95 E5 Premium': 'gasolina_95_e5_premium',
  'Precio Gasolina 95 E85': 'gasolina_95_e85',
  'Precio Gasolina 98 E10': 'gasolina_98_e10',
  'Precio Gasolina 98 E5': 'gasolina_98_e5',
  'Precio Gasolina Renovable': 'gasolina_renovable',
  'Precio Hidrogeno': 'hidrogeno',
  'Precio Metanol': 'metanol',
};

/**
 * Cuadrícula geográfica fija (WGS84).
 * Criterio: celdas de 0,5° (~55 km). Una búsqueda cercana típica (≤25 km)
 * carga la celda del punto y las 8 vecinas → cubre el otro lado de límites
 * municipales y de partición sin descargar España entera.
 */
export interface GridConfig {
  cellSizeDeg: number;
  /** Origen latitud (sur). */
  latOrigin: number;
  /** Origen longitud (oeste). */
  lonOrigin: number;
}

export const DEFAULT_GRID: GridConfig = {
  cellSizeDeg: 0.5,
  latOrigin: 35.0,
  lonOrigin: -10.0,
};

export interface PublicStation {
  id: string;
  name: string;
  address: string;
  postalCode: string;
  locality: string;
  municipality: string;
  idMunicipality: string;
  idProvince: string;
  idCcaa: string;
  lat: string;
  lon: string;
  schedule: string;
  saleType: string;
  remision: string;
  margen: string;
  /** Precios con precisión preservada (texto). Ausentes = no incluidos. */
  prices: Record<string, string>;
}

export interface CellFile {
  cellId: string;
  datasetVersion: string;
  contentHash: string;
  stationCount: number;
  stations: PublicStation[];
}

export interface ManifestCellEntry {
  id: string;
  path: string;
  count: number;
  sha256: string;
  bytes: number;
}

export interface Manifest {
  schemaVersion: 1;
  datasetVersion: string;
  contentHash: string;
  /** Fecha/hora global de la respuesta oficial (`Fecha`). */
  sourceFecha: string;
  /**
   * Instantánea ISO de la descarga asociada a este conjunto.
   * En punteros mutables se alinea con `lastSuccessfulFetchAt` tras sync-only.
   */
  downloadedAt: string;
  /**
   * Última descarga y validación exitosa (punteros mutables / sync).
   * Distinta de `publishedAt` del contenido cuando solo se actualiza frescura.
   */
  lastSuccessfulFetchAt?: string;
  /**
   * Instantánea ISO de publicación del contenido de este datasetVersion.
   * Distinta de downloadedAt / lastSuccessfulFetchAt; puede ser null si aún no se ha publicado.
   */
  publishedAt: string | null;
  nota: string | null;
  attribution: {
    sourceName: string;
    sourceUrl: string;
    reuseConditionsUrl: string;
    catalogUrl: string;
  };
  grid: GridConfig;
  stationCount: number;
  priceCount: number;
  fileCount: number;
  totalBytes: number;
  /** Minutos tras los cuales un cliente debe avisar de datos antiguos. */
  staleAfterMinutes: number;
  cells: ManifestCellEntry[];
}

export interface GenerateResult {
  datasetVersion: string;
  contentHash: string;
  sourceFecha: string;
  stationCount: number;
  priceCount: number;
  cellCount: number;
  files: Map<string, string>;
  manifest: Manifest;
}

export interface PipelineConfig {
  minStationCountAbsolute: number;
  minStationCountRatioOfActive: number;
  retainPreviousVersions: number;
  staleAfterMinutes: number;
  leaseTtlMs: number;
  grid: GridConfig;
  /**
   * Permite publicar cuando no hay estado live previo (primer despliegue).
   * Obligatorio y documentado; un fallo de recuperación remota NO implica bootstrap.
   */
  allowEmptyPublish: boolean;
}

/** Umbrales nacionales de producción. No relajar por tamaño de respuesta. */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  minStationCountAbsolute: 8_000,
  minStationCountRatioOfActive: 0.9,
  retainPreviousVersions: 1,
  staleAfterMinutes: 90,
  leaseTtlMs: 15 * 60 * 1000,
  grid: DEFAULT_GRID,
  allowEmptyPublish: false,
};

/**
 * Configuración solo para pruebas o desarrollo con fixtures pequeñas.
 * Incompatible con ejecución de producción / Actions de datos.
 */
export const FIXTURE_PIPELINE_CONFIG: PipelineConfig = {
  ...DEFAULT_PIPELINE_CONFIG,
  minStationCountAbsolute: 2,
  allowEmptyPublish: true,
};

export type PipelineOutcome =
  | 'published'
  /** Contenido igual: se actualizó sync/frescura mutable; requiere publicar metadatos. */
  | 'synced_unchanged'
  | 'failed_validation'
  | 'failed_publish'
  | 'abandoned_concurrent'
  | 'abandoned_stale'
  /** No hay live y no se pasó allowEmptyPublish. */
  | 'refused_empty_bootstrap';

export interface PipelineResult {
  outcome: PipelineOutcome;
  detail: string;
  datasetVersion: string | null;
  contentHash: string | null;
  activeDatasetVersion: string | null;
  /** true si hace falta desplegar el árbol (contenido nuevo o solo metadatos de sync). */
  needsDeploy: boolean;
  metrics: {
    stationCount: number | null;
    priceCount: number | null;
    cellCount: number | null;
    fileCount: number | null;
    totalBytes: number | null;
    maxFileBytes: number | null;
    durationMs: number;
  };
}

export const ATTRIBUTION = {
  sourceName:
    'Ministerio de Industria y Turismo — Precios de carburantes en estaciones de servicio (España)',
  sourceUrl:
    'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/',
  reuseConditionsUrl: 'https://sede.serviciosmin.gob.es/es-ES/Paginas/aviso.aspx#Reutilizacion',
  catalogUrl:
    'https://datos.gob.es/es/catalogo/e05068001-precio-de-carburantes-en-las-gasolineras-espanolas',
} as const;
