---
name: Klinicos carga real — lecciones
description: Qué destapó la primera carga real del robot (ingreso ambulatorio) y las guardas de reintento.
---

# Primera carga real del robot Klinicos (ingreso ambulatorio)

## Circuito 100% automático desde Validar Token (02/08/2026)
Si al validar el token no hay atención del robot, `cargarYAutorizarAutomatico` (sala_espera) encadena: encolar (con advisory lock por turno anti doble-inserción; encolarTrabajoKlinicos devuelve el id canónico) → copiar token → simular → auto-aprobar (`aprobadoPor="automático (validar token)"`, CAS sobre esperando_aprobacion) → carga real (ingreso + prestación 420101 + autorización con token) → bono. Guardas: klinicosHabilitado, KLINICOS_DRY_RUN frena antes de aprobar, reentradas en_proceso/completado devuelven detalle sin tocar nada. Todo verde en UI (cartel, recuadro del dialog y 3 toasts) exige nroBono real.

- El portal exige `idParentescoResponsable` aunque no haya responsable: la simulación (dry-run) nunca lo detecta porque no postea. El robot elige "OTRO" del select del form.
- Rechazo de validación (200 + marcadores `field-validation-error`/`validation-summary-errors`) es DEFINITIVO: no crea nada, y el robot limpia `postIntentadoEn` (guarda `marcarPostRechazado`) para que Reintentar re-postee. Un 200 sin marcadores queda como "resultado desconocido" y sigue bloqueado.
- En CONSULTORIOS el ingreso NO crea el bono de consulta solo (la grilla de la atención queda VACÍA — verificado en vivo ago 2026); el robot ahora lo crea posteando el form precargado de `/ordenPrestacion/create/{IdAtencionACobrar}/1` (420101 CONSULTA MEDICA). Claves calibradas: el create usa el id NUMÉRICO `data-idAtencionACobrar` del detalle (no el GUID) y la grilla de prestaciones es AJAX (`POST /ordenPrestacion/porIdAtencionesEstados`, DataTables, `columns[0].search.value`=GUID) — `parsePrestaciones` sobre el HTML del detalle da [] en vivo; la relectura confiable va contra ese endpoint (recordsTotal). Si el paso falla, el trabajo queda en error con link directo a la atención.
- Nombres de profesionales: la planilla puede diferir de Klinicos (ej. "FRANGI" vs "FRANGIS"); el error lista los profesionales disponibles del sector para corregir la planilla.
- Los trabajos guardan una FOTO de agenda/planilla al encolarse: corregir datos no afecta trabajos ya encolados; hay que cancelar el turno y re-reservar para regenerar el trabajo (la orden vinculada al turno viejo tampoco se readopta: cancelarla y crear una suelta).

**Why:** verificado en producción con la primera carga real exitosa (Holter, agosto 2026).
**How to apply:** al depurar trabajos del robot o extender la carga real, respetar la clasificación definitivo/desconocido antes de tocar las guardas anti-duplicado.

## Recorrido manual observado (ago 2026, capturas del usuario)
Flujo real de una consulta ambulatoria en Klinicos (ACEAPP), usuario administración:
1. Pacientes → Búsqueda → buscar por Documento único → fila del paciente → menú → **Ingreso ambulatorio**.
2. Formulario "Ingreso AMBULATORIO": Consulta por (texto libre), Edad aparente (autocompleta), **Responsable: "No presenta"** (así se resuelve el Parentesco en ambulatorio), Sector/Servicio=CONSULTORIOS, Especialidad, Profesional, Puesto de trabajo (p.ej. "Consultorio 1"), Obra Social a facturar (IOMA muestra panel verde con afiliado/plan/tipo). Guardar.
3. Resultado: toasts "Se ingresó el paciente con éxito" + "Se ha creado una prestación"; pantalla Atención/Detalle con la prestación (Tipo-Año-Número C-AAAA-NNNNNN, estado CONFIRMADO).
4. **El token IOMA se carga en la fila de la prestación**: columna "Token" con input de texto + botón tilde para validar. (N° Bono queda vacío hasta validar.)
Ojo: la "Forma de ingreso" mostró "Guardia" aunque el circuito fue ambulatorio por consultorios.

