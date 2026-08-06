# RPA KLINICOS — Informe de diferencias manual ↔ código (Etapa 1)

Fecha: 31/07/2026 · Tarea 189 (etapas 1–3)

**Fuentes usadas:** la documentación funcional obligatoria provista (resumen
oficial del "manual de facturacion.pdf" v1.0 30/07/2026 — el PDF en sí NO fue
subido al proyecto, se pidió y quedó pendiente), la spec del módulo RPA, el
video "como cargar un ECG en Klinicos" (31/07/2026), las capacitaciones
transcriptas (`docs/klinicos-flujo-administrativo.md`) y el código actual
(`klinicos-robot.ts`, `klinicos-worker.ts`, `klinicos-cola.ts`, esquema
`lib/db/src/schema/klinicos.ts`).

**Decisiones del usuario (31/07/2026):**
- Arquitectura: automatizador INTERNO de Conectar (se retoma `klinicos-robot.ts`).
  El Robot externo (ROBOT_API_URL) sigue solo para la validación de token ya
  productiva; no se le delega la carga de prestaciones.
- Token completo: se guarda en Conectar (pedido de la clínica, ya en prod en
  `consultas_token.token_completo`), pero el RPA solo usa/loguea la versión
  enmascarada. NO se reutiliza para validaciones posteriores: si KLINICOS lo
  rechaza, se avisa y el operador carga a mano por KLINICOS.

## Tabla de diferencias

