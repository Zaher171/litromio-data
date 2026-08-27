# Seguridad de GitHub Actions (diseño — no activado)

Este archivo describe el diseño. El workflow de ejemplo está en `examples/workflows/update-data.yml` (**no** en `.github/workflows`) para que Actions no se active hasta copiarlo y autorizarlo explícitamente.

## Principios

| Control | Diseño |
| --- | --- |
| Runner | `ubuntu-latest` (estándar Linux; no larger runners de pago) |
| Permisos | `permissions: contents: read` (+ lo mínimo para deploy si aplica vía token Cloudflare, no `write` al repo de datos en Git) |
| Acciones de terceros | Fijadas a **SHA de commit** verificados (no tags flotantes solos) |
| PRs externos | Sin ejecución privilegiada; **no** `pull_request_target` |
| Secretos | Futuros: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` — **no solicitados ni añadidos en 1C.1** |
| Arranque | Primero `workflow_dispatch` manual; `schedule` después de revisión |
| Primer publish | Input `allow_empty_publish=true` solo una vez; no usar si falló recover |
| Estado previo | `PUBLIC_DATA_BASE_URL` (variable de repo) + `cli recover` antes de generar |
| Cron | Fuera del minuto `:00` (p. ej. `17,47 * * * *`); documentar retrasos/omisiones posibles |
| Inactividad | Repo público: schedule puede desactivarse a los 60 días sin actividad; **sin** commits dummy |
| Artefactos | No usar como CDN ni como única fuente de verdad entre runners |
| Deploy | Paso remoto **desactivado** (`if: false`) hasta autorización |

## SHAs fijados en el ejemplo (verificados 2026-08-27)

| Acción | Tag | SHA |
| --- | --- | --- |
| `actions/checkout` | v4.2.2 | `11bd71901bbe5b1630ceea73d27597364c9af683` |
| `actions/setup-node` | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |

## Separación de repos

- `Zaher171/litromio` — privado (app).
- `litromio-data` — público (solo pipeline + docs de datos; salida en CDN Cloudflare, no en Git).

## Credencial Cloudflare futura

- Token con permiso mínimo de Workers Scripts / Assets del Worker de datos.
- No acceso a Mesa Uno ni al Worker de la app si se puede acotar.
- Rotación documentada; sin volcar en logs.
- Comprobación post-deploy: HTTP GET a `current.json` y `sync.json` en la URL pública.
