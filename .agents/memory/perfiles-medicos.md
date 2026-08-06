---
name: Perfiles médicos
description: El perfil "medico" común fue reemplazado por "medico_consulta_informante"
---
Regla: el perfil `medico` común ya no se ofrece; existen `medico_consulta`, `medico_informante` y el combinado `medico_consulta_informante` (todos rol "medico").
**Why:** el usuario pidió eliminar el perfil común y tener uno combinado (consulta + informante).
**How to apply:**
- `medico` sigue en los enums de LECTURA del OpenAPI y en `ROL_POR_PERFIL` por compatibilidad con datos viejos, pero NO en los enums de input (crear/editar usuario).
- Migración idempotente al arrancar el api-server (`asegurarUsuariosPorDefecto`): `perfil='medico'` → `medico_consulta_informante`. En prod corre sola al republicar.
- El combinado redirige a `/consultorio` y tiene botón de header a `/worklist` (data-testid `boton-header-worklist`).
- Listas hardcodeadas de perfiles médicos existen en perfiles/index.tsx, app-layout.tsx, vista-rol-switcher.tsx y auth.ts (PERFILES_VISTA); un perfil nuevo debe agregarse en todas.
