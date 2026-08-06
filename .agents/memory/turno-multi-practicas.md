---
name: Varias prácticas por turno
description: Cómo se guardan y viajan los turnos con más de un estudio (turno_practicas)
---
- Conjunto completo en tabla `turno_practicas`; `turnos.klinicos_practica_id` sigue siendo la práctica PRINCIPAL (primera) por compat con PACS/ficha/checklist.
- API: `klinicosPracticaIds[]` en POST/PATCH /turnos (array vacío = quitar todos; array con ids inválidos → 400). enrichTurno devuelve `practicas[]`.
- Robot: `practice_code` = SOLO el de la principal (si no resuelve, se omite); `practice_codes[]` lista todos cuando hay >1. Nunca inventar combinaciones de códigos.
- **Why:** Conectar exige códigos textuales exactos de la planilla; combinar códigos de dos prácticas no es una fila de planilla.
- Ficha de recepción / sala de espera siguen editando la práctica singular (pendiente).
- Frontend: `MultiCombobox` (combobox.tsx) con chips; agenda-medico manda la lista.
