/**
 * @workspace/clinica-db — Conectar Red Clínica Digital
 *
 * Infraestructura de base de datos clínica para conectar-clinica-dev (AWS RDS).
 *
 * Uso:
 *   import { initClinicaDB, runMigrations } from "@workspace/clinica-db";
 *
 * Configuración (variables de entorno requeridas):
 *   CLINICA_DB_URL o CLINICA_DB_HOST + _NAME + _USER + _PASSWORD
 *   CLINICA_DB_SSL_CA (requerido en staging/production)
 *   NODE_ENV (production | staging | development | test)
 *
 * Ver docs/clinica-db-informe.md para la guía de despliegue AWS completa.
 */

// Conexión y pool
export {
  initClinicaDB,
  getClinicaDB,
  getClinicaPool,
  createTestPool,
  closeClinicaDB,
  clinicaDBHealthCheck,
  withRetry,
} from "./connection.js";
export type { ClinicaDBConfig, HealthCheckResult, ClinicaDB } from "./connection.js";

// Migraciones
export { runMigrations, pendingMigrations } from "./migrations/runner.js";
export type { MigrationRecord, MigrationResult } from "./migrations/runner.js";

// Schema (tipos TypeScript)
export * from "./schema/index.js";

// S3
export {
  loadS3Config,
  buildDocumentoKey,
  buildAlephooKey,
  generatePresignedGetUrl,
  generatePresignedPutUrl,
  createS3Client,
} from "./s3/client.js";
export type { S3Config, S3ObjectMeta, PresignedUrlRequest } from "./s3/client.js";

// Pipeline Alephoo
export { ejecutarPipeline } from "./importacion/alephoo/index.js";
export type {
  FilaRaw,
  FilaAlephooStaging,
  FilaNormalizada,
  FilaCuarentena,
  ResultadoDedup,
  ResultadoIncorporacion,
  SesionImportacion,
  OpcionesPipeline,
  EstadoFilaPipeline,
  EstadoImportacion,
} from "./importacion/alephoo/index.js";
