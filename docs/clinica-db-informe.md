# `lib/clinica-db` — Informe de entrega v1.0

**Fecha:** 2026-07-20  
**Instalación objetivo:** `conectar-clinica-dev` en Amazon RDS PostgreSQL (privada, vacía al momento de este informe)  
**Estado:** Paquete construido y listo para migración. Sin conexión a producción. Sin datos reales.

---

## Qué se construyó

### Paquete `lib/clinica-db` (TypeScript, ESM, composite lib)

```
lib/clinica-db/
├── src/
│   ├── index.ts                              # Barrel de exportaciones públicas
│   ├── connection.ts                         # Pool PostgreSQL, TLS, health check, retry
│   ├── migrations/
│   │   ├── runner.ts                         # Runner idempotente con checksum SHA-256
│   │   ├── cli.ts                            # CLI para ejecutar desde terminal
│   │   └── sql/
│   │       ├── 001_foundation.sql            # Extensiones, tipos globales, triggers
│   │       ├── 002_pacientes.sql             # Índice maestro (UUID PK, soft-delete)
│   │       ├── 003_identificadores_externos.sql
│   │       ├── 004_contactos_coberturas.sql
│   │       ├── 005_consultas_episodios.sql
│   │       ├── 006_evoluciones.sql           # Versionado inmutable + firma + trigger
│   │       ├── 007_antecedentes_alergias_dx.sql
│   │       ├── 008_signos_vitales.sql        # Serie de tiempo append-only
│   │       ├── 009_medicacion_recetas.sql
│   │       ├── 010_ordenes_token_klinicos.sql # Órdenes + token hash SHA-256
│   │       ├── 011_estudios_informes.sql     # Sin DICOM; metadatos + S3 keys
│   │       ├── 012_documentos_adjuntos.sql   # Metadatos + hash; binarios en S3
│   │       ├── 013_consentimientos.sql
│   │       └── 014_usuarios_roles_auditoria.sql # RBAC + audit_log append-only
│   ├── schema/
│   │   ├── pacientes.ts                      # Drizzle ORM types
│   │   ├── episodios.ts
│   │   ├── evoluciones.ts
│   │   ├── documentos.ts
│   │   ├── usuarios.ts
│   │   └── auditoria.ts
│   ├── s3/
│   │   └── client.ts                         # Factory S3 (sin credenciales hardcoded)
│   └── importacion/alephoo/
│       ├── types.ts                          # Tipos del pipeline
│       ├── pipeline.ts                       # Orquestador 8 stages
│       └── stages/
│           ├── raw.ts                        # Lee Excel (buffer/S3)
│           ├── staging.ts                    # Mapeo columnas Alephoo → schema
│           ├── normalizacion.ts              # DNI, fechas, sexo, email
│           ├── deduplicacion.ts              # Intra-batch + contra DB
│           └── incorporacion.ts             # INSERT transaccional con auditoría
└── tests/
    ├── migrations.test.ts                    # 6 tests de migración
    ├── evoluciones.test.ts                   # 6 tests de inmutabilidad
    ├── auditoria.test.ts                     # 3 tests de audit_log
    ├── alephoo-pipeline.test.ts              # 13 tests de pipeline
    └── fixtures/
        ├── pacientes.ts                      # Datos ficticios
        └── excel-sample.ts                   # Filas Excel ficticias
```

---

## Tablas implementadas (14 migraciones, 22 tablas)

