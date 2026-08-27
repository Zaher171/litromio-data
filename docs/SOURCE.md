# Fuente oficial de datos

## Recurso

| Campo | Valor |
| --- | --- |
| Nombre | Precios de carburantes en las gasolineras españolas |
| Catálogo | https://datos.gob.es/es/catalogo/e05068001-precio-de-carburantes-en-las-gasolineras-espanolas |
| REST nacional | https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/ |
| Help | https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/help |
| Condiciones de reutilización | https://sede.serviciosmin.gob.es/es-ES/Paginas/aviso.aspx#Reutilizacion |

Consultado en Fase 1A/1C: **2026-08-27**.

## Reutilización y redistribución

Según el aviso legal de la sede (condiciones generales Ley 18/2015 / reutilización del sector público), aplicables a conjuntos de datos abiertos:

1. No alterar el contenido (incl. metadatos) de forma que se desnaturalice.
2. No desnaturalizar el sentido de la información.
3. **Citar la fuente.**
4. **Mencionar la fecha de la última actualización.**
5–6. Restricciones adicionales si hubiera datos personales / disociación.

No hay en ese aviso una prohibición explícita de uso comercial ni de redistribución de los datos abiertos bajo esas condiciones. Este paquete redistribuye JSON **derivados** (particionados, normalizados) manteniendo precios/identificadores/atribución/fecha.

El ministerio se reserva medidas técnicas ante uso abusivo o robotizado. Diseño: **una** petición nacional por ciclo, User-Agent identificable, cadencia ~30 min (alineada con la `Nota` de la API, sin cuota numérica publicada).

## Distinción de fechas

| Campo | Significado |
| --- | --- |
| `sourceFecha` | Campo `Fecha` de la respuesta oficial |
| `downloadedAt` | Instantánea ISO de la descarga en el pipeline |
| `publishedAt` | Instantánea ISO de publicación del conjunto (local o CDN) |

## Qué no se versiona en Git

- Snapshots nacionales crudos (~12 MB).
- Árbol `out/live` generado.
- Secretos / tokens Cloudflare.
