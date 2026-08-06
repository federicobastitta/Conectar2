# Módulo "Estudios" + Workspace PACS — Plan de integración con DiagnosticPACS

> Estado: **PROPUESTA — nada implementado, feature flag `PACS_WORKSPACE_ENABLED=false`** (lado Conectar) y `PACS_INTEGRATION_ENABLED=false` (lado DiagnosticPACS).
> No se activa ni se usa con pacientes reales hasta que DiagnosticPACS confirme el contrato (sección 3), termine su **migración DICOM a S3** y reconcilie resultados. Mientras la migración corre: no reiniciar, no publicar, no cambiar flags ni rutas de almacenamiento, no correr pruebas de carga contra el PACS.
>
> **⚠️ CAMBIO DE ESCENARIO — 21-jul-2026 (v3, manda sobre todo lo anterior):**
> La integración pasa a ser **por worklist** y **los informes se realizan en el PACS**:
> 1. **Conectar publica la worklist**: cuando hay un turno/orden para una práctica de imágenes (ej. una ergometría), Conectar se lo informa al PACS como ítem de lista de trabajo (paciente + práctica + modalidad + fecha/hora + motivo). Al PACS le tiene que "figurar que hay que hacer una ergometría" sin carga manual.
> 2. **El estudio y el informe se hacen en el PACS**: redacción, firma y versionado del informe son del lado DiagnosticPACS. Conectar ya NO redacta ni firma informes de imágenes (queda sin efecto la decisión v0.2 de "informes en Conectar" y el CM-4 de evidencia congelada al firmar).
> 3. **Conectar consume el resultado**: recibe por webhook los eventos del estudio (recibido/listo/error) y del informe (borrador/firmado), actualiza la máquina de estados del turno/orden, descarga el informe firmado (PDF) y lo muestra/distribuye al médico solicitante y al paciente (portal, WhatsApp).
> Las secciones marcadas «v0.2» más abajo quedan como historia de la negociación; donde difieran, manda esta actualización.
>
> **Actualización 20-jul-2026 (superada por v3 en lo relativo a informes):** el PACS entregó su borrador v0.2 (ZIP verificado). La revisión de compatibilidad y las observaciones devueltas están en **`docs/pacs-compatibilidad-v0.2.md`** — ese informe decía que los informes se redactaban/firmaban/versionaban/publicaban en Conectar; ese punto queda revertido por la v3. Siguen vigentes de esa ronda: identificadores, sesión contextual de visor, seguridad, webhook firmado.
>
> v2: alineado con la especificación espejo del lado DiagnosticPACS (API `/api/v1/integration/*`, webhooks firmados, sesión de un solo uso, DICOMweb autenticado). La consola propia del PACS se conserva, restringida a administración técnica y contingencia — Conectar no la reemplaza ni la muestra a recepción/médicos.

Objetivo: convertir Conectar en la interfaz única de trabajo para recepción, técnicos y médicos, integrando DiagnosticPACS como servicio especializado de imágenes. Conectar **no** almacena imágenes DICOM ni Base64: DiagnosticPACS/S3 sigue siendo dueño de imágenes, series, mediciones, anotaciones e informes de imágenes.

---

## 1. Inventario de lo existente

### 1.1 Integraciones PACS ya operativas

| Pieza | Ubicación | Qué hace hoy |
|---|---|---|
| PACS poller ("robot") | `api-server/src/integraciones/pacs-poller.ts` + `pacs-flujo.ts` | Cada 2 min consulta DiagnosticPACS (`medical-vision-ai.replit.app`) por turnos en `pendiente_informe`/`informando`; si el estudio figura informado, cierra el turno. Auth saliente: Bearer `PACS_API_TOKEN`. |
| Webhook entrante | `POST /api/pacs/webhook/estudio-informado` (`routes/pacs.ts`) | DiagnosticPACS avisa estudio informado. Auth: Bearer `PACS_API_TOKEN` con `timingSafeEqual`. Idempotente por transición atómica de estado. |
| Envío al PACS | `enviarTurnoAlPacs` (disparado por `PATCH /api/turnos/:id/estado` → `pendiente_informe`) | Crea el estudio en el PACS y guarda `pacs_estudio_id` + `pacs_enviado_en` en el turno. |
| Phir-it | `integraciones/phirit-api.ts` + scraper | Estudios por DNI en vivo; guarda `studyIUID`, `numAcceso` (accession), `linkVisualizador`. |
| Pulso | `pulso-estudios-sync.ts` → tabla `pulso_estudios` | Espejo de estudios/informes del HIS Pulso (dni, modalidad, `id_legible`, `tiene_informe`, `informe_firmado`). |

