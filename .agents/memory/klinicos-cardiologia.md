---
name: Consultas Klinicos — Cardiología y regla de correlación
description: Reglas de Federico (02-ago-2026) para cargar consultas de cardiología y qué datos de Conectar se correlacionan
---

## Regla general de CONSULTAS
- De Conectar SOLO se correlaciona **DNI + especialidad + día de atención**. El resto (profesional, motivo) lo decide el robot.
- En consultas NUNCA se piensa en códigos de facturación — los códigos son exclusivos de prácticas/estudios.
- No importa qué profesional atiende en Conectar: no se machea contra Klinicos.

## Cardiología (02-ago-2026)
- Variantes de Conectar: "Cardiología", "Cardiología Lomas", "Cardiología Infantil", "Cardiología Demanda Espontánea" → todas cargan como especialidad **CARDIOLOGIA** en Klinicos, sector CONSULTORIOS.
- Profesional: rota SIEMPRE entre los 5 cardiólogos del desplegable (CACERES FRANCO, CASTILLO MONICA, FRANGIS PATRICIO, GIUFFRA NESTOR, GOMEZ Leonardo Alberto), sembrados activos en `klinicos_profesionales_ingreso` (round-robin atómico por `ultimo_uso_en`). Si la rotación falla → sin profesional → fail-closed.
- Excepción única (igual que clínica): `turno.klinicosProfesional` cargado a mano por recepción en la ficha es un override manual y gana.
- Motivo "Consulta por": rota entre 10 motivos cardiológicos dictados por el usuario (`DIAGNOSTICOS_CARDIOLOGIA` en klinicos-robot.ts).
- Token/bono: mismo circuito que Clínica Médica, sin cambios.

## Todas las especialidades de consultorio (02-ago-2026)
- Ya no hay ramas por especialidad: tabla `ESPECIALIDADES_CONSULTA` en klinicos-robot.ts (detección regex sobre Conectar + nombre del select del portal + motivos rotados). EL ORDEN IMPORTA: NEUROLOGIA antes que UROLOGIA ("neurologia" contiene "urolog") y CLINICA MEDICA al final (/CLINICA/ es amplio).
- Cubre todo el desplegable de CONSULTORIOS salvo IMAGENES/IMAGENES S/C (pendientes a pedido del usuario). Pediatría con motivos dictados por el usuario; el resto con motivos típicos elegidos por el agente (usuario delegó).
- Cardiología es la ÚNICA con `profesionalDeLaCola` (rotación sembrada); todas las demás rotan del desplegable del portal.
- Matcheo por inclusión contra el portal exige match ÚNICO (0 o varios → fail-closed).

## Traumatología y Ginecología (02-ago-2026)
- Conectar con "TRAUMATOLOGIA" → Klinicos **"ORTOPEDIA Y TRAUMATOLOGIA"** (¡machear por inclusión, no exacto — verificado contra el portal!). Conectar con "GINECO" → Klinicos "GINECOLOGIA".
- Profesional: rota entre los del DESPLEGABLE del portal (como Clínica Médica; sin lista sembrada; se excluyen CANESTRO y "USUARIO, Medico").
- Motivos rotados: 10 traumatológicos (Lumbalgia…Probable fractura) y 8 ginecológicos (Dolor pélvico…Control ginecológico), listas dictadas por el usuario en DIAGNOSTICOS_* de klinicos-robot.ts.
- En la cola no viaja el médico de Conectar como fallback (mismo fail-closed que cardio).

**Why:** el usuario enseñó la regla paso a paso y fue explícito: "la única correlación que tenés que seguir en CONSULTAS es DNI, ESPECIALIDAD y DÍA DE ATENCIÓN, el resto lo pones vos".
**How to apply:** al agregar nuevas especialidades de consulta, replicar el patrón: bucket propio en seed-profesionales-ingreso, mapeo de variantes por `includes` normalizado, rama en el robot con especialidad exacta del select y motivos rotados aprobados por el usuario.

Circuito multi-especialidad APROBADO por el usuario (02-ago-2026) tras carga real en prod de una consulta de GINECOLOGIA (rotación de profesional del desplegable + motivo rotado + IOMA validada; consulta CONFIRMADA sin autorizar, token después). El flujo de prueba en prod: crear turno vía POST /turnos + POST /turnos/:id/encolar-klinicos → simulación → esperando_aprobacion → POST /trabajos/:id/aprobar → carga real. Cardiología puntual sigue sin corrida real propia.

## Prácticas de cardio (lección en curso, NO implementar aún)
- Ingreso ambulatorio igual que consultas: motivo = nombre del estudio, sector CONSULTORIO, especialidad CARDIOLOGIA, profesional SIEMPRE CÁCERES, FRANCO.
- La fila C- NO nace sola: en la atención → "Nueva Prestación" → tipo Práctica, radio Sala; Prescriptor = clínico habitual (cardiólogos valen); "Seleccione una orden" VACÍO; Efector CONSULTORIOS / CÁCERES FRANCO / CARDIOLOGIA; cantidad 1, estado C.
- Códigos de facturación: electro 170101, presurometría 881701, ergometría 881706, Holter 881710.
- Diagnóstico: va SOLO en "Diagnóstico general" (buscador + Cod. diagnóstico); en la fila de cada práctica NO hace falta.
- La orden manuscrita de Conectar debe coincidir con diagnóstico y prescriptor.
- Diagnósticos leves APROBADOS para rotar: R00.x palpitaciones, R01.x soplo, R03.0 presión elevada, R06.0 disnea leve, R07.2/R07.4 dolor precordial; presurometría SIEMPRE R03.0.
- Tras Guardar la prestación queda C- CONFIRMADO con casillero de token en la grilla, igual que consultas (confirmado con captura 02/08/2026).
- Orden médica: en la grilla, Acciones (botón herramienta) → "Adjuntar documentación" → pestaña Documentos múltiples → tildar tipo "Orden de práctica/s" (máx 1.5 MB) → Examinar y subir el PDF → escribir "orden medica" en Descripción del documento → Guardar.
- El PDF es la orden de baja complejidad de Conectar (manuscrita): logo Diagnosticar, datos del médico cargado como prescriptor en la práctica, datos del paciente, y FECHA 1 a 7 días ANTES de la fecha presente.
- ALCANCE prácticas dictado 03/08/2026: el circuito automatizado llega hasta subir la orden médica; el TOKEN NO se valida (Federico lo pidió explícito: "no quiero que valides el token"). Implementación aún no autorizada.
