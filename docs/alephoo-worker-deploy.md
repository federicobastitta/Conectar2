# Alephoo Worker — Guía de Despliegue AWS

**ECS Fargate Job · sa-east-1 · RDS PostgreSQL privado · S3 privado**

---

## Resumen

El `alephoo-worker` es un job de una sola ejecución (no un servidor permanente) que:
1. Aplica migraciones pendientes en `conectar-clinica-dev` (idempotente)
2. Lee el Excel Alephoo más reciente de S3 (`alephoo/raw/`)
3. Corre el pipeline: raw → staging → normalización → deduplicación → cuarentena
4. Sube reportes a S3 (`alephoo/staging/`, `alephoo/rechazados/`, `alephoo/conciliacion/`)
5. **Sin `--approve`**: termina en estado `pendiente_aprobacion` (nunca escribe pacientes)
6. **Con `--approve`**: incorpora las filas aprobadas a la base de datos clínica

La idempotencia se garantiza por SHA-256 del archivo Excel: re-ejecutar sobre el mismo archivo no hace nada si ya fue incorporado.

---

## Prerequisitos

- AWS CLI v2 + Docker + jq instalados
- IAM user/role con permisos suficientes para crear ECR, ECS, RDS, S3, IAM, Secrets Manager
- Contexto AWS: `aws configure` con el perfil correcto

---

## Despliegue inicial (una sola vez por entorno)

```bash
# Desde la raíz del repo
bash infra/aws/setup.sh dev       # entorno dev
bash infra/aws/setup.sh staging   # entorno staging
bash infra/aws/setup.sh prod      # producción
```

El script crea:
- Repositorio ECR `conectar/alephoo-worker` con escaneo on-push
- Bucket S3 `conectar-documentos-clinicos-{env}` privado y cifrado (AES256)
- RDS PostgreSQL 16 `conectar-clinica-{env}` (db.t4g.micro, 20 GB gp3, cifrado)
- Secret en Secrets Manager: `conectar/{env}/clinica-db-url`
- Log Group CloudWatch `/ecs/conectar/alephoo-worker` (retención 30 días)
- IAM Role `conectar-alephoo-worker-task` con políticas mínimas
- Cluster ECS `conectar-{env}`
- Task Definition `alephoo-worker` registrada

> **⚠️ Único paso externo requerido** (no automatizable sin credenciales en este repo):
> Ejecutar `bash infra/aws/setup.sh dev` con un AWS profile que tenga permisos de admin en la cuenta target.

---

## Actualizar la imagen (deploys subsiguientes)

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.sa-east-1.amazonaws.com/conectar/alephoo-worker"

aws ecr get-login-password --region sa-east-1 | \
  docker login --username AWS --password-stdin "${ECR_URI}"

docker build -f artifacts/alephoo-worker/Dockerfile \
  -t "${ECR_URI}:latest" \
  -t "${ECR_URI}:$(git rev-parse --short HEAD)" \
  .

docker push "${ECR_URI}:latest"
docker push "${ECR_URI}:$(git rev-parse --short HEAD)"
```

---

## Ejecutar el worker manualmente

### Staging (sin incorporación — solo estadísticas y reportes S3)

```bash
aws ecs run-task \
  --cluster conectar-dev \
  --task-definition alephoo-worker \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={
    subnets=["SUBNET_PRIVADA_ID"],
    securityGroups=["SG_WORKER_ID"]
  }' \
  --region sa-east-1
```

### Incorporación (con `--approve`)

```bash
aws ecs run-task \
  --cluster conectar-dev \
  --task-definition alephoo-worker \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={
    subnets=["SUBNET_PRIVADA_ID"],
    securityGroups=["SG_WORKER_ID"]
  }' \
  --overrides '{
    "containerOverrides": [{
      "name": "alephoo-worker",
      "command": ["--approve"]
    }]
  }' \
  --region sa-east-1
