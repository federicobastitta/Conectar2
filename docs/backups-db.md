# Backups diarios de la base clinica-db (AWS RDS)

Última actualización: 2026-08-01

## Qué se respalda y dónde

- **Base**: la base que usa la app según el entorno (`resolverClinicaUrl`):
  - producción → `CLINICA_DB_URL` (base real, `conectar_app_prod`)
  - desarrollo → `clinica_dev` (solo si se fuerza con `BACKUP_DB_ENABLED=true`)
- **Formato**: dump lógico `pg_dump --format=custom` (comprimido, restaurable
  selectivamente con `pg_restore`).
- **Destino**: Object Storage (bucket privado de la app), bajo
  `PRIVATE_OBJECT_DIR/backups/<base>/<fecha>.dump`
  (ej.: `gs://<bucket>/.private/backups/conectar_app_prod/2026-08-01T18-16.dump`).
- **Frecuencia**: diaria. El worker (`iniciarBackupDbWorker` en
  `artifacts/api-server/src/integraciones/backup-db.ts`) chequea cada 30 min y
  corre un backup cuando el último exitoso tiene más de ~23,5 h. El estado se
  persiste en `config_sistema` (clave `backup_db_estado`), así el cronograma
  sobrevive reinicios y las instancias de autoscale hacen catch-up al despertar.
- **Retención**: se borran dumps con más de `BACKUP_DB_RETENCION_DIAS` días
  (default **14**, mínimo 7). Siempre se conservan los últimos 7 archivos,
  aunque sean viejos.

## Motivo del diseño

No tenemos acceso a la consola AWS para confirmar la retención de snapshots
automáticos de RDS, así que la garantía de recuperación vive del lado de la
app. Si más adelante se confirma la retención de snapshots RDS (recomendado:
≥7 días + PITR), este dump lógico queda como segunda línea de defensa.

## Detalle importante: versión de pg_dump

El servidor RDS corre **PostgreSQL 18**; `pg_dump` debe ser de versión mayor
o igual. Como el entorno puede traer un cliente más viejo, el módulo descarga
una build portable de PostgreSQL 18 (theseus-rs/postgresql-binaries, verificada
por SHA-256) a `/tmp/pg18-tools` la primera vez que la necesita.

## Operación

- **Ver estado / listado de dumps**: `GET /api/backups-db/estado` (rol admin).
- **Disparar un backup ya**: `POST /api/backups-db/correr` (rol admin, corre
  en segundo plano; el resultado aparece luego en el estado).
- **Variables**:
  - `BACKUP_DB_ENABLED` — `false` apaga el worker; `true` lo fuerza en dev.
    Sin definir: activo solo en producción/staging.
  - `BACKUP_DB_RETENCION_DIAS` — retención en días (mínimo 7, default 14).

## Procedimiento de restauración (probado el 2026-08-01)

Probado restaurando el dump real de `conectar_app_prod` (66 MB, 94 tablas)
en una base scratch (`restore_prueba_231`) del mismo servidor RDS: todas las
tablas quedaron con los conteos exactos del momento del dump (p. ej.
pacientes 111.318, turnos 19.557, evoluciones 173.074, diagnósticos 217.388),
sin duplicados y con índices y constraints creados. La base scratch se
eliminó al terminar.

**Importante**: correr `pg_restore` de una sola vez y sin interrumpirlo. Si
se corta a mitad de camino y se relanza sin limpiar, las tablas ya cargadas
se duplican (usar `--clean --if-exists` o recrear la base destino).

1. **Descargar el dump** desde Object Storage (desde el workspace de Replit,
   que tiene acceso al bucket vía el sidecar):

   ```js
   // node, desde artifacts/api-server (usa el mismo cliente que la app)
   const { objectStorageClient } = await import("./src/lib/objectStorage");
   await objectStorageClient
     .bucket("<bucket>")
     .file(".private/backups/conectar_app_prod/<fecha>.dump")
     .download({ destination: "/tmp/restore.dump" });
   ```

   El bucket y el nombre exacto aparecen en `GET /api/backups-db/estado`.

2. **Crear la base destino** (nunca restaurar encima de la base viva; ante un
   desastre, restaurar a una base nueva y recién entonces renombrar/apuntar):

   ```sql
   CREATE DATABASE conectar_app_restaurada;
   ```

3. **Restaurar** con el `pg_restore` v18 (el módulo lo deja en
   `/tmp/pg18-tools/bin`, o usar la misma build portable):

   ```bash
   PGSSLMODE=require /tmp/pg18-tools/bin/pg_restore \
     --no-owner --no-privileges --jobs=4 \
     --dbname="postgresql://<usuario>@<host-rds>:5432/conectar_app_restaurada" \
     /tmp/restore.dump
   ```

   Notas:
   - `--no-owner --no-privileges` evita errores por roles que no existan.
   - Con ~66 MB de dump la restauración tarda varios minutos por el TLS al RDS.
   - Si la base destino ya tiene objetos, agregar `--clean --if-exists`.

4. **Verificar**: comparar conteos de filas de las tablas principales contra
   la base original (o contra lo esperado):

   ```sql
   SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC;
   ```

5. **Poner en servicio**: apuntar `CLINICA_DB_URL` (secreto del deployment) a
   la base restaurada, o renombrar bases (`ALTER DATABASE … RENAME TO …`) en
   una ventana sin tráfico, y reiniciar el deployment.

6. **Limpieza** (si fue un simulacro): `DROP DATABASE <scratch>;`

## Qué NO cubre

- Cambios posteriores al último dump diario (RPO ≈ 24 h). Para RPO menor hace
  falta confirmar PITR de RDS en la consola AWS.
- Bases distintas a la que usa la app (p. ej. otras bases del mismo servidor).
