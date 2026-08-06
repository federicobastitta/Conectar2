---
name: Unificación de agendas duplicadas
description: Cómo se unificaron turneras duplicadas (mismo profesional+sede+horario) y qué cuidar en reimportaciones
---

Regla (jul 2026, pedida por el usuario): turneras del mismo profesional + sede + especialidad + modalidad + duración + hora_inicio deben ser UNA sola agenda — se unen los `dias_atencion`, se toma la `hora_fin` máxima, se mueven los turnos a la sobreviviente (min id) y las demás quedan `activa=false` con `import_key=NULL`.

**Why:** las importaciones de Alephoo creaban una turnera por día/regla, y el asistente de Nuevo Turno mostraba al mismo profesional repetido en el mosaico.

**Update (jul 2026):** el criterio estricto (misma duración+hora_inicio) no detecta los duplicados reales de la doble importación (vienen con duración/hora_fin levemente distintas y nombres invertidos "Apellido, — Especialidad" vs "Especialidad — Nombre"). El criterio que funciona: mismo profesional+sede+especialidad, activas, que comparten al menos un día y cuyos rangos horarios se cruzan. Hay un script reutilizable (dry-run por defecto) que opera 100% vía API y sirve igual para dev y la app publicada; correr contra la API por localhost:PORT en dev — vía el proxy del preview cada PATCH tarda ~4 s y no termina.

**How to apply:**
- Al mover turnos, respetar el índice `turnos_slot_activo_unique`: mover a lo sumo uno por (turnera, fecha, hora); los duplicados exactos (mismo paciente/fecha/hora en ambas) se cancelan con observación; los choques reales se mueven como `sobreturno=true`.
- **Guardias (jul 2026):** los creadores de turneras deduplican guardias por nombre normalizado + sede: POST /turneras con esGuardia reutiliza/reactiva la existente (responde 200, no 201), y los importadores de scripts tienen fallback por nombre+sede antes de insertar (las guardias no matchean por trío profesional porque no tienen profesional fijo).
- **Caveat reimportación:** el `import_key` de la sobreviviente conserva la `hora_fin` original, pero el importador calcula la key desde las reglas del archivo fuente — una reimportación del mismo padrón puede recrear las agendas por-día. Si eso pasa, considerar unificar en el importador (merge por profesional+sede+esp+hora_inicio) o re-correr la unificación.

**Update (jul 2026):** el importador de agendas ahora, antes de insertar, busca una turnera ACTIVA del mismo profesional+sede+especialidad con horario superpuesto/cubierto y la reutiliza (une días, ensancha horario); la decisión vive en `elegirTurneraReutilizable` (@workspace/db, lógica pura) y las reutilizaciones quedan en `importaciones_admin.detalle.agendasReutilizadasDetalle`. Bloques disjuntos (mañana vs tarde) NO se fusionan, coherente con la regla por hora_inicio.
