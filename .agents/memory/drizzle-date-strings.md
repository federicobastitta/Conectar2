---
name: Drizzle date fields
description: How to handle date column type mismatches between Drizzle and Orval-generated Zod schemas in this project.
---

# Drizzle date fields require string conversion

## The rule
`date(..., { mode: "string" })` Drizzle columns only accept `string` values in `eq()`, `gte()`, `lte()`, and `insert().values()`. Orval-generated Zod schemas emit `zod.coerce.date()` or `zod.date()` for date fields, so parsed values are `Date` objects.

**Always convert before use:**
```typescript
const fechaStr = fechaRaw instanceof Date ? fechaRaw.toISOString().split("T")[0] : fechaRaw;
```

**Why:** Drizzle's PgDateString column type has overloads that only accept `string | SQLWrapper`, not `Date`. TypeScript will catch this at compile time with a TS2769 error.

**How to apply:** Any route that receives a date query param or body field and then uses it in a Drizzle `eq/gte/lte/insert` call must convert it. Affected routes: turnos.ts, dashboard.ts, turneras.ts.
