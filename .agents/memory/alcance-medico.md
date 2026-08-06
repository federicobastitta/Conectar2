---
name: Alcance del rol médico
description: Regla de acceso a datos para usuarios con rol medico (turnos, pacientes, HCE, documentos)
---

Regla: un usuario rol `medico` solo puede ver/escribir sobre turnos y pacientes dentro de su alcance: turneras propias (`turneras.profesional_id`), turneras grupales donde participa (`turnera_participantes`), turnos con `turnos.profesional_id` suyo, y la bolsa de guardia (`es_guardia`) en /consultorio/agenda.

**Why:** pedido explícito del usuario (jul 2026): "el médico no puede tener botones en ningún lado que le permitan ver otros pacientes que no sean los asignados a él o turneras grupales que lo involucren".

**How to apply:** helpers centralizados en `api-server/src/lib/alcance-medico.ts` (`turneraIdsDelProfesional`, `turneraIdsGuardia`, `medicoPuedeVerPaciente`, `turnoEnAlcanceMedico`). Desde ago 2026 `medicoPuedeVerPaciente` y `turnoEnAlcanceMedico` incluyen la bolsa de guardia — sin eso los médicos de guardia recibían 403 en la HCE de sus pacientes (turnos de guardia sin profesional asignado). Ojo: la bolsa de guardia entra al alcance en TODAS las vistas de turnos del día (sala de espera, planilla/turnos-dia, consultorio) y sin filtrar por `activa` — hay guardias desactivadas (duplicadas) que igual reciben pacientes. Los turnos de guardia tienen `profesional_id NULL`: filtrar solo por turnos asignados deja la vista vacía para los médicos de guardia. Cualquier endpoint nuevo que exponga turnos/pacientes/HCE/documentos a rol medico debe usarlos. Los tests de aislamiento crean turnera+turno "scope" para dar alcance al médico de prueba — replicar ese patrón en tests nuevos. Excepción consciente: la bandeja de informes por modalidad (worklist) sigue mostrando toda la modalidad al informante.

Atendidos privados (ago 2026): en las listas del día para rol medico (/recepcion/turnos-dia y /consultorio/agenda), los turnos en estados atendidos-cerrados (`ESTADOS_ATENDIDO_CERRADO` en alcance-medico.ts) de turneras compartidas se ocultan si los atendió OTRO profesional (atribución `llamado_por_profesional_id ?? profesional_id`; sin atribución quedan visibles). Los pendientes siguen siendo bolsa compartida y el staff ve todo. Cualquier lista nueva del día para médicos debe aplicar la misma regla.

Atribución manual: PATCH /turnos/:id/estado acepta `atendidoPorProfesionalId` SOLO para staff no-médico, SOLO al cerrar (visto/pendiente_informe) y SOLO si el turno no tiene médico (profesional_id y llamado_por_profesional_id null; el no-pisado también va en el WHERE del UPDATE). El tablero de recepción pide el médico con un diálogo cuando se cierra a mano un turno sin médico.

Nota calendario "Agenda por médico": pasado en blanco, hoy azul, futuro verde/amarillo(≥50%)/rojo(completa). El buscador de paciente no filtra la lista del día cuando hay paciente seleccionado.