| # | Regla del manual | Categoría | Detalle |
|---|---|---|---|
| 1 | Operar KLINICOS por las mismas pantallas que un operador, con usuarios propios | **Implementada** | El robot usa las pantallas reales del portal (login, sector, pacientes, ingreso) vía HTTP con credenciales propias (`KLINICOS_USUARIO/PASSWORD`). Nota técnica: opera los mismos forms/endpoints de las pantallas pero sin navegador (fetch + cookies), equivalente funcional. |
| 2 | No emitir facturas ni liquidaciones | **Implementada** | El robot no toca Facturación IOMA; se limita a ingreso/prestación/token/documentación. |
| 3 | Principio fail-closed ante ambigüedad | **Parcial → reforzada en esta etapa** | Ya era fail-closed en: DNI sin coincidencia exacta (nunca usa otra fila), robot nunca crea pacientes, POST previo con resultado desconocido no se re-envía. Se agrega: selección de prestación a autorizar exige EXACTAMENTE una candidata (0 o >1 → revisión) y exclusión Doppler/resonancia. |
| 4 | Validar token vía Prestaciones → filtrar fecha+DNI → 1 sola CONFIRMADA sin autorización → Autorizar → releer → bono | **No implementada → calibrada en simulación (etapa 2-3)** | Nuevo `klinicos-prestaciones.ts`: parseo de la grilla de prestaciones del detalle de atención, selección fail-closed de la candidata única y plan de autorización. La ejecución real queda para la etapa 4 (MVP asistido). |
| 5 | 0 o >1 candidatas → no adivinar | **Implementada (nueva)** | `elegirPrestacionParaAutorizar`: si no hay exactamente una CONFIRMADA sin bono, el caso va a revisión con el motivo explícito. |
| 6 | Consultas de especialidad: código 420101 + profesional administrativo configurado | **Decisión de negocio pendiente / contradictoria** | Hoy el bono de consulta lo AUTOGENERA KLINICOS al crear el ingreso con el médico real (capacitación oficial + video). El manual pide 420101 con un profesional administrativo. No se cambió nada: requiere decisión (¿en qué casos se carga consulta a mano con 420101?). |
| 7 | Prácticas: solo código exacto del nomenclador y combos aprobados; sin equivalencia única → revisión | **Implementada** | El catálogo (`klinicos_practicas.codigos` + `codigo_envio`) y las reglas de equivalencia cumplen. Reforzado (01/08/2026): `machearOpcion` ahora exige coincidencia exacta o TODAS las palabras en exactamente UNA opción (empate/parcial → null → revisión), y el fallback de `resolverPractica` por nombre contenido solo acepta EXACTAMENTE una candidata (0 o >1 → sin práctica, revisión desde la bandeja). |
| 8 | Eco Doppler y resonancias: carga manual (decisión 22/07/2026) | **Implementada (nueva)** | `esPracticaExcluida` (DOPPLER / RESONANCIA / RMN / RNM) corta el trabajo ANTES de ejecutar el robot: queda cancelado con mensaje de carga manual. |
| 9 | Validaciones de token con prioridad absoluta sobre cargas documentales | **No implementada** | La cola procesa FIFO sin prioridades. Pendiente para etapa 4+ (pool con prioridades). |
| 10 | Nunca guardar el token completo; solo enmascarado + huella | **Contradictoria — resuelta por decisión del usuario** | La clínica pidió guardarlo y ya está en prod (`consultas_token.token_completo`, `klinicos_trabajos.token_autorizacion`). Decisión 31/07/2026: se guarda en Conectar; el RPA solo expone la versión enmascarada en logs, pasos y payloads de simulación (`enmascararToken`). Sin reuso para validaciones posteriores; rechazo → aviso + carga manual. |
| 11 | Un token nunca se consume dos veces; ante reintento consultar primero el resultado | **Parcial** | Para el ingreso ya existe la guarda `post_intentado_en` (un POST con resultado desconocido nunca se repite). Para la autorización de token se aplica el mismo patrón en el plan (releer la grilla antes de reintentar); la ejecución real es etapa 4. |
| 12 | Timeout/respuesta incierta ≠ rechazo, nunca habilita reenvío automático | **Implementada** | Guardas anti-duplicado del robot + mapeo TECHNICAL_ERROR/TIMEOUT del Robot externo que no son denegaciones. |
| 13 | Documentación: solo informes firmados, matrícula contra registro, 1 informe por práctica, hash anti-duplicado, descripciones neutras | **Parcial** | Existe el circuito de informe PDF (generado/subido) por trabajo. Falta: hash del PDF, control "1 informe por práctica" (hoy es por trabajo), validación de matrícula contra el registro de firmas al subir. Pendiente etapa 4 (la carga documental real todavía no se automatiza). |
| 14 | Concurrencia: empezar con 1 sesión; contradicción interna del manual (1 usuario/sesión vs 2 sesiones/usuario y 8 paralelas) | **Implementada + decisión pendiente registrada** | El worker es secuencial (1 trabajo por vez, 1 sesión). La contradicción del manual queda registrada como decisión pendiente: NO habilitar concurrencia hasta resolverla. |
| 15 | Modos: simulación / asistido / automático + parada de emergencia | **Parcial → simulación completada en esta etapa** | Simulación = `KLINICOS_DRY_RUN=1` (default). Ahora además PERSISTE lo que habría enviado (`simulacion_payload`) sin confirmar nada. Asistido, automático y parada de emergencia: etapas 4–6. |
| 16 | Auditoría append-only e inalterable | **Parcial** | Hay trazabilidad por trabajo (`pasos_completados`, intentos, errores, logs estructurados) pero se sobreescribe por reintento; no hay tabla de auditoría append-only dedicada. Pendiente. |
| 17 | Centro de Control (tokens en proceso, bono, latencia, casos frenados, errores consecutivos, actividad por hora…) | **Parcial** | Existen la bandeja de trabajos y `/integraciones/klinicos/estado` (contadores). Métricas finas (latencia, actividad por hora, sesiones) pendientes para la etapa 5 (medición). |
| 18 | Diagnósticos CIE-10 | **Implementada** | Reglas fijas motivo→CIE10 primero; IA solo de respaldo y revisable en bandeja. Reforzado (01/08/2026): el código sugerido por la IA se valida contra el catálogo aprobado (`klinicos_reglas_cie10` activas); fuera del catálogo → queda null (pendiente de revisión), nunca se envía un código inventado. |
| 19 | No CAPTCHA, no coordenadas/OCR, no eludir controles | **Implementada** | El robot usa forms/endpoints de las pantallas; si aparece un CAPTCHA el login simplemente falla y el caso queda en error para intervención humana. |
| 20 | El robot NUNCA crea pacientes | **Implementada** | Coincidencia estricta de DNI; si no existe, el trabajo falla con mensaje para carga manual. |

## Calibración de la pantalla Prestaciones → Autorizar (Etapa 2, sin cargas reales)

Fuente: video "como cargar un ECG en Klinicos" (31/07/2026) + capacitaciones.
Vale para ECG y cualquier práctica de un solo código.

1. **Detalle de atención** (`/atencion/detalle/atencionesEstados/{guid}`):
   grilla "Prestaciones: {obra social}" con columnas
   `Tipo-Año-Número · Profesional (MP) · Estado · Token · N° Bono · Acciones`.
   La consulta autogenerada aparece como `C-AAAA-NNNNNN` en estado CONFIRMADO;
   cada fila tiene un input de Token + tilde (✓) para autorizar.
2. **Nueva Prestación → Práctica** navega a
   `/ordenPrestacion/create/{atencionId}/3` (el `3` es el tipo Práctica).
