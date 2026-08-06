# Decisión de Conectar sobre el contrato DiagnosticPACS–Conectar v0.3

> **⚠️ ADDENDUM 21-jul-2026 — CAMBIO DE ESCENARIO (v3, integración por worklist):**
> Conectar cambió el modelo: la integración pasa a ser **por worklist** (Conectar publica al PACS los estudios a realizar — si se agenda una ergometría, al PACS le figura que hay que hacer una ergometría) y **los informes se redactan y firman en el PACS**, no en Conectar.
> Impacto sobre este documento:
> - **CM-4 queda sin efecto** (evidencia congelada al firmar en Conectar): al no firmar Conectar, la evidencia del informe firmado es responsabilidad del PACS; Conectar solo archiva copia inmutable del **PDF firmado** que recibe (con hash `pdf_sha256` verificado).
> - Los endpoints de escritura de informe (`POST .../report`, `POST .../report/sign`) salen del contrato; entran `POST/DELETE /worklist` y `GET .../report/pdf`.
> - CM-1 (accession propio `C{AA}-{12 dígitos}`), CM-2 (inmutables + 409), CM-3 (redeem), CM-5 y CM-6 **siguen vigentes**.
> Detalle del nuevo escenario: `docs/pacs-workspace-plan.md` (nota v3) y `docs/pacs-workspace-openapi.yaml` (0.3.0-draft-worklist). Requiere una nueva ronda de revisión con DiagnosticPACS.

Fecha: 2026-07-20 · Autor: equipo Conectar · Referencia: paquete v0.3
(ZIP `b0dd6f85…3ea545` ✔ · OpenAPI `bd27fc36…a7db83` ✔ · Anexo DICOMweb `d1e89362…76ca0df` ✔ — los tres hashes verificados; ambos YAML validan como OpenAPI 3.1 sin errores)

---

## DECISIÓN: **CAMBIOS MENORES NECESARIOS**

Las diez observaciones de v0.2 quedaron correctamente incorporadas — lo verificamos
punto por punto contra el OpenAPI y el diseño (XOR con `oneOf` estricto, identidad
fijada en la sesión, `user` eliminado de KeyImageCreate y de la subida de objetos,
serviceToken sin acceso clínico + read-session, colección `GET /orders/{id}/studies`,
contrato formal de órdenes, redeem de un solo uso, 409/422/429/503 + `Retry-After`,
`Idempotency-Key` en todos los POST, `technical_state` separado, `signature_ts`
anti-replay, anexo DICOMweb completo con QIDO acotado al alcance, plan §14, y el
error YAML de la 404 corregido).

No hay objeciones de arquitectura. Quedan **seis cambios menores**, enumerados
exactamente. ~~Incorporados estos seis puntos tal como se enuncian, Conectar da el
contrato por **APROBADO COMO V1** sin necesidad de una nueva ronda de revisión~~
**(SUPERADO por el addendum v3: el cambio de escenario a worklist + informes en el
PACS exige una nueva ronda de revisión; la vía rápida "solo reenviar YAML" ya no
aplica).**

---

## Cambios menores requeridos (lista exhaustiva)

### CM-1 · Accession number: secuencia propia, NO `CON-{order_id}`

Se rechaza el formato `CON-{order_id}` con zero-padding propuesto en v0.3: no hay
que concatenar un `order_id` arbitrariamente largo dentro de un campo con tope
DICOM de 16 caracteres.

Decisión de Conectar (a reflejar en la descripción de `OrderUpsert.accession_number`):
- Generado por **secuencia propia de Conectar**, independiente de `order_id`.
- Formato: `C{AA}-{secuencia de 12 dígitos}` → ejemplo `C26-000000000001`
  (16 caracteres exactos, `[A-Z0-9-]`, `AA` = año de emisión de dos dígitos).
- **Único e inmutable** de por vida; el PACS lo trata como identificador opaco
  (no parsear, no derivar el año ni la orden desde él).
- El `pattern` actual `^[A-Z0-9-]{1,16}$` ya lo cubre — solo cambiar descripción
  y ejemplo del schema y del diseño §3/§8.

### CM-2 · Mutabilidad de la orden: campos inmutables y reglas 409 explícitas

Agregar a `POST /orders` (descripción del endpoint + tabla en el diseño):
- **Inmutables**: `order_id`, `accession_number`, `conectar_patient_id`.
  Upsert que intente cambiarlos ⇒ `409` (no hay "corrección" de identidad; ante
  error real, se anula la orden y se emite una nueva).
- **Actualizables solo mientras el estudio no tenga imágenes recibidas**
  (`technical_state` = ESPERANDO_OBJETOS): `practice_id`, `practice_description`,
  `modality`, `reason_for_study`, `diagnosis`, `scheduled_at`, `technician_notes`.
  Intento de modificación después de recibir el primer objeto ⇒ `409`.
- Ya está pactado (y se mantiene): misma `Idempotency-Key` con body distinto ⇒ `409`.