| Tabla | Descripción | Notas técnicas |
|---|---|---|
| `pacientes` | Índice maestro | UUID PK, DNI indexado no-PK, soft-delete |
| `identificadores_externos` | IDs en Alephoo/Pulso/Klinicos/PACS | Único por sistema + valor |
| `contactos` | Teléfonos, emails, domicilios | Indexado por email normalizado |
| `coberturas` | OS y prepagas del paciente | Con historial de vigencia |
| `episodios` | Agrupador de atenciones | Máquina de estados; no elimina físicamente |
| `episodio_transiciones` | Log de cambios de estado | Append-only |
| `evoluciones` | Nota clínica SOAP | **Trigger inmutabilidad** post-firma; versionado |
| `antecedentes` | Historial médico | Buscable por CIE-10 |
| `alergias` | Alergias activas | Flag `activa`, severity enum |
| `diagnosticos` | CIE-10 por episodio/evolución | Tipo presuntivo/definitivo/etc |
| `signos_vitales` | Serie de tiempo | Append-only; columnas tipadas para alertas |
| `medicaciones` | Medicación activa | Estados activa/suspendida/completada |
| `recetas` | Recetas emitidas | PDF en S3; hash en DB; estado máquina |
| `receta_items` | Ítems de receta | FK a recetas |
| `ordenes` | Órdenes de estudio/interconsulta | Accession number; PACS externo desacoplado |
| `tokens_klinicos` | Token validación Klinicos | **Solo hash SHA-256**; texto claro nunca persiste |
| `estudios` | Metadatos de estudios | DICOM UID; sin imágenes |
| `informes_estudios` | Informes médicos versionados | Inmutables post-firma; PDF en S3 |
| `documentos` | Adjuntos clínicos | Metadatos + SHA-256; binario en S3 |
| `documentos_accesos` | Log de descarga/visualización | Trazabilidad de acceso |
| `consentimientos` | Consentimientos informados | Estado legal; doc firmado en S3 |
| `usuarios` | Usuarios del sistema | bcrypt/argon2; MFA cifrado con KMS |
| `permisos_rol` | RBAC fino | Precargado con permisos mínimos por rol |
| `sesiones` | Sesiones activas | Token hasheado; no texto claro |
| `audit_log` | Log inmutable de auditoría | Triggers en tablas críticas; actor_id por transacción |
| `schema_migrations` | Control de migraciones | Version + checksum SHA-256 |

---

## Características técnicas

### Conexión PostgreSQL (TLS obligatorio en prod)
- Pool configurable por env vars: min/max conexiones, timeouts de conexión/idle/statement/lock
- TLS configurado via `CLINICA_DB_SSL_CA` (CA cert del RDS en PEM)
- Health check non-leaking: devuelve `{ok, latencyMs, serverVersion}` sin credenciales
- Retry con backoff exponencial para errores de red transitórios
- Pool de test aislado (`createTestPool`) — no comparte estado con el pool de producción

### Migraciones SQL versionadas
- Idempotentes: `CREATE ... IF NOT EXISTS` + `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`
- Transaccional: cada migración se aplica en una transacción; si falla se hace ROLLBACK
- Verificación de checksum SHA-256: si una migración ya aplicada fue modificada, lanza error crítico
- Soporte `--dry-run` para verificar qué se aplicaría sin ejecutar
- CLI standalone para usar en CI/CD o ECS task pre-start

### Evoluciones firmadas — inmutabilidad por trigger
```sql
-- Trigger protect_evolucion_firmada():
-- Si estado = 'firmada' y se intenta modificar subjetivo/objetivo/evaluacion/plan/
-- texto_libre/firmada_por/firmada_en/firma_hash → RAISE EXCEPTION 'evolucion_inmutable'
-- Las correcciones siempre crean una nueva versión (version_anterior_id → chain de versiones)
```

### Seguridad — tokens nunca en texto claro
- `tokens_klinicos.token_hash`: SHA-256 del token; texto claro se entrega al paciente en memoria únicamente
- `usuarios.password_hash`: bcrypt/argon2; texto claro nunca persiste
- `sesiones.token_hash`: SHA-256 del token de sesión
- `usuarios.mfa_secret_cifrado`: cifrado con AWS KMS

