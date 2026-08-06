# Informe de compatibilidad — Conectar ↔ DiagnosticPACS (borrador v0.2)

Fecha: 2026-07-20 · Revisión del ZIP `informe-conectar-v0.2.zip`
SHA-256 verificado: `db265b0694cb3ba77c9f81fb6d32a1b0934fe56b65ba3bdd4117da389cd6661e` ✔ (coincide)
Archivos extraídos: `informe-para-conectar.md`, `integracion-conectar-diseno.md`, `openapi-integracion-conectar.yaml`.

**Validación OpenAPI 3.1:** el documento valida contra el schema 3.1 salvo **un error de sintaxis**: en `GET /key-images/{key_image_id}/thumbnail`, la respuesta `404` usa un mapa en línea con una descripción con comas sin comillas (`{ description: No existe, fue borrada o... }`), por lo que YAML la parte en propiedades espurias. Arreglo: encomillar la descripción. No hay otros errores estructurales.

Decisiones aprobadas que este informe da por fijas: Conectar redacta/firma/versiona/publica informes; el PACS provee visor, mediciones, anotaciones e imágenes clave; el Robot queda fuera del contrato; relación principal `order_id + accession_number + StudyInstanceUID`; un informe puede vincular varios StudyInstanceUID; imágenes clave por `SeriesInstanceUID + SOPInstanceUID + frame_number`; Conectar no almacena DICOM.

---

## 1. Compatible sin cambios

- **Flags y rollback**: `PACS_INTEGRATION_ENABLED` / `PACS_WORKSPACE_ENABLED` apagados; API aditiva; rollback = apagar flag. Coincide con nuestro plan.
- **Dos credenciales (serviceToken / sessionToken)** con mínimo privilegio: correcto y compatible con cómo hoy guardamos `PACS_API_TOKEN` solo en backend.
- **Sesión contextual**: respuesta `{session_id, viewer_url, expires_at, permitted_actions, study_instance_uid, audit_id}` — exactamente lo que nuestra pantalla única espera; TTL 5 min/30 min y token opaco hasheado, OK.
- **Carga reanudable por instancia** con SHA-256, idempotencia por SOP IUID (200 mismo hash / 409 hash distinto): compatible; Conectar solo persistirá punteros (`pacs_cargas`), jamás Base64 (regla ya vigente en nuestra DB).
- **Webhooks firmados HMAC + `event_id` idempotente + cola con reintentos**: compatible con la tabla `pacs_eventos` planificada; el header se llama `X-Conectar-Signature` (nosotros habíamos propuesto `X-Pacs-Signature` — adoptamos el de ellos, es cosmético).
- **Estados compartidos**: la matriz de §7 del diseño coincide con la nuestra, con una precisión bienvenida: `PENDIENTE_DE_INFORME` lo produce el PACS vía `STUDY_READY`. Compatible con nuestra máquina (`pendiente_informe` ← webhook en vez de transición manual).
- **Imágenes clave (v0.2)**: modelo correcto para "informe en Conectar"; identificación con frame_number y viewport_state es suficiente. Conectar guardará solo referencias JSON.
- **IA a demanda, sin firma automática, con auditoría**: idéntico a nuestro plan (tabla `ia_ejecuciones`).
- **Consola técnica del PACS conservada e independiente**: OK, sin cambios de nuestro lado.

## 2. Cambios necesarios en Conectar

1. **Informes multi-estudio**: hoy `informes.pacs_study_id` es un campo único de texto. Nueva tabla `informe_estudios (informe_id FK, study_instance_uid, accession_number, order_id, created_at)` con unique `(informe_id, study_instance_uid)` — un informe ↔ N estudios, como fija la decisión aprobada.
2. **Versionado y publicación de informes**: como Conectar pasa a ser la única fuente del informe, agregar `informe_versiones (informe_id, version, texto, conclusion, firmado_por, firmado_en, publicado_en, created_at)`; `informes` pasa a apuntar a la versión vigente. (Hoy solo hay `estado` borrador/firmado/publicado sin historial.)
3. **Imágenes clave**: tabla `informe_imagenes_clave (informe_id, key_image_id, study_instance_uid, series_instance_uid, sop_instance_uid, frame_number, title, physician_comment, thumbnail_sha256, orden, created_at)` — solo referencias; la miniatura se pide al PACS por URL prefirmada al momento de mostrar (nunca se persiste el binario).
4. **Webhook receptor** `POST /api/pacs/webhook/eventos`: verificar firma `X-Conectar-Signature` (HMAC-SHA256, secreto compartido) + `event_id` idempotente en `pacs_eventos`; el evento `KEY_IMAGES_UPDATED` refresca la lista de imágenes clave del informe abierto. Sin `REPORT_DRAFTED`/`REPORT_SIGNED` (correcto: el informe vive acá).
5. **Transición por `STUDY_READY`**: nuestro `pendiente_informe` pasa a dispararse por webhook del PACS (hoy lo dispara la recepción/técnico). Mantener el disparo manual como fallback mientras conviva el circuito viejo (poller + `estudio-informado`), que sigue intacto porque **el Robot queda fuera de este contrato**.
6. **Orden formal hacia el PACS**: `study_orders` no tiene hoy `accession_number`, `modality` ni `scheduled_at` → columnas nuevas (aditivas) + generación de accession propio (propuesta: `CON-{order_id}` zero-padded, a confirmar formato con el PACS).
7. Resto sin cambios respecto del plan v2: rol `tecnico`, páginas `/estudios` y `/estudios/:ordenId`, `pacs_cargas`, `ia_ejecuciones`.

