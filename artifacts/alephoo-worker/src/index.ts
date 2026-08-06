#!/usr/bin/env node
/**
 * Alephoo Worker — Entry point
 *
 * Uso:
 *   node dist/index.js                         # staging del Excel más reciente en S3
 *   node dist/index.js --dry-run               # staging sin escritura
 *   node dist/index.js --approve               # incorporar el lote pendiente
 *   node dist/index.js --key=alephoo/raw/x.xlsx   # archivo específico
 *   node dist/index.js --upload-id=xxx --approve  # aprobar lote por upload-id
 *
 * Variables requeridas:
 *   CLINICA_DB_URL     URL de conexión PostgreSQL (RDS conectar-clinica-dev)
 *   CLINICA_S3_BUCKET  Bucket S3 privado (conectar-documentos-clinicos-dev)
 *   CLINICA_S3_REGION  Región AWS (sa-east-1)
 *
 * En AWS: las credenciales provienen del IAM Task Role. NO configurar ACCESS_KEY_ID.
 */

import { loadConfig } from "./config.js";
import { correrWorker } from "./worker.js";
import { iniciarHealthServer, setHealthy, cerrarHealthServer } from "./health.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  iniciarHealthServer(cfg.healthPort);
  setHealthy(true, "corriendo");

  try {
    await correrWorker(cfg);
    setHealthy(true, "completado");
    console.log("[worker] Completado exitosamente.");
    process.exitCode = 0;
  } catch (err) {
    setHealthy(false, String(err));
    console.error("[worker] Falló con error:", err);
    process.exitCode = 1;
  } finally {
    cerrarHealthServer();
  }
}

main().catch((err) => {
  console.error("[worker] Error inesperado en main:", err);
  process.exit(2);
});
