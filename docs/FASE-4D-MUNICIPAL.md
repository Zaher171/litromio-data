# Fase 4D — Soporte municipal en el pipeline público

**Fecha:** 2026-08-27
**Estado:** código + tests + docs en `main` (checkpoint de implementación). **Sin** geometry-publish remoto, **sin** deploy, **sin** ejecución de Actions en la entrega del checkpoint.
**Worker:** `litromio-data` (mismo). Sin segundo Worker ni servicios de pago.

## Contratos

### Ciclo B — precios (cada sync)

| Artefacto | Path | Versión |
| --- | --- | --- |
| Celdas | `v/{datasetVersion}/cells/*.json` | `datasetVersion` = `contentHash.slice(0,16)` |
| Índice municipal | `v/{datasetVersion}/municipality-cells.json` | Mismo `datasetVersion` + `contentHash` |
| Punteros | `current.json`, `manifest.json`, `sync.json` | Mutables |

`municipality-cells.json` se genera en `generatePartitionedDataset` desde las mismas estaciones/celdas. Gate: cobertura completa + vínculo de versión/hash.

### Ciclo A — geometría / catálogo (infrecuente)

| Artefacto | Path |
| --- | --- |
| Puntero | `g/current.json` (mutable; cache corto) |
| Manifiesto + hashes | `g/{geometryVersion}/geometry-catalog-manifest.json` |
| Catálogo INE→Minetur[] | `g/{geometryVersion}/municipality-catalog.json` |
| Packs | `g/{geometryVersion}/packs/{cellId}.json` |

`geometryVersion` es **independiente** de `datasetVersion`. Atribución IGN **CC BY 4.0** obligatoria en manifiesto.

### Compatibilidad clientes antiguos

Campos **opcionales** en `current.json` (ignorables):

- `municipalityCellsPath`
- `geometryCurrentPath` (`g/current.json`)
- `geometryCatalogPath`

Invariantes de precios sin cambio: `schemaVersion`, `datasetVersion`, `contentHash`, `manifestPath`, `staleAfterMinutes`, attribution Minetur.

CDN **sin** `g/` ni punteros geométricos: recover OK (formato antiguo).
Si `current.json` **declara** geometría y faltan archivos o fallan hashes: recover **aborta** (corrupción ≠ bootstrap).

## Conservación entre syncs de precios

1. `recover` restaura precios + `g/` (si existe) + `municipality-cells` (si declarado/presente).
2. `promoteStagingToLive` copia `g/` desde live → staging (**no** regenera packs).
3. `synced_unchanged` actualiza mutables y exige árbol coherente completo (incluye `g/` si estaba).
4. Retención: `retainPreviousVersions` / `retainGeometryVersions` **default 1** = **una versión anterior además de la activa** (no “solo 1 en total”). Listadas en `sync.json.retainedVersions` / `g/current.json.retainedVersions` (sin incluir la activa). No se eliminan archivos aún referenciados.

## Incorporación inicial (explícita)

Migración con **precios idénticos** (CDN antiguo sin municipal):

1. Recover del estado público de precios (válido, sin `g/` ni `municipalityCellsPath`).
2. Misma carga de precios → `synced_unchanged` (no reescribe `v/{datasetVersion}/`).
3. `geometry-publish` con `--allow-initial-geometry`:
   - Escribe `g/{geometryVersion}/…` nuevo.
   - Añade **solo** `v/{datasetVersion}/municipality-cells.json` si faltaba.
   - **No** modifica bytes de celdas ni del manifiesto versionado ya publicados.
   - Si `municipality-cells.json` ya existía (publicación posterior con índice), se **conservan** sus bytes (URL inmutable).

```powershell
# Sobre un out/live de precios ya válido:
npx tsx src/cli.ts geometry-publish `
  --out ./out `
  --packs-dir <dir-packs> `
  --source-manifest <geometry-catalog-manifest.json> `
  --relations <ine-minetur-relations.json> `
  --geometry-version <16hex> `
  --catalog-version <16hex> `
  --allow-initial-geometry