## 3. Cambios solicitados a DiagnosticPACS (observaciones sobre el borrador)

1. **`ViewerSessionRequest` debe exigir exactamente uno** de `order_id` | `study_instance_uid`. En el YAML ambos son opcionales y nada impide mandar ninguno o los dos. Pedido: `oneOf` con `required: [order_id]` / `required: [study_instance_uid]` y `409/422` si llegan ambos.
2. **Identidad desde la sesión, no del request**: `KeyImageCreate` (y el upload de objetos) aceptan `user {external_id, role}` libremente aun autenticando con `sessionToken`. La sesión ya conoce usuario y rol: los endpoints con `sessionToken` deben **ignorar/omitir `user`** y derivar la identidad del token, para impedir suplantación. `user` solo tiene sentido al **crear** la sesión con `serviceToken`.
3. **`serviceToken` sin acceso a objetos clínicos**: en el borrador, `GET /studies/{uid}/key-images` y `GET /key-images/{id}/thumbnail` aceptan `serviceToken`. Pedido: el token de servicio solo crea sesiones (viewer/upload/lectura-informe); las miniaturas y listados clínicos se obtienen con un token clínico temporal de alcance acotado emitido por esa sesión.
4. **Una orden, varios estudios**: `GET /orders/{order_id}/study` devuelve un único estudio. Pedido: `GET /orders/{order_id}/studies` → colección `[StudySummary]` (una orden puede generar más de un StudyInstanceUID). Conectar ya modela esto (punto 2.1).
5. **La orden debe estar en el contrato**: el YAML delega el ingreso del motivo en `POST /api/integrations/conectar/orders` como "referencia normativa" pero ese endpoint **no está documentado en el ZIP**. Pedido: incluirlo formalmente con `order_id`, `accession_number`, `conectar_patient_id`, `practice_id`, `modality`, `reason_for_study`, `scheduled_at` (+ `practice_description`, `diagnosis`, `technician_notes`).
6. **Anexo DICOMweb pendiente** (QIDO-RS/WADO-RS/STOW-RS bajo `sessionToken`): sin ese anexo **no implementamos el visor**. Bloqueante.
7. **Errores formales**: falta manejo homogéneo de `409` (conflicto), `422` (datos inválidos — hoy solo en key-images), `429` + `Retry-After` (rate limit) y `503` + `Retry-After` (no disponible), y la declaración de que todos los POST aceptan reintentos idempotentes (idempotency key o semántica equivalente). Pedido: sección común de respuestas de error en el OpenAPI.
8. **Cómo recibe el navegador el token de carga**: `upload_url` incluye el token de sesión, pero no está definido cómo llega al browser sin exponer credenciales en URLs. Pedido: **código de canje de un solo uso** — Conectar (backend) recibe `redeem_code`, el navegador lo canjea contra el PACS por el token efímero de la sesión (mismo patrón que el canje inicial del visor).
9. **Apagar la doble fuente de verdad**: al activar informes en Conectar, `POST /api/studies/:id/report` y `POST /api/analyses/:id/sign` del PACS (hoy activos con Clerk `requireDoctor`, según su propio inventario §2) deben quedar deshabilitados o de solo lectura.
10. **Nada clínico público antes de activar**: exigir autenticación en toda vista previa/descarga clínica hoy pública o semipública (`GET /api/descargar-gateway` sin auth; proxy `/pacs` a `instances/:id/file|preview`; revisar el enlace HMAC de PDF `/api/conectar/pdf/:versionId` — expiración corta y one-shot).
11. (Menor) Corregir el error YAML del thumbnail (arriba) y encomillar descripciones con comas.

## 4. Modelo de tablas (Conectar, todas aditivas)

| Tabla | Rol |
|---|---|
| `pacs_eventos` | Idempotencia + auditoría de webhooks (`event_id` UNIQUE, tipo, uids, payload sin URLs permanentes). |
| `pacs_cargas` | Sesiones de carga: `upload_id`, `orden_id`, estado, esperados/verificados, checksum; nunca binarios. |
| `informe_estudios` | N StudyInstanceUID por informe (decisión aprobada). |
| `informe_versiones` | Redacción, firma, versionado y publicación en Conectar. |
| `informe_imagenes_clave` | Referencias a key images (uids + frame + título + comentario); miniatura siempre on-demand. |
| `ia_ejecuciones` | Auditoría de IA a demanda (usuario, modelo, resultado, aceptación/corrección). |
| `study_orders` (alter) | + `accession_number`, `study_instance_uid?`, `modality`, `scheduled_at`, `observaciones_tecnico`. |
| Enum de rol (alter) | + `tecnico`. |