## Alta de paciente inexistente (aprendizaje ago 2026)
Si la búsqueda por DNI no encuentra al paciente: botón **Nuevo**. Para afiliados IOMA, al poner el DNI Klinicos autocompleta los datos del padrón; lo único que hay que completar a mano es **género y teléfono**.
Detalle UI: el botón azul de la fila del paciente NO se clickea directo; hay que **posarse (hover)** sobre él para que se despliegue la opción "Ingreso ambulatorio".
Campo "Consulta por" (motivo): texto libre, pero el usuario definió una lista estándar para consultas: Dolor de cabeza, Dolor de garganta, Tos, Congestión nasal, Fiebre, Malestar general, Dolor de oído, Dolor de espalda, Dolor de cuello, Dolor abdominal, Náuseas, Vómitos, Diarrea, Mareos, Dolor muscular, Alergia o picazón, Irritación o enrojecimiento de ojos, Ardor o molestias al orinar, Control de presión arterial, Solicitud de receta o certificado médico. El automatizador debería elegir de esa lista (o dejar que recepción la elija).
Campo a campo (confirmado por el usuario): Edad aparente la calcula Klinicos solo (no tocar); Responsable queda VACÍO con el desplegable en "No presenta" para ambulatorio.
Sector/Servicio: SIEMPRE "CONSULTORIOS" para consultas (confirmado por el usuario).
"Con prioridad": SIEMPRE destildado (confirmado por el usuario, ago 2026).
"Puesto de trabajo": poner siempre "Consultorio 1" (confirmado por el usuario, ago 2026).
Especialidades del desplegable Klinicos (capturas parciales ago 2026): ANATOMIA PATOLOGICA, CARDIOLOGIA, CIRUGIA, CLINICA MEDICA, DERMATOLOGIA, ENDOCRINOLOGIA, FLEBOLOGIA, GASTROENTEROLOGIA, GINECOLOGIA, IMAGENES, IMAGENES S/C, MEDICINA GENERAL Y/O DE FAMILIA, ... OFTALMOLOGIA, ONCOLOGIA, ORTOPEDIA Y TRAUMATOLOGIA, OTORRINOLARINGOLOGIA, PEDIATRIA-LACTANTES, REUMATOLOGIA, UROLOGIA. Habrá que mapear las especialidades propias a estos nombres exactos (ej: "Traumatología" → "ORTOPEDIA Y TRAUMATOLOGIA").
Profesional del ingreso (definido por el usuario, ago 2026): se usa SIEMPRE "SAEZ, IGNACIO" para las consultas de clínica médica, sin importar quién atienda en Conectar. Implementado dejando a SAEZ como único activo en la tabla de rotación (klinicos_profesionales_ingreso): reactivar nombres desde la DB restaura la rotación sin tocar código, y cualquier especialidad normalizada que contenga "CLINICA MEDICA" (guardia, sufijos de sede) cae en esa regla. Ojo: en las bases AWS faltaba el índice único (especialidad, nombre) y el seed reinsertaba los 12 nombres en cada arranque; el seed ahora depura duplicados y crea el índice si falta (autocuración idempotente).
Especialidades: NO coinciden con las nuestras (las propias tienen acentos, sufijos de sede "Lomas de Zamora", guardias y prácticas). Hace falta tabla de equivalencias hacia los nombres exactos de Klinicos. Ya existen columnas klinicos_especialidad en profesionales/turneras/turnos para guardar el valor mapeado.
## Primera carga real del robot (02/08/2026) — ÉXITO
Ingreso ambulatorio creado por el robot en Klinicos vía aprobación manual en la bandeja (encolado manual con la llave de autoenvíos apagada). Formulario correcto: CONSULTORIOS · CLINICA MEDICA · SAEZ, IGNACIO · IOMA. Confirmado: la prestación en Consultorios queda para confirmar a mano (klinicosPrestacionCreada=false es esperado). Regla operativa: antes de aprobar una carga real, verificar que la consulta no esté ya cargada a mano en Klinicos (duplicaría el ingreso).

