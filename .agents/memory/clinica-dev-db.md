---
name: Base conectar_app_dev aislada
description: Base de desarrollo aislada en el mismo RDS; guardarraíl que evita usar la base real en dev.
---

- Existe `conectar_app_dev` en el mismo servidor RDS que la base real (`postgres`); esquema completo vía migraciones de @workspace/clinica-db.
- El secret CLINICA_DEV_DB_URL puede apuntar por error a la misma base que CLINICA_DB_URL: el resolver (clinica-url-resolver) reescribe el nombre de base a `conectar_app_dev` cuando host+puerto+base coinciden con prod. **Why:** el usuario cargó dos veces la URL de prod sin cambiar el nombre; el guardarraíl elimina el riesgo y evita pedirle la clave otra vez.
- Setup de una base nueva en RDS: los CREATE EXTENSION de la migración 001 pueden requerir crearse aparte, y el `f_unaccent` de 001 falla en PG15+ al crear índices (unaccent sin calificar); aplicar antes la versión schema-qualified de la migración 018.
- El script scripts/setup-clinica-dev-db.ts requiere deps (pg, @workspace/clinica-db) en el paquete scripts y que clinica-db tenga dist compilado; alternativa práctica: correr runMigrations desde lib/clinica-db con tsx.
