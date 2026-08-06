# Video: cómo cargar una consulta de Clínica Médica en KLINICOS (31/07/2026)

Fuente: `attached_assets/como_cargar_una_consulta_con_clinica_medica_1785541644893.mp4`
(55 s, sin audio — captura de pantalla del portal real, usuaria `florencia.gonzalez`,
contexto ADMINISTRACIÓN, POLICONSULTORIO DIAGNOSTICAR). Frames extraídos y verificados.

## Circuito observado, paso a paso

1. **Gestión de turnos → Listado** (`/GestionTurnos/ListadoTurnos`)
   Filtros: fecha 31/07/2026, todas las agendas, tipo "Programados", estados
   `Libre` + `A completar`. Grid con Fecha/hora, Agenda (nro.), Sector CONSULTORIOS,
   Especialidad CLINICA MEDICA, Profesional/Puesto, Estado. Botón "Excel".

2. **Pacientes → Búsqueda** (`/paciente`)
   Campos: Documento único, N° HC, Primer apellido, Primer nombre. Se busca por DNI
   (4849369 → FRONTINI, Hilda).

3. **Nueva atención** (`/atencion/nuevo/{guid}?formaIngreso=1&buscarOS=true&returnUrl=/paciente`)
   Izquierda: Detalle del paciente (DNI, sexo, F. nac., HC `1944-00020329/1`, badge
   PERMANENTE, Obras Sociales: IOMA con afiliado y tipo OBLIGATORIO).
   Derecha: **Ingreso AMBULATORIO** con:
   - `Consulta por` (texto libre; en el video: "control")
   - `Edad aparente` (autocompletada: 82 AÑOS)
   - `Responsable` ("No presenta")
   - `Sector/Servicio` → **CONSULTORIOS** (opciones: ADMINISTRACIÓN, APOYO, AUDITORIA,
     CONSULTORIOS, ENFERMERIA, IMAGENES, LABORATORIO…)
   - `Especialidad` → **CLINICA MEDICA**
   - `Profesional` → ANDRADA, CAMILA
   - `Puesto de trabajo` → se dejó "Seleccione..." (NO es obligatorio)
   - `Obra Social a facturar` → `OS902001 - O.S.P. BUENOS AIRES (IOMA) (IOMA)`
     (al elegirla aparece panel verde con afiliado/fecha nac./plan)

4. **Confirmación**: toasts verdes "**Se ingresó el paciente con éxito**" y
   "**Se ha creado una prestación**" → redirige a
   `/atencion/detalle/atencionesEstados/{guid}`.
   Cabecera: Forma de ingreso **Guardia** + fecha/hora, Consulta por, Sector, Especialidad
   + profesional, Obra Social.

5. **Token — SE CARGA EN LA MISMA GRILLA de Prestaciones del detalle de atención**
   Grid "Prestaciones: O.S.P. BUENOS AIRES (IOMA)" con columnas:
   `Tipo-Año-Número` (ej. C-2026-198672) · `Profesional` (con MP) · `Estado` ·
   `Token` (input + botón ✔ azul) · `N° Bono` · `Acciones`.
   - La prestación nace en estado **CONFIRMADO** (azul).
   - Se tipea el token (6 dígitos, ej. 516377) y se aprieta el ✔.

6. **Resultado token OK**: toast verde "**IOMA informa: OK**", el estado pasa a
   **$ FACTURABLE** (verde) y aparece el **N° Bono** (ej. 18405784). Ese bono es la
   prueba real de autorización.

## Implicancias para el RPA (calibración)

- **La validación del token para consultas NO pasa por el menú Prestaciones→Autorizar**
  del manual: se hace inline en el detalle de la atención recién creada (input Token + ✔).
  El flujo del manual (filtrar por fecha+DNI en Prestaciones) sirve para retomar casos ya
  ingresados; para el circuito normal la atención recién creada YA muestra su prestación.
- Criterio de éxito verificable: toast "IOMA informa: OK" **y** estado $ FACTURABLE
  **y** N° Bono visible (releer la grilla, como exige el manual).
- La prestación de consulta se autogenera al crear el ingreso ("Se ha creado una
  prestación") — no hay que crearla a mano para consultas.
- `Puesto de trabajo` puede quedar vacío; `Obra Social a facturar` con código
  `OS902001` para IOMA.
- La "Forma de ingreso" quedó como **Guardia** (probablemente por formaIngreso=1).
- Coincide con el flujo ya calibrado en `docs/klinicos-flujo-administrativo.md` y con lo
  implementado en `integraciones/klinicos-robot.ts` (login → buscar por DNI → ingreso
  ambulatorio → detalle → prestación). El paso NUEVO que faltaba calibrar es el punto 5-6
  (token inline + bono).
