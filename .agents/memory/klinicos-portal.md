---
name: Klinicos portal (ACEAPP)
description: Quirks de red/TLS para el robot Klinicos contra klinicos.aceapp.ar
---

- El servidor de klinicos.aceapp.ar envía la cadena TLS incompleta (solo el cert hoja, falta la intermedia Sectigo DV R36) → `fetch` nativo falla con UNABLE_TO_VERIFY_LEAF_SIGNATURE. La CA intermedia va embebida como constante PEM y se pasa vía `Agent({connect:{ca:[...tls.rootCertificates, PEM]}})`.
- **Un `Agent` del paquete `undici` NO funciona con el `fetch` global de Node** (versiones internas distintas → "invalid onRequestStart method"). Usar `fetch` importado del mismo paquete `undici` que el dispatcher.
- Login del portal: `GET /` redirige 302 a `/Login?ReturnUrl=%2F`.

## Modo real — guardas obligatorias
- Búsqueda de paciente: POST /paciente/grid/{dni}/null/null/null exige payload DataTables completo (9 columnas); coincidencia de DNI debe ser ESTRICTA (nunca tomar filas[0] como fallback — riesgo de ingreso a paciente equivocado).
- Anti-duplicado: persistir `post_intentado_en` ANTES del POST del ingreso y `klinicos_ingreso_creado` apenas confirma (302). Reintento con intento previo sin confirmación NO re-postea → revisión manual.
- El form AtencionForm declara multipart pero se postea urlencoded — verificar en el primer ingreso real.
- Errores del portal pueden venir como HTTP 200 con field-validation-error en el HTML.

## Validación en vivo del token IOMA
- Endpoint: POST `/ordenPrestacion/validarDatosObraSocialPaciente` (form-urlencoded, XHR) con `{idPaciente, idObraSocial, grupoNomenclador, OSToken, tipoEspecialidadDestino}`.
- La respuesta es JSON **doblemente serializado**: body → string JSON → `{error, message, data}`, y `data` → string JSON → `{Status: "OK"|"WARNING"|"NO", Mensaje, ApellidoNombre, ...}`.
- Token no numérico → `error:true` con "Input string was not in a correct format" (validar formato antes de llamar).
- Token vacío → `Status:"OK"` (solo valida afiliación, no exige token): nunca tratar vacío como token válido.
- **Why:** el "tilde de autorizar" del portal usa este mismo endpoint contra Yoma; permite validar el token en recepción sin crear el ingreso.