### S3 — binarios fuera de PostgreSQL
PostgreSQL almacena: `s3_bucket`, `s3_key`, `sha256`, `content_type`, `tamano_bytes`, `paginas`  
S3 almacena: el binario (PDF, imagen, Excel de importación)  
Las URLs de descarga (presigned) se generan bajo demanda y **nunca se persisten**.

### Auditoría automática
Tablas con trigger `audit_row()`: `evoluciones`, `recetas`, `informes_estudios`, `consentimientos`, `tokens_klinicos`, `usuarios`  
Cada entrada en `audit_log` incluye: tabla, operación, ID del registro, datos antes/después (JSONB), actor_id, actor_origen.  
El `actor_id` se configura por transacción: `SET LOCAL app.actor_id = 'uuid-del-usuario'`.

---

## Pipeline Alephoo — 8 stages

```
Excel en S3
    │
    ▼ raw       — Lee hoja Excel → FilaRaw[] (columnas tal como llegan)
    │
    ▼ staging   — Mapea columnas Alephoo → schema interno; detecta columnas sin mapeo
    │
    ▼ normalizacion — DNI sin puntos; fechas → ISO; sexo → enum; email lowercase
    │
    ▼ dedup     — Intra-batch (mismo DNI) + contra DB (nombre+fecha similitud ≥ 0.85)
    │
    ├─ duplicado_exacto  → omitir o cuarentena (configurable)
    ├─ duplicado_probable → cuarentena (configurable)
    └─ sin_duplicado     → aprobada
                │
                ▼ incorporacion — INSERT transaccional en pacientes + identificadores + coberturas
                                  Contexto de auditoría: SET LOCAL app.actor_id
```

---

## Variables de entorno requeridas

### Conexión RDS (ninguna con valor por defecto en código)

| Variable | Descripción | Obligatoria |
|---|---|---|
| `CLINICA_DB_URL` | Cadena completa (alternativa a los campos individuales) | Una u otra |
| `CLINICA_DB_HOST` | Host del RDS | Una u otra |
| `CLINICA_DB_PORT` | Puerto (default 5432) | No |
| `CLINICA_DB_NAME` | Nombre de la base | Sí |
| `CLINICA_DB_USER` | Usuario | Sí |
| `CLINICA_DB_PASSWORD` | Contraseña — inyectar desde Secrets Manager | Sí |
| `CLINICA_DB_SSL_CA` | CA cert PEM del RDS — inyectar desde SSM/Secrets | Sí en prod/staging |
| `CLINICA_DB_SSL_REJECT_UNAUTHORIZED` | `"false"` solo en dev sin CA | No |
| `CLINICA_DB_POOL_MIN` | Mínimo de conexiones (default 2) | No |
| `CLINICA_DB_POOL_MAX` | Máximo de conexiones (default 10) | No |

### S3

| Variable | Descripción |
|---|---|
| `CLINICA_S3_BUCKET` | Nombre del bucket privado |
| `CLINICA_S3_REGION` | Región AWS |
| `CLINICA_S3_PREFIX` | Prefijo base de keys (default "clinica") |
| `CLINICA_S3_PRESIGN_TTL_SECS` | TTL de presigned URLs (default 900) |

### Tests

| Variable | Descripción |
|---|---|
| `CLINICA_DB_TEST_URL` | URL de DB para tests (fallback a `DATABASE_URL`) |

---

## Despliegue en AWS VPC — pasos posteriores

### Pre-requisitos en AWS (a cargo del equipo de infraestructura)

1. **RDS PostgreSQL 16+** en subnet privada, security group que solo permite tráfico desde la VPC  
2. **Secrets Manager**: secreto `conectar/clinica-dev/db` con `{ "password": "...", "ca": "..." }`  
3. **S3 bucket** `conectar-clinica-dev-docs` con block public access, server-side encryption (SSE-S3 o SSE-KMS)  
4. **IAM Role** para el servicio con políticas: `secretsmanager:GetSecretValue`, `s3:GetObject`, `s3:PutObject` sobre los recursos específicos  
5. **VPC Endpoints** para S3 y Secrets Manager (tráfico nunca sale a internet)

