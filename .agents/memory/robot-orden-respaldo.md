---
name: Orden de respaldo automática del robot Klinicos
description: Cómo el worker resuelve/crea la orden médica que respalda una práctica cargada en Klinicos.
---

Regla (pedido del usuario, 01/08/2026): al mandar una práctica a Klinicos, si Conectar ya tiene una orden cargada se usa esa; si no, el robot la crea automáticamente.

- Resolución en `klinicos-ordenes.ts` (worker la llama antes del ingreso): 1) orden vinculada al turno, 2) orden del paciente para la misma práctica sin turno (claim atómico del turnoId: si el UPDATE no afecta filas, no se adopta), 3) creación automática dentro de una transacción con `pg_advisory_xact_lock` por paciente+práctica y re-chequeo, para que reintentos/concurrencia no dupliquen órdenes.
- **Órdenes auto-creadas nacen SIEMPRE `pendiente_validacion`** (nunca `validada` por mera presencia de token — la validación real es otro circuito) y sin accessionNumber (no viajan al PACS).
- Un trabajo puede traer códigos de varias prácticas (ECG + ergometría multi-código): la orden referencia UNA práctica — se toma la del primer código con match inequívoco (exactamente una práctica activa del catálogo por `codigos`/`reglasKlinicos.practiceCode`/`codigo`).
- El prescriptor rotado (klinicos_prescriptores) se matchea a `profesionales` por matrícula exacta y, si no, por nombre normalizado con match único; ambigüedad → fail-closed con `faltante` explicativo (no frena el ingreso, queda anotado en el paso "prestacion").
- La rotación de prescriptor y el paso/simulación de prestación aplican a CUALQUIER trabajo con `practicaCodigos`, ya no solo a sector IMAGENES S/C.
- Vínculo persistido en `klinicos_trabajos.orden_practica_id` (drift aditivo auto-aplicado al arrancar).

- Regla pendiente del usuario: las prácticas oftalmológicas se hacen con efector "DIAZ DIEGO" — aún no hay prácticas oftalmológicas en la planilla (klinicos_practicas); al cargarlas, fijarles ese efector.
- Efector: la planilla trae duplas en `klinicos_practicas.efector_nombre` separadas por "-" (cardio → FRANGI/CACERES, ecografías → MUÑOZ/VARELA); el worker elige UNO por rotación (menos usado según último trabajo) y también resuelve el efector por código para prácticas tildadas en agenda (antes solo imágenes). Un solo nombre fijado en la bandeja se respeta tal cual.

**Why:** las prestaciones en Klinicos necesitan una orden de respaldo auditada; decisiones previas ya habilitaron órdenes manuscritas sin aprobación previa.
**How to apply:** cualquier cambio al circuito de órdenes o del worker debe respetar el candado y el estado inicial `pendiente_validacion`.

**Regla cambiada (03-ago-2026, aprobada):** la orden automática se genera SIEMPRE, aunque el turno ya tenga una orden cargada a mano. Las órdenes manuales solo se usan como último recurso si la automática no se puede crear (práctica/prescriptor sin resolver). En reintentos se reutiliza solo la automática (marca fija en observaciones), nunca la manual.