3. Form "Crear Prestación": Fecha y Tipo de orden precargados (radio Sala);
   datos del paciente y OS/plan/afiliado bloqueados.
   - **Profesional prescriptor**: buscador select2 (mín. 1 carácter). Elegir un
     profesional interno autocompleta prescriptor + especialidad + tipo de
     matrícula (PROVINCIAL) + matrícula. Con orden en papel va "externo al
     establecimiento" con nombre/especialidad/matrícula a mano.
     "Seleccione una orden" queda vacío si no hay orden del sistema.
   - **Profesional efector**: Sector/Servicio + Profesional + Especialidad,
     precargados con los del ingreso.
   - **Diagnóstico general**: buscador por texto (mín. 1 carácter) o código
     directo; completa `Cod. diagnóstico` (ej. I10). OBLIGATORIO: si falta,
     el portal devuelve "Debe indicar un diagnóstico general o asociar cada
     práctica con un diagnóstico en particular."
   - **Prácticas**: select2 (mín. 2 caracteres), busca por código exacto,
     ej. `170101 | ELECTROCARDIOGRAMA EN CONSULTORIO (CON O SIN PRUEBA DE
     ESFUERZO)`. Una fila por código.
4. **Guardar** → redirect al detalle de atención + toast verde "Prestación
   creada correctamente"; la nueva fila `P-AAAA-NNNNNN` queda CONFIRMADO,
   sin token ni bono.
5. **Autorizar** (regla del manual): con EXACTAMENTE una CONFIRMADA sin
   autorización, cargar el token en la fila y tildar → releer la grilla →
   token aceptado SOLO si aparece N° de bono o confirmación real. 0 o >1
   candidatas → revisión humana (nunca adivinar).

Endpoints AJAX exactos del POST de creación y de la autorización se terminan
de calibrar con credenciales en la etapa 4 (asistido); hasta entonces todo
corre en modo simulación (se persiste el payload, no se confirma nada).

## Verificación contra el PDF real del manual (01/08/2026)

El PDF (`attached_assets/manual_de_facturacion_1785544761006.pdf`, v1.0 30/07/2026) fue
subido y leído completo. Confirma el informe de arriba, con estas precisiones nuevas:

- **Regla 6 se aclara a medias**: el manual (§3) confirma que para consultas comunes el
  ingreso ambulatorio autogenera la prestación CONSULTA en CONFIRMADO (igual que el video)
  y recién ahí se valida el token. La diferencia que queda pendiente es SOLO el
  profesional: el manual pide el "profesional administrativo configurado" (y código
  420101), la capacitación/video usan el médico real de la atención.
- **Órdenes sin PDF real — CONTRADICCIÓN entre documentos**: el manual (§4) dice que si
  no hay orden real el robot "genera una orden con prescriptor firmado y CIE-10
  determinístico", pero la documentación funcional obligatoria (documento posterior)
  prohíbe generar documentación clínica de forma autónoma y manda derivar al circuito
  estructurado de órdenes de Conectar. Rige la regla más restrictiva (no generar) hasta
  decisión expresa. Nota: Conectar ya tiene generación de órdenes manuscritas con firma —
  usarla para el RPA requiere la confirmación con trazabilidad que exige el documento.
- **Concurrencia (regla 14) detallada**: hasta 4 usuarios propios, rol principal rota por
  día; pico 8–20 h hasta 2 sesiones por usuario (máx. 8), fuera de pico 1 por usuario,
  sesiones precalentadas. La contradicción "un usuario por sesión / nunca en dos pantallas
  a la vez" vs "2 sesiones por usuario" sigue sin resolver → se mantiene 1 sesión total.
- El manual describe la arquitectura del Robot EXTERNO (webhooks de Conectar, polling a
  PHIR cada 5', Pulso diario). Por decisión del 31/07/2026 la carga la hace el
  automatizador interno; el manual vale como fuente FUNCIONAL (reglas y controles), no
  como arquitectura obligatoria.

## Pendientes que bloquean etapas 4+

1. ~~Subir el "manual de facturacion.pdf" real~~ — subido y verificado el 01/08/2026.
2. ~~Decisión regla 6~~ — **RESUELTA (01/08/2026, decisión del usuario)**: las consultas
   se cargan con el **profesional administrativo configurado y código 420101**, como dice
   el manual (no con el médico real del video/capacitación). Falta definir en Secrets/
   configuración QUIÉN es ese profesional administrativo en Klinicos.
2b. ~~Decisión órdenes sin PDF real~~ — **RESUELTA (01/08/2026, decisión del usuario,
   corregida el mismo día)**: si no hay orden real, el robot **genera la orden manuscrita
   de Conectar SIN aprobación previa**; la revisión la hace después un operador en
   Klinicos. Debe quedar trazado en la auditoría que la orden fue autogenerada.
3. Resolver contradicción de concurrencia del manual (regla 14).
4. Credenciales KLINICOS en Secrets para calibración en vivo (hoy no están).
5. Auditoría append-only y prioridades de cola (reglas 9 y 16).