### 1.2 Datos ya modelados (Drizzle, `lib/db/src/schema/`)

- `turnos`: estados clínicos `en_atencion → pendiente_informe → informando → informado → publicado` + `pacs_enviado_en`, `pacs_estudio_id`, `pacs_informado_en`. Transiciones en `TRANSICIONES_VALIDAS` (`routes/informes.ts`).
- `informes`: `estado` (`borrador/firmado/publicado`), `pacs_study_id`, `pacs_viewer_url`.
- `study_orders` (`documentos_clinicos.ts`): órdenes de estudio con `study_type`, `study_name`, `clinical_justification`, `status` — **ya existe el "motivo del estudio"** como `clinical_justification`.
- `practicas`: prácticas indicadas por profesional.
- `pulso_estudios`: estudios externos espejados.

### 1.3 UI existente

- `pages/worklist/` — bandeja de informes + sala de espera del médico informante.
- `pages/worklist/informe.tsx`, `pages/informes/` — editor de informes con firma.
- `components/dicom-pacs.tsx`, `pacs-estudios.tsx` — visores embebidos actuales (iframe con URL que devuelve el PACS).
- Roles ya existentes: `admin`, `recepcionista`, `medico`, `paciente` (falta `tecnico`).

### 1.4 Brechas contra el objetivo

1. No hay módulo "Estudios" unificado con buscador multi-criterio (hoy la info está repartida entre worklist, informes, Phir-it y Pulso).
2. No hay pantalla única de trabajo (encabezado + orden/motivo + visor + informe/IA en una sola vista).
3. No hay sesión contextual temporal para el visor: hoy se usan URLs de visor que entrega el PACS, sin token de corta duración negociado backend-a-backend por orden/rol.
4. No existe el rol `tecnico` ni sus permisos.
5. No hay flujo de carga de estudios iniciado desde Conectar con upload directo al PACS.
6. Webhooks: existe uno solo (`estudio-informado`); faltan los 7 eventos del contrato, con auditoría e idempotencia por `event_id`.
7. Los 5 estados del módulo (`AGENDADO … AUSENTE`) hay que mapearlos a la máquina de estados actual (no crear una segunda máquina).

---

## 2. Diseño de pantallas

### 2.1 Módulo "Estudios" (`/estudios`, staff)

Listado paginado sobre una vista unificada de órdenes+turnos. Filtros combinables:

- **Paciente**: reutiliza `PacienteBuscador` (DNI o apellido/nombre, autocompletado con lupita).
- **Fecha**: calendario con rango (default: hoy).
- **Modalidad** (CR, CT, MR, US, MG, …), **Práctica**, **Sede**, **Profesional**: selects.
- **Estado**: chips `AGENDADO / RECEPCIONADO / PENDIENTE_DE_INFORME / INFORMADO / AUSENTE`.

Mapeo de estados (sin nueva máquina de estados; es una **proyección** de la actual):

| Estado módulo | Estados internos de turno |
|---|---|
| AGENDADO | `pendiente`, `confirmado` |
| RECEPCIONADO | `arribo`, `llamado`, `en_atencion` |
| PENDIENTE_DE_INFORME | `pendiente_informe`, `informando` |
| INFORMADO | `informado`, `publicado` |
| AUSENTE | `ausente` / `cancelado` con arribo vencido |

