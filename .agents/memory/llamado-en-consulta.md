---
name: Llamado = EN CONSULTA (bloqueo)
description: Desde jul 2026, llamar a un paciente cambia el estado del turno a "llamado" y lo bloquea para otros médicos.
---

Regla: POST /turnos/:id/llamar ya NO mantiene el estado — transiciona a `llamado` (la UI lo muestra como "En consulta"). El turno guarda `llamadoPorProfesionalId`; mientras esté en `llamado` con ese campo seteado, solo ese médico puede re-llamar y (salvo admin) solo él puede finalizar la consulta que libera el bloqueo (`/consultorio/consultas/finalizar` lo exige en el WHERE del UPDATE).

**Why:** pedido del usuario — evitar que dos médicos llamen al mismo paciente (guardia/agendas grupales); el bloqueo dura hasta "Finalizar Consulta".

**How to apply:** el guard es atómico (condición en el UPDATE, no solo precheck 409). Cualquier código nuevo que asuma que "llamar no cambia el estado" está desactualizado; salidas de rescate: staff puede marcar `ausente` o `en_atencion`, y admin finaliza siempre. Chips/labels de `llamado` deben decir "En consulta".