## N° de Bono — regla dura (ago 2026)
El cartel verde dice "PACIENTE VALIDADO · N° de Bono X" SOLO con el bono real que Klinicos devuelve al releer la grilla tras autorizar; nunca se inventa ni se arma — sin bono, el cartel sale sin número. Tras TOKEN_ACCEPTED la API autoriza la prestación sincrónicamente (tope 45 s, sigue en background) si el robot ya creó la atención; el bono queda en klinicos_trabajos y en consultas_token.authorization_number (trazabilidad de la consulta). La guarda anti doble-consumo del token es un compare-and-set sobre autorizacion_post_intentado_en: quien pierde la carrera aborta ANTES de POSTear.

## Validación del token IOMA — éxito (captura ago 2026)
Al validar un token correcto: toast verde arriba a la derecha "**IOMA informa: OK**"; la prestación pasa a estado "**$ FACTURABLE**" (badge verde con fecha); la columna Token queda con el número (6 dígitos, ej. 649648) y se completa **N° Bono** (8 dígitos, ej. 18409856) que antes estaba vacío. Señales de éxito para el robot: estado FACTURABLE + N° Bono presente. Confirmado también acá: especialidad se muestra "CLINICA MEDICA - SAEZ, IGNACIO" (MP 237810). "Forma de ingreso: Guardia" volvió a aparecer en un circuito ambulatorio (parece ser el valor por defecto que muestra Klinicos, no un error de carga). Token inválido (dicho por el usuario, sin captura): toast arriba a la derecha que dice "token inválido"; la prestación NO pasa a FACTURABLE ni se completa N° Bono. Circuito de validación completo: éxito = toast OK + FACTURABLE + N° Bono; rechazo = toast "token inválido".

Profesional del ingreso (definido por el usuario, ago 2026): por ahora se usa SIEMPRE "SAEZ, IGNACIO" para las consultas de clínica médica, sin importar quién atienda en Conectar.
Especialidades: NO coinciden con las nuestras (las propias tienen acentos, sufijos de sede "Lomas de Zamora", guardias y prácticas). Hace falta tabla de equivalencias hacia los nombres exactos de Klinicos. Ya existen columnas klinicos_especialidad en profesionales/turneras/turnos para guardar el valor mapeado.


## Prestación de consulta al validar el token (ago 2026)
La autorización con token se auto-repara: si el trabajo es una consulta (sin códigos, sector no-imágenes) y la prestación no quedó cargada, `autorizarConsultaConToken` la crea antes de autorizar (con pre-chequeo de grilla AJAX para no duplicar si alguien la cargó a mano). Si la carga falla, el trabajo pasa a error visible. Además, `autorizarPrestacionReal` cae a la grilla AJAX (porIdAtencionesEstados) cuando el HTML del detalle no trae filas — en vivo NUNCA las trae, así que sin ese fallback toda autorización moría con "grilla vacía".

## Token en turno distinto al del robot (ago 2026)
Recepción puede crear un turno nuevo (guardia) distinto del turno donde el robot dejó el ingreso. La autorización con token ahora tiene fallback: busca la última atención del MISMO paciente en la MISMA fecha (ingreso creado, con URL, sin bono). **Fail-closed**: si hay más de una candidata, NO se consume el token (detalle pide autorización manual). El camino "token ya aceptado" reintenta la autorización con el token guardado (token_completo), así que tras corregir basta re-validar.

**Guarda de autorización y rechazo explícito (2-ago-2026):** un rechazo explícito de IOMA (IsSuccessStatus=false) libera la guarda `autorizacionPostIntentadoEn` — el resultado se conoce y un token NUEVO debe poder enviarse. Solo "incierto" mantiene la guarda (riesgo de doble consumo). Hay saneo idempotente al arrancar para rechazos viejos que quedaron con la guarda puesta.
