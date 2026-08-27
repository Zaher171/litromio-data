# Consistencia, fallos y datos antiguos

## Inmutabilidad y versiones

- Cada conjunto lleva `datasetVersion` = 16 hex del `contentHash` (SHA-256 del contenido normalizado, **sin** fechas de reloj).
- Rutas versionadas **inmutables**: `v/{datasetVersion}/cells/...` y `v/{datasetVersion}/manifest.json`.
- Punteros **mutables** con caché corta: `manifest.json`, `current.json`, `sync.json`.
- **No** cambiar bytes bajo una URL ya publicada como inmutable.

## Relojes de sync (no confundir)

| Campo | Significado |
| --- | --- |
| `sourceFecha` | `Fecha` asociada al **contenido** activo (la misma que en el manifiesto de ese `datasetVersion`) |
| `lastObservedSourceFecha` | `Fecha` de la fuente en la última consulta válida aceptada (puede ser posterior si solo cambió la cabecera) |
| `lastSuccessfulFetchAt` | Instantánea ISO de esa descarga/validación |
| `contentPublishedAt` / `publishedAt` | Cuándo se publicó el **contenido** de ese `datasetVersion` (no cambia en sync-only) |

`contentHash` y `datasetVersion` identifican el contenido normalizado **sin** fechas de consulta. El manifiesto versionado y las particiones son inmutables; su `sourceFecha` conserva la fecha de la fuente con la que se publicó ese contenido.

`sync.json` concentra la evidencia de consulta sin tocar el árbol `v/…`. Una UI futura debe mostrar frescura con `lastSuccessfulFetchAt` / `lastObservedSourceFecha`, no asumir que `sourceFecha` avanza en cada ciclo.

## Publicación sin mezclar versiones

1. Generar árbol completo en `staging/`.
2. Fusionar retención de versión anterior si aplica.
3. Escribir `sync.json` y `_headers`.
4. **Validar todo el árbol staging** (manifiesto, hashes, versiones retenidas, cabeceras).
5. Reemplazar `live/` solo si la validación pasa.
6. Remoto (futuro): un único `wrangler deploy` del árbol live → versión de Worker atómica en Cloudflare.

Nunca servir celdas de la versión N con un manifiesto de la N+1.

## Reemplazo local en Windows (no atómico)

En este entorno, `rename` de directorios grandes bajo Desktop puede fallar con `EPERM`.
El publish local usa **copia + reemplazo** de `live/` (con restauración desde `.bak` si falla a mitad).

Esa secuencia **no es atómica para lectores concurrentes**: durante la ventana de borrado/copia un lector local podría ver `live/` incompleto. Sirve para pruebas y runners de un solo escritor; la atomicidad de lectura concurrente la aporta el **deploy de una versión de Worker** en Cloudflare, no la copia local.

## Cachés, CORS y clientes

Implementado en `static/_headers` (se copia a `out/live/_headers` en cada publish):

| Recurso | Cache-Control | CORS |
| --- | --- | --- |
| `v/{id}/...` | `public, max-age=31536000, immutable` | `Access-Control-Allow-Origin: *` |
| `manifest.json` / `current.json` / `sync.json` | `public, max-age=60, must-revalidate` | igual |

La app privada (otro origen) debe poder hacer `GET` de esos JSON gracias a CORS en Static Assets (`run_worker_first: false` → aplican `_headers`).

### Cliente con versión antigua ya no retenida

1. El cliente guarda un `datasetVersion` y pide celdas `v/{old}/…`.
2. Si la retención (`retainPreviousVersions: 1`) ya omitió esa versión en un deploy posterior, esas URLs responden **404**.
3. Reacción correcta: volver a leer `current.json` / `sync.json`, adoptar el `datasetVersion` activo y descargar solo las celdas nuevas.
4. No reutilizar celdas de un manifiesto viejo mezcladas con el puntero nuevo.

## Frescura sin cambio de precios

Si `contentHash` coincide con el activo y la `Fecha` observada es **igual o posterior** a `lastObservedSourceFecha`:

