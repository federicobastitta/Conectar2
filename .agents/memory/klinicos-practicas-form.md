---
name: Form de prácticas Klinicos calibrado
description: Cómo se arma el POST de una prestación Práctica (tipo 3) en el portal Klinicos — calibrado en vivo con la carga real del Holter.
---

Calibración en vivo (03/08/2026, carga real Holter Frontini → P-2026-199611):

- El create de prestación exige el id NUMÉRICO IdAtencionACobrar (con GUID → 500), igual que la consulta. La grilla de confirmación es 100% AJAX (el HTML del detalle no trae filas).
- Los ítems se buscan en `/ordenPrestacion/itemJSON/{ObraSocialid}/{IdObraSocialPlan}/{IdConvenio}/{TipoOrdenPrestacionId}/{idProfesion}?q=<término>` (valores del propio form; idProfesion = data-idProfesion del option seleccionado de EspecialidadId). Devuelve `[{Value, Text: "COD | NOMBRE", data:{codigo, valor, copago…}}]`. El catálogo de Klinicos puede listar el código de envío exacto (881710 estaba como ítem propio, además de los 1701xx) — matchear por código al inicio del Text, coincidencia única.
- La fila del ítem va como campos `ordenPrestacionItems[i].*` (id=0, OrdenPrestacionid=0, IdNomencladorPrestador=Value del ítem, codigoNomenclador, terminologia, cantidad, precio, estado="C", vencimientos = campo Fecha del form, etc.). La plantilla exacta se lee del form de consulta (tipo 1), que viene con el ítem server-rendered.
- Prescriptor EXTERNO (texto libre): exige nombre + matrícula + **tipo de matrícula** (`ProfesionalOrdenTipoMatricula` y `_list`, "MP"/"MN"); si falta el tipo, el portal rechaza con "Debe indicar el profesional solicitante" (mensaje engañoso). Mandar `ProfesionalOrdenId` interno NO alcanzó para pasar esa validación.
- Regla del usuario: en prácticas cardio, prescriptor = PIROPO (matrícula 238844), efector = CÁCERES — "eso no cambia nunca hasta que yo te avise". "Práctica" ⇒ no es consulta; el código sale del catálogo anotado.

Adjuntar la orden médica (obligatorio en prácticas): dos pasos — POST multipart `/repositorio/UploadMultipleFile` (files, descripcionesArchivos, idPacienteRepositorio=GUID del paciente que aparece en el JS del detalle como `let idPaciente='…'`, tipoEntidadAsociada="Prestacion", idEntidadAsociada=Id numérico de la fila, selAcronimo=6 "Orden de práctica/s", máx 1.5 MB) y luego POST `/ordenPrestacion/vincular-documentacion` {id, idArchivo, vincularA:"PRESTACION"}; sin el segundo paso el archivo queda huérfano en el repositorio (TieneDocumentacionCargada sigue false).

**How to apply:** todo está volcado en `crearPrestacionReal` (klinicos-prestaciones.ts); ante un rechazo nuevo del portal, recalibrar leyendo el form real, no adivinar campos.
