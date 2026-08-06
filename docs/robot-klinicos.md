# Integración El Robot — validación de token IOMA en KLINICOS

Conectar delega la validación del token IOMA a un servicio externo ("El Robot",
`ROBOT_API_URL`). El frontend **nunca** llama directamente al Robot: siempre
pasa por el backend de Conectar, que guarda la clave (`ROBOT_API_KEY`, en
Secrets) y la envía únicamente por el header `X-Api-Key` (sin `Authorization
Bearer`).

## Ubicación de la consola administrativa (aclaración de arquitectura)

`artifacts/mi-diagnosticar` es el **frontend interno de Conectar** (nombre
histórico del paquete): una sola SPA React que sirve la consola de personal
(sidebar "CONECTAR by Diagnosticar") y algunas rutas públicas de pacientes
(`/reservar`, `/mi-turno`, `/pantalla-sala`). **No existe una app separada
"Mi Diagnosticar" en este repo** — la app del paciente (PWA) es un módulo de
roadmap todavía no iniciado.

La pantalla de prueba (`/configuracion/klinicos`) vive dentro de
`ProtectedRoutes`/`AppLayout`:

- `AppLayout` exige sesión y **redirige a los usuarios con rol `paciente`**
  fuera de la consola (a `/mi-turno`); sin sesión no renderiza nada.
- La card "Prueba de validación de token" solo se monta si
  `user.rol === "admin"`.
- Ninguna ruta pública de paciente monta la card ni usa
  `useProbarRobotKlinicos` (único consumidor: esta página).
- La defensa real está en el backend: `POST /api/robot-klinicos/prueba`
  devuelve 401 sin sesión y 403 para todo rol distinto de `admin`
  (cubierto por tests).

## Cliente backend

`artifacts/api-server/src/integraciones/robot-cliente.ts`

- `validarTokenConRobot(payload)` → `POST {ROBOT_API_URL}/api/v1/klinicos/token/validate`
- Headers: `X-Api-Key`, `Content-Type: application/json`, `X-Request-ID` e
  `Idempotency-Key` (= `request_id`).
- Timeout: `ROBOT_TOKEN_VALIDATION_TIMEOUT_MS` (default 30 s) vía `AbortSignal.timeout`.
- Body según `matching-request.schema.json` (snake_case, `patient` anidado,
  opcionales vacíos se omiten). Validaciones previas: `request_id`, `token` y
  `document_number` obligatorios; DNI solo dígitos; CIE-10 normalizado.
- Respuesta interpretada de forma tolerante: `status`, `reason_code`,
  `reason_message`, `missing_fields`, `authorization_number`,
  `klinicos_reference`. Estados desconocidos → `TECHNICAL_ERROR`.
- HTTP 401 del Robot → `TECHNICAL_ERROR` + `noAutenticado: true` +
  `codigo: AUTH_ERROR` con mensaje amigable; se registra a nivel `error`
  para administradores. **Nunca** se registra el token completo (se enmascara)
  ni la API key.

## Endpoints internos (Conectar)

### `POST /api/robot-klinicos/prueba`

- **Permisos:** usuario autenticado con rol `admin` (401 sin sesión, 403 otros roles).
- **Request** (JSON): `token`* , `dni`* (solo dígitos), `documentType`
  (default DNI), `patientId`, `affiliateNumber`, `practiceCode`,
  `professionalId`, `professionalName`, `specialtyCode`, `institutionId`,
  `diagnosisCode` (CIE-10), `consultationId`, `requestId` (reintento: reusar
  el del intento previo; si falta se genera un UUID).
- **Validaciones:** token no vacío; DNI solo dígitos; CIE-10 con estructura
  válida y, si el catálogo institucional (reglas CIE-10) tiene entradas, debe
  existir allí (400 con mensaje claro si no).
- **Rate limiting:** 1 solicitud en vuelo por usuario (bloquea doble clic y
  reintentos simultáneos) y máx. 5 por minuto → 429.
- **Response 200:** `estado`, `mensaje`, `requestId`, `referenciaKlinicos`,
  `latenciaMs`, `codigo`, `camposFaltantes`, `numeroAutorizacion`,
  `noAutenticado`.
- **Auditoría:** log estructurado (pino) con requestId, token enmascarado,
  estado, latencia y email del admin; 401 del Robot se loguea a nivel error.
- Funciona aunque `KLINICOS_TOKEN_VALIDATION_ENABLED=false` (el flag protege
  solo el circuito productivo de recepción).

### `GET /api/robot-klinicos/prueba/{requestId}` (PROVISIONAL)

- **Permisos:** solo `admin`.
- Polling del estado de una solicitud `PROCESSING` (mismo `request_id`).
- **PROVISIONAL:** llama a `GET {ROBOT_API_URL}/api/v1/klinicos/token/requests/{id}`,
  que hoy devuelve 404 → responde `TECHNICAL_ERROR` "no disponible". La ruta
  interna se mantendrá; el path del Robot se ajustará cuando publiquen su
  OpenAPI definitivo.
