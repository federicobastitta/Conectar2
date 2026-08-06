/**
 * Configuración del Alephoo Worker — 100% por variables de entorno.
 * Nunca credenciales hardcodeadas. En AWS usa IAM Role (ECS Task Role).
 */

export interface WorkerConfig {
  nodeEnv: "development" | "staging" | "production" | "test";
  clinicaDbUrl: string;
  clinicaDbSslCa: string | undefined;
  s3Bucket: string;
  s3Region: string;
  s3RawPrefix: string;
  s3ReportesPrefix: string;
  s3RechazadosPrefix: string;
  s3ConciliacionPrefix: string;
  approve: boolean;
  dryRun: boolean;
  s3Key: string | undefined;
  uploadId: string | undefined;
  iniciadoPor: string;
  healthPort: number;
}

export function loadConfig(): WorkerConfig {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as WorkerConfig["nodeEnv"];

  let clinicaDbUrl = process.env.CLINICA_DB_URL ?? "";
  // Si CLINICA_DB_PASSWORD está seteada, pisa la contraseña embebida en la URL
  // de AWS (rotación de clave con UN solo secreto). No aplica al DATABASE_URL local.
  const passOverride = process.env.CLINICA_DB_PASSWORD?.trim();
  if (clinicaDbUrl && passOverride) {
    try {
      const u = new URL(clinicaDbUrl);
      u.password = encodeURIComponent(passOverride);
      clinicaDbUrl = u.toString();
    } catch {
      // URL no parseable — se usa tal cual
    }
  }
  if (!clinicaDbUrl) clinicaDbUrl = process.env.DATABASE_URL ?? "";
  if (!clinicaDbUrl) {
    throw new Error(
      "[alephoo-worker] CLINICA_DB_URL es requerida. " +
        "En AWS: configurar en ECS Task Definition o via Secrets Manager. " +
        "En dev: exportar la variable antes de correr el worker.",
    );
  }

  const s3Bucket = process.env.CLINICA_S3_BUCKET ?? "conectar-documentos-clinicos-dev";
  const s3Region = process.env.CLINICA_S3_REGION ?? "sa-east-1";

  const args = process.argv.slice(2);
  const approve = args.includes("--approve");
  const dryRun = args.includes("--dry-run");

  const keyArg = args.find((a) => a.startsWith("--key="))?.split("=")[1];
  const uploadIdArg = args.find((a) => a.startsWith("--upload-id="))?.split("=")[1];

  return {
    nodeEnv,
    clinicaDbUrl,
    clinicaDbSslCa: process.env.CLINICA_DB_SSL_CA,
    s3Bucket,
    s3Region,
    s3RawPrefix: process.env.ALEPHOO_S3_RAW_PREFIX ?? "alephoo/raw",
    s3ReportesPrefix: process.env.ALEPHOO_S3_STAGING_PREFIX ?? "alephoo/staging",
    s3RechazadosPrefix: process.env.ALEPHOO_S3_RECHAZADOS_PREFIX ?? "alephoo/rechazados",
    s3ConciliacionPrefix: process.env.ALEPHOO_S3_CONCILIACION_PREFIX ?? "alephoo/conciliacion",
    approve,
    dryRun,
    s3Key: keyArg ?? process.env.ALEPHOO_S3_KEY,
    uploadId: uploadIdArg ?? process.env.ALEPHOO_UPLOAD_ID,
    iniciadoPor: process.env.ALEPHOO_INICIADO_POR ?? "worker-automatico",
    healthPort: parseInt(process.env.PORT ?? "3099", 10),
  };
}