Cada fila abre la pantalla única de trabajo.

### 2.2 Pantalla única de trabajo (`/estudios/:ordenId`)

```
┌─ Encabezado: Paciente (DNI, cobertura) · Práctica · Fecha · Modalidad · Sede · Estado ─┐
├───────────────┬──────────────────────────────────────┬────────────────────────────────┤
│ IZQUIERDA     │ CENTRO                               │ DERECHA (v3: solo lectura)     │
│ · Orden       │ · Visualizador DiagnosticPACS        │ · Informe del PACS (lectura)   │
│ · Motivo (*)  │   (iframe autenticado con sesión     │ · Estado del informe           │
│ · Diagnóstico │    contextual de corta duración)     │ · PDF firmado (descarga/envío) │
│ · Anteceden.  │ · Estudios comparativos              │ · Entrega al paciente          │
│ · Obs. técnico│ · Mediciones / anotaciones (PACS)    │ · Acciones de estado           │
└───────────────┴──────────────────────────────────────┴────────────────────────────────┘
```

- El contexto del paciente viaja con la orden: **nunca** se vuelve a buscar al paciente ni se abren pestañas.
- El motivo del estudio (`clinical_justification`) es **obligatorio** y visible para técnico, médico, visor (metadata de sesión) e IA/informe.
- Columnas visibles según rol (sección 2.3). En contingencia el centro muestra "Visualizador temporalmente no disponible" con botón reintentar; el resto sigue operativo.

### 2.3 Roles y permisos

| Acción | Recepción | Técnico | Médico | Admin téc. |
|---|---|---|---|---|
| Crear orden + motivo | ✔ | — | ✔ | — |
| Consultar estado / worklist | ✔ | ✔ | ✔ | ✔ |
| Iniciar carga de estudios | ✔ | ✔ | — | — |
| Obs. del técnico / marcar realizado | — | ✔ | — | — |
| Visor con imágenes / mediciones | — | vista técnica | ✔ | — |
| Ver informe del PACS / descargar PDF firmado (v3: se redacta y firma en el PACS) | — | — | ✔ | — |
| Diagnóstico de integración (sin administrar Orthanc) | — | — | — | ✔ |
| Ver info clínica (diagnóstico, antecedentes, informe) | ✖ | parcial | ✔ | ✖ |

Requiere: nuevo rol `tecnico` en el enum de roles + `requireRol` por endpoint; los permisos concretos van también en `requested_permissions` de la sesión contextual.

---

## 3. Contrato OpenAPI propuesto (a validar con DiagnosticPACS)

Archivo propuesto: `docs/pacs-workspace-openapi.yaml` (borrador para discusión — **no** se inventan las respuestas del PACS; los schemas de respuesta quedan marcados `x-pending-confirmation` hasta que DiagnosticPACS los confirme).

Identificadores mínimos en todos los recursos: `order_id`, `patient_id` (interno de Conectar), `accession_number`, `study_instance_uid` (cuando exista), `practice_id`, `modality`, `status`, `reason_for_study`, `updated_at`.

### 3.0 Prácticas que se publican a la worklist del PACS (definido por el usuario, 21-jul-2026)

Solo estas prácticas generan ítem de worklist en el PACS (las demás — consultas, etc. — no se publican):

| Práctica | Modalidad DICOM sugerida |
|---|---|
| Holter | ECG (ambulatorio) |
| Presurometría (MAPA) | ECG / OT |
| Electrocardiograma | ECG |
| OCT (tomografía de coherencia óptica) | OPT |
| PAP (ginecología) | SM (anatomía patológica) |
| Resonancia Magnética | MR |
| Ecografía | US |
| Rayos | CR / DX |
| Mamografía | MG |

La pertenencia se configura en Conectar por práctica/especialidad (flag "se envía al PACS" + código de modalidad), no hardcodeada — así se pueden sumar o quitar prácticas sin tocar código. Los códigos de modalidad quedan a confirmar con DiagnosticPACS (`x-pending-confirmation`).

