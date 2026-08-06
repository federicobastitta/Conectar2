# Klinicos (ACEAPP) — Flujo administrativo real

Fuente: transcripción de las capacitaciones oficiales "Usuarios Administrativos" Parte 1 (61 min) y Parte 2 (29 min) provistas por el usuario. Sirve para calibrar el robot RPA (`klinicos-robot.ts`).

## 1. Login y contexto de sesión

1. Login con `nombre.apellido` (todo minúscula, sin espacios). Primera vez: se repite el usuario como contraseña → el portal fuerza personalizar contraseña (6–10 caracteres, con minúscula + mayúscula + número). Si se olvida, el soporte solo puede "blanquearla" (volver al paso inicial).
2. Tras el login hay una **pantalla intermedia obligatoria** donde se selecciona:
   - **Establecimiento** (puede haber más de uno habilitado)
   - **Sector** (ej. "Administración" / "Admisión" — el nombre varía por establecimiento)
   - **Puesto de trabajo** (número; un puesto por persona logueada)
   - **Especialidad**: se deja vacía (solo profesionales)
3. Recién ahí se entra al sistema. El menú lateral depende de los roles del usuario. Todo queda auditado por usuario.

Implicancia robot: después del POST de login hay un segundo paso de selección establecimiento/sector/puesto que hay que enviar antes de operar. "Cerrar y salir del puesto" libera el puesto de trabajo.

## 2. Flujo de atención administrativa (el circuito del robot)

Orden canónico: **buscar paciente → (si no existe: carga MANUAL por recepción/administración — el robot NUNCA crea pacientes) → ingreso ambulatorio → detalle de la atención → cargar prestaciones → token → autorizar → realizar → adjuntar documentación → informar → facturable**.

### 2.1 Buscar / crear paciente

> **Regla del robot (decisión del usuario, jul 2026):** el robot NO crea pacientes en Klinicos. Si el DNI no existe, el trabajo falla con mensaje claro y el alta la hace a mano un recepcionista o administrador (pasos de abajo). Lo que sigue describe el procedimiento humano.
- Siempre se busca primero por **DNI** en Pacientes → búsqueda común (la base es compartida entre establecimientos; el paciente puede ya existir).
- Si no existe → botón **Nuevo**. Con obra social Yoma: se ingresa DNI + sexo y el servicio de Yoma autocompleta los datos ("Buscando datos en Yoma" → "Afiliado encontrado"). Verificar que la obra social figure abajo; si el servicio está caído se carga a mano y hay que apretar **Agregar** para que la OS quede asociada. Teléfono es obligatorio. Guardar.
- Error típico "afiliado inexistente" (cartel rojo): casi siempre es sexo mal cargado.

### 2.2 Ingreso ambulatorio
- Desde el botón azul en la fila del paciente (ingreso directo) o desde un turno programado ("ver reserva" → ingresar, solo visible el día del turno).
- El ingreso pide un **macheo** con cómo se loguea el profesional: **sector + especialidad + profesional** (los tres datos deben coincidir con el login del médico para que el paciente aparezca en su lista de espera).
- **Motivo de consulta es obligatorio.**
- Abajo muestra el estado del afiliado frente a la obra social (verde = activo; rojo = inexistente/inactivo).
- Guardar → cartel verde arriba y queda parado en el **detalle de la atención**.

### 2.3 Prestaciones (bonos) — en el detalle de la atención
Tipos: **Consulta (C), Práctica (P), Alta complejidad, Odontología, Odontología imágenes, Psicología** (+ Nutrición que combina consulta y práctica).

- **Consulta**: si el profesional del ingreso es médico, el bono de consulta **se crea automáticamente** al ingresar. Solo hay que pedirle el **token** al paciente (lo genera desde su app), cargarlo y apretar el **tilde de autorizar** → el sistema valida contra Yoma ("Yoma informa OK") → pasa directo a **facturable**. (Licenciados —psicología, nutrición, odontología— NO generan consulta automática.)
- **Práctica** (el caso del robot): Nueva prestación → Práctica.
  - **Prescriptor**: si la orden fue generada dentro del sistema se elige la orden ("seleccione una orden"). Si el paciente trae orden en papel → prescriptor **"externo al establecimiento"**: nombre + especialidad + **matrícula** (deben coincidir con el sello/firma de la orden).
  - **Efector**: por defecto el profesional del ingreso.
  - **Diagnóstico general**: código directo o buscador por texto.
  - **Práctica**: buscador por texto (ej. "radiografía de hombro").
  - Guardar → "Prestación creada correctamente" (carteles siempre arriba a la derecha).
  - Token + tilde → si no pega contra topes mensuales/anuales, queda **"autorizada por realizar"**.
  - Botón **Realizar** → pregunta qué profesional informa → confirmar → estado **"esperando informe"**.
  - **Adjuntar documentación** (herramienta al final de la línea): la **orden médica** se carga a nivel prestación (general).
  - El **informe** se carga POR PRÁCTICA (cada código individual): desplegar la prestación → "esperando informe" → **Informar** → adjuntar archivo → estado **informado** → la prestación pasa a **facturable**.
