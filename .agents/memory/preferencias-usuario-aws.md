---
name: Preferencias de usuario en AWS
description: Regla de aislamiento dev/prod para módulos clinica-db; qué variable usar según entorno y por qué CLINICA_DB_URL no se usa en dev.
---

## Regla de aislamiento dev/prod

Todo dato de pacientes/usuarios vive en AWS (lib/clinica-db). Los módulos que escriben en esa base deben usar el resolver centralizado para nunca mezclar entornos:

| Entorno           | Variable usada         | Qué base toca              |
|-------------------|------------------------|----------------------------|
| production/staging| `CLINICA_DB_URL`       | Base real (obligatoria)    |
| development/test  | `CLINICA_DEV_DB_URL`   | Base aislada (`clinica_dev`)|
| development/test  | `DATABASE_URL`         | Fallback local (no RDS)    |

**CRÍTICO:** en dev/test `CLINICA_DB_URL` es **ignorada** intencionalmente — apunta a la base real de producción. Si en dev no hay `CLINICA_DEV_DB_URL` ni `DATABASE_URL`, los módulos arrojan error explícito (nunca degradan silenciosamente).

**Why:** un fallback silencioso a `CLINICA_DB_URL` en dev permitiría que la app de prueba escribiera sobre datos reales de pacientes.

## Resolver centralizado

`artifacts/api-server/src/integraciones/clinica-url-resolver.ts` — exporta `resolverClinicaUrl(modulo, env?)`. El segundo argumento inyectable facilita tests unitarios.

Los tres módulos que lo usan:
- `preferencias-db.ts` — tabla `preferencias_usuario`
- `estudios-previos-db.ts` — tabla `estudios_previos_paciente`
- `clinica-db-init.ts` — pool general de clinica-db (se desactiva sin error si no hay URL)

## Diferencia de comportamiento en dev sin URL

- `preferencias-db` / `estudios-previos-db`: arrojan error (la operación falla explícitamente).
- `clinica-db-init`: captura la excepción y desactiva la integración silenciosamente (el servidor arranca igual, el endpoint de PACS simplemente no está disponible).

## Setup de la base de dev

Script único: `scripts/setup-clinica-dev-db.ts`
Crea `clinica_dev` en el mismo RDS y aplica todas las migraciones.
Ver `CLINICA_DEV_DB_URL` en Replit Secrets con la URL resultante.

## Gotcha esbuild

`pg` debe estar en `external` de `artifacts/api-server/build.mjs` — no es bundleable.