### 3.1 Llamadas Conectar → DiagnosticPACS (backend a backend, Bearer `PACS_API_TOKEN`)

API de integración acordada (`/api/v1/integration/*`):

| Endpoint | Uso |
|---|---|
| `POST /api/v1/integration/worklist` | **Nuevo (v3): publicar/actualizar un ítem de worklist.** Se dispara cuando un turno/orden de práctica de imágenes queda agendado o recepcionado en Conectar: paciente, práctica (ej. ergometría), modalidad, fecha/hora, sede, profesional solicitante, `reason_for_study`. Upsert idempotente por `order_id`/`accession_number`; cancelación/reprogramación actualizan el mismo ítem. |
| `DELETE /api/v1/integration/worklist/{order_id}` | **Nuevo (v3): quitar el ítem** cuando el turno se cancela o el paciente queda ausente. |
| `GET /api/v1/integration/health` | Diagnóstico de integración (pantalla de admin técnico en Conectar). |
| `POST /api/v1/integration/viewer-sessions` | Sesión contextual temporal. Respuesta: `session_id`, `viewer_url` temporal **de un solo uso** restringida al estudio, `expires_at` (pocos min), `permitted_actions`, `study_instance_uid`, `audit_id`. Sin claves permanentes; no permite enumerar otros estudios. |
| `POST /api/v1/integration/upload-sessions` | Inicia carga: `upload_id` vinculado a `order_id`, URL prefirmada breve (S3 privado + KMS), **reanudable**, con `checksum` para verificación y anti-duplicados (409 si duplicada). El archivo no pasa por Conectar. |
| `GET /api/v1/integration/orders/{order_id}/study` | Estudio asociado a una orden. |
| `GET /api/v1/integration/studies/{study_uid}/status` | Estado del estudio (recibido/incompleto/listo/error, series e instancias). |
| `GET /api/v1/integration/studies/{study_uid}/report` | **Solo lectura (v3):** obtener el informe redactado y firmado **en el PACS** (metadatos + cuerpo). |
| `GET /api/v1/integration/studies/{study_uid}/report/pdf` | **Nuevo (v3):** descargar el PDF del informe firmado para archivarlo en Conectar y entregarlo al paciente. |
| ~~`POST .../report` / `POST .../report/sign`~~ | **Eliminados (v3):** la redacción y la firma ocurren en el PACS; Conectar no escribe informes de imágenes. |
| `POST /api/v1/integration/webhooks/test` | Prueba de webhook + verificación de firma. |

DICOMweb (QIDO-RS búsqueda, WADO-RS visualización, STOW-RS carga): siempre autenticado, nunca expuesto públicamente; el navegador solo accede vía la sesión contextual.

En cada orden Conectar entrega el contexto clínico completo: `order_id`, `patient_id` interno, `accession_number`, `practice_id`, `practice_description`, `modality`, `reason_for_study` (obligatorio), `diagnosis`, `technician_notes`. El motivo es visible en el visor y **precondición para ejecutar IA**.

### 3.2 Webhooks DiagnosticPACS → Conectar (firmados)

`POST /api/pacs/webhook/eventos` — firmado con HMAC-SHA256: header `X-Pacs-Signature` (hash del body con secreto compartido `PACS_WEBHOOK_SECRET`, **nuevo secret** distinto del token) + `X-Pacs-Timestamp` (rechazo si desvío > 5 min, anti-replay). Body:

```json
{ "event_id": "uuid", "event_type": "STUDY_READY", "occurred_at": "…",
  "order_id": 123, "accession_number": "…", "study_instance_uid": "…", "payload": { } }
```

Eventos: `STUDY_UPLOAD_STARTED`, `STUDY_RECEIVED`, `STUDY_INCOMPLETE`, `STUDY_READY`, `REPORT_DRAFTED`, `REPORT_SIGNED`, `STUDY_ERROR` (+ `WEBHOOK_TEST`).
Reglas: `event_id` único persistido (tabla `pacs_eventos`) → reintentos idempotentes; sin URLs S3 permanentes en payload; auditoría sin datos clínicos innecesarios.

