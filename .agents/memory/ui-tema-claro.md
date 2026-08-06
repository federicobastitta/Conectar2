---
name: UI legible en tema claro
description: El staff usa el tema claro; colores pensados solo para dark quedan invisibles.
---

Regla: todo texto sobre fondos tintados (banners, chips, avisos) debe declarar ambos temas, ej. `text-red-800 dark:text-red-200`.

**Why:** el banner de "solicita asistencia" se veía como una cinta rosa sin palabras para el usuario (tema claro) porque usaba `text-red-200` sobre `bg-red-500/20`; en dark (donde se testeaba) se veía perfecto. Julio 2026.

**How to apply:** al agregar avisos/chips con fondos `/20`–`/40`, usar tonos 700–900 para light y 100–200 con `dark:` para dark. Verificar en ambos temas, no solo en el que abre por defecto el navegador de test.
