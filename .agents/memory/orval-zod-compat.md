---
name: Orval Zod compat
description: Constraints on the OpenAPI spec to keep Orval-generated code compatible with Zod v3 installed under the zod/v4 import path.
---

# Orval + Zod v3/v4 compatibility

## The rule
Zod v3 is installed but imported as `zod/v4`. Orval generates `import * as zod from 'zod'` — that resolves to v3. Two OpenAPI patterns cause Orval to emit v4-only methods that break at runtime:

1. `format: email` → generates `zod.email()` (v4 only). **Never use `format: email` in the spec.**
2. Bare `type: object` without `properties` → generates `zod.looseObject()` (v4 only). **Always include at least one `properties` field.**

**Why:** The project must run on Zod v3 for workspace compatibility, but `zod/v4` is the import path alias. v4-only methods don't exist on the v3 runtime.

**How to apply:** When editing `lib/api-spec/openapi.yaml`, check any `type: string` with `format: email` and replace with plain `type: string`. Always give objects at least one property.

## Path + query params collision
An operation with BOTH a path param and query params emits a TS type `<OpId>Params` (query, in api-client types) and a Zod const `<OpId>Params` (path, in api-zod) → duplicate export TS2308. **Avoid mixing path and query params on one operation** — move the path param into query (e.g. `?clave=...`) or split the endpoint. Inline request bodies can collide too (`<OpId>Body`); prefer named component schemas.

## Schema naming collision
A component schema named exactly `<OperationId>Response` collides with the Orval-generated zod const of the same name (duplicate export in `lib/api-zod`). **Never name a schema `<OperationId>Response`** — pick a domain name instead (e.g. `TurnoReprogramado` for operation `reprogramarTurno`).

- Si `tsc --build` falla en `lib/api-zod/src/generated/api.ts` con "used before its declaration" (regex fuera de orden), NO editar a mano: correr `pnpm run codegen` en `lib/api-spec` (incluye dedupe) y vuelve a compilar. Puede pasar tras merges de tareas.
