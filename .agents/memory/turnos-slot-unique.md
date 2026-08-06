---
name: Anti doble-reserva de turnos
description: Cómo se garantiza un solo turno activo por slot y qué deben respetar código y tests.
---
Regla: existe un índice único parcial `turnos_slot_activo_unique` en `(turnera_id, fecha, hora_inicio)` WHERE estado NOT IN ('cancelado','ausente') AND sobreturno=false.
**Why:** el check-then-insert de reservas permitía doble booking bajo concurrencia (hallazgo de revisión); la garantía real vive en la DB.
**How to apply:** todo insert de turnos no-sobreturno debe capturar la violación unique (código PG 23505, helper `esViolacionUnique` en api-server/src/lib/pg.ts) y responder 409. Los tests que crean varios turnos activos en la misma turnera/fecha deben usar horaInicio distinta o marcar sobreturno=true.
