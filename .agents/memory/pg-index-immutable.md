---
name: PG index IMMUTABLE rules
description: PostgreSQL exige IMMUTABLE en expresiones y predicados de índice; errores comunes y soluciones.
---

## Regla

Todo lo que aparece en la expresión de un índice (`ON t USING ... (expr)`) o en su predicado (`WHERE cond`) debe ser **IMMUTABLE**. Usar funciones STABLE o VOLATILE genera error en tiempo de creación del índice.

## Casos frecuentes

### `unaccent()` — es STABLE, no IMMUTABLE
Crea un wrapper explícito en la migración de foundation:
```sql
CREATE OR REPLACE FUNCTION f_unaccent(text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$SELECT unaccent($1)$$;
```
Luego usar `f_unaccent(col)` en vez de `unaccent(col)` en todos los índices.

### `gin_trgm_ops` — requiere `pg_trgm`
Si la extensión no está instalada en el servidor de destino (CI, dev local), la creación falla con `undefined_object`. Envolver en DO block:
```sql
DO $$ BEGIN
  CREATE INDEX ... USING GIN (col gin_trgm_ops);
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'pg_trgm no instalada — índice omitido';
END $$;
```

### `CURRENT_DATE` / `NOW()` en predicado WHERE de índice — STABLE, prohibido
```sql
-- MAL: falla en CREATE INDEX
WHERE vigente_hasta >= CURRENT_DATE

-- BIEN: mover el filtro de fecha a la consulta SQL, no al índice
WHERE estado = 'otorgado' AND deleted_at IS NULL
-- y en la query: AND (vigente_hasta IS NULL OR vigente_hasta >= CURRENT_DATE)
```

**Why:** PostgreSQL evalúa el predicado del índice una sola vez al momento de construcción, y requiere que el resultado sea determinístico (IMMUTABLE). `CURRENT_DATE` cambia cada día → STABLE → no permitido.

**How to apply:** Ante cualquier migración que cree índices con funciones o predicados, verificar que cada función sea IMMUTABLE antes de hacer `CREATE INDEX`. Si no, usar wrapper IMMUTABLE o mover la condición a la capa de query.

## Peer deps opcionales en TypeScript

Para módulos opcionales (`exceljs`, `@aws-sdk/*`) que no se instalan en el paquete lib pero se usan via dynamic import:
- Crear `src/types/optional-peers.d.ts` con `declare module "nombre-modulo"` (typed as `any`)
- Incluir el directorio en `tsconfig.json` → `"include": ["src", "src/types"]`
- Esto evita TS2307 sin instalar las deps en el paquete lib
