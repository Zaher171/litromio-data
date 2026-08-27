/**
 * CLI: descarga, pipeline de precios e incorporación explícita de geometría municipal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadFuente, readLocalPayload, withRetries } from './download.ts';
import {
  buildGeometryPublishFiles,
  incorporateGeometryIntoLive,
} from './geometry.ts';
import { runPipeline } from './pipeline.ts';
import { createStorePaths } from './publish-local.ts';
import { recoverPublishedState } from './recover-state.ts';
import {
  DEFAULT_PIPELINE_CONFIG,
  FIXTURE_PIPELINE_CONFIG,
  type PipelineConfig,
} from './types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function usage(): never {
  console.error(`Uso:
  npx tsx src/cli.ts generate --input <json> --out <dir> [--dev-fixtures] [--allow-empty-publish]
  npx tsx src/cli.ts pipeline --input <json|--download> --out <dir> [--public-base-url <url>] [--allow-empty-publish] [--dev-fixtures]
  npx tsx src/cli.ts measure --input <json|--download> --out <dir> [--metrics <path>] [--dev-fixtures] [--allow-empty-publish]
  npx tsx src/cli.ts recover --public-base-url <url> --out <dir> [--allow-http-local]
  npx tsx src/cli.ts geometry-publish --out <dir> --packs-dir <dir> --source-manifest <json> --relations <json> --geometry-version <16hex> --catalog-version <16hex> [--allow-initial-geometry]

Producción: umbral nacional fijo (minStationCountAbsolute=${DEFAULT_PIPELINE_CONFIG.minStationCountAbsolute}).
--dev-fixtures: solo pruebas/desarrollo local (incompatible con producción).
--allow-empty-publish: primer arranque explícito sin estado previo de precios.
--allow-initial-geometry: primera incorporación explícita de g/ (nunca ante fallo de recover).
--public-base-url: recupera estado publicado antes de generar (obligatorio en runners limpios salvo bootstrap).
`);
  process.exit(2);
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function resolveConfig(args: string[]): PipelineConfig {
  const devFixtures = hasFlag(args, '--dev-fixtures');
  const allowEmpty = hasFlag(args, '--allow-empty-publish');
  if (devFixtures) {
    return {
      ...FIXTURE_PIPELINE_CONFIG,
      allowEmptyPublish: allowEmpty || FIXTURE_PIPELINE_CONFIG.allowEmptyPublish,
    };
  }
  return {
    ...DEFAULT_PIPELINE_CONFIG,
    allowEmptyPublish: allowEmpty,
  };
}

async function loadPayload(args: string[]): Promise<{ body: string; downloadedAt: string; bytes: number }> {
  const input = argValue(args, '--input');
  if (!input) usage();
  if (input === '--download' || input === 'download') {
    const { value } = await withRetries(() => downloadFuente(), { maxAttempts: 3, delayMs: 1000 });
    return { body: value.body, downloadedAt: value.downloadedAt, bytes: value.bytes };
  }
  const local = readLocalPayload(path.resolve(input));
  return local;
}

async function maybeRecover(args: string[], outDir: string): Promise<void> {
  const publicBaseUrl = argValue(args, '--public-base-url');
  if (!publicBaseUrl) return;

  const recovered = await recoverPublishedState({
    publicBaseUrl,
    outRoot: outDir,
  });
  if (!recovered.ok) {
    const summary = {
      outcome: 'failed_recover_state',
      detail: recovered.reason,
      code: recovered.code,
      needsDeploy: false,
      note: 'Fallo al recuperar estado publicado. No se interpreta como primer arranque; no se publica.',
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(1);
  }
  console.error(
    JSON.stringify({
      recover: 'ok',
      datasetVersion: recovered.manifest.datasetVersion,
      fileCount: recovered.fileCount,
      baseUrl: recovered.baseUrl,
    }),
  );
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help') usage();

  const outDir = path.resolve(argValue(args, '--out') ?? path.join(ROOT, 'out'));

  if (cmd === 'recover') {
    const publicBaseUrl = argValue(args, '--public-base-url');
    if (!publicBaseUrl) usage();
    const recovered = await recoverPublishedState({
      publicBaseUrl,
      outRoot: outDir,
      allowHttpLocal: hasFlag(args, '--allow-http-local'),
    });
    if (!recovered.ok) {
      console.log(
        JSON.stringify(
          {
            outcome: 'failed_recover_state',
            detail: recovered.reason,
            code: recovered.code,
            needsDeploy: false,
          },
          null,
          2,
        ),
      );
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          outcome: 'recovered',
          datasetVersion: recovered.manifest.datasetVersion,
          contentHash: recovered.manifest.contentHash,
          fileCount: recovered.fileCount,
          needsDeploy: false,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === 'geometry-publish') {
    const packsDir = argValue(args, '--packs-dir');
    const sourceManifestPath = argValue(args, '--source-manifest');
    const relationsPath = argValue(args, '--relations');
    const geometryVersion = argValue(args, '--geometry-version');
    const catalogVersion = argValue(args, '--catalog-version');
    if (!packsDir || !sourceManifestPath || !relationsPath || !geometryVersion || !catalogVersion) {
      usage();
    }
    const store = createStorePaths(outDir);
    const sourceManifest = JSON.parse(fs.readFileSync(path.resolve(sourceManifestPath), 'utf8')) as Record<
      string,
      unknown
    >;
    const relationsRaw = JSON.parse(fs.readFileSync(path.resolve(relationsPath), 'utf8')) as {
      relations: Record<string, string[]>;
      ineWithoutMinetur: string[];
      stats?: { ineCount?: number };
      generatedAt?: string;
    };
    const publishedAt = new Date().toISOString();
    const built = buildGeometryPublishFiles({
      geometryVersion,
      catalogVersion,
      packsDir: path.resolve(packsDir),
      sourceManifest,
      relations: {
        relations: relationsRaw.relations,
        ineWithoutMinetur: relationsRaw.ineWithoutMinetur,
        ...(relationsRaw.stats?.ineCount !== undefined ? { ineCount: relationsRaw.stats.ineCount } : {}),
        ...(relationsRaw.generatedAt !== undefined ? { generatedAt: relationsRaw.generatedAt } : {}),
      },
      publishedAt,
      previousGeometryVersion: null,
      retainGeometryVersions: DEFAULT_PIPELINE_CONFIG.retainGeometryVersions,
    });
    if (!built.ok) {
      console.log(JSON.stringify({ outcome: 'failed_geometry_build', detail: built.reason }, null, 2));
      process.exit(1);
    }
    // Si ya hay g/, retener versión previa.
    const existingG = path.join(store.liveDir, 'g', 'current.json');
    let previous: string | null = null;
    if (fs.existsSync(existingG)) {
      const prev = JSON.parse(fs.readFileSync(existingG, 'utf8')) as { geometryVersion?: string };
      previous = typeof prev.geometryVersion === 'string' ? prev.geometryVersion : null;
    }
    const rebuilt =
      previous && previous !== geometryVersion
        ? buildGeometryPublishFiles({
            geometryVersion,
            catalogVersion,
            packsDir: path.resolve(packsDir),
            sourceManifest,
            relations: {
              relations: relationsRaw.relations,
              ineWithoutMinetur: relationsRaw.ineWithoutMinetur,
              ...(relationsRaw.stats?.ineCount !== undefined ? { ineCount: relationsRaw.stats.ineCount } : {}),
              ...(relationsRaw.generatedAt !== undefined ? { generatedAt: relationsRaw.generatedAt } : {}),
            },
            publishedAt,
            previousGeometryVersion: previous,
            retainGeometryVersions: DEFAULT_PIPELINE_CONFIG.retainGeometryVersions,
          })
        : built;
    if (!rebuilt.ok) {
      console.log(JSON.stringify({ outcome: 'failed_geometry_build', detail: rebuilt.reason }, null, 2));
      process.exit(1);
    }
    const incorporated = incorporateGeometryIntoLive({
      liveDir: store.liveDir,
      geometryFiles: rebuilt.files,
      geometryCurrent: rebuilt.current,
      retainGeometryVersions: DEFAULT_PIPELINE_CONFIG.retainGeometryVersions,
      allowInitialGeometry: hasFlag(args, '--allow-initial-geometry'),
    });
    if (!incorporated.ok) {
      console.log(
        JSON.stringify({ outcome: 'failed_geometry_publish', detail: incorporated.reason, needsDeploy: false }, null, 2),
      );
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          outcome: 'geometry_published',
          geometryVersion,
          catalogVersion,
          needsDeploy: true,
          metrics: incorporated.metrics,
          note: 'Incorporación local de g/. No es deploy remoto ni Actions.',
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === 'generate' || cmd === 'pipeline' || cmd === 'measure') {
    await maybeRecover(args, outDir);

    const payload = await loadPayload(args);
    const startedAt = new Date().toISOString();
    const config = resolveConfig(args);

    // Defensa: nunca relajar umbral por tamaño de bytes en producción.
    if (!hasFlag(args, '--dev-fixtures') && config.minStationCountAbsolute < DEFAULT_PIPELINE_CONFIG.minStationCountAbsolute) {
      console.error('Configuración inválida: umbral por debajo del nacional sin --dev-fixtures');
      process.exit(2);
    }

    const result = runPipeline({
      runId: `cli-${Date.now()}`,
      outRoot: outDir,
      payload: payload.body,
      downloadedAt: payload.downloadedAt,
      startedAt,
      config,
    });

    const summary = {
      outcome: result.outcome,
      detail: result.detail,
      datasetVersion: result.datasetVersion,
      contentHash: result.contentHash,
      activeDatasetVersion: result.activeDatasetVersion,
      needsDeploy: result.needsDeploy,
      downloadBytes: payload.bytes,
      metrics: result.metrics,
      configMode: hasFlag(args, '--dev-fixtures') ? 'dev-fixtures' : 'production',
      allowEmptyPublish: config.allowEmptyPublish,
      note:
        'Métricas locales de generación/publicación simulada. No representan consumo real de Cloudflare.',
    };
    console.log(JSON.stringify(summary, null, 2));

    if (cmd === 'measure') {
      const metricsPath = path.resolve(
        argValue(args, '--metrics') ?? path.join(ROOT, '..', 'docs', 'metrics', 'fase-1c-local.json'),
      );
      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.writeFileSync(
        metricsPath,
        `${JSON.stringify({ measuredAt: new Date().toISOString(), ...summary }, null, 2)}\n`,
        'utf8',
      );
      console.error(`Métricas escritas en ${metricsPath}`);
    }

    if (result.outcome !== 'published' && result.outcome !== 'synced_unchanged') {
      process.exitCode = 1;
    }
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
