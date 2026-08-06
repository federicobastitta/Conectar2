---
name: Estilo crayón para estados
description: Preferencia visual confirmada del usuario para los chips/óvalos de estado en modo oscuro.
---

Regla: los estados (Agendado/Recepcionado/Informado/etc.) en modo oscuro van con relleno **sólido** apagado tipo crayón (nada de transparencias tipo `/25`), palabra en blanco suave, más una textura de grano (clase `.estado-crayon`, ruido SVG feTurbulence en index.css, desactivada en print).

**Why:** el usuario iteró varias veces: rechazó grises puros, rechazó pasteles brillantes y rechazó fondos translúcidos; aprobó explícitamente ("quedó excelente") los sólidos desaturados (HSL ~25% sat, ~38% luz) con textura crayón. Informado va en VERDE, Entregado en teal, Agendado en celeste.

**How to apply:** cualquier estado o badge nuevo debe seguir este patrón (color sólido desaturado + `.estado-crayon` + texto blanco/85) en vez de los pares clásicos bg-*-50/text-*-700.
