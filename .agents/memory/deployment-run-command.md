---
name: Deployment run command fallback
description: Cómo se resolvió el error de publish "Could not find run command" en este monorepo pnpm
---
El publish exige `build`/`run` en la sección `[deployment]` de `.replit` aunque cada artifact tenga su config de producción en `artifact.toml` (que sigue mandando: los frontends se sirven estáticos y el api-server corre como proceso).

**Why:** al republicar apareció "Could not find run command" porque `.replit` solo tenía `deploymentTarget` y `postBuild`.

**How to apply:** mantener `build = pnpm --filter @workspace/api-server run build` y `run = pnpm --filter @workspace/api-server start` en `.replit`. No usar `pnpm run build` global ahí: los vite.config de video-consola/mockup-sandbox exigen PORT al cargar y rompen el build fuera del contexto por-artifact.
