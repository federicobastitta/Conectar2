# Guardia virtual — Reserva Check in para la app del paciente

Contrato de integración para el equipo del portal (app del paciente).
Cubre los endpoints de **disponibilidad de horarios** y **reserva de turno Check in** que se agregaron al flujo original de guardia virtual.

Host producción: `https://clinic-core-suite.replit.app/api`

**Autenticación:** todos los endpoints `/publico/guardia-virtual/*` requieren el header:
```
x-api-key: <API_PUBLICA_KEY>
```
La clave es la misma que se usa para el resto de la API pública de turnos.
Sin clave o con clave inválida → **401**.

---

## Contexto: dos modalidades de ingreso a la guardia

El flujo de guardia virtual ahora soporta dos variantes:

| Modalidad | Parámetro al registrarse | Flujo |
|-----------|--------------------------|-------|
| `videollamada` (default) | `"modalidad": "videollamada"` | Cola por orden de llegada, hoy. Funciona exactamente igual que antes. |
| `presencial` | `"modalidad": "presencial"` | El paciente puede **elegir un horario** (hoy, mañana u otra fecha hasta +3 días). Eso es la "Reserva Check in". |

> **Importante:** la reserva de fecha/hora (Check in) **solo aplica a sesiones creadas como `presencial`**. Si una sesión `videollamada` envía `fecha`+`horaInicio` al validar el token, recibirá un 400.

---

## Flujo de pantallas sugerido

```
1. Elegir guardia
   [Clínica médica adultos]  [Pediátrica]

2. Elegir modalidad
   [Videollamada (ahora)]  [Check in presencial (elegir horario)]

   ─ si videollamada ─────────────────────────────────────────────
   → flujo actual (registrarse → validar token → esperar llamado)

   ─ si presencial ───────────────────────────────────────────────
3. Elegir fecha
   [Hoy]  [Mañana]  [Pasado mañana]  (máximo +3 días desde hoy)

4. GET /publico/guardia-virtual/checkin/disponibilidad?guardia=...&fecha=...
   → mostrar lista de horarios libres (horaInicio – horaFin)

5. Paciente elige un horario

6. Registrarse (si todavía no lo hizo)
   POST /publico/guardia-virtual/registros con modalidad: "presencial"
   → guardar sesionToken

7. Paciente ingresa su token IOMA

8. POST .../validar-token con tokenIoma + fecha + horaInicio
   → si 200 TOKEN_ACCEPTED: mostrar turnoFecha y turnoHora reales
     (pueden diferir del horario elegido si hubo carrera — ver §3)
   → si 409 reintentable: el horario se ocupó justo antes; refrescar
     disponibilidad (paso 4) y dejar elegir de nuevo sin re-pedir el token

9. Pantalla de confirmación: "Tu turno Check in es el {turnoFecha} a las {turnoHora}"
   Botón "Ya llegué" disponible solo el día del turno.
```

---

## Endpoint 1 — Horarios disponibles

```
GET /publico/guardia-virtual/checkin/disponibilidad
```

### Query params

| Param    | Tipo   | Obligatorio | Descripción |
|----------|--------|-------------|-------------|
| `guardia` | string | no | `clinica` (default) o `pediatrica` |
| `fecha`  | string | **sí**       | `YYYY-MM-DD`. Rango válido: hoy hasta hoy+3 días. |

### Respuesta 200

```json
{
  "guardia": "clinica",
  "fecha": "2026-09-09",
  "horarios": [
    { "horaInicio": "08:00", "horaFin": "08:15" },
    { "horaInicio": "08:15", "horaFin": "08:30" },
    { "horaInicio": "09:00", "horaFin": "09:15" }
  ]
}
```

- `horarios` incluye **solo los slots libres** para esa fecha. Si no hay ninguno, la lista es vacía `[]`.
- `horaInicio` y `horaFin` siempre en formato `HH:MM`.
- El campo `guardia` y `fecha` se devuelven como eco de los parámetros recibidos.

### Errores

| Código | Descripción |
|--------|-------------|
| 400    | `fecha` faltante, mal formateada, ya pasó, o supera +3 días. / `guardia` inválida. |
| 401    | Clave de API inválida o faltante. |
| 503    | La guardia no está activa o no tiene agenda configurada. |

### Ejemplos de error 400

```json
{ "error": "fecha es obligatoria (formato YYYY-MM-DD)." }
{ "error": "La fecha ya pasó." }
{ "error": "Solo se puede reservar hasta 3 días adelante." }
{ "error": "guardia inválida (clinica | pediatrica)." }
```

---

## Endpoint 2 — Validar token (con reserva Check in)

```
POST /publico/guardia-virtual/registros/{sesionToken}/validar-token
```

Este endpoint es el mismo que ya existe para el flujo original. Los campos `fecha` y `horaInicio` son opcionales y activan la reserva Check in.

### Path param

| Param        | Descripción |
|--------------|-------------|
| `sesionToken` | Token de sesión obtenido en `POST /publico/guardia-virtual/registros` |

### Body

```json
{
  "tokenIoma": "123456",
  "fecha": "2026-09-09",
  "horaInicio": "09:00"
}
```