### CM-3 · Canje del redeem_code: resolver la contradicción replay vs. recuperación

Hoy el contrato dice a la vez "segundo canje ⇒ 401" y "misma Idempotency-Key +
mismo body ⇒ respuesta original". Especificar en `POST /sessions/redeem`
exactamente esto:
- **Mismo `redeem_code` + misma `Idempotency-Key`** (caso respuesta perdida):
  devolver el **mismo** `RedeemResponse` mientras la sesión canjeada siga vigente
  y no revocada. La sesión sigue siendo una sola (no se emite un segundo token).
- **Mismo `redeem_code` + otra `Idempotency-Key`** (o sin ella): `401`.
- Cualquier otro reintento distinto (código vencido, sesión revocada/expirada): `401`;
  body distinto con la misma clave: `409`.
- El canje debe estar **ligado a origen + nonce (o PKCE)**: la creación de la sesión
  acepta un `code_challenge` opcional que, si se envió, hace obligatorio el
  `code_verifier` en el canje (mismo esquema S256 de PKCE). Conectar lo va a usar.
- Documentar en el diseño §4 los compromisos de manejo del código (aplican a ambos
  lados): nunca en localStorage ni en logs ni en URLs (ya cumplido: canje por POST),
  TTL ≤ 5 min (ya cumplido), respuesta del visor con `Referrer-Policy: no-referrer`,
  y `session_token` únicamente en memoria del navegador.

### CM-4 · ~~Evidencia congelada al firmar: Opción A (copia en Conectar)~~ — **SIN EFECTO desde el addendum v3** (Conectar ya no firma informes; se conserva como historia)

Decisión de Conectar: al firmar un informe, Conectar **descarga y conserva una copia
inmutable de cada miniatura firmada** en su propio almacenamiento privado (junto con
`key_image_id`, UIDs, `frame_number`, título, comentario, orden dentro del informe,
`thumbnail_sha256` verificado contra la copia y versión del informe). El PDF firmado
incorpora esas copias, no URLs del PACS. Un borrado lógico posterior en el PACS
**no** puede romper un informe firmado porque el informe ya no depende del PACS.

Cambios menores que esto pide del lado PACS:
- Garantizar en el contrato que la miniatura de una key image **no borrada** es
  recuperable vía read-session al momento de la firma y que `thumbnail_sha256` es
  estable (regenerar la miniatura ⇒ nuevo `key_image_id`, nunca mutar una existente).
- Nota en `DELETE /key-images/{id}` y en el diseño §5 bis: el borrado lógico es
  solo para informes aún no firmados; la evidencia firmada vive en Conectar
  (Opción A adoptada; no hace falta el manifiesto de la Opción B).

### CM-5 · `ViewerSessionRequest`: quitar la ambigüedad del `required`

El schema declara `required: [user]` a nivel raíz y el XOR por `oneOf`, pero los
`not: { required: [...] }` no impiden un body con ambas claves si un validador solo
mira `required`. Pedido concreto: agregar `unevaluatedProperties: false` o, más
simple, mover `user` y `purpose` dentro de cada rama del `oneOf` con
`additionalProperties: false`, y declarar explícitamente en la descripción que
`order_id` y `study_instance_uid` presentes a la vez ⇒ `422` aunque el JSON pase
el schema. (Es endurecimiento del contrato, no cambio de comportamiento: el
diseño ya lo dice.)

### CM-6 · `RedeemResponse`: agregar `session_id`

Para correlacionar auditoría (Conectar registra `audit_id`/`session_id` al crear la
sesión) el canje debe devolver también `session_id`. Agregarlo como requerido en
`RedeemResponse`.

---

## Compromisos del lado Conectar (no requieren cambios del PACS)

1. Generar y persistir la secuencia de `accession_number` (tabla/secuencia propia,
   columna única e inmutable en `study_orders`).
2. ~~Congelar evidencia al firmar (CM-4)~~ **(sin efecto en v3)** — reemplazado por:
   archivar copia inmutable del **PDF firmado** que entrega el PACS, verificando
   `pdf_sha256` al descargarlo.
3. Cliente del canje: `redeem_code` solo en memoria, canje por POST inmediato,
   PKCE cuando el contrato lo incorpore, sin logs del código ni del token.
4. Webhook receptor `/api/pacs/webhook/eventos` con validación `signature_ts`
   (±300 s), idempotencia por `event_id` y doble secreto durante rotación.
5. Órdenes: nunca reintentar un upsert que cambie identidad; ante 409 de identidad,
   anular y re-emitir orden nueva.

## Pendientes operativos (sin cambios de contrato)

- URL receptora definitiva del webhook y primera rotación de secreto: se coordinan
  al activar (después de la migración S3 y su conciliación).
- `PACS_WORKSPACE_ENABLED` (Conectar) y `PACS_INTEGRATION_ENABLED` (PACS) siguen
  en false. Nada se implementa ni publica hasta la aprobación v1 y el fin de la
  migración DICOM→S3.
