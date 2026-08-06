#!/usr/bin/env bash
# ============================================================================
# infra/aws/setup.sh — Infraestructura reproducible para Conectar en AWS
# ============================================================================
# Requiere: AWS CLI v2, jq, Docker
# Entorno: sa-east-1 (São Paulo)
# Ejecutar desde la raíz del repo: bash infra/aws/setup.sh [dev|staging|prod]
# ============================================================================
set -euo pipefail

ENV="${1:-dev}"
REGION="sa-east-1"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_REPO="conectar/alephoo-worker"
CLUSTER_NAME="conectar-${ENV}"
S3_BUCKET="conectar-documentos-clinicos-${ENV}"
RDS_ID="conectar-clinica-${ENV}"
RDS_DB="clinica_${ENV}"
RDS_USER="clinica_app"
SECRET_DB_URL="conectar/${ENV}/clinica-db-url"
SECRET_SSL_CA="conectar/${ENV}/rds-ca-cert"
LOG_GROUP="/ecs/conectar/alephoo-worker"

echo "=== Conectar — Setup AWS ${ENV} (${REGION}) ==="
echo "Account: ${ACCOUNT_ID}"
echo ""

# ── 1. ECR ───────────────────────────────────────────────────────────────────
echo "[1/9] Creando repositorio ECR..."
aws ecr describe-repositories --repository-names "${ECR_REPO}" --region "${REGION}" 2>/dev/null || \
  aws ecr create-repository \
    --repository-name "${ECR_REPO}" \
    --region "${REGION}" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256

ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"
echo "    ECR: ${ECR_URI}"

# ── 2. S3 ────────────────────────────────────────────────────────────────────
echo "[2/9] Creando bucket S3..."
aws s3api head-bucket --bucket "${S3_BUCKET}" 2>/dev/null || \
  aws s3api create-bucket \
    --bucket "${S3_BUCKET}" \
    --region "${REGION}" \
    --create-bucket-configuration LocationConstraint="${REGION}"

aws s3api put-bucket-encryption --bucket "${S3_BUCKET}" \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-public-access-block --bucket "${S3_BUCKET}" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "    Bucket: s3://${S3_BUCKET}"

# ── 3. RDS PostgreSQL ─────────────────────────────────────────────────────────
echo "[3/9] Verificando RDS..."
if ! aws rds describe-db-instances --db-instance-identifier "${RDS_ID}" --region "${REGION}" 2>/dev/null; then
  echo "    RDS no existe. Creando ${RDS_ID} (puede tardar ~10 min)..."
  RDS_PASSWORD="$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 32)"

  aws rds create-db-instance \
    --db-instance-identifier "${RDS_ID}" \
    --db-instance-class db.t4g.micro \
    --engine postgres \
    --engine-version "16.4" \
    --master-username "${RDS_USER}" \
    --master-user-password "${RDS_PASSWORD}" \
    --db-name "${RDS_DB}" \
    --allocated-storage 20 \
    --storage-type gp3 \
    --storage-encrypted \
    --no-publicly-accessible \
    --backup-retention-period 7 \
    --region "${REGION}"

  echo "    ⏳ Esperando que RDS esté disponible..."
  aws rds wait db-instance-available --db-instance-identifier "${RDS_ID}" --region "${REGION}"
  
  RDS_ENDPOINT="$(aws rds describe-db-instances --db-instance-identifier "${RDS_ID}" \
    --query 'DBInstances[0].Endpoint.Address' --output text --region "${REGION}")"
  DB_URL="postgresql://${RDS_USER}:${RDS_PASSWORD}@${RDS_ENDPOINT}:5432/${RDS_DB}?sslmode=require"

  echo "[4/9] Guardando credenciales en Secrets Manager..."
  aws secretsmanager create-secret --name "${SECRET_DB_URL}" \
    --secret-string "${DB_URL}" --region "${REGION}" 2>/dev/null || \
  aws secretsmanager put-secret-value --secret-id "${SECRET_DB_URL}" \
    --secret-string "${DB_URL}" --region "${REGION}"

  echo "    RDS Endpoint: ${RDS_ENDPOINT}"
  echo "    ⚠️  Guardar la contraseña de RDS en un gestor de credenciales seguro."
else
  echo "    RDS ${RDS_ID} ya existe."
fi

# ── 4. CloudWatch Log Group ───────────────────────────────────────────────────
echo "[5/9] Creando Log Group CloudWatch..."
aws logs create-log-group --log-group-name "${LOG_GROUP}" --region "${REGION}" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "${LOG_GROUP}" --retention-in-days 30 --region "${REGION}"

# ── 5. IAM Roles ─────────────────────────────────────────────────────────────
echo "[6/9] IAM Roles..."
TRUST_ECS='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam create-role --role-name "conectar-alephoo-worker-task" \
  --assume-role-policy-document "${TRUST_ECS}" 2>/dev/null || true

aws iam put-role-policy --role-name "conectar-alephoo-worker-task" \
  --policy-name "alephoo-worker-task-policy" \
  --policy-document "$(cat infra/aws/iam-policies.json | jq .TaskRolePolicy)"

# ── 6. ECS Cluster ────────────────────────────────────────────────────────────
echo "[7/9] ECS Cluster..."
aws ecs describe-clusters --clusters "${CLUSTER_NAME}" --region "${REGION}" | \
  jq -e '.clusters[0].status == "ACTIVE"' 2>/dev/null || \
  aws ecs create-cluster --cluster-name "${CLUSTER_NAME}" \
    --capacity-providers FARGATE FARGATE_SPOT --region "${REGION}"

# ── 7. Build + Push imagen ────────────────────────────────────────────────────
echo "[8/9] Build + Push Docker image..."
aws ecr get-login-password --region "${REGION}" | \
  docker login --username AWS --password-stdin "${ECR_URI}"

docker build -f artifacts/alephoo-worker/Dockerfile \
  -t "${ECR_URI}:latest" \
  -t "${ECR_URI}:$(git rev-parse --short HEAD)" \
  .

docker push "${ECR_URI}:latest"
docker push "${ECR_URI}:$(git rev-parse --short HEAD)"

# ── 8. Registrar ECS Task Definition ─────────────────────────────────────────
echo "[9/9] Registrando ECS Task Definition..."
TASK_DEF=$(cat infra/aws/ecs-task-def.json | \
  sed "s/ACCOUNT_ID/${ACCOUNT_ID}/g")

aws ecs register-task-definition \
  --cli-input-json "${TASK_DEF}" \
  --region "${REGION}"

echo ""
echo "=== ✅ Setup completo para entorno: ${ENV} ==="
echo ""
echo "Para ejecutar el worker manualmente (staging, sin incorporación):"
echo "  aws ecs run-task \\"
echo "    --cluster ${CLUSTER_NAME} \\"
echo "    --task-definition alephoo-worker \\"
echo "    --launch-type FARGATE \\"
echo "    --network-configuration 'awsvpcConfiguration={subnets=[SUBNET_ID],securityGroups=[SG_ID]}' \\"
echo "    --region ${REGION}"
echo ""
echo "Para incorporar (requiere --approve):"
echo "  Agregar a la llamada: --overrides '{\"containerOverrides\":[{\"name\":\"alephoo-worker\",\"command\":[\"--approve\"]}]}'"