| Campo       | Tipo   | Obligatorio | Descripción |
|-------------|--------|-------------|-------------|
| `tokenIoma` | string | **sí**       | Token de autorización IOMA del día. Mínimo 4 caracteres. |
| `fecha`     | string | no           | `YYYY-MM-DD`. Rango: hoy hasta hoy+3 días. Requiere `horaInicio`. |
| `horaInicio`| string | no           | `HH:MM`. Horario elegido de `/checkin/disponibilidad`. Requiere `fecha`. |

> `fecha` y `horaInicio` son ambos opcionales pero deben ir juntos: mandar uno sin el otro devuelve 400.

> Si la sesión fue registrada como `videollamada`, enviar `fecha`+`horaInicio` devuelve 400. Solo aplica a `presencial`.

### Respuesta 200 — Token aceptado (reserva Check in)

```json
{
  "estado": "TOKEN_ACCEPTED",
  "mensaje": "Token aceptado. Tu turno Check in quedó reservado para el 2026-09-09 a las 09:00. Número de bono: 80123456. Ese día, cuando llegues a la clínica, apretá 'Ya llegué'.",
  "nroBono": "80123456",
  "reintentable": false,
  "turnoFecha": "2026-09-09",
  "turnoHora": "09:00"
}
```

### Respuesta 200 — Token aceptado (orden de llegada, sin reserva)

```json
{
  "estado": "TOKEN_ACCEPTED",
  "mensaje": "Token aceptado. Tenés un lugar en la guardia. Número de bono: 80123456.",
  "nroBono": "80123456",
  "reintentable": false,
  "turnoFecha": "2026-09-08",
  "turnoHora": null
}

```

> `turnoHora` es **`null`** cuando el paciente entró a la fila por orden de llegada (sin fecha/horaInicio). `turnoFecha` siempre es la fecha del turno creado.

### ⚠️ turnoFecha/turnoHora pueden diferir del horario elegido

Si el horario pedido se ocupó entre el pre-chequeo y la inserción final (carrera de milisegundos), el backend asigna el siguiente horario libre de la grilla. La respuesta devuelve el horario **real** asignado en `turnoFecha`/`turnoHora`. El portal debe mostrarlo y avisar al paciente si difirió.

### Respuesta 200 — Token rechazado por IOMA

```json
{
  "estado": "DENIED",
  "mensaje": "El token no fue aceptado por IOMA. Revisá que sea el token del día.",
  "nroBono": null,
  "reintentable": true
}
```

El paciente puede reintentar con un token distinto sin volver a registrarse.

### Respuesta 200 — Error técnico (reintentable)

```json
{
  "estado": "TECHNICAL_ERROR",
  "mensaje": "...",
  "nroBono": null,
  "reintentable": true
}
```

### Respuesta 409 — Horario ya ocupado (token NO se gasta)

```json
{
  "error": "Ese horario acaba de ocuparse. Elegí otro horario (tu token no se gastó).",
  "reintentable": true
}
```

Este 409 ocurre **antes** de consumir el token IOMA. El paciente puede refrescar la disponibilidad y elegir otro horario sin volver a ingresar el token.

```json
{
  "error": "Ese horario no está en la agenda de la guardia para esa fecha. Elegí otro (tu token no se gastó).",
  "reintentable": true
}
```

> **Comportamiento recomendado:** al recibir 409 con `reintentable: true`, re-llamar a `/checkin/disponibilidad` para actualizar la lista de horarios y presentarla al usuario nuevamente sin salir del flujo ni pedir el token otra vez.

### Errores 4xx/5xx

| Código | Descripción |
|--------|-------------|
| 400    | `tokenIoma` faltante/inválido; `fecha` o `horaInicio` mal formateados; fecha pasada o fuera de rango; sesión no es presencial pero envió fecha/horaInicio. |
| 401    | Clave de API inválida. |
| 404    | Sesión no encontrada. |
| 409    | Horario ocupado (reintentable, ver arriba) / validación en curso (otra request simultánea, esperar y reintentar) / sesión en estado terminal. |
| 410    | Sesión expirada (las sesiones duran 2 horas). |
| 503    | Guardia no configurada / agenda no disponible (reintentable). |

---

## Endpoint 3 — Estado de la sesión (polling)

```
GET /publico/guardia-virtual/registros/{sesionToken}/estado
```

Polling periódico para actualizar la pantalla del paciente después de validar el token.

### Respuesta 200

```json
{
  "estado": "en_cola",
  "modalidad": "presencial",
  "posicion": 3,
  "esperaEstimadaMinutos": 25,
  "jitsiUrl": null,
  "nroBono": "80123456",
  "turnoFecha": "2026-09-09",
  "turnoHora": "09:00",
  "llegoALaClinica": false
}
```

