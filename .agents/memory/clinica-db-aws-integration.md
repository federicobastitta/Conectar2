---
name: clinica-db AWS integration
description: Patrón de integración condicional de clinica-db en api-server; gotchas de Dockerfile y tipos pg.
---

## Integración condicional en api-server

`artifacts/api-server/src/integraciones/clinica-db-init.ts` — solo se activa si `CLINICA_DB_URL` está en el entorno.
Endpoint de health: `GET /api/healthz-clinica` → `{ ok, enabled, db? }`.
Devuelve `{ ok: false, enabled: false }` sin bloquear el arranque cuando no hay AWS.

**Why:** El api-server corre en dev sin credenciales AWS; la integración no debe romper el startup.
**How to apply:** `initClinicaDBIfConfigured(logger)` se llama en `index.ts` dentro del callback del `app.listen`.

## Conexión a RDS real (desde 2026-07)

La base es RDS PostgreSQL 18 `conectar-clinica-dev` (sa-east-1, endpoint `conectar-clinica-dev.cvasa08yuy52.sa-east-1.rds.amazonaws.com:5432/postgres`); la password vive en AWS Secrets Manager (nunca guardarla acá) y es la misma que la instancia principal. Desde jul-2026 existe el secret `CLINICA_DEV_DB_URL` en Replit: en development el resolver usa esa instancia dev aislada (log "clinica-db: usando base aislada de desarrollo") y ya no cae a la DB Replit local.
RDS **exige TLS siempre** (rechaza "no encryption" via pg_hba) y su certificado lo firma la CA propia de RDS, que no está en el trust store de Node.
**How to apply:** los pools hacia `CLINICA_DB_URL` usan `ssl: { rejectUnauthorized: false }` en todos los entornos (dev y prod); `ssl: false` o `rejectUnauthorized: true` sin CA fallan.

## PG 15+/18: unaccent en índices necesita schema-qualified

`CREATE INDEX` ejecuta las funciones con search_path restringido; `f_unaccent` debe llamar a `public.unaccent($1)` (fix en migración 018). Las migraciones ya aplicadas no se editan (el runner valida checksum) — siempre migración correctiva nueva. El runner además requiere `CREATE EXTENSION unaccent/pg_trgm` previo (018 no lo cubre en bases nuevas: lo hace 001).

## @types/pg en api-server

api-server no tiene `@types/pg` por defecto (usa Drizzle ORM que abstrae pg).
Si clinica-db-init.ts necesita tipos de pg, agregar `@types/pg` a devDeps del api-server.
Alternativa: definir interfaces mínimas locales (PgPool, PgClient) y castear con `as unknown as PgPool`.

## Dockerfile — SQL migrations en dist/

En clinica-db, el migration runner resuelve `__dirname` relativo al archivo compilado:
`dist/migrations/runner.js` → busca SQL en `dist/migrations/sql/`.

En el Dockerfile runtime stage, copiar así:
```dockerfile
COPY lib/clinica-db/src/migrations/sql ./lib/clinica-db/dist/migrations/sql
```
NO copiar a `src/migrations/sql/` — el runner compilado no busca ahí.

**Why:** TypeScript no copia archivos `.sql` al `dist/`; hay que copiarlos explícitamente en el Dockerfile.

## Mudanza de la app a AWS (2026-07-29)
- La app principal puede apuntar a AWS con `APP_DB_NAME` (env var por entorno, ej `conectar_app_dev`/`conectar_app_prod`): lib/db arma la URL con el host de CLINICA_DB_URL. Sin APP_DB_NAME sigue en DATABASE_URL (Replit).
- TLS: los certificados raíz de RDS están embebidos (`RDS_CA` exportada por @workspace/db, generada del global-bundle). Nunca usar rejectUnauthorized:false — fue rechazado en review.
- Copia de datos: endpoint interno admin `POST /api/admin/migracion-aws/copiar` (+ `/estado`), corre en background dentro del server, reanudable por conteos. Lecciones: leer json/jsonb como ::text (node-pg rompe arrays JSON), cursor dentro de REPEATABLE READ (no OFFSET), lote limitado por 60000/columnas y por bytes/fila (blobs de job_importaciones ~6MB c/u van de a 1).
- **Why:** la instancia t4g.micro se congeló por agotar créditos de CPU durante la carga masiva (ni un SELECT 1 respondía; pg_terminate no mataba backends). Se agrandó a db.t4g.medium.
- Latencia Replit⇄sa-east-1 ~0,23s por consulta: los endpoints N+1 se vuelven inusables (turnos-dia pasó de 42s a 3s tras batchear); revisar N+1 antes de culpar a AWS.
- Estado al 2026-07-29: corte completado. 89 tablas / 762 469 filas copiadas a conectar_app_prod via POST /api/admin/migracion-aws/copiar desde la app publicada. APP_DB_NAME=conectar_app_prod seteado en env production; app publicada reiniciada y smoke test ok (111 295 pacientes). Base Replit queda como copia inactiva. Backfills de data pendientes (QR, dedup, prácticas) quedan en tareas de seguimiento.