- El frontend admin pollea cada 4 s mientras el estado es `PROCESSING` e
  ignora los `TECHNICAL_ERROR` del polling (no pisa el resultado visible).

### `GET /api/robot-klinicos/catalogo/practicas` y `/catalogo/profesionales`

- **Permisos:** solo `admin`.
- Catálogos institucionales exportables para que el equipo del Robot configure
  el mapeo: prácticas (código IOMA + descripción, desde el catálogo Klinicos
  activo) y profesionales (ID, nombre, matrícula, especialidad).
- `?formato=csv` descarga CSV (UTF-8 con BOM, valores escapados); sin el
  parámetro devuelve JSON.

### `POST /api/robot-klinicos/prueba/prestacion-cargada`

- **Permisos:** solo `admin`.
- **Request:** `{ requestId }` (se conserva el mismo request_id de la contingencia).
- **Response:** `{ registrado, usuario, fecha }`.
- **Auditoría:** log con requestId + usuario + fecha/hora. No marca el token
  como aceptado; solo habilita el reintento.

## Mapeo de estados

| Estado | Efecto |
|---|---|
| `TOKEN_ACCEPTED` | habilita consulta, muestra autorización y referencia KLINICOS |
| `TOKEN_DENIED` | no habilita; muestra motivo |
| `MANUAL_PRESTATION_REQUIRED` | contingencia ámbar; carga manual + reintento con el MISMO request_id |
| `PROCESSING` | asíncrono: el Robot encoló la solicitud; se pollea con el mismo request_id; puede informar `queue_position` / `estimated_wait_seconds` (→ `posicionCola` / `esperaEstimadaSegundos`) |
| `DATA_REQUIRED` | faltan/corregir datos (`camposFaltantes`); reintentable con el MISMO request_id |
| `MAPPING_REQUIRED` | falta configuración institucional del Robot (mapeo de práctica/profesional/sede); avisar al administrador — no es problema del token ni del paciente |
| `TECHNICAL_ERROR` | falla técnica; NO es denegación |
| `TIMEOUT` | pendiente; conservar request_id (no generar otro) |
| `MANUAL_REVIEW` | "En revisión técnica": lo resuelve el equipo técnico; la UI NO muestra enlaces ni instrucciones de KLINICOS |

En el circuito de sincronización (worker): `PROCESSING` → trabajo queda
`PROCESSING`; `DATA_REQUIRED`/`MAPPING_REQUIRED` → `READY_TO_RETRY`. En tokens:
`PROCESSING` → `VALIDATING`; `DATA_REQUIRED`/`MAPPING_REQUIRED` → `PENDING`.

## Idempotencia (comprobada en vivo, jul 2026)

Reintento con el mismo `request_id`: el Robot devuelve el resultado cacheado
(~0,5 s vs ~18 s del intento original) — el mismo request_id **no** consume el
token dos veces.

## Seguridad

- API key solo en backend (Secrets); jamás llega al navegador ni a los logs.
- Token: no se guarda en localStorage, no viaja por URL, se enmascara en logs.
- DNI enmascarado en logs del Robot (responsabilidad del Robot) y no se
  registra completo en logs propios de la integración.

## Feature flags

- `KLINICOS_TOKEN_VALIDATION_ENABLED=false`: la recepción productiva no usa la
  validación; la pantalla admin de prueba (`/configuracion/klinicos`, card
  "Prueba de validación de token") es el único camino sancionado.
- `KLINICOS_CONSULTATIONS_PROCESS_ENABLED=false` (independiente): circuito
  nuevo `POST /api/v1/klinicos/consultations/process`. Esqueleto en
  `integraciones/robot-consultas.ts`; NO sale a la red hasta tener el OpenAPI
  definitivo del Robot (ver `docs/robot-openapi/README.md`). Reglas: mismo
  request_id en reintentos, aislamiento de paciente, se envía la práctica
  (id, código, descripción, catálogo) y NUNCA médico/matrícula/especialidad.

## Sondeo de endpoints (19-jul-2026)

- `GET /api/v1/klinicos/health` → **200 OK** (robot_available, klinicos_reachable,
  session_active en true; versión 1.0.0).
- `POST /api/v1/klinicos/token/validate` → **publicado** (400 "Falta request_id"
  ante body vacío).
- `GET /api/v1/klinicos/token/requests/{id}` → **publicado**; 404 significa
  request_id inexistente, no endpoint faltante.
- `POST /api/v1/klinicos/consultations/process` → **404, aún NO publicado**.
- No cambiar rutas hasta que el Robot confirme URL base y endpoints definitivos.

## Riesgos pendientes
- El catálogo CIE-10 institucional es parcial (reglas CIE-10 de KLINICOS); si
  está vacío solo se valida la estructura del código.
- La ruta TOKEN_ACCEPTED real requiere una prestación cargada de verdad en
  KLINICOS (probada solo contra Robot simulado en tests).