### Pasos de despliegue

```bash
# 1. Obtener credenciales de Secrets Manager (en el contexto del IAM role)
export CLINICA_DB_PASSWORD=$(aws secretsmanager get-secret-value \
  --secret-id conectar/clinica-dev/db \
  --query SecretString --output text | jq -r .password)

export CLINICA_DB_SSL_CA=$(aws secretsmanager get-secret-value \
  --secret-id conectar/clinica-dev/db \
  --query SecretString --output text | jq -r .ca)

# 2. Configurar el resto de variables
export CLINICA_DB_HOST=conectar-clinica-dev.xxxxx.us-east-1.rds.amazonaws.com
export CLINICA_DB_NAME=clinica_dev
export CLINICA_DB_USER=clinica_app
export NODE_ENV=staging

# 3. Verificar pending migrations (dry-run)
pnpm --filter @workspace/clinica-db run migrate -- --dry-run

# 4. Aplicar migraciones
pnpm --filter @workspace/clinica-db run migrate

# 5. Verificar health check
node -e "
import('@workspace/clinica-db').then(async ({ initClinicaDB, clinicaDBHealthCheck }) => {
  const { pool } = initClinicaDB();
  const health = await clinicaDBHealthCheck(pool);
  console.log(JSON.stringify(health, null, 2));
  process.exit(health.ok ? 0 : 1);
});"
```

### Verificación de integridad de la migración

```bash
# Listar migraciones aplicadas y sus checksums
psql $CLINICA_DB_URL -c "
SELECT version, filename, applied_at, left(checksum_sha256, 12) || '...' AS checksum
FROM schema_migrations
ORDER BY version;"
```

---

## Separación DiagnosticPACS

La base `conectar-clinica-dev` **NO almacena imágenes DICOM**. La separación es:

| Sistema | Almacena | Conectar-clinica-dev almacena |
|---|---|---|
| DiagnosticPACS | Imágenes DICOM, series, instancias | `pacs_study_instance_uid`, `pacs_accession_number` (como texto) |
| S3 privado | PDF de informes, documentos clínicos | `s3_key`, `sha256`, metadatos |
| `conectar-clinica-dev` | Metadatos, estados, textos, identidad | Identificadores de referencia a PACS y S3 |

---

## Tests automatizados

```bash
# Correr todos los tests (requiere DATABASE_URL)
pnpm --filter @workspace/clinica-db run test

# Solo pipeline Alephoo (no requiere DB)
pnpm --filter @workspace/clinica-db run test -- --reporter=verbose tests/alephoo-pipeline.test.ts
```

**Cobertura:**
- `migrations.test.ts` — 5 tests: aplica 14 migraciones, idempotencia, 22 tablas, extensiones, dry-run, checksum
- `evoluciones.test.ts` — 6 tests: create borrador, editar en borrador, firmar, trigger inmutabilidad, nueva versión
- `auditoria.test.ts` — 3 tests: INSERT auditado, UPDATE con before/after JSONB, append-only
- `alephoo-pipeline.test.ts` — 13 tests: staging (4), normalización (8), dedup (3), integración (3)

---

## Lo que NO hace este paquete

- **No conecta a producción**: toda la configuración apunta a dev/test
- **No almacena credenciales**: todo por variables de entorno / Secrets Manager
- **No modifica la base Conectar existente** (`DATABASE_URL`): es un paquete separado con su propio pool
- **No gestiona imágenes DICOM**: DiagnosticPACS es externo e independiente
- **No expone endpoints HTTP**: es una biblioteca de infraestructura; los endpoints los implementa el API server

---

*Entrega: `lib/clinica-db` v1.0 — 2026-07-20. Para conectar al RDS real, proveer las variables de entorno documentadas y ejecutar el migration runner.*
