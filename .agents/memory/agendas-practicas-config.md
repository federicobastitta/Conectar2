---
name: Configurar agendas de prácticas para el robot
description: Qué datos necesita una agenda de prácticas nueva (ej. ECG) para que el robot la cargue en Klinicos sin intervención.
---

Lección (03/08/2026, prueba ECG Frontini en prod): una agenda de prácticas nueva NO funciona sola; hay que configurar por API/UI:

1. **Prácticas tildadas** en la turnera (turnera_practicas con el código de envío, ej. 170101) — es lo que la marca como "de prácticas" y encola al reservar. La heurística de sector NO reconoce "Electrocardiograma" (PALABRAS_IMAGENES no incluye ELECTRO → cae a CONSULTORIO y no encola).
2. **klinicosSector/klinicosEspecialidad/klinicosProfesional/klinicosMotivo** en la turnera (ej. CONSULTORIOS/CARDIOLOGIA/CACERES FRANCO/ARRITMIA). El worker usa trabajo.especialidad textual contra el desplegable del portal; la tabla klinicos_eq_especialidades NO se aplica en este camino (solo en el outbox emitter).
3. **Prescriptor en klinicos_prescriptores** (nombre exacto del trabajo + matrícula); en prod la tabla puede estar vacía → "Falta nombre o matrícula del prescriptor". Alta vía POST /api/integraciones/klinicos/prescriptores.
4. La orden automática matchea prescriptorNombre contra profesionales de Conectar; "PIROPO NETO RUBEM" no matchea "Piropo, Rubem" — el worker termina creando la orden de respaldo con el prescriptor de klinicos_prescriptores, así que el punto 3 alcanza.

**Gotcha bandeja:** PATCH a un trabajo esperando_aprobacion lo devuelve a pendiente y re-simula; aprobar recién cuando vuelve a esperando_aprobacion. GET /integraciones/klinicos/trabajos devuelve un ARRAY plano (no {data}).

**How to apply:** al dar de alta una agenda de prácticas, correr esta checklist antes de la primera reserva; el circuito completo (encolar al reservar → simular → aprobar → ingreso+prestación+orden adjunta) quedó probado e2e en prod con el trabajo del ECG.

## Prácticas eco con código interno (ago 2026)
Federico pidió cargar dopplers/eco obstétrica en las 33 agendas de ecografía y dijo explícitamente que NO hacen falta códigos de facturación. Se crearon en practicas_catalogo con códigos internos `ECO-DOPPLER-*` / `ECO-OBSTETRICA` (sin nomenclador).
**Why:** el catálogo IOMA no las tiene y varios dopplers comparten 881841/A (turnera_practicas dedupe por código impide filas separadas con el mismo código real).
**How to apply:** sirven para el buscador rápido; si alguna vez facturan por robot caerán a revisión manual (código no matchea planilla) — es el comportamiento esperado, no inventar códigos reales. Replicar catálogo+tildado en prod tras publicar.

Aclaración de Federico: esas 6 son prácticas de ALTA complejidad — la autorización no la hace el sistema/robot. Quedaron con requiereTokenKlinicos=false; no entran al circuito de token ni al encolado Klinicos.