## 5. Endpoints definitivos (resumen)

**PACS → consumidos por Conectar (serviceToken):** `GET /health` · `POST /viewer-sessions` (con XOR de ids y user solo acá) · `POST /upload-sessions` (devuelve `redeem_code`) · `GET /upload-sessions/{id}` · `GET /orders/{order_id}/studies` (colección) · `GET /studies/{uid}/status` · `POST /webhooks/test`.
**PACS → con sessionToken (navegador/técnico):** `POST /upload-sessions/{id}/objects` · `POST|GET /studies/{uid}/key-images` · `GET /key-images/{id}/thumbnail` · `DELETE /key-images/{id}` · DICOMweb (anexo pendiente).
**Conectar → expuestos al PACS:** `POST /api/pacs/webhook/eventos` (HMAC `X-Conectar-Signature`, `event_id` idempotente). El endpoint de órdenes (`POST /api/integrations/conectar/orders` del lado PACS) debe formalizarse en el contrato (punto 3.5).

## 6. Seguridad

- serviceToken solo backend; sessionToken opaco, hasheado, un solo uso al canje, alcance de un estudio; identidad derivada de la sesión (punto 3.2); serviceToken sin acceso a objetos clínicos (punto 3.3).
- S3 privado + KMS; URLs prefirmadas ~120 s `private, no-store`; jamás enlaces permanentes; nada clínico sin auth (punto 3.10).
- 401 sin autenticación; 403/404 sin permiso sin revelar existencia; aislamiento total entre pacientes; auditoría de visualización/descarga/carga/imágenes clave correlacionada por `audit_id`.
- Webhooks firmados + timestamp anti-replay; rotación del secreto: proponemos doble secreto activo (viejo+nuevo) durante la ventana de rotación.

## 7. Pruebas (antes de activar)

Las de nuestro plan v2 más las del diseño del PACS: aislamiento entre pacientes (sesión de A contra estudio B ⇒ 403/404), expiración y doble canje ⇒ 401, carga cortada y reanudada con checksums y sin duplicados, flag apagado ⇒ 404 en todo `/api/v1/integration/*`, firma HMAC inválida ⇒ 401, `event_id` repetido sin doble efecto, `KEY_IMAGES_UPDATED` refresca el informe, informe multi-estudio (2 UIDs → 1 informe), versionado (firmar crea versión inmutable), y verificación final de que la migración S3 no fue afectada (informe de conciliación).

## 8. Migraciones

Todas aditivas (sección 4); sin backfill obligatorio — `informe_estudios` se puede poblar desde `informes.pacs_study_id` existente cuando no sea nulo. En prod, DDL vía psql/deploy como siempre. Reversibles apagando el flag (las tablas nuevas quedan inertes).

## 9. Preguntas bloqueantes para DiagnosticPACS

1. ¿Aceptan el **XOR** `order_id`/`study_instance_uid` en `viewer-sessions` y derivar identidad de la sesión (quitar `user` de los requests con sessionToken)?
2. ¿Confirman `GET /orders/{order_id}/studies` como colección?
3. ¿Publican el **contrato formal de la orden** (`POST /api/integrations/conectar/orders`) dentro del OpenAPI con los campos del punto 3.5? ¿Qué formato de `accession_number` esperan que genere Conectar?
4. **Anexo DICOMweb**: ¿cuándo lo entregan? Sin él no arrancamos el visor.
5. Identidad en la sesión contextual: proponemos **payload backend-a-backend simple** (external_id + rol) — el canal ya está autenticado con serviceToken; JWT firmado solo si prevén validación offline. ¿De acuerdo?
6. `STUDY_INCOMPLETE`: proponemos **N = 15 minutos** desde el último objeto recibido. ¿OK?
7. Estados: los 5 nos alcanzan; no pedimos `EN_PROCESO` (nuestro RECEPCIONADO ya cubre arribo→atención). ¿Cierran los 5?
8. ¿Confirman deshabilitar/read-only los endpoints viejos de informe del PACS al activar (punto 3.9) y autenticar lo hoy público (punto 3.10)?
9. Canje del token de carga por `redeem_code` de un solo uso (punto 3.8): ¿de acuerdo?
10. Rotación del secreto HMAC de webhooks: ¿soportan doble secreto activo durante la rotación?

---
*Nada de esto se implementa sobre supuestos: primero respuestas a la sección 9 y OpenAPI corregido. `PACS_WORKSPACE_ENABLED` sigue en `false` y no se publica nada del módulo.*
