# litromio-data

Paquete **independiente** para el proceso público de actualización y los JSON derivados de la fuente oficial de precios de carburantes en España.

No contiene la aplicación Litromio, su historial Git, secretos ni configuración de otros proyectos.

## Estado

- Preparado y probado **en local** (Fase 1C.1: recover, sync de frescura, umbral de producción fijo; Fase 4D: índice municipal + geometrías bajo `g/`, ver `docs/FASE-4D-MUNICIPAL.md`).
- Repositorio público de código del pipeline; la salida generada (`out/`) **no** se versiona en Git.
- Workflow Actions activo: `workflow_dispatch` + **schedule** cada ~30 min (`17,47 * * * *` UTC). **No** regenera geometrías IGN en ese cron.
- GitHub puede retrasar u omitir ejecuciones programadas; no es tiempo real garantizado.
- El cron puede desactivarse en repos públicos tras ~60 días de inactividad.
- La aplicación Litromio debe avisar si la última sincronización válida es antigua (`docs/CONSISTENCY.md`).
- Licencia del **código** de este paquete: **pendiente de decisión del usuario** (ver `LICENSE-CODE.PENDING.md`).
- Condiciones de los **datos**: reutilización del sector público (ver `docs/SOURCE.md` y `docs/ATTRIBUTION.md`).

## Qué genera

- JSON particionado por **cuadrícula geográfica** 0,5° (WGS84).
- `municipality-cells.json` por `datasetVersion` (índice Minetur→celdas).
- Opcional: packs geométricos IGN + catálogo INE↔Minetur bajo `g/{geometryVersion}/`.
- `manifest.json` / `current.json` / `sync.json` con atribución y relojes: `sourceFecha` (contenido), `lastObservedSourceFecha` (última consulta), `lastSuccessfulFetchAt`, `contentPublishedAt` / `publishedAt`.
- Precios como texto (precisión preservada); `IDEESS` como id estable.
- Validación del árbol completo antes de reemplazar `live/`.
- `synced_unchanged` actualiza frescura mutable (requiere deploy de metadatos); no muta `v/…` ni `g/{version}/…`.

## Comandos

Desde la raíz de este repositorio:

```powershell
npm ci
npm test
npm run check

# Descarga en vivo (genera out/; no publica en Git ni en Cloudflare):
npx tsx src/cli.ts pipeline --input download --out .\out --allow-empty-publish

# O desde un JSON local ya descargado (ruta relativa a este repo):
npm run measure -- --input .\fixtures\estaciones-terrestres.json --out .\out --allow-empty-publish
```

## Documentación

| Doc | Contenido |
| --- | --- |
| `docs/SOURCE.md` | Fuente, URLs, reutilización |
| `docs/ATTRIBUTION.md` | Texto de atribución |
| `docs/RUN.md` | Ejecución local |
| `docs/PUBLISH.md` | Publicación prevista (Worker Static Assets) |
| `docs/CONSISTENCY.md` | Versiones, sync, CORS, fallos, clientes |
| `docs/SECURITY-ACTIONS.md` | Seguridad del workflow Actions activo |
| `examples/workflows/update-data.yml` | Ejemplo de workflow (**fuera** de `.github/workflows`) |
