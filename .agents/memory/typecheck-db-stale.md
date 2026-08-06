---
name: Typecheck falla por dist stale de lib/db
description: Errores "property does not exist" sobre columnas que sí están en el schema
---
Si `pnpm run typecheck` en api-server falla con "Property X does not exist" sobre columnas que SÍ existen en `lib/db/src/schema/*`, el problema es que los `.d.ts` compilados de `lib/db/dist/` quedaron viejos (project references).

**How to apply:** correr `cd lib/db && npx tsc -b tsconfig.json` y reintentar. No hay script `build` en lib/db; el runtime importa desde src, solo el typecheck usa dist.
