---
name: Circuito Klinicos validado end-to-end
description: Diseño confirmado en producción del circuito turno → carga automática → token → bono IOMA para CONSULTAS de Clínica Médica; reglas que NO deben romperse.
---

# Circuito Klinicos validado — versión "consultas Clínica Médica" (2-ago-2026, aprobado por Federico)

**Alcance**: este circuito validado cubre las CONSULTAS de Clínica Médica (sector Consultorios). Las prácticas/estudios (imágenes, etc.) tienen su propio camino y todavía no están validadas end-to-end con bono.

Confirmado en producción con bono real a la primera (bonos 18409984 y 18409999). También validado el camino GUARDIA por orden de llegada: la recepcionista registra el turno en Agenda por médico y aprieta Validar — el circuito crea la atención y autoriza solo. Si el paciente tiene atenciones viejas sin bono, el circuito NO frena: crea su propia atención para el turno y autoriza esa (pedido 2-ago-2026; el token nunca va a una atención adivinada).

## Flujo que funciona — no cambiar sin causa
1. **Reserva del turno** (turnera de Clínica Médica): NO encola nada en Klinicos (llave `klinicos_autoencolado='off'`).
2. **Carga en Klinicos SIN token** (puede hacerse antes de que el paciente genere el token): encolar → simulación → aprobación → carga real. Crea ingreso ambulatorio + consulta CONFIRMADA con casillero de token vacío. Federico aprobó explícitamente este orden ("está muy bien ese proceso").
3. **Botón Validar Token** (único disparador automático): el token viaja a IOMA **UNA sola vez**, directo a la autorización de la prestación. Si no hay atención aún, el circuito automático la crea primero y usa el token una única vez.
4. **Resultado**: bono → ACCEPTED + cartel verde; rechazo explícito → DENIED + rojo (y ese MISMO token no se reenvía jamás; la guarda liberada es solo para tokens NUEVOS — ante DENIED, validar-token solo hace una relectura SOLO LECTURA de la grilla que puede rescatar un bono ya existente sin enviar nada); sin confirmación → error técnico amarillo reintentable.

## Reglas inviolables (todas surgieron de incidentes reales)
- **El token se consume al validarlo**: `/ordenPrestacion/validarDatosObraSocialPaciente` con OSToken NO es solo-lectura. Nunca reintroducir una "validación previa" que incluya el token (ver robot-token-validacion.md).
- **Verde SOLO con ACCEPTED + bono persistido** (ver token-cartel-regla-unica.md). El bono nunca se inventa; HTTP 200 ≠ aprobación.
- **Sin reintento automático ante resultado desconocido**: la guarda `autorizacionPostIntentadoEn` solo se libera con rechazo EXPLÍCITO del financiador.
- **Fail-closed en todo**; el token nunca completo en logs (enmascarar).
- Anular atenciones en Klinicos lo hace el usuario a mano, nunca el robot.

## Verificación
Test de contrato: `token_un_solo_viaje.test.ts` (el token jamás pasa por validarDatosObraSocialPaciente; mismo token DENIED no se reenvía). Auditoría de prod siempre vía la API publicada.
