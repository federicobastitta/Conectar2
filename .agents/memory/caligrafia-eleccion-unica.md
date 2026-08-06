---
name: Caligrafía elegida por el médico
description: Elección única e inmutable de letra manuscrita (6 bases) y regla del sorteo por defecto
---
Regla: el médico elige su caligrafía UNA vez vía POST /perfil/caligrafia (update atómico `WHERE caligrafia IS NULL`; 409 si ya eligió). No hay endpoint para cambiarla; PATCH /profesionales no la acepta (el body zod la stripea) — mantener eso así.

**Why:** pedido explícito del usuario: que no la puedan cambiar una vez elegida.

**How to apply:**
- El sorteo por defecto para quienes no eligieron está CONGELADO en las 5 bases originales (`id % 5`, const BASES_SORTEO). La 6ª base (Patrick Hand, imprenta) solo entra por elección explícita. Si se agregan más bases, NUNCA ampliar el módulo del sorteo o cambian las letras de documentos existentes.
- Todo lugar que arma `datos.profesional` para documento_pdf debe pasar `caligrafia` (consultorio_docs, ordenes_practicas, klinicos).
- El frontend previsualiza con las TTF reales servidas por GET /perfil/caligrafia/fuente/:i (auth de médico).
