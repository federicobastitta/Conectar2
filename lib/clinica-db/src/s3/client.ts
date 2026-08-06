/**
 * S3 client — conectar-clinica-dev
 *
 * Configuración exclusivamente por variables de entorno / IAM:
 *   CLINICA_S3_BUCKET       nombre del bucket privado
 *   CLINICA_S3_REGION       región AWS (ej: us-east-1)
 *   CLINICA_S3_PREFIX       prefijo base para todas las keys (ej: "clinica-dev")
 *   CLINICA_S3_PRESIGN_TTL_SECS   TTL de URLs presignadas (default 900 = 15 min)
 *
 * En AWS (ECS/EC2 con IAM):
 *   Las credenciales provienen del IAM role de la task/instance.
 *   NO se configuran ACCESS_KEY_ID ni SECRET_ACCESS_KEY en el código.
 *   La política IAM del role debe incluir:
 *     s3:GetObject, s3:PutObject, s3:DeleteObject sobre el bucket.
 *
 * En desarrollo local fuera de AWS:
 *   Usar AWS_PROFILE o variables de entorno AWS_ACCESS_KEY_ID +
 *   AWS_SECRET_ACCESS_KEY con credenciales temporales de un IAM user de dev.
 *   Nunca credenciales permanentes con permisos amplios.
 *
 * NUNCA incluir credenciales en código fuente, Dockerfiles ni en este repo.
 */

export interface S3Config {
  bucket: string;
  region: string;
  prefix: string;
  presignTtlSecs: number;
}

export function loadS3Config(): S3Config {
  const bucket = process.env.CLINICA_S3_BUCKET;
  const region = process.env.CLINICA_S3_REGION;

  if (!bucket || !region) {
    throw new Error(
      "[clinica-s3] CLINICA_S3_BUCKET y CLINICA_S3_REGION son requeridos. " +
        "Configurar como variables de entorno. Ver documentación de despliegue AWS.",
    );
  }

  return {
    bucket,
    region,
    prefix: process.env.CLINICA_S3_PREFIX ?? "clinica",
    presignTtlSecs: process.env.CLINICA_S3_PRESIGN_TTL_SECS
      ? parseInt(process.env.CLINICA_S3_PRESIGN_TTL_SECS, 10)
      : 900,
  };
}

/**
 * Construye la S3 key para un documento clínico.
 * Estructura: {prefix}/{año}/{mes}/{pacienteId}/{tipo}/{uuid}.{ext}
 * Esta convención facilita policies de bucket y lifecycle rules por fecha.
 */
export function buildDocumentoKey(params: {
  prefix: string;
  pacienteId: string;
  tipo: string;
  documentoId: string;
  extension: string;
  fecha?: Date;
}): string {
  const d = params.fecha ?? new Date();
  const anio = d.getUTCFullYear();
  const mes = String(d.getUTCMonth() + 1).padStart(2, "0");
  const tipoNorm = params.tipo.replace(/_/g, "-").toLowerCase();
  const ext = params.extension.replace(/^\./, "");
  return [
    params.prefix,
    String(anio),
    mes,
    params.pacienteId,
    tipoNorm,
    `${params.documentoId}.${ext}`,
  ].join("/");
}

/**
 * Construye la S3 key para archivos de importación Alephoo.
 * Estructura: {prefix}/importacion/alephoo/{año}/{mes}/{uploadId}.{ext}
 */
export function buildAlephooKey(params: {
  prefix: string;
  uploadId: string;
  extension: string;
  fecha?: Date;
}): string {
  const d = params.fecha ?? new Date();
  const anio = d.getUTCFullYear();
  const mes = String(d.getUTCMonth() + 1).padStart(2, "0");
  const ext = params.extension.replace(/^\./, "");
  return [
    params.prefix,
    "importacion",
    "alephoo",
    String(anio),
    mes,
    `${params.uploadId}.${ext}`,
  ].join("/");
}

/**
 * Metadatos de un objeto S3 para registrar en PostgreSQL.
 * NO incluye presigned URLs ni credenciales — se generan bajo demanda.
 */
export interface S3ObjectMeta {
  bucket: string;
  key: string;
  versionId?: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  etag?: string;
  uploadedAt: Date;
}

/**
 * Descripción de una operación de presigned URL.
 * La URL en sí se genera en el backend y se devuelve al cliente; no se persiste.
 */
export interface PresignedUrlRequest {
  bucket: string;
  key: string;
  operation: "get" | "put";
  contentType?: string;
  ttlSecs?: number;
}

/**
 * Factory de cliente S3 — carga dinámica para no romper builds sin aws-sdk.
 * En producción aws-sdk debe estar en node_modules del servicio que lo use.
 */
export async function createS3Client(cfg?: S3Config) {
  const config = cfg ?? loadS3Config();

  // Importación dinámica — @aws-sdk/client-s3 es peer dependency opcional
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { S3Client } = await (import("@aws-sdk/client-s3") as Promise<any>).catch(() => {
    throw new Error(
      "[clinica-s3] @aws-sdk/client-s3 no está instalado en el servicio que usa S3. " +
        "Instalar con: pnpm --filter @workspace/api-server add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner",
    );
  }) as { S3Client: new (cfg: { region: string }) => unknown };

  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    client: new S3Client({ region: config.region }),
    config,
  };
}

/**
 * Genera una presigned URL para GET (descarga temporal).
 * La URL expira; nunca se almacena en la base de datos.
 */
export async function generatePresignedGetUrl(params: {
  bucket: string;
  key: string;
  ttlSecs?: number;
  config?: S3Config;
}): Promise<string> {
  const cfg = params.config ?? loadS3Config();
  const { client } = await createS3Client(cfg);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { getSignedUrl } = await (import("@aws-sdk/s3-request-presigner") as Promise<any>) as { getSignedUrl: (client: unknown, cmd: unknown, opts: unknown) => Promise<string> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { GetObjectCommand } = await (import("@aws-sdk/client-s3") as Promise<any>) as { GetObjectCommand: new (cfg: unknown) => unknown };

  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: params.bucket, Key: params.key }),
    { expiresIn: params.ttlSecs ?? cfg.presignTtlSecs },
  );
}

/**
 * Genera una presigned URL para PUT (subida temporal).
 * El cliente sube directamente a S3; el backend nunca maneja el binario.
 */
export async function generatePresignedPutUrl(params: {
  bucket: string;
  key: string;
  contentType: string;
  ttlSecs?: number;
  config?: S3Config;
}): Promise<{ url: string; key: string; expiresAt: Date }> {
  const cfg = params.config ?? loadS3Config();
  const { client } = await createS3Client(cfg);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { getSignedUrl } = await (import("@aws-sdk/s3-request-presigner") as Promise<any>) as { getSignedUrl: (client: unknown, cmd: unknown, opts: unknown) => Promise<string> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { PutObjectCommand } = await (import("@aws-sdk/client-s3") as Promise<any>) as { PutObjectCommand: new (cfg: unknown) => unknown };
  const ttl = params.ttlSecs ?? cfg.presignTtlSecs;

  const url = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      ContentType: params.contentType,
    }),
    { expiresIn: ttl },
  );

  return {
    url,
    key: params.key,
    expiresAt: new Date(Date.now() + ttl * 1000),
  };
}
