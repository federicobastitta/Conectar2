---
name: Flujo administrativo Klinicos (ACEAPP)
description: Hallazgos de las capacitaciones oficiales que calibran el robot RPA Conectar→Klinicos.
---

Fuente completa: `docs/klinicos-flujo-administrativo.md` (destilado) y `docs/transcripciones/` (texto íntegro de los audios de capacitación).

Login y contexto CALIBRADOS contra el portal real (jul 2026):
- ASP.NET MVC: POST form a `/Login?ReturnUrl=%2F` con `UserName`/`Password` + `__RequestVerificationToken` (hidden + cookie). Credenciales mal → 200 con "usuario o contraseña incorrecta"; OK → 302 a `/Login/SeleccionarSector`.
- Selección de contexto: POSTear el form **con TODOS los hidden** (avatar, nombres, tipoUsuario, etc. con sus values reales) — si van vacíos el portal responde 302 a `/login/logout` y borra la cookie `Klinicos`. Sector se resuelve por AJAX `/sector/porEstablecimiento/selectList`. ADMINISTRACIÓN funciona con puesto/especialidad `-1`. Éxito → 302 a `/GestionTurnos/ListadoTurnos`.
- Cookies: respetar Set-Cookie con Expires pasado (borrado), y parsear inputs por tag (el `value` viene después de otros atributos).

Reglas clave para el robot:
- Tras el POST de login hay una **pantalla intermedia obligatoria**: elegir establecimiento + sector + puesto de trabajo (especialidad vacía para administrativos). Sin esto no se puede operar.
- Usuario del portal = `nombre.apellido` en minúscula; contraseña personalizada 6–10 chars con mayúscula+minúscula+número. Si falla el login, probablemente la contraseña fue blanqueada → el portal fuerza re-personalización.
- **El robot SÍ puede crear pacientes en Klinicos** (regla CAMBIADA por el usuario, jul 2026; antes era alta manual exclusiva): Conectar expone el padrón paginado en `GET /api/robot-klinicos/padron` con auth entrante `x-api-key` = ROBOT_API_KEY; la carga efectiva en Klinicos la implementa el Robot externo.
- Circuito: buscar paciente por DNI → ingreso ambulatorio (macheo sector+especialidad+profesional, motivo obligatorio) → detalle de atención → prestaciones.
- Bono de consulta se autogenera solo si el profesional del ingreso es médico (no licenciados).
- Práctica con orden en papel: prescriptor "externo al establecimiento" exige nombre + especialidad + **matrícula** → el prescriptor rotativo necesita esos campos.
- **El token de autorización lo genera el paciente desde su app Yoma** y se lo da a la recepcionista, que lo carga en la bandeja Klinicos de Conectar (campo del trabajo). Decisión del usuario: es el ÚNICO paso humano del circuito; todo lo demás lo hace el robot.
- **Repositorio de documentos de Klinicos**: el usuario lo considera un buen lugar para usar como "base de datos" documental por paciente — tenerlo en cuenta al diseñar adjuntos/órdenes/informes del robot (adjuntar ahí y/o leer desde ahí).
- Cadena de estados: creada → token+autorizar (valida Yoma/topes) → autorizada por realizar → Realizar (confirma profesional que informa) → esperando informe → adjuntar orden (nivel prestación) + Informar por cada código → facturable.

**Why:** el robot se calibró contra estas capacitaciones oficiales; cualquier cambio al flujo RPA debe respetar estos pasos.
**How to apply:** al tocar `klinicos-robot.ts`/`klinicos-worker.ts`, verificar contra el checklist de `docs/klinicos-flujo-administrativo.md`.

## Video consulta Clínica Médica (31/07/2026)
Calibración NUEVA: el token de una consulta se carga inline en la grilla Prestaciones del detalle de atención (input + ✔), no en el menú Prestaciones→Autorizar. Éxito = toast "IOMA informa: OK" + estado $ FACTURABLE + N° Bono. La prestación de consulta se autogenera al crear el ingreso. Detalle: docs/klinicos-video-consulta-clinica-medica.md