- **Alta complejidad**: solo en establecimientos autorizados. Igual que práctica + datos extra (urgente, CUC, motivo si internado) y documentación previa obligatoria (orden + planilla de alta complejidad; opcional CUD, resumen HC). Se suele mandar a autorizar ANTES del turno porque puede ir a auditoría y tardar días. Recién con "autorizada por realizar" se cita al paciente.
- **Odontología**: el token se pide EN EL INGRESO (validez 1 mes, cubre todas las prácticas de esa atención). Requiere odontograma activo (crearlo si no hay) + pieza dental/cara. "Odontología imágenes" (panorámica) sí lleva prescriptor + orden.
- **Psicología**: sin prescriptor; diagnóstico + código (ej. psicoterapia individual) + token.
- **Nutrición**: código EDPNUT001 = consulta común (diagnóstico "consulta"); EDPNUT002–005 llevan patología asociada → se cargan como práctica con orden médica + prescriptor + diagnóstico.

### 2.4 Estados de una prestación
`creada/confirmada → autorizada por realizar → (Realizar) → esperando informe → informado → facturable`
- Se puede volver al detalle de atención en cualquier momento desde solapa **Prestaciones** (filtros por DNI, apellido, estado, tipo) para completar documentación pendiente.

### 2.4.1 Anular una prestación (capacitación de Federico, 05/08/2026)

Caso de uso: quedó una prestación de consulta CONFIRMADA sin bono (ej. token rechazado en guardia virtual) y no corresponde facturarla — se anula.

1. Menú **Prestaciones → Prestaciones** (listado).
2. En el campo **"Buscar..."** (arriba de la columna N° de Bono) poner el **DNI del paciente**.
3. En la fila de la prestación, botón **llave inglesa** (al final) → desplegable con *Detalle de la atención*, *Descargar Copago*, *Descargar Bono*.
4. **"Detalle de la atención"** → abre la pantalla de detalle (`/atencion/detalle/atencionesEstados/{guid}`, la misma que usa el robot).
5. Ahí, botón **"Anular prestación"**. **No se carga motivo.**
6. La prestación queda en estado **ANULADO** (rojo) en el listado, con la fecha de anulación.

Caso real verificado: C-2026-202968 (Frontini, token rechazado 05/08/2026) anulada por Federico; la consulta buena con bono 18596757 quedó aparte.

## 2.5 Receta electrónica IOMA (capacitación aparte)

Flujo del médico dentro de Klinicos:
1. Paciente ingresado → atender → crear/abrir un **problema de atención** → generar una **evolución** (con diagnóstico, ej. cefalea).
2. Dentro de la evolución, apartado de **órdenes** (imágenes/laboratorio) y abajo el de recetas → botón **"Nueva IOMA"**.
3. Completar: diagnóstico, tratamiento normal o prolongado, medicamento (buscador, ej. ibuprofeno), presentación, indicaciones, observaciones, cantidad de envases, dosis, unidad y duración.
4. Con el tilde **"enviar receta electrónica"** activado, al Guardar (confirma "¿está seguro?") la receta **aparece directamente en la app de IOMA del paciente**.
5. También se puede crear fuera de una evolución: tocar el problema → herramienta "agregar orden o receta" sobre una evolución previa.

Implicancia Conectar: si el robot (o un médico vía Klinicos) genera la receta ahí, el paciente la recibe en su app IOMA sin pasos extra — integración valiosa para el circuito de recetas de Conectar.

## 3. Turnos y agendas (Parte 2 — contexto)