```

### Archivo específico

```bash
# Agregar a --overrides.containerOverrides:
"command": ["--key=alephoo/raw/mi-archivo.xlsx"]
```

---

## Variables de entorno requeridas en ECS Task Definition

| Variable | Fuente | Descripción |
|---|---|---|
| `CLINICA_DB_URL` | Secrets Manager | `postgresql://user:pass@host:5432/db?sslmode=require` |
| `CLINICA_DB_SSL_CA` | Secrets Manager (opcional) | Certificado CA del RDS (PEM) |
| `CLINICA_S3_BUCKET` | ECS env | `conectar-documentos-clinicos-{env}` |
| `CLINICA_S3_REGION` | ECS env | `sa-east-1` |
| `NODE_ENV` | ECS env | `production` |

Las credenciales AWS (acceso a S3 y Secrets Manager) provienen del **IAM Task Role** — nunca se configuran `AWS_ACCESS_KEY_ID` ni `AWS_SECRET_ACCESS_KEY`.

---

## Arquitectura de red AWS

```
VPC privada
├── Subnet privada (sin internet gateway directo)
│   ├── ECS Fargate Task (alephoo-worker)
│   └── RDS PostgreSQL (conectar-clinica-dev)
├── VPC Endpoints (para S3 y Secrets Manager sin salir a internet)
│   ├── com.amazonaws.sa-east-1.s3
│   ├── com.amazonaws.sa-east-1.secretsmanager
│   └── com.amazonaws.sa-east-1.ecr.dkr
└── Security Groups
    ├── SG-worker: outbound → SG-rds:5432, VPC endpoints, ECR (443)
    └── SG-rds: inbound ← SG-worker:5432 ONLY (nunca 0.0.0.0/0)
```

> El RDS **nunca** debe ser públicamente accesible. El parámetro `--no-publicly-accessible` está fijo en `setup.sh`.

---

## Pipeline de idempotencia

```
Excel subido a S3 (alephoo/raw/)
    ↓
Worker descarga el Excel
    ↓
SHA-256 del archivo
    ↓ ¿ya procesado?
    ├── estado=incorporado → SKIP (idempotente)
    ├── estado=pendiente_aprobacion → SKIP (requiere --approve)
    └── nuevo → pipeline completo
                    ↓
              lotes_importacion (tabla en clinica-db)
```

---

## Tabla lotes_importacion

Registra cada ejecución en `conectar-clinica-dev.lotes_importacion` con:
- `archivo_sha256` (unique) — garantía de idempotencia
- `estado` — máquina de estados: `iniciado → staging → pendiente_aprobacion → aprobado → incorporado | error`
- Contadores de filas por etapa
- Keys de reportes en S3
- `aprobado_por` / `aprobado_en` — trazabilidad de la aprobación

---

## Integración con api-server (Conectar)

El api-server de Conectar se conecta opcionalmente a clinica-db si `CLINICA_DB_URL` está configurada:

```
GET /api/healthz-clinica
→ { ok: true, db: "clinica_dev", enabled: true }   # si CLINICA_DB_URL está configurada
→ { ok: false, enabled: false, reason: "..." }      # si no está configurada
```

En dev (sin credenciales AWS), el endpoint devuelve `{ ok: false, enabled: false }` sin bloquear el arranque.

---

## Rollback

Para deshacer una incorporación errónea, conectarse directamente al RDS y ejecutar:

```sql
-- Ver filas del lote a deshacer
SELECT * FROM lotes_importacion WHERE id = <lote_id>;

-- Eliminar pacientes incorporados en ese lote (ajustar según el esquema)
-- SIEMPRE hacer en una transacción con BEGIN/ROLLBACK para verificar antes
BEGIN;
  DELETE FROM pacientes WHERE upload_id = '<upload_id>';
  -- verificar conteo antes de COMMIT
  SELECT COUNT(*) FROM pacientes WHERE upload_id = '<upload_id>';
ROLLBACK; -- o COMMIT si el conteo es correcto
```
