import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadFuente, readLocalPayload, withRetries } from './download.ts';
import { runPipeline } from './pipeline.ts';
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
  npx tsx src/cli.ts recover --public-base-url <url> --out <dir>

Producción: umbral nacional fijo (minStationCountAbsolute=${DEFAULT_PIPELINE_CONFIG.minStationCountAbsolute}).
--dev-fixtures: solo pruebas/desarrollo local (incompatible con producción).
--allow-empty-publish: primer arranque explícito sin estado previo.
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
    const recovered = await recoverPublishedState({ publicBaseUrl, outRoot: outDir });
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
