---
name: Backups de clinica-db
description: Cómo funciona el backup diario pg_dump→Object Storage y las trampas de restauración contra RDS PG18
---

- El RDS corre PostgreSQL 18; el `pg_dump` del workspace es v16 y nixpkgs no trae v18. El módulo de backups descarga una build portable (theseus-rs/postgresql-binaries, SHA-256 pineada) a /tmp. El `psql` portable falla por libreadline; usar el psql del sistema para COPY.
- **Why:** pg_dump aborta si el servidor es de versión mayor; sin binario v18 no hay backup.
- **How to apply:** cualquier tooling que hable con clinica-db vía binarios pg debe usar `ensurePgTools` (integraciones/backup-db.ts) o la misma build portable, con `PGSSLMODE=verify-full` + RDS_CA y la URL sin query params (sslmode=no-verify estilo node rompe libpq).
- Worker de backup: catch-up cada 30 min con estado en config_sistema (`backup_db_estado`); activo solo en prod salvo `BACKUP_DB_ENABLED=true`. Retención en `backups/<base>/` del área privada, mínimo 7 archivos.
- Restauración: `pg_restore` interrumpido y relanzado DUPLICA filas (commit por tabla, sin truncate) — restaurar siempre a base recién creada y de una sola corrida, o `--clean --if-exists`. Procedimiento probado en docs/backups-db.md.
- En el entorno del agente los procesos en background no sobreviven entre ShellExec y /tmp se limpia: correr restauraciones largas por fases (`--section=pre-data/data/post-data` + `-L` con listas de tablas) y filas gigantes (blobs de job_importaciones, ~200 MB texto) por COPY fila a fila.
