---
name: Código de envío Conectar
description: practice_code de validación de token IOMA viene de klinicos_practicas.codigo_envio, nunca de unir codigos
---

Regla: el `practice_code` que viaja al Robot (validación de token IOMA) es el string textual `codigo_envio` de `klinicos_practicas`, exacto según la planilla Conectar — separadores `+`/`-` y sufijos `/A`/`/B` preservados (ej. `290101-290102-420102`, `340601+340601+340602+340602`, `881841/A+881841/B`). Consultas de especialidad: siempre `420101` + specialty_code = nombre de especialidad tal cual la cartilla.

**Why:** Conectar solo resuelve la validación en segundos si recibe el código exacto acordado; unir `codigos` con coma (o mandar el primero) hace caer los combos a resolución manual del lado de Conectar.

**How to apply:** resolver siempre vía `codigoFacturacionPractica()` (lib klinicos-codigo-facturacion): orden `codigo_envio` (textual planilla) → `codigo_facturacion` (override legado, columna que convive tras el merge) → planilla embebida (match por multiconjunto de codigos) → código único tal cual → null. Null = NO inventar código: marcar MANUAL_REVIEW local con aviso al staff. `codigos` (array) sigue existiendo para facturación/cantidades. Seed idempotente: `artifacts/api-server/scripts/seed-codigos-envio-conectar.mts` (dev; prod se carga vía API publicada).