### 3.3 Estados compartidos — quién produce cada transición

| Transición | Sistema que la produce |
|---|---|
| → AGENDADO | Conectar (turnera/agenda) |
| AGENDADO → RECEPCIONADO | Conectar (recepción / técnico) |
| AGENDADO → AUSENTE | Conectar (recepción o vencimiento automático) |
| → ítem en worklist del PACS | Conectar (al agendar/recepcionar una práctica de imágenes publica el ítem; al cancelar/ausentar lo quita) |
| RECEPCIONADO → PENDIENTE_DE_INFORME | Conectar (técnico marca realizado) — el ítem de worklist pasa a "para informar" |
| PENDIENTE_DE_INFORME → INFORMADO | **DiagnosticPACS exclusivamente** vía webhook `REPORT_SIGNED` (el informe se redacta y firma en el PACS) |
| Sub-estados de imagen (upload/received/ready/error) | **DiagnosticPACS** exclusivamente (Conectar solo los refleja) |

Regla: cada estado tiene un único dueño; el otro sistema solo lo consume. Conflictos se resuelven por auditoría (`audit_id` / `event_id`).

### 3.4 IA (solo a demanda)

- v3: la asistencia de IA para el informe, si existe, vive **del lado del PACS** (donde se redacta el informe). Conectar solo exige que el ítem de worklist lleve `reason_for_study` para darle contexto.
- Siguen valiendo las reglas: análisis masivo automático apagado, IA solo a demanda de un médico autorizado, auditada, y la IA nunca firma ni publica.

### 3.5 SSO / identidad

No hay SSO real en v1: el usuario se autentica solo en Conectar; el PACS confía en la sesión contextual creada backend-a-backend (que lleva `user_id` + `role` de Conectar y devuelve `audit_id`). La consola técnica del PACS mantiene su login propio como **acceso de emergencia independiente de Conectar**. Un SSO formal (OIDC) queda para una fase posterior si se necesita.

### 3.6 Reglas de seguridad del visor y de la integración

- Ninguna API key ni secreto llega al navegador: el iframe recibe solo la `viewer_url` de un solo uso y corta duración.
- Sin enlaces públicos/permanentes ni URLs S3 permanentes; S3 privado + cifrado KMS del lado PACS; renovación de sesión siempre desde el backend de Conectar.
- Respuestas del PACS: 401 sin autenticación, 403/404 sin permiso (sin filtrar existencia de estudios ajenos).
- Iframe restringido: `Content-Security-Policy: frame-src https://<host-pacs>` + `frame-ancestors` acordados con el PACS; allowlist del host del visor (ya existe patrón en la integración Phir-it).
- Auditoría en ambos lados de visualización, descarga, carga e informe (correlacionada por `audit_id`).
- Contingencia técnica: la consola propia del PACS queda como acceso de emergencia independiente de Conectar.

---

## 4. Cambios necesarios en Conectar

Todo detrás de `PACS_WORKSPACE_ENABLED` (env var, default `false`; el backend responde 404 en las rutas nuevas y el frontend oculta el módulo cuando está apagado).

