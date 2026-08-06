---
name: Pacientes DNI único global
description: El índice pacientes_dni_unique cubre fichas inactivas; reglas para altas por DNI.
---
Regla: `pacientes_dni_unique` es parcial solo por `dni IS NOT NULL`, NO por `activo`. Cualquier alta de paciente por DNI debe: (1) buscar el DNI sin filtrar por activo; (2) si existe inactivo, reactivar esa ficha con los datos nuevos (conserva numeroHc, audita REACTIVACION); (3) si existe activo, 409 DNI_DUPLICADO incluso con forzarCreacion; (4) capturar 23505 en el insert y mapear a 409.
**Why:** el chequeo de duplicados solo miraba activos y el insert chocaba con el índice → 500 en recepción.
**How to apply:** en todo endpoint/script que cree pacientes (pacientes.ts, turnos.ts auto-create, importación, api_publica, pulso-sync).
