---
name: Check in público de consultas
description: La app del paciente ve todas las agendas y valida token IOMA de turnos de consulta vía el handler compartido de sala_espera.
---
# Check in público de consultas (ago 2026)
- La API pública lista/reserva TODAS las agendas activas, guardias incluidas (se quitó el filtro visibilidad '%online%' y la exclusión esGuardia). Única excepción: la guardia de Odontología queda fuera de la app (helper esGuardiaExcluidaDeApp, match /odont/i por nombre o especialidad).
- POST /publico/turnos/:id/validar-token (x-api-key + dni dueño): guardas del canal (404 uniforme para turno ajeno, 409 práctica-Pixel vía coalesce(envia_worklist, envia_al_pacs) / turno no vigente) y después delega TODO en `ejecutarValidacionTokenTurno` exportado de sala_espera.ts.
**Why:** nunca reimplementar el circuito de token (reglas inviolables de facturación: aceptado solo con bono, consulta Klinicos se crea al validar); la ruta staff conserva solo la auth y comparte el cuerpo.
**How to apply:** cambios al flujo de token se hacen en el handler compartido (sirven a ambos canales); el actor de auditoría es ActorToken (id null = app del paciente). Prácticas y todo lo que va al Pixel siguen validando en recepción; las guardias sí pueden validar token por la app.
