# Seguridad de GitHub Actions

Workflow activo en `.github/workflows/update-data.yml`. Ejemplo histórico en `examples/workflows/update-data.yml`.

## Principios

| Control | Diseño |
| --- | --- |
| Runner | `ubuntu-latest` (estándar Linux; no larger runners de pago) |
| Permisos | `permissions: contents: read` (+ lo mínimo para deploy si aplica vía token Cloudflare, no `write` al repo de datos en Git) |
| Acciones de terceros | Fijadas a **SHA de commit** verificados (no tags flotantes solos) |
| PRs externos | Sin ejecución privilegiada; **no** `pull_request_target` |
| Secretos | Futuros: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` — **no solicitados ni añadidos en 1C.1** |
| Arranque | `workflow_dispatch` manual + `schedule` (`17,47 * * * *` UTC, ~cada 30 min) |
| Primer publish | Input `allow_empty_publish=true` solo una vez; no usar si falló recover |
| Estado previo | `PUBLIC_DATA_BASE_URL` (variable de repo) + `cli recover` antes de generar |
| Cron | `17,47 * * * *` — minutos 17 y 47 de cada hora UTC (~cada 30 min); fuera de `:00` |
| Retrasos | GitHub puede retrasar u omitir ejecuciones programadas; **no** es tiempo real garantizado |
| Inactividad | Repo público: schedule puede desactivarse a los 60 días sin actividad; **sin** commits dummy |
| Datos antiguos | La app Litromio debe avisar si `lastSuccessfulFetchAt` supera el umbral (`docs/CONSISTENCY.md`) |
| Artefactos | No usar como CDN ni como única fuente de verdad entre runners |
| Deploy | Condicionado a `needsDeploy`; verificación HTTP post-deploy |
| Concurrencia GHA | `concurrency.group: litromio-data-update`, `cancel-in-progress: false` → jobs en cola; uno antiguo **termina** y puede desplegar |
| Deploy local | `wrangler deploy` manual **no** participa en ese grupo; puede pisar/ser pisado por Actions |
| 1ª geometría | Pausar workflow (Disable en UI, sin editar cron YAML), drenar runs activos/pendientes, publicar, ciclo precios controlado, luego Enable — ver `docs/FASE-4D-MUNICIPAL.md` |

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
