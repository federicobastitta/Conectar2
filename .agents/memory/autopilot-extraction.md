---
name: Autopilot data extraction
description: How to pull catalog + agenda/schedule data from the external Autopilot (go.autopilotcare.io) tRPC API.
---

# Autopilot (go.autopilotcare.io) extraction

Autopilot exposes a public tRPC API at `/api/trpc` (superjson transformer). GET shape:
`/api/trpc/<proc>?batch=1&input=<urlencode({0:{json:INPUT}})>` with headers Referer/Origin/User-Agent
pointing at the tenant's `reservar` page. Filter every call by `{tenantId:<UUID>}`, NOT the slug.

**Key gotcha — the schedule template is NOT exposed.** `alephoo.agendasPorProfesional` returns
agendaId/especialidad but `dia:0` and empty hours, so it is useless for días/horarios/minutos.

**The only reliable source of días/horarios/duración is `alephoo.turnosDisponibles`**
(`{especialidadId, fechaInicio, fechaFin, limit<=150, tenantId}`). It returns REAL bookable slots:
`{hora, fecha, cantidadTurnosDisponibles, agendaId, institucionId, institucionNombre, medicoNombre}`.
Reconstruct schedules by aggregating slots per `agendaId`:
- días = set of `getUTCDay()` over `fecha` (parse as `new Date(\`${fecha}T00:00:00.000Z\`)`)
- horaInicio/horaFin = min/max `hora`; duración = smallest positive gap between sorted `hora`s
- sede = `institucionId`/`institucionNombre`; médico = `medicoNombre` (messy: mixed name order +
  parenthetical office notes like "(Calle 147)" — strip them; link to clean identity via
  agendaId→personalId from agendasPorProfesional when it overlaps, else parse the string).

**Why:** faithfully importing "días, horarios y cada cuántos minutos atienden" cannot come from any
template endpoint; it must be inferred from actually-offered slots over a wide window (~3 months).

**How to apply:** widen the date window and iterate all visible especialidades
(`especialidades.getVisibles {tenantId}`) — some especialidades have 0 availability and yield no
agenda. The professional↔sede relationship in our DB lives on `turneras` (profesionalId+sedeId), not
on `profesionales` (no sedeId column).
