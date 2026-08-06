---
name: Agente recepción con herramientas
description: Decisiones del tool-calling del chat IA de recepción (carga de turnos)
---

# Agente de recepción con tool-calling

Regla: las herramientas del agente IA nunca reimplementan lógica de negocio.
`crear_turno` llama por HTTP interno a `POST /api/turnos` (localhost:$PORT) reenviando
el Authorization del usuario, para reusar TODAS las validaciones (doble reserva,
cupos, guardia, worklist, robot, región anatómica).

**Why:** el POST /turnos tiene mucha lógica (23505→409, cupos por obra social,
guardia grupal); duplicarla en el agente generaba riesgo de turnos inválidos.

**How to apply:** cualquier tool nueva que escriba datos debe llamar al endpoint
real con el token del usuario, no insertar directo en la DB.

Otras decisiones:
- Las rondas de tools se persisten en `agenteMensajes.metadata.toolRounds`
  ({toolCalls, resultados}) y se reconstruyen al armar el historial; sin esto el
  modelo pierde los IDs/huecos ofrecidos y no puede resolver "confirmo el de las 13:15".
- Última ronda del loop (6) va sin tools para forzar respuesta en texto.
- Tool calls sin id o nombre se descartan (deltas de streaming malformados).
- El prompt exige confirmación explícita del usuario antes de crear_turno.
- Tools de documentos (documentos_paciente/enlace_pdf) pasan por /api/consultorio/*,
  que por política testeada solo permite admin/medico: para recepcionista devuelven
  403 y el agente lo explica. Cambiar eso es decisión de producto, no un bug.
- Informes de estudios se listan con lectura directa de DB en la tool: es válido
  porque el agente "recepcion" solo lo usan roles staff (misma matriz que
  ROLES_LECTURA de /informes); el enlace es la página /worklist/informe/:turnoId.
- El chat renderiza links markdown escapando TODO el texto antes de aplicar
  markdown (dangerouslySetInnerHTML); los links /api/ se bajan con fetch+Bearer.

**Huecos clickeables (ago 2026):** al correr `proximos_huecos`, el backend emite un evento SSE extra `{huecos:[...]}` (máx 4 botones, uno por día si hay varios días) además del texto; el frontend los pinta como botones que preseleccionan agenda+fecha+hora vía `preseleccion` en agenda-medico. El prompt exige respuesta de UNA frase sin repetir horarios en texto.

**Lección de prompt:** el modelo copia ejemplos concretos del instructivo como pedidos reales (aplicó "jueves a la tarde" del ejemplo a un pedido sin filtros). Al ejemplificar argumentos de tools, aclarar "si el usuario no lo pidió, llamá sin esos filtros".
