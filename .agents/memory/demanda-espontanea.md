---
name: Demanda espontánea (ingreso ambulatorio)
description: Reglas del circuito de pacientes sin turno (bolsa esGuardia)
---

- Modo bolsa: el ingreso ambulatorio entra a la turnera grupal `esGuardia` de la especialidad SIN médico asignado; los médicos lo toman desde consultorio (flujo tomar guardia existente).
- El médico prende `profesionales.acepta_demanda_espontanea` desde su consultorio; ese switch es el criterio de presencia. Las guardias están abiertas 24 hs todos los días: NO se filtra por diasAtencion/horaFin de la bolsa (bolsaHasta fijo 23:59); la agenda personal solo informa el "hasta hora" si existe.
- La pertenencia médico↔guardia NO puede depender solo de `especialidad_id` del profesional (la mayoría de los médicos de guardia la tienen NULL): también cuentan los anotados en `turnera_participantes` de la bolsa. **Why:** con solo especialidad, prendían el switch y nunca aparecían como "atendiendo".
- **POST /turnos con turnera esGuardia exige rol staff** (admin/recepcionista/medico). La reserva pública quedó solo para agendas programadas. **Why:** la bolsa es circuito interno; sin guard, cualquiera podía inyectar pacientes a la guardia.
- Regla mixta: al crear en bolsa, si hoy hay turnos programados de la misma especialidad ya recepcionados (arribo/recepcionado/en_sala/llamado), la horaInicio se corre a 1 min después del último recepcionado — el que llega sin turno se forma detrás.
- El ingreso desde UI manda fecha/hora actual argentina calculada client-side con toLocaleDateString/TimeString y timeZone AR.