- Menú Turnos: Configurar agendas / Licencias / Planillas diarias / Gestión de turnos.
- Agendas por "especialidad y profesional" (habitual) o "especialidad y puesto de trabajo" (ej. extracciones). Config: vigencia, días, horario, períodos por minutos o cantidad de turnos, espontánea vs programada, telemedicina, días de anticipación, turnos reservados del profesional (azules), múltiples pacientes por horario, color. Conflictos de solapamiento se avisan al guardar.
- Gestión de turnos → turnos vigentes: filtrar por profesional/especialidad; **Reservar** al final de la línea → buscar paciente → motivo de consulta obligatorio + email o teléfono → guardar → imprimir ticket.
- El filtro de estados por defecto NO muestra reservados (solo libres y "a completar") — hay que agregar el estado para verlos.
- Acciones: **Mover** (libera el original), **Reasignar** (anula el original — caso profesional que no viene), **Cancelar** (libera; irreversible), **Anular** turnos libres en lote, **Sobreturno** (amarillo). "Ver reserva → Ingresar" solo el día del turno.
- **Licencias**: particulares (por agenda, desde la herramienta de la fila) o generales (todo el establecimiento, menú Turnos → Licencias). Bloquean los libres pero siguen mostrando los reservados con advertencia para gestionarlos.

## 4. Checklist de calibración del robot

- [x] Login real — CALIBRADO (jul 2026): POST a `/Login?ReturnUrl=%2F` con `UserName`/`Password` + antiforgery; OK → 302 a `/Login/SeleccionarSector`.
- [x] Pantalla Crear Prestación (Práctica) — CALIBRADA por video (31/07/2026, ECG): `/ordenPrestacion/create/{atencionId}/3`; prescriptor interno autocompleta matrícula; efector precargado del ingreso; CIE-10 obligatorio ("Debe indicar un diagnóstico general…"); prácticas por código exacto (select2 mín. 2 caracteres, ej. `170101 | ELECTROCARDIOGRAMA…`); Guardar → redirect + "Prestación creada correctamente", fila `P-AAAA-NNNNNN` CONFIRMADO. Ver `docs/rpa-klinicos-informe-diferencias.md` y `klinicos-prestaciones.ts`.
- [x] Pantalla Prestaciones → Autorizar — CALIBRADA sin cargas reales (31/07/2026): grilla `Tipo-Año-Número · Profesional · Estado · Token(input+tilde) · N° Bono`; regla fail-closed: EXACTAMENTE una CONFIRMADA sin bono; tras autorizar releer y exigir bono. Endpoints AJAX exactos del POST se confirman en etapa 4 (asistido).
- [x] Paso post-login (contexto) — CALIBRADO: POST del form completo (incluidos hidden avatar/nombres/tipoUsuario con valores reales; vacíos = logout) con sector ADMINISTRACIÓN resuelto vía AJAX y puesto/especialidad `-1`; OK → `/GestionTurnos/ListadoTurnos`.
- [ ] Ingreso ambulatorio: sector + especialidad + profesional (macheo) + motivo de consulta obligatorio.
- [x] Prestación práctica: prescriptor externo (nombre/especialidad/matrícula) — IMPLEMENTADO: campos matrícula y especialidad por prescriptor (DB + API + UI de configuración); el worker los pasa al robot.
- [x] El token lo aporta el paciente desde su app — DEFINIDO: el paciente se lo da a la recepcionista, que lo carga en la bandeja Klinicos de Conectar (campo "Token de autorización IOMA" del trabajo). Es el ÚNICO paso humano del circuito; el robot lo usa para autorizar y seguir la cadena.
- [x] Prestación de CONSULTA en CONSULTORIOS — CALIBRADA (02/08/2026, lectura en vivo sobre la atención Frontini): el ingreso ambulatorio NO crea el bono de consulta solo (la grilla quedó vacía); el robot postea el form precargado de `/ordenPrestacion/create/{IdAtencionACobrar}/1` (ítem 420101 CONSULTA MEDICA). OJO: el create usa el id NUMÉRICO `data-idAtencionACobrar` del detalle (no el GUID), y la grilla de prestaciones es AJAX (`POST /ordenPrestacion/porIdAtencionesEstados`, DataTables con `columns[0].search.value` = GUID) — el HTML del detalle no trae filas. Si el paso falla, el trabajo queda en error con el link directo a la atención para confirmarla a mano.
- [ ] Después de autorizar: Realizar → confirmar profesional que informa → adjuntar orden (nivel prestación) → Informar por práctica (nivel código) para llegar a facturable.
- Credenciales KLINICOS_USUARIO/KLINICOS_PASSWORD vigentes y verificadas contra el portal (login + contexto OK).
- Próximo: calibrar búsqueda de paciente por DNI, ingreso ambulatorio y prestación (hoy solo dry-run).
