---
name: ARM v2 por módulos
description: Reconstrucción del robot Klinicos módulo a módulo con aprobación del usuario entre pasos; estado y calibraciones logradas.
---

Regla de trabajo: el usuario aprueba cada módulo ANTES de ejecutarlo; presentar selectores/plan, esperar autorización, ejecutar, informar y FRENAR. No adelantarse ni encadenar módulos.

Módulos completados (código en `artifacts/api-server/src/arm/`):
1. **Sesión** (`sesion.ts`) — iniciar/verificar. SESSION_ACTIVE = enlace "Cerrar sesión" visible; SESSION_EXPIRED = form UserName+Password; nunca por URL/cookies.
2. **Búsqueda de paciente** (`paciente.ts`) — grid `/paciente/grid/{dni}/null/null/null`, cuenta coincidencias EXACTAS (filter, no find) para UNIQUE vs MULTIPLE; DNI siempre enmascarado en registros (…últimos 3).
3. **Ingreso ambulatorio** (calibrado 2-ago-2026, aún como script, no en arm/): GET `/atencion/nuevo/{idPaciente}?formaIngreso=1&buscarOS=true` → tomar defaults con camposDeForm y tocar SOLO motivo, idSectorDestino, idEspecialidadDestino, idProfesionalDestino, IdObraSocialSeleccionada (verificar IOMA antes). POST urlencoded al action del form; éxito = redirect 3xx a `/atencion/detalle/atencionesEstados/{guid}`. **Verificación de identidad**: el DNI visible está en `name="numeroDocumento" value=`, FUERA del bloque AtencionForm — no buscar el DNI dentro del form.

**Why:** el circuito viejo de "orden de prestación" cargó mal una consulta (la consulta la crea el ingreso ambulatorio, no /ordenPrestacion/create). El usuario exige fail-closed: 0 o >1 coincidencias, texto no exacto o pantalla distinta → MANUAL_REVIEW sin guardar.

Hallazgos 2-ago-2026 (pendiente resolver): TODAS las atenciones del día muestran "Forma de ingreso: Guardia" (incluso las creadas por la opción "Ingreso ambulatorio", manuales y del robot). Las creadas a mano por el usuario en la UI aparecen CON la prestación de consulta C-… ya en la grilla; las del robot quedan SIN prestación. Descartado como causa: formato multipart/urlencoded, puesto de trabajo del contexto (ADMINISTRACIÓN no tiene puestos: `/puestotrabajo/traerPuestosDeTrabajoPorIdSector` da []), usuario (robot y UI usan la misma cuenta), popups post-guardar (el usuario confirma que solo aprieta Guardar) y los dos AJAX previos al submit del navegador — POST `/paciente/obra-social-validar` {idPaciente,idObraSocial} y POST `/ordenPrestacion/validarDatosObraSocialPaciente` {idPaciente,idObraSocial,grupoNomenclador:"IOMA",OSToken:"",tipoEspecialidadDestino} (recuadro verde; responde Status OK) — replicados y la grilla sigue vacía. El GET a /atencion/createOrdenPrestacion/{guid} ("Generar Prestaciones") devuelve 302 sin crear nada, y el detalle NO auto-crea nada al cargar. RESUELTO por el usuario: Klinicos NO genera la fila de la consulta (C-…) si el paciente ya tiene una atención con ese mismo médico — todos los ingresos del robot repetían médico SAEZ sobre atenciones ya existentes del día, por eso la grilla salía vacía; no era un paso faltante del navegador. Regla para el robot: antes del ingreso, verificar si el paciente ya tiene atención abierta/del día con ese médico → si existe, MANUAL_REVIEW sin guardar (fail-closed). Vocabulario del usuario: decir "consultas", no "prestaciones" (se confunde con prácticas). Orden vigente: NO usar "Nueva Prestación" ni "Generar Prestaciones"; alcance = solo ingreso ambulatorio. Ojo: quedaron varias atenciones de prueba de Frontini del 2-ago que anula el usuario a mano.

**Regla del usuario (2-ago-2026): el agente NO anula prestaciones en Klinicos — eso lo hace él a mano, siempre.** No proponer ni intentar anulaciones. Queda solo, si él anula C-2026-199466, revertir la sincronización del trabajo 2209 en prod cuando lo pida. Módulos que faltan: prestación/token/resultado/actualización en Conectar.

## Reglas de Clínica Médica (usuario, 2-ago-2026)
- Mapeo: toda especialidad de Conectar que contenga "clínica" (Guardia Clínica Médica, Clínica Médica Lomas de Zamora, etc.) se carga como CLINICA MEDICA en Klinicos.
- Diagnóstico "Consulta por" rotativo entre 10 fijos (lista `DIAGNOSTICOS_CLINICA_MEDICA` en klinicos-robot.ts).
- Profesional rotativo entre los del select, EXCLUYENDO a CANESTRO y a "USUARIO, Medico" (usuario de sistema; exclusión avisada, sin objeción).
- Rotación determinística: semilla = id del trabajo (idempotente entre reintentos).

## Circuito de consultas (confirmado en vivo 2-ago-2026)
- El ingreso ambulatorio crea SOLO la fila C-… con casillero de token; el robot solo LEE la grilla para confirmar (0 filas → fail-closed "posible atención previa con el mismo médico"; >1 → manual). PROHIBIDO /ordenPrestacion/create para consultas.
- Antes del Guardar se replican los 2 AJAX del navegador (validarDatosObraSocialPaciente con token vacío + /paciente/obra-social-validar; error en el segundo → fail-closed).
- Prueba punta a punta desde Conectar OK: C-2026-199476 (VILTE), sin token. KLINICOS_DRY_RUN es env por entorno: dev=1, prod=0.
- Atención "muerta": si TODAS las filas de la atención están ANULADAS, autorizarConsultaConToken devuelve el sentinel "Sin atención creada..." para que Validar Token cree un ingreso nuevo; el viejo camino de auto-reparación con /ordenPrestacion/create al validar token se eliminó (fail-closed).
- Autorización del token = réplica del navegador: GET /ordenPrestacion/autorizar-prestacion?idOrdenPrestacion=<Id fila>&token=... (el POST {id,OSToken} daba 500 en Klinicos antes de llegar a IOMA). La respuesta trae data JSON con IsSuccessStatus/Mensaje: solo IsSuccessStatus=false es rechazo explícito; guardar respuesta sanitizada como evidencia.
