# Guardia virtual (videollamada) — API para la app del paciente

Respuesta a las cuatro consultas del equipo del portal (agosto 2026).

Host: `https://clinic-core-suite.replit.app` (mismo que el resto).
**Importante:** los endpoints de guardia virtual son nuevos y responden 404 en
producción hasta la próxima publicación de Conectar. En cuanto se publique,
quedan activos tal cual se documentan acá.

## Concepto: la guardia NO es con turnos

La guardia de Clínica Médica por videollamada es una **cola de espera por orden
de llegada**. No hay horarios para elegir ni turnos para reservar:

- NO usar `POST /api/publico/turnos` para la guardia.
- NO hace falta disponibilidad por turnera: no existe el concepto de "horario
  libre" en la guardia (por eso la turnera de guardia tampoco se lista en
  `/api/publico/turneras`; es intencional).
- El flujo es: mostrar espera aproximada → el paciente decide → se anota en la
  cola → manda el token de IOMA → espera a que el médico lo llame.

## Autenticación

- `GET /espera`: **sin autenticación** (no expone datos personales).
- `POST /cola` y `POST /token`: header `Authorization: Bearer <clave compartida>`
  (la misma clave compartida que ya usamos para los avisos push hacia el portal).

## 1. Espera de la guardia (en vivo)

`GET /api/integraciones/app-paciente/videollamadas/espera`

Respuesta real:

```json
{
  "ok": true,
  "modalidad": "cola_de_espera",
  "abierto": true,
  "horario": "Lunes a sábado de 8 a 19 hs, domingo de 12 a 18 hs",
  "enEspera": 3,
  "guardiaAtendiendo": true,
  "esperaAproximadaMin": 45,
  "mensaje": "Espera aproximada: 45 minutos (3 en espera). La atención es por orden de llegada, sin turno."
}
```

Cálculo en vivo sobre la sala grupal de guardia clínica médica: pacientes ya
recepcionados hoy en la guardia + anotados en la antesala virtual.

## 2. Anotarse en la cola

`POST /api/integraciones/app-paciente/videollamadas/cola`

```json
{ "dni": "30111222", "nombre": "Juan", "apellido": "Pérez",
  "telefono": "2211234567", "obraSocial": "IOMA", "motivo": "Fiebre" }
```

Respuesta `201`:

```json
{ "colaId": 12, "estado": "en_cola", "posicion": 4, "demoraMinutos": 45,
  "guardiaAtendiendo": true, "horario": "Lunes a sábado de 8 a 19 hs, domingo de 12 a 18 hs" }
```

- Idempotente por DNI: si el paciente ya está en la cola, devuelve `200` con la
  misma fila y `"repetido": true` (con posición y demora actualizadas).
- Errores: `400` DNI inválido; `422` obra social no IOMA
  (`codigo: "obra_social_sin_servicio"`); `409` fuera de horario
  (`codigo: "fuera_de_horario"`); `401` clave compartida inválida.

## 3. Token de IOMA (después de anotarse)

`POST /api/integraciones/app-paciente/videollamadas/token`

```json
{ "colaId": 12, "dni": "30111222", "token": "123456" }
```

(`colaId` opcional; alcanza con el DNI. `nombre`, `apellido` y `telefono`
opcionales — completan la ficha si no vinieron en `/cola`.)

Respuesta `200` (token aceptado):

```json
{ "ok": true, "estado": "recepcionado", "colaId": 12, "turnoId": 4581,
  "posicion": 4, "demoraMinutos": 45,
  "mensaje": "Token aceptado. Quedaste en la fila de la guardia: te avisamos cuando el médico te llame." }
```

Respuesta `422` (token rechazado o no verificable — **reintentable**):

```json
{ "estado": "TOKEN_DENIED", "error": "El token no fue aceptado. Revisá que sea el token del día y probá de nuevo.", "reintentable": true }
```

El paciente queda en la cola y puede volver a mandar otro token con el mismo
`colaId`/DNI. `404`: no hay espera activa para ese DNI (anotarse primero).

## 4. Avisos hacia el portal (confirmado)

Sí: usamos `POST /api/integracion/videollamadas` (del lado del portal) para
todos los eventos de la guardia, con `videollamadaId` en texto:

- `en_cola` (posición/demora actualizadas), `tu_turno` (siempre con el link de
  Jitsi), `cancelada`, `finalizada`.

## Autologin

Pendiente de nuestro lado: emitimos un link real de prueba y se los pasamos
aparte (es de un solo uso).
