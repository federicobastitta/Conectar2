/**
 * CLI de migraciones — conectar-clinica-dev
 *
 * Uso:
 *   CLINICA_DB_URL=postgres://user:pass@host/db \
 *   CLINICA_DB_SSL_CA="$(cat rds-ca.pem)" \
 *   node --import tsx/esm src/migrations/cli.ts [--dry-run] [--pending]
 *
 * En AWS (ECS / EC2 con IAM):
 *   La contraseña se obtiene de Secrets Manager antes de invocar este script.
 *   El CA del RDS se monta como secreto o se obtiene de SSM.
 */

import pg from "pg";
import { runMigrations, pendingMigrations } from "./runner.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const showPending = args.includes("--pending");

async function main() {
  const connectionString = process.env.CLINICA_DB_URL;
  if (!connectionString) {
    console.error("Error: CLINICA_DB_URL no está configurado.");
    process.exit(1);
  }

  const sslCa = process.env.CLINICA_DB_SSL_CA;
  const { Pool } = pg;
  const pool = new Pool({
    connectionString,
    ssl: sslCa
      ? { rejectUnauthorized: true, ca: sslCa }
      : process.env.NODE_ENV === "development"
        ? false
        : { rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  try {
    if (showPending) {
      const pending = await pendingMigrations(pool);
      if (pending.length === 0) {
        console.log("✓ No hay migraciones pendientes.");
      } else {
        console.log(`Migraciones pendientes (${pending.length}):`);
        pending.forEach((v) => console.log(`  - ${v}`));
      }
      return;
    }

    await runMigrations(pool, { dryRun, log: console.log });
    if (dryRun) {
      console.log("\n[DRY RUN] No se aplicó nada. Quitá --dry-run para ejecutar.");
    }
  } catch (err) {
    console.error("Error durante la migración:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void main();