```

Sin `--allow-initial-geometry` la primera geometría se rechaza. Un fallo de recover **no** habilita bootstrap geométrico.

No se modifica un manifiesto versionado existente para “añadir” el índice: el índice es archivo hermano nuevo bajo la misma `datasetVersion`.

## Compatibilidad del workflow Actions (revisión checkpoint)

Archivo: `.github/workflows/update-data.yml` (no modificado en este checkpoint; schedule intacto).

| Paso | Contrato CLI / script | Compatibilidad |
| --- | --- | --- |
| `recover` | stdout JSON: `outcome=recovered`, `datasetVersion` (16 hex), `fileCount` ≥ 1 | OK con CLI actual. Fallo → `failed_recover_state` + exit 1 (workflow aborta; sin bootstrap). |
| `pipeline` | stdout JSON: `outcome` ∈ {`published`,`synced_unchanged`}, `needsDeploy` bool, `datasetVersion`, `contentHash` (64 hex), `configMode=production`, `allowEmptyPublish≠true` | OK. Sin `--allow-empty-publish` / `--dev-fixtures`. |
| Outputs job | `outcome`, `needs_deploy`, `dataset_version`, `content_hash`, `last_successful_fetch_at`, `deployed`, `verified` | Sin cambios de nombres; siguen alimentando deploy/verify. |
| `verify-published.mjs` | Env: `PUBLIC_DATA_BASE_URL`, `EXPECTED_VERSION`, `EXPECTED_HASH`, `EXPECTED_FETCH_AT` | OK. Si `current` declara municipal/geometría: valida índice, `g/current`, manifiesto IGN, **catálogo**, 1 pack+hash (o todos con `VERIFY_EXHAUSTIVE_PACKS=1`). |
| Cron | Solo precios (`pipeline --input download`); **no** llama `geometry-publish` | Intencional. Tras 1ª geometría, `recover` + `promote` deben conservar `g/`. |
| Timeout | `timeout-minutes: 25`; recover geometría default +600 s | Suficiente para árbol típico; no afirmar wall-time CDN. |
| Concurrencia GHA | `group: litromio-data-update`, `cancel-in-progress: false` | Cola jobs; un job antiguo **sigue hasta el final**. |

**No basta** con unit tests: el flujo real es recover → pipeline sobre el mismo `./out` → deploy condicionado → verify HTTP. Un job con **código anterior a municipal** que despliegue tras existir `g/` en CDN puede publicar un árbol **sin** geometrías (recover antiguo no restaura `g/`; promote antiguo no lo conserva).

## Riesgo de concurrencia (primera publicación)

1. **Job Actions antiguo** (commit pre-municipal, o recover sin `g/`): puede hacer `wrangler deploy` de `out/live` **sin** `g/` y **sin** punteros geométricos → borra la geometría pública en el siguiente deploy atómico del Worker.
2. **Deploy manual local** (`wrangler deploy` desde un laptop) **no** entra en el grupo `litromio-data-update`. Puede pisar o ser pisado por un job de Actions en paralelo.
3. Con `cancel-in-progress: false`, deshabilitar el workflow **no cancela** runs ya `in_progress` / `queued`: hay que listarlos y cancelarlos o esperar a que terminen **antes** de publicar geometría.

### Cómo impedir ejecuciones durante la 1ª publicación (sin editar el cron YAML)

**En esta tarea de checkpoint no se desactiva el workflow ni se cambia el schedule.** En el paso autorizado siguiente:

1. GitHub → repo `Zaher171/litromio-data` → **Actions** → workflow `update-litromio-data` → ⋮ → **Disable workflow**
   (pausa triggers `schedule` + `workflow_dispatch`; **no** modifica el `cron` del YAML).
2. Comprobar que no queda ningún job activo o pendiente:

```powershell
gh run list --repo Zaher171/litromio-data --workflow=update-data.yml --limit 20
gh run list --repo Zaher171/litromio-data --workflow=update-data.yml --status in_progress
gh run list --repo Zaher171/litromio-data --workflow=update-data.yml --status queued
gh run list --repo Zaher171/litromio-data --workflow=update-data.yml --status pending
```

3. Si hay runs activos/pendientes: `gh run cancel <RUN_ID> --repo Zaher171/litromio-data` (o esperar a que fallen/terminen) y **volver a listar** hasta cero.
4. No lanzar `workflow_dispatch`, ni `wrangler deploy` local, ni otro publish paralelo hasta cerrar el procedimiento.
5. Reanudar solo tras el ciclo controlado de precios (ver procedimiento abajo): **Enable workflow** en la misma UI (sigue el mismo `cron` del YAML).

## Verificación HTTP

| Ámbito | Qué hace |
| --- | --- |
| Local / publish | `assertPublishedTreeCoherent` — exhaustivo (todas las celdas, packs retenidos, hashes) |
| Remoto (`scripts/verify-published.mjs`) | Muestreo: punteros, 1 celda, índice municipal si declarado, `g/current`, manifiesto IGN, **catálogo**, 1 pack + hash. Opcional `VERIFY_EXHAUSTIVE_PACKS=1` |

El verificador remoto **falla** ante catálogo, índice municipal o pack incorrecto/ausente cuando `current.json` declara contratos municipales. No sustituye la validación exhaustiva previa al swap de `live/`.

## Recuperación (límites)

- Concurrencia de packs: default **8**.
- Timeout geometría adicional: default **600 s** (árbol nacional + retención).
- `maxResponseBytes`: **25 MiB** (límite Free por archivo); HTTPS, rutas seguras, hashes y esquema **siguen activos**.
- Mediciones locales HTTP (`docs/metrics/fase-4d-municipal-local.json`, ~2–3 s en 127.0.0.1) **no** son wall-time de Actions ni CDN Cloudflare.

## CLI / módulos

- `src/municipality-cells.ts`, `src/geometry.ts`, `src/hash.ts`
- `geometry-publish` en `src/cli.ts`
- Tests: `tests/municipal.test.ts`
- Medición local: `scripts/measure-municipal-local.mjs`

## Procedimiento exacto — primera publicación remota (paso autorizado; **no** ejecutado en el checkpoint)

Prerrequisitos: packs/catálogo IGN ya construidos **offline** (fuera de Git), secretos Cloudflare ya existentes para `litromio-data`, autorización explícita. **No** cambiar schedule YAML, secretos, DNS, app privada ni Mesa Uno.

### A. Pausar automáticos y comprobar cola

1. Disable workflow `update-litromio-data` (UI Actions; no editar YAML).
2. Listar/cancelar runs `in_progress` / `queued` / `pending` hasta cero (comandos `gh` arriba).
3. Confirmar que **ningún** `wrangler deploy` local está en curso.

### B. Código a publicar = código que usarán futuras ejecuciones

1. En el runner/máquina de publicación: `git fetch origin && git checkout main && git pull --ff-only`
2. Anotar `COMMIT=$(git rev-parse HEAD)` — debe ser el commit del checkpoint municipal (o posterior compatible).
3. `npm ci && npm run check && npm test`
4. Futuras Actions, al reactivarse, harán checkout de `main` → mismo linaje. No publicar geometría con un working tree distinto del `main` remoto.

### C. Recover inmediato antes de preparar el árbol

```powershell
# Fallo → ABORTAR. No --allow-empty-publish. No geometry-publish si recover falla.
npx tsx src/cli.ts recover --public-base-url $env:PUBLIC_DATA_BASE_URL --out ./out
```

Confirmar `out/live` coherente (precios). Esperado en 1ª migración: sin `g/` / sin `geometryCurrentPath` (o árbol geométrico ya coherente si se reintenta).

### D. Incorporar geometrías y validar integridad (local exhaustivo)

```powershell
npx tsx src/cli.ts geometry-publish `
  --out ./out `
  --packs-dir <packs> `
  --source-manifest <manifest> `
  --relations <relations> `
  --geometry-version <16hex> `
  --catalog-version <16hex> `
  --allow-initial-geometry
```

