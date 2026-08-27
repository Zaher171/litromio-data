# Ejecución local

## Requisitos

- Node.js ≥ 22.12.0
- npm (mantener `package-lock.json`)

## Instalación

Desde la raíz de este repositorio:

```powershell
npm ci
```

## Pruebas

```powershell
npm test
npm run check
```

## Modos de configuración

| Modo | Cómo | Umbral estaciones |
| --- | --- | --- |
| Producción (default) | sin flags especiales | `minStationCountAbsolute = 8000` |
| Fixtures / desarrollo | `--dev-fixtures` | umbral bajo (`FIXTURE_PIPELINE_CONFIG`) |

**Prohibido** relajar el umbral automáticamente por tamaño de descarga. `--dev-fixtures` es incompatible con la ejecución de producción / Actions de datos.

## Generar desde fixture local

Coloca un JSON de estaciones en una ruta local (p. ej. `.\fixtures\estaciones-terrestres.json`; esa carpeta no se versiona). Luego:

```powershell
npm run measure -- --input .\fixtures\estaciones-terrestres.json --out .\out --allow-empty-publish
```

Para fixtures pequeñas de prueba:

```powershell
npx tsx src/cli.ts pipeline --input .\fixture-pequeña.json --out .\out --dev-fixtures --allow-empty-publish
```

Salida en `out/live/`:

- `manifest.json` — índice + metadatos (mutable)
- `current.json` — puntero compacto (mutable)
- `sync.json` — frescura / última consulta exitosa (mutable)
- `_headers` — CORS + Cache-Control
- `v/{datasetVersion}/cells/{cellId}.json` — particiones **inmutables**
- `v/{datasetVersion}/manifest.json` — copia versionada **inmutable**

## Primer arranque vs recuperación

- Sin estado previo: hace falta `--allow-empty-publish`.
- Con CDN ya publicado: recuperar antes de generar:

```powershell
npx tsx src/cli.ts recover --public-base-url https://TU-URL-PUBLICA --out .\out
npx tsx src/cli.ts pipeline --input download --out .\out
```

Un fallo de `recover` **no** se trata como primer arranque.

## Descarga en vivo (opcional)

```powershell
npx tsx src/cli.ts pipeline --input download --out .\out --allow-empty-publish
```

Outcomes relevantes: `published`, `synced_unchanged` (ambos con `needsDeploy: true`), `refused_empty_bootstrap`, `failed_validation`, etc.

No programar ni desplegar desde este entorno sin revisión.
