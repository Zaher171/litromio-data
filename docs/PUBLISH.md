# Publicación prevista (no activada)

## Destino elegido

**Worker Cloudflare independiente** (`litromio-data`) con **Static Assets**, distinto del Worker de la aplicación privada Litromio.

Soporte municipal (Fase 4D, local): ver [`docs/FASE-4D-MUNICIPAL.md`](FASE-4D-MUNICIPAL.md) — prefijo `g/{geometryVersion}/`, `municipality-cells.json`, recover/promote que conserva geometrías. Sin segundo Worker.

| Aspecto | Decisión |
| --- | --- |
| CDN | Workers Static Assets (no GitHub Pages, no `raw.githubusercontent.com`, no artefactos Actions como CDN de producción) |
| R2 / KV / D1 | **No** en este pipeline de datos |
| Cuenta | Misma cuenta Cloudflare posible; Worker **separado**; no tocar Mesa Uno |
| Credenciales | API token de alcance mínimo → secret de GitHub **futuro**; nunca en archivos; **no se solicitan en 1C.1** |
| Frecuencia de deploy | Contenido nuevo **o** metadatos de sync (`synced_unchanged`) — ver abajo |
| Presupuesto | Workers Free: peticiones a estáticos **gratuitas e ilimitadas** (doc oficial); sin coste de almacenamiento de Assets documentado |

## Límites Free consultados (2026-08-27 / docs Cloudflare)

| Límite | Free |
| --- | --- |
| Archivos por versión de Worker | **20 000** |
| Tamaño por archivo | **25 MiB** |
| Requests a Static Assets | Free / unlimited (si no se invoca el script Worker) |
| Requests al script Worker | 100 000 / día (evitar `run_worker_first` para JSON) |
| Workers por cuenta | 100 |
| Versiones listables | ~100 recientes |
| API Cloudflare | 1 200 req / 5 min (cuenta) |

## Compatibilidad con ~48 ciclos/día

- Actions en repo **público** + runners estándar: minutos **no** consumen el cupo Free de privados (doc GitHub).
- Cada consulta exitosa puede requerir deploy:
  - `published` — contenido + metadatos
  - `synced_unchanged` — **solo metadatos mutables** (`sync.json`, punteros); sigue siendo un `wrangler deploy` del árbol
- Recalculo: hasta **~48 deploys/día** si se renueva frescura en cada ciclo (no afirmar “sin deploy” cuando hay sync).
- Rate limit API (1 200/5 min) holgado; **PENDIENTE** medir wall-time real de `wrangler deploy`.

## Recuperación del estado publicado

Antes de generar en un runner limpio:

```text
npx tsx src/cli.ts recover --public-base-url <URL_PUBLICA> --out ./out
```

- Verifica manifiesto, esquema, hashes y archivos de retención.
- Fallo → detener (no bootstrap implícito).
- URL: variable de repo `PUBLIC_DATA_BASE_URL` (configurable). **No inventada** en el código ni en el ejemplo.

Primer despliegue: `--allow-empty-publish` / input `allow_empty_publish=true` del workflow.

## wrangler.jsonc

Configuración sin `account_id` ni secretos. `assets.directory = ./out/live`, `run_worker_first: false`.

Cabeceras CORS/Cache-Control: `static/_headers` → copiado a `out/live/_headers` en cada publish (Static Assets las aplica).

## Contenido exacto a publicar

Tras publish exitoso (`out/live/`):

- `manifest.json`, `current.json`, `sync.json`
- `_headers`
- `v/<16 hex>/manifest.json`
- `v/<16 hex>/cells/*.json`
- Opcional: `v/<16 hex>/municipality-cells.json` + punteros municipales en `current.json`
- Opcional: `g/current.json`, `g/<geometryVersion>/…` (ciclo A; no regenerar en sync de precios)
- Opcional: retención de `v/<versión anterior>/` y `g/<geometría anterior>/`

Primera incorporación remota de `g/`: procedimiento y concurrencia en [`docs/FASE-4D-MUNICIPAL.md`](FASE-4D-MUNICIPAL.md). No ejecutar geometry-publish/deploy sin autorización; un job Actions antiguo o un deploy local paralelo puede publicar un árbol sin geometrías.

## Generación local vs publicación remota

| Paso | Qué hace | Activado en 1C.1 |
| --- | --- | --- |
| `pipeline` / `generate` | Escribe `./out/live` | Sí (local / futuro Actions) |
| `wrangler deploy` | Publica el árbol al Worker | **No** (`if: false` en el ejemplo) |

Tras autorizar deploy: comprobar `GET {PUBLIC_DATA_BASE_URL}/current.json` y `/sync.json` (HTTP 200, JSON, `datasetVersion` / `lastSuccessfulFetchAt` coherentes).

## No usar sin verificación adicional

- GitHub Pages como CDN de JSON de producción.
- `raw.githubusercontent.com`.
- Artefactos de Actions como única fuente de verdad entre runners.