Comprobar localmente (implícito en CLI vía `assertPublishedTreeCoherent`):

- Existen `g/current.json`, `g/{geometryVersion}/…`, `municipality-cells.json` si faltaba.
- Bytes de `v/{datasetVersion}/cells/*` y manifiesto versionado de precios **intactos**.
- `_headers` incluye `/g/*` (immutable) y `/g/current.json` (mutable).

Anotar desde `out/live`: `datasetVersion`, `contentHash`, `lastSuccessfulFetchAt`, `geometryVersion`.

### E. Desplegar exclusivamente `litromio-data`

```powershell
# Solo Worker litromio-data (wrangler.jsonc name). No Mesa Uno. No app privada.
npx wrangler deploy --config wrangler.jsonc
```

### F. Verificar por HTTP (remoto)

```powershell
$env:EXPECTED_VERSION = "<datasetVersion>"
$env:EXPECTED_HASH = "<contentHash>"
$env:EXPECTED_FETCH_AT = "<lastSuccessfulFetchAt>"
# $env:PUBLIC_DATA_BASE_URL ya definida
node scripts/verify-published.mjs
# Opcional más estricto:
# $env:VERIFY_EXHAUSTIVE_PACKS = "1"
```

Comprobar además (curl/Invoke-WebRequest):