**Backend (`api-server`)**
1. `routes/estudios.ts`: `GET /api/estudios` (buscador con filtros + proyección de estados), `GET /api/estudios/:ordenId` (detalle unificado orden+turno+paciente+informe).
2. `routes/pacs.ts`: **publicador de worklist (v3)** — al agendar/recepcionar/cancelar un turno de práctica de imágenes se hace upsert/delete del ítem en el PACS (reintentos con backoff; la agenda nunca se bloquea si el PACS no responde); `POST /api/estudios/:ordenId/sesion-visor` (sesión contextual, devuelve solo `viewer_url`+`expires_at`+`permitted_actions`); `POST /api/pacs/webhook/eventos` con verificación de firma HMAC (`PACS_WEBHOOK_SECRET`) + anti-replay por timestamp — al recibir `REPORT_SIGNED` descarga y archiva el PDF y marca el turno INFORMADO; el webhook actual `estudio-informado` se mantiene hasta que el PACS migre.
3. Rol `tecnico`: enum + `requireRol` en rutas nuevas y worklist.
4. Motivo obligatorio: validación Zod en creación de orden (`clinical_justification` no vacío) cuando el flag está activo — el motivo viaja en el ítem de worklist.
4b. ~~Auditoría de IA en Conectar~~ (v3: la IA del informe vive en el PACS; Conectar no ejecuta IA de informes de imágenes).
5. Contingencia: si el PACS no responde, las rutas de agenda/recepción no se ven afectadas (ya desacopladas); los ítems de worklist pendientes de publicar quedan en cola con reintentos; `sesion-visor` devuelve 503 con código `PACS_UNAVAILABLE`.
5b. Archivo del informe (v3): al recibir `REPORT_SIGNED`, descargar el PDF firmado, guardarlo en el almacenamiento privado de Conectar (copia inmutable, con hash) y vincularlo a la orden/turno para mostrarlo al médico y entregarlo al paciente.

**Frontend (`mi-diagnosticar`)**
6. Página `/estudios` (listado + filtros, reutiliza `PacienteBuscador`).
7. Página `/estudios/:ordenId` (pantalla única de 3 columnas, iframe con sesión temporal y renovación automática, columnas por rol).
8. Spec OpenAPI interno (`lib/api-spec/openapi.yaml`) + codegen para los endpoints nuevos.

**No se toca**: poller PACS actual, Phir-it, Pulso (siguen alimentando el listado como fuentes de estudios comparativos).

## 5. Migraciones (aditivas, sin pérdida)

1. `ALTER TYPE`/check de rol: agregar `tecnico`.
2. Tabla `pacs_eventos`: `id`, `event_id UNIQUE`, `event_type`, `order_id`, `accession_number`, `study_instance_uid`, `payload jsonb`, `procesado_en`, `created_at` (auditoría + idempotencia).
3. Tabla `pacs_cargas`: `id`, `upload_id`, `orden_id FK`, `estado`, `cantidad_archivos`, `checksum`, `resultado`, `referencias jsonb`, timestamps — **nunca** contenido de archivos ni Base64.
3b. ~~Tabla `ia_ejecuciones`~~ (v3: sin efecto — la IA del informe vive en el PACS; Conectar no ejecuta IA de informes de imágenes).
4. `study_orders`: agregar `accession_number`, `study_instance_uid`, `modality`, `sede_id?`, `observaciones_tecnico` (nullable, aditivo).
5. Índices: `pacs_eventos(event_id)`, `pacs_cargas(orden_id)`, `study_orders(accession_number)`.

Recordatorio operativo: en prod las DDL se aplican vía psql/deploy (ver gotcha de drizzle push) — se documentará en `prod-schema-pending`.

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| El contrato del PACS difiere de lo propuesto | Schemas `x-pending-confirmation`; no codificar respuestas hasta confirmación; flag apagado. |
| Fuga de credenciales al navegador | Sesión contextual backend-a-backend; revisar que ningún endpoint devuelva `PACS_API_TOKEN` ni URLs permanentes. |
| Doble máquina de estados divergente | Los 5 estados del módulo son proyección de la máquina existente, no estados nuevos en DB. |
| Webhooks duplicados/perdidos | `event_id` único + poller existente como red de seguridad (reconciliación). |
| Carga confirmada sin confirmación del PACS | La carga sólo pasa a `confirmada` por webhook `STUDY_RECEIVED`/`STUDY_READY` o polling del PACS; nunca por el cliente. |
| Recepción viendo info clínica | Permisos por columna/rol en el endpoint de detalle (el backend omite campos clínicos según rol, no solo la UI). |
| PACS caído | Agenda/recepción intactas; visor con placeholder y reintento; órdenes nunca se pierden (viven en Conectar). |
| Rendimiento del listado con 68k pacientes | Filtros server-side indexados + paginación (patrón ya aplicado en `GET /pacientes`). |
| Interferir con la migración DICOM→S3 en curso | Nada se activa, publica ni prueba contra el PACS hasta que la migración termine, se reconcilie y se entregue el informe. |
| IA usada sin control | (v3: del lado PACS) sigue el mismo principio: solo a demanda de médico autorizado, motivo obligatorio, auditada; nunca firma/publica. |
| Worklist desincronizada (turno cancelado que el PACS igual atiende) | Upsert/delete idempotentes + cola de reintentos + reconciliación periódica contra `GET /orders/{id}/study`. |

