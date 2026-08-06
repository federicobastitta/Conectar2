---
name: Estudios multi-código
description: Cómo se modelan los estudios que facturan varios códigos de nomenclador juntos
---

Algunos estudios facturan varios códigos juntos (EEG = 290101+290102+420102; Eco Abdomen = 180112+180113; Mamografía bilateral = 340601 x2 + 340602 x2; Doppler art+ven = 881841/A + 881841/B).

Modelo:
- `practicas_catalogo.codigos` (jsonb string[]) guarda el listado COMPLETO con repeticiones (las repeticiones expresan cantidad, para facturación/robot Klinicos).
- El API expone `codigosNomenclador` = dedup de `codigos` (fallback: código numérico extraído por regex del `codigo`). Ojo: la extracción por regex pierde sufijos como `/A` — por eso los dopplers 881841/A llevan `codigos` explícito.
- Al tildar el estudio en una agenda, el frontend crea UNA fila de `turnera_practicas` por código (misma `descripcion`), así el flujo klinicos-cola manda cada código como ítem separado.
- El filtro "Estudio/Práctica" de nuevo turno dedupe opciones por `descripcion` y matchea agendas por código O descripción.

**Why:** el usuario necesita que al seleccionar un estudio viajen todos sus códigos como ítems separados para que el robot los cargue en Klinicos.

**Gap conocido:** `turnera_practicas` tiene unique (turnera_id, codigo) → no conserva cantidades (x2); cuando se implemente la carga del robot a Klinicos, las cantidades deben salir de `practicas_catalogo.codigos`, no de turnera_practicas.

**Edición desde recepción:** POST /turnos/:id/ingreso-consulta acepta `practicaIds[]` (reemplaza el conjunto en turno_practicas; [] los quita; prioridad sobre el singular `practicaId`). El GET del ingreso y /sala-espera/cola devuelven todos los estudios. Ojo: los trabajos Klinicos ya procesados NO se re-sincronizan al corregir estudios (solo pendiente/error).