| Recurso | Esperado |
| --- | --- |
| `/current.json` | 200; punteros municipal/geometría; `datasetVersion` |
| `/v/{ver}/municipality-cells.json` | 200; mismo `datasetVersion`/`contentHash` |
| `/g/current.json` | 200; `Cache-Control` **mutable** (`max-age=60`, `must-revalidate`); CORS `*` |
| `/g/{geometryVersion}/municipality-catalog.json` | 200 |
| `/g/{geometryVersion}/geometry-catalog-manifest.json` + 1+ packs | 200; `Cache-Control` **immutable** (`max-age=31536000`) |
| Versiones retenidas `v/{prev}/` y `g/{prev}/` si declaradas | 200 |
| Cabeceras CORS en todos los JSON anteriores | `Access-Control-Allow-Origin: *` |

### G. Ciclo controlado de precios (conserva geometrías)

Aún con workflow **disabled**, en la misma máquina/`COMMIT`:

```powershell
npx tsx src/cli.ts recover --public-base-url $env:PUBLIC_DATA_BASE_URL --out ./out
npx tsx src/cli.ts pipeline --input download --out ./out
# outcome published | synced_unchanged; needsDeploy true típico
# Confirmar out/live/g/ sigue presente y coherente
npx wrangler deploy --config wrangler.jsonc
node scripts/verify-published.mjs   # con EXPECTED_* del live recién generado
```

Éxito = precios actualizados/frescos **y** geometrías intactas en CDN.

### H. Reanudar programación

Solo tras G OK: **Enable workflow** `update-litromio-data`. No hace falta cambiar el `cron` del YAML. Vigilar el primer run programado o un `workflow_dispatch` único y su verify.

### I. Recuperación ante fallo (sin restaurar código incompatible)

| Fallo | Acción |
| --- | --- |
| Recover falla antes de geometry-publish | No publicar. Diagnosticar CDN/red. No `--allow-empty-publish` como atajo. |
| `geometry-publish` falla local | No deploy. `out/live` previo intacto si el CLI abortó antes del swap. |
| Deploy OK pero verify HTTP falla | **No** reactivar workflow. No desplegar desde commit antiguo. Re-recover + re-validar; corregir árbol; re-deploy solo con commit municipal. |
| Job Actions antiguo desplegó sin `g/` | Disable workflow de nuevo; cancelar cola; volver a B–F con commit municipal; **no** “revertir” el repo a un SHA pre-municipal para “arreglar” el CDN. |
| Rollback de Worker en Cloudflare | Solo a una versión de assets que ya incluya el mismo contrato municipal **o** precios legacy **sin** declarar `geometry*` en `current.json`. Nunca mezclar `current.json` nuevo (con punteros `g/`) con assets viejos sin `g/`. |

## Pendientes remotos (claros)

- Medir en Actions/Cloudflare: wall-time `wrangler deploy`, bytes subidos, omisión de blobs sin cambio.
- Confirmar en CDN real que `_headers` aplican CORS/Cache-Control a `/g/*` y `/g/current.json`.
- Autorizar el primer `geometry-publish` + deploy (este checkpoint **no** lo ejecuta).

## Límites Free (oficiales)

Fuente: https://developers.cloudflare.com/workers/platform/limits/

- **20 000** archivos / versión Worker (Free)
- **25 MiB por archivo** (Free y Paid; no es tope del árbol)

## Fusiones y sin Minetur

- Relaciones INE→varios IDs Minetur en `municipality-catalog.json` (dedupe).
- `ineWithoutMinetur[]` publicado; sin precios inventados.
- Índice de celdas por `idMunicipality` Minetur; el cliente une IDs en fusiones.