- Outcome: `synced_unchanged` (no “skip sin deploy”).
- Se actualizan solo mutables: `sync.json` (`lastSuccessfulFetchAt`, `lastObservedSourceFecha`), `current.json` / `manifest.json` raíz (frescura; `sourceFecha` del contenido se conserva).
- **No** se mutan archivos bajo `v/{datasetVersion}/`.
- `needsDeploy: true` — hay que publicar metadatos para que la frescura pública no parezca abandonada.

Si la `Fecha` observada es **anterior** a `lastObservedSourceFecha` → `abandoned_stale` (antes de decidir sync vs publish). Comparación vía `parseFuenteFechaToEpoch` (Europe/Madrid), no lexicográfica.

### Publicaciones diarias (recalculo)

Objetivo ~cada 30 min → hasta **~48 ciclos/día**.

| Antes (incorrecto) | Ahora |
| --- | --- |
| “Deploy solo si cambia el hash” → 0 deploy si precios iguales | Cada consulta exitosa puede exigir **deploy de metadatos** (`synced_unchanged`) o de contenido (`published`) |
| Frescura pública estancada si no hay cambio de precio | `lastSuccessfulFetchAt` público se renueva |

Hasta ~48 `wrangler deploy`/día sigue dentro del rate limit API Free documentado (1 200 / 5 min), **pendiente** de medir wall-time real.

## Reintentos e idempotencia

- Descarga: `withRetries` (red); no escribe live hasta validar.
- Mismo `contentHash` → `synced_unchanged` (idempotente en contenido; sí actualiza frescura).
- Lease en disco (`.publish.lock`) evita concurrencia.

## Estado entre runners / Actions

Los runners parten de disco vacío. La fuente de verdad publicada es la **URL pública** (`PUBLIC_DATA_BASE_URL` / `--public-base-url`), no artefactos ni cachés de Actions.

`recoverPublishedState`:

- Descarga `current.json`, `manifest.json`, manifiesto versionado, `sync.json`, celdas activas y retenidas.
- Verifica esquema, hashes, rutas canónicas y coherencia (mismo conjunto).
- `sync.json` y `manifest.json` raíz son **obligatorios** (sin síntesis ni fallback).
- Si `sync.json` publicado aún no trae `lastObservedSourceFecha`, se admite y se rellena con su `sourceFecha` (solo en el sync mutable local; no se tocan archivos versionados).
- `_headers` se toma de `static/_headers` local, no del CDN.
- Ante red, HTTP inesperado, esquema, ruta insegura o corrupción → **no publicar**.
- Eso **no** es primer arranque.

Primer despliegue solo con `--allow-empty-publish` / `allow_empty_publish=true` documentado.

## Ejecuciones concurrentes o antiguas

- Lease TTL (15 min por defecto).
- Si `Fecha` / `downloadedAt` son más antiguos que la última observación aceptada → `abandoned_stale`.

## Descarga incompleta / fallo

- Validación de JSON + `ResultadoConsulta` + umbral **nacional absoluto** (producción: 8 000 estaciones) y ratio vs activa.
- **No** relajar el umbral por tamaño de respuesta HTTP.
- Fixtures pequeñas: solo `--dev-fixtures` / `FIXTURE_PIPELINE_CONFIG` (pruebas/desarrollo).
- Fallo de publicación → live intacto (`failed_publish`).
- Sin live y sin `allowEmptyPublish` → `refused_empty_bootstrap`.

## Aviso de datos antiguos

- Campo `staleAfterMinutes` (default 90).
- La app compara `lastSuccessfulFetchAt` (preferente) o `downloadedAt`/`publishedAt` con el reloj local.
- **No** fingir frescura si el sync se detuvo.

## Retención y limpieza

- Conservar versión activa + 1 anterior en el árbol de assets.
- No acumular snapshots en Git.
- Limpieza = omitir versiones más viejas en el siguiente deploy exitoso de contenido.
