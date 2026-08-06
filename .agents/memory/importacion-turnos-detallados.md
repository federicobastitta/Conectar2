---
name: Importación Turnos detallados Alephoo
description: Cómo se importan los exports "Turnos detallados" y por qué nunca via POST /turnos
---
Regla: las importaciones masivas de turnos escriben DIRECTO a la base vía el endpoint admin `POST /importaciones-admin/turnos-detallados` (multipart `archivo`, background, progreso en `importaciones_admin` por runId). NUNCA usar `POST /turnos` para importar.

**Why:** POST /turnos dispara validaciones de reserva (slot pasado, obras sociales) y automatizaciones (encolado Klinicos al reservar, Pixel, avisos) — 16k requests habrían generado miles de trabajos espurios.

**How to apply:** cualquier carga masiva futura (re-exports de Alephoo u otros HIS) va por ese endpoint o por la misma lib (`api-server/src/lib/importacion-turnos-detallados.ts`). Es idempotente: dedup a nivel trío sede+especialidad+médico, re-subir el mismo archivo da 0 creados. Guard anti-concurrencia: flag en memoria + run "procesando" (<2 h) en la base. Contador `turnosErrores` separa errores reales de duplicados. La duración se infiere por gap modal (mín. 3 gaps de evidencia; valores válidos 10/15/20/30/40/60).
