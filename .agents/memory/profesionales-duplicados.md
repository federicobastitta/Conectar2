---
name: Profesionales duplicados en prod
description: Limpieza de duplicados por doble importación — desactivar, nunca borrar
---

Una importación corrida dos veces creó ~68 profesionales duplicados en prod (ids viejos bajos vs reimportados 15xx–17xx). Limpieza 2026-07-28: se desactivó la copia sin turnos futuros y sus turneras (68 profesionales + 143 turneras + turnera 1252 de Figueroa), vía PATCH en la app publicada.

**Regla del keeper:** conserva la copia con turnos futuros; si ninguna tiene, la de más turnos históricos, luego más agendas activas, luego id más alto.

**Why:** borrar (DELETE /profesionales) huérfana turnos/turneras históricos; desactivar es reversible y preserva historial.

**Prevención en importador v2:** cuando la matrícula viene vacía, analizarFila matchea por nombre normalizado (sin tildes, sin puntuación, orden de palabras indistinto) y prefiere el registro activo sobre duplicados desactivados.

**How to apply:** ante nuevos duplicados (otra reimportación), repetir el mismo criterio: nunca DELETE, siempre activo=false + turneras activa=false. Los pickers del frontend deben filtrar `activo !== false` (GET /profesionales devuelve también inactivos por defecto).

## Agendas (turneras) duplicadas — regla de limpieza (jul 2026)
Los "profesionales duplicados" del picker eran turneras: el picker mostraba también las inactivas ("(inactiva)") — ya se filtran por activa — y había ~50 grupos de turneras activas con mismo nombre+sede.
**Regla aplicada:** desactivar (nunca DELETE) solo la turnera cuyo días/horario está cubierto por otra hermana del grupo; las que tienen turnos futuros se unifican moviendo esos turnos a la sobreviviente (ver agendas-unificadas.md, script scripts/unificar-agendas-duplicadas.mts). Dev y prod son bases separadas: correr el procedimiento en cada una (prod vía la API publicada con admin).
