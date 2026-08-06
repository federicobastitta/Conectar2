---
name: Guardia virtual — contrato con el portal del paciente
description: Reglas del push de videollamadas de guardia al portal (campos exigidos, eventos, hooks)
---

- El portal recibe `POST {APP_PACIENTE_PUSH_URL}/api/integracion/videollamadas` con Bearer `APP_PACIENTE_PUSH_TOKEN`.
- **`videollamadaId` es obligatorio y debe ser TEXTO**: con número lo rechaza con 400 "Falta videollamadaId" (probado ago 2026). Se manda `String(colaId)`.
- Eventos: `en_cola`, `tu_turno` (exige `linkVideollamada`, nunca encolar sin link), `cancelada`, `finalizada`. Reenvíos idempotentes (`action: updated`).
- Hooks de estado: llamar→tu_turno, devolver_sala→en_cola, no_presentado/cancelar→cancelada, finalizar consulta (consultorio_docs)→finalizada; siempre fire-and-forget con `void notificarEventoVideollamadaPorTurno(...)`.
- El link Jitsi se deriva del qrCodigo del turno (`urlVideollamadaTurno`), no se guarda.
- **Why:** el contrato lo definió el equipo del portal y no valida tipos con mensaje claro; un payload numérico falla silencioso en la cola de envíos.
- **How to apply:** cualquier campo nuevo del payload probarlo primero directo contra su endpoint (node fetch, nunca curl con secrets) antes de congelarlo en `videollamadas_envios`.