### Campos de respuesta

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `estado` | string | Ver tabla de estados más abajo. |
| `modalidad` | string | `videollamada` o `presencial`. |
| `posicion` | integer \| null | Posición en la fila (1 = próximo). **Solo se informa cuando el turno es de hoy.** Los Check in reservados para días futuros devuelven `posicion: null`. |
| `esperaEstimadaMinutos` | number \| null | Minutos estimados de espera. Solo cuando `posicion` está presente. |
| `jitsiUrl` | string \| null | URL de la videollamada Jitsi. Solo presente cuando `estado = "llamado"` **y** `modalidad = "videollamada"`. |
| `nroBono` | string \| null | Número de bono IOMA. Disponible desde que el token fue aceptado. |
| `turnoFecha` | string \| null | Fecha del turno `YYYY-MM-DD`. `null` antes de que el token sea validado. |
| `turnoHora` | string \| null | Hora del turno. Para Check in reservado: `HH:MM` (o `HH:MM:SS` — truncar a 5 caracteres). Para orden de llegada: `null`. |
| `llegoALaClinica` | boolean \| null | Solo `modalidad = "presencial"`. `false` = turno "confirmado" → mostrar botón "Ya llegué". `true` = ya avisó. `null` = no presencial. |

> **Nota de formato:** `turnoHora` en `/estado` puede venir como `"09:00"` o `"09:00:00"` según la agenda. Usar siempre los primeros 5 caracteres (`turnoHora.slice(0, 5)`).

### Estados de la sesión

| Estado | Descripción | Acción sugerida en la UI |
|--------|-------------|--------------------------|
| `pre_registro` | Sesión creada, token todavía no enviado. | Mostrar formulario de token. |
| `validando_token` | Token en proceso de validación. | Spinner, reintentar polling en ~3 s. |
| `token_rechazado` | IOMA rechazó el token. El paciente puede reintentar. | Mostrar error, pedir nuevo token. |
| `en_cola` | Token aceptado, turno reservado, esperando llamado. | Mostrar posición y espera estimada. |
| `llamado` | El médico llamó al paciente. | Videollamada: abrir `jitsiUrl`. Presencial: indicar que lo están llamando. |
| `atendido` | Consulta finalizada. | Pantalla de fin. |
| `abandonado` | El paciente abandonó o canceló. | Ofrecer reiniciar. |

### Posición en fila: solo el día del turno

Para Check in reservados a futuro (ej. turno para mañana), `/estado` devuelve `posicion: null` y `esperaEstimadaMinutos: null` hasta que llegue el día del turno. Ese día, al hacer polling, la posición empieza a informarse.

### Errores

| Código | Descripción |
|--------|-------------|
| 401    | Clave de API inválida. |
| 404    | Sesión no encontrada. |
| 410    | Sesión expirada (solo en estado `pre_registro`). |

---

## Endpoint 4 — Ya llegué (solo presencial)

```
POST /publico/guardia-virtual/registros/{sesionToken}/llegue
```

Botón "Ya llegué a la clínica". Pasa el turno de `confirmado` a `arribo` (recepcionado) para que el médico pueda llamarlo. Idempotente.

- Solo disponible el día del turno (`turnoFecha == hoy`).
- Si el turno es para una fecha futura, devuelve 409 con mensaje indicando la fecha.
- Si el turno ya está recepcionado o más adelante: responde 200 con `{ "ok": true, "yaEstaba": true }`.

---

## Compatibilidad hacia atrás

El parámetro `fecha`/`horaInicio` en `validar-token` es completamente opcional. Si el portal no los envía, el comportamiento es idéntico al actual: el paciente entra a la fila de hoy por orden de llegada. En ese caso:
- `turnoHora` es `null` tanto en la respuesta de `validar-token` como en `/estado`.
- `posicion` en `/estado` se informa desde el momento del registro (turno es siempre de hoy).

---

## Resumen de discrepancias verificadas

Al auditar el código contra el plan de contrato se encontraron las siguientes diferencias (sin impacto en el backend — son aclaraciones para el portal):

1. **`/checkin/disponibilidad` response**: El plan describía solo `{ horarios: [...] }`. La respuesta real incluye también `guardia` y `fecha` como eco de los parámetros. El OpenAPI ya lo documenta correctamente.

2. **`turnoHora` en `validar-token` es `null` para orden de llegada**: El plan decía "la respuesta trae turnoFecha/turnoHora reales" sin aclarar este caso. `turnoHora` es `null` cuando no se usó reserva (flujo original).

3. **Reserva Check in requiere `modalidad: "presencial"`**: Enviar `fecha`+`horaInicio` desde una sesión `videollamada` devuelve 400. El portal debe habilitar el date picker solo para sesiones presenciales.

4. **`turnoHora` en `/estado` puede llegar como `"HH:MM:SS"`**: A diferencia de `validar-token` (que ya corta a 5 chars), `/estado` devuelve el campo `horaInicio` directamente desde la base. Truncar siempre con `turnoHora.slice(0, 5)`.

5. **409 "slot ocupado" en `validar-token`**: El backend pre-valida el slot *antes* de consumir el token IOMA. El 409 implica que el token no fue enviado a IOMA. Si la carrera ocurre *después* de la aceptación del token, el backend busca el siguiente horario libre de la grilla en vez de devolver 409, por lo que `turnoFecha`/`turnoHora` en la respuesta pueden diferir del horario pedido.
