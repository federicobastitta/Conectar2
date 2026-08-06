---
name: Guard de envío a Pixel
description: Los requests que mutan datos en Pixel solo salen en producción; cobertura de agendas por especialidad.
---

**Regla:** ningún request mutante (no-GET) sale hacia la integración real de Pixel salvo `NODE_ENV==='production'` o `PIXEL_INTEGRACION_ACTIVA==='true'`. Guard central `pixelEnvioActivo()` aplicado en la capa de red (`pacsV1Fetch`, `pacsFetch`, `avisarLlamadoPixel`). Los GETs de lectura pasan en dev (no contaminan).

**Why:** las suites de test en el sandbox comparten tokens con prod y mandaron miles de órdenes "TEST…, SUGERENCIA" al PACS real de la clínica (jul–ago 2026). Pixel pidió frenarlas.

**How to apply:** cualquier camino saliente nuevo hacia Pixel debe pasar por esas funciones de red o chequear `pixelEnvioActivo()`. Fixtures de test que crean prácticas de catálogo deben setear `generaDicom: false`. Para pruebas coordinadas con Pixel desde dev, setear `PIXEL_INTEGRACION_ACTIVA=true` temporalmente.

**Cobertura de agendas:** decide `COALESCE(turneras.envia_worklist, especialidades.envia_al_pacs)`; `false` en la turnera es bloqueo absoluto aunque la especialidad tenga true. Seed idempotente al arrancar activa `envia_al_pacs` + `modalidad_dicom` para las especialidades que Pixel procesa (matching por nombre, palabra completa — "OCT" matcheaba apellidos). El reconciliador de worklist solo cubre turnos con fecha >= hoy: turnos históricos que quedaron sin ítem requieren resync manual por turnoId. Mejora futura documentada: matching por práctica de catálogo (Opción C).
