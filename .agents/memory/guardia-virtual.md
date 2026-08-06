---
name: Guardia virtual IOMA
description: Videollamadas de Guardia Clínica Médica — antesala local, token antes de todo, feature apagado por config
---
- La sesión de antesala (`guardia_virtual_sesiones`) es SOLO local: ni turno ni consulta Klinicos existen antes de token ACCEPTED + bono (misma regla que klinicos-precarga-registro).
- Al validar token: turno directo en la bolsa esGuardia con `modalidad="videoconsulta"` + `qrCodigo`; el link Jitsi lo construye `urlVideollamadaTurno` y ya se renderiza en consultorio/sala de espera sin lógica nueva.
- Feature gate en `config_sistema`: `guardia_virtual_activa`, `guardia_virtual_turnera_id`, `guardia_virtual_obras_sociales` (default ["IOMA"]), horario. Apagado hasta configurarlo en prod.
- API pública bajo `/publico/guardia-virtual/` exige API_PUBLICA_KEY (x-api-key); dedupe por DNI devuelve la sesión existente; validación sincrónica fail-closed (NO_CONFIGURADO/503 sin Klinicos).
- **Why:** compartir la agenda de guardia presencial sin romper la fila ni violar la regla de facturación del token.
- **How to apply:** cualquier cambio al flujo de guardia o de token debe conservar el orden token→turno→Klinicos y el gate por config.

## Portal del paciente usa los endpoints legacy de videollamadas
El portal NO usa /publico/guardia-virtual/* sino los legacy `/integraciones/app-paciente/videollamadas/{status,espera,cola}` (routes/integracion_videollamadas.ts). Su horario estaba hardcodeado (L-S 8-19) y decía "cerrada" ignorando la config real; desde ago 2026 leen `leerConfigGuardia()` (exportada de routes/guardia_virtual.ts): `abierto = activa && dentroDeHorario`, y la turnera prefiere `guardia_virtual_turnera_id` con fallback a `videollamadas_guardia_turnera_id`.
**Cómo aplicarlo:** cualquier cambio al comportamiento de la guardia virtual debe tocar AMBOS juegos de endpoints (o mejor, los helpers compartidos); probar siempre `/status` y `/espera` legacy además de los públicos.

## Avisos de avance de fila (ago 2026)
Todo paciente de guardia con token aceptado (portal antesala Y flujo público, presencial incluido) tiene fila en `videollamadas_cola`; el flujo público la crea DENTRO de la tx del TOKEN_ACCEPTED, idempotente por turnoId. `avanzarFilaGuardia(turnoId)` reenvía "en_cola" con posición nueva SOLO cuando baja (guard atómico sobre `ultima_posicion_avisada`, anti-spam/carreras); hooks void en llamar/no_presentado/devolver/cancelar/finalizar. `tu_turno` sin link (presencial) se saltea a propósito.
**Cómo aplicarlo:** toda transición nueva que saque un turno de una fila de guardia debe llamar `void avanzarFilaGuardia(turnoId)`; el portal debe mostrar los reenvíos de `en_cola` como avance (coordinar).

## Reserva Check in en la agenda de guardia (ago 2026)
El paciente presencial validado puede reservar un turno "Check in" con fecha (hoy..+30d) + hora de la grilla de la guardia: `validar-token` acepta `fecha`+`horaInicio`, con pre-check del slot ANTES de gastar el token (revierte a pre_registro, 409 reintentable). El token IOMA vale solo hoy → la consulta Klinicos SIEMPRE se valida hoy; el turno Conectar queda para la fecha elegida, ya validado con bono ("Check in validado" en recepción). Inserción con `horaExacta` (ErrorSlotOcupado, sin corrimiento de 1 min fuera de grilla); ante carrera toma el siguiente slot libre de la grilla y responde SIEMPRE la fecha/hora persistidas. "Ya llegué" solo el día del turno; /estado calcula posición solo si fecha=hoy y devuelve turnoFecha/turnoHora.
**Cómo aplicarlo:** nunca insertar reservas de guardia fuera de la grilla ni confirmar una hora distinta de la guardada; el alta staff por orden de llegada sigue siendo solo hoy.

## Guardias públicas para "Atención sin turno" (ago 2026)
GET /publico/guardias (x-api-key) lista turneras esGuardia activas + extras de config_sistema `guardias_publicas_extra_ids` (IDs coma-separados, para servicios por orden de llegada que no son bolsas de guardia: Radiografías, Mamografía). Devuelve días/horarios (horariosDia pisa al global) y `abiertaAhora` con hora argentina, más `pacientesEnEspera` (turnos activos del día por agenda). Los extras se administran con PUT /guardia-virtual/config `publicasExtraIds` (valida existencia+activa). El portal filtra qué publica; tras publicar hay que setear los extras en prod vía la API publicada.