**Plan de rollback:** todo va detrás de los flags — apagar `PACS_WORKSPACE_ENABLED` (y `PACS_INTEGRATION_ENABLED` en el PACS) devuelve ambos sistemas al comportamiento actual sin migraciones inversas (las DDL son aditivas). El webhook legado `estudio-informado` y el poller siguen operativos como fallback durante toda la transición.

## 7. Plan de pruebas

**Integración (vitest, contra DB dev, PACS mockeado):**
1. `GET /api/estudios`: cada filtro y combinación; proyección correcta de estados; permisos por rol (recepción no recibe campos clínicos); 404 con flag apagado.
2. Webhook `eventos`: firma HMAC inválida o timestamp vencido → 401; `event_id` repetido → 200 sin doble efecto; cada `event_type` produce la transición/auditoría esperada; evento para orden inexistente → 202 auditado sin crash; payload con URL S3 permanente → rechazado/alertado.
3. Sesión de visor: pide permisos según rol; nunca expone el token; PACS caído → 503 `PACS_UNAVAILABLE`; **aislamiento entre pacientes** (sesión de la orden A no sirve para el estudio B → 403/404); **expiración** (sesión vencida → rechazo y renovación backend).
4. Cargas: crear → `iniciada`; confirmación sólo vía webhook/polling; reintento idempotente; **reanudación** tras corte (mismo `upload_id`, checksum verificado); duplicado → 409.
5. Motivo obligatorio: crear orden sin motivo → 400 (con flag activo); el ítem de worklist siempre sale con `reason_for_study`.
5b. Worklist (v3): agendar práctica de imágenes → upsert publicado (mock PACS lo registra); reprogramar → mismo ítem actualizado; cancelar/ausente → delete; PACS caído → ítem queda en cola y se reintenta sin bloquear la agenda; upsert repetido idempotente.

**E2E (subagente Playwright, usuarios demo + rol técnico de prueba):**
6. Recepción: crea orden con motivo, ve estado, inicia carga, NO ve diagnóstico/informe.
7. Técnico: toma de worklist, confirma práctica, carga observaciones, marca realizado.
8. Médico: abre pantalla única, ve motivo y visor embebido (mock); llega webhook `REPORT_SIGNED` (mock) → estado INFORMADO, informe visible y PDF descargable.
9. Contingencia: con PACS mock caído, la pantalla muestra el placeholder y la agenda sigue funcionando.

**Seguridad:** revisión de que ninguna respuesta ni HTML contenga `PACS_API_TOKEN`; CSP del iframe; expiración real de la sesión.

## 8. Orden de entrega propuesto

0. **Esperar el fin de la migración DICOM→S3 del PACS** + informe de reconciliación ← **bloqueante duro** (mientras tanto solo diseño y código detrás de flags)
1. Confirmar contrato con DiagnosticPACS (sección 3) y acordar `PACS_WEBHOOK_SECRET` ← **bloqueante**
2. Migraciones + rol `tecnico` + webhook de eventos (compatible con el actual)
3. Backend módulo Estudios + sesión de visor + cargas (flag apagado)
4. Frontend `/estudios` + pantalla única
5. Pruebas integración + E2E con PACS mock
6. Activación del flag en dev con datos de prueba → recién después, prod
