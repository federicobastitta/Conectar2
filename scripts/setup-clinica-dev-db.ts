#!/usr/bin/env node
/**
 * setup-clinica-dev-db.ts
 *
 * Crea la base de datos de desarrollo (clinica_dev) en el mismo servidor RDS
 * y aplica todas las migraciones de @workspace/clinica-db.
 *
 * Uso:
 *   CLINICA_DB_URL=postgres://user:pass@host/postgres \
 *   node --import tsx/esm scripts/setup-clinica-dev-db.ts [--db-name clinica_dev]
 *
 * Prerequisitos:
 *   - CLINICA_DB_URL debe apuntar a una base existente en el RDS (ej: "postgres")
 *     con un usuario que tenga permisos CREATE DATABASE.
 *   - TLS habilitado (se usa el CA embebido en @workspace/db).
 *
 * Resultado:
 *   - Crea la base <DEV_DB_NAME> si no existe.
 *   - Aplica todas las migraciones SQL de lib/clinica-db/src/migrations/sql/.
 *   - Imprime la URL de conexión final para configurar CLINICA_DEV_DB_URL.
 */

import pg from "pg";
import { RDS_CA } from "@workspace/db";
import { runMigrations } from "@workspace/clinica-db/migrations";

const { Client, Pool } = pg;

// ── Parámetros ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const dbNameIdx = argv.indexOf("--db-name");
const DEV_DB_NAME = dbNameIdx !== -1 ? argv[dbNameIdx + 1] : "clinica_dev";

if (!DEV_DB_NAME || !/^[a-z_][a-z0-9_]*$/.test(DEV_DB_NAME)) {
  console.error(`Error: nombre de base inválido: "${DEV_DB_NAME}"`);
  process.exit(1);
}

const adminUrl = process.env.CLINICA_DB_URL;
if (!adminUrl) {
  console.error("Error: CLINICA_DB_URL no está configurada.");
  console.error("  Ejemplo: CLINICA_DB_URL=postgres://user:pass@host/postgres node --import tsx/esm scripts/setup-clinica-dev-db.ts");
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildDevUrl(baseUrl: string, dbName: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${dbName}`;
  u.searchParams.delete("sslmode");
  return u.toString();
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔧 setup-clinica-dev-db — destino: ${DEV_DB_NAME}\n`);

  const sslConfig = { ca: RDS_CA };

  // 1. Conectar al servidor (base admin) para crear la base de dev si no existe
  console.log("1. Verificando si la base ya existe…");
  const adminClient = new Client({
    connectionString: adminUrl,
    ssl: sslConfig,
    connectionTimeoutMillis: 10_000,
  });

  await adminClient.connect();
  try {
    const { rows } = await adminClient.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [DEV_DB_NAME],
    );
    if (rows[0].exists) {
      console.log(`   ✓ La base "${DEV_DB_NAME}" ya existe — omitiendo CREATE DATABASE`);
    } else {
      console.log(`   → Creando base "${DEV_DB_NAME}"…`);
      // CREATE DATABASE no puede correr en una transacción
      await adminClient.query(`CREATE DATABASE ${DEV_DB_NAME}`);
      console.log(`   ✓ Base "${DEV_DB_NAME}" creada`);
    }
  } finally {
    await adminClient.end();
  }

  // 2. Conectar a la nueva base y aplicar migraciones
  const devUrl = buildDevUrl(adminUrl, DEV_DB_NAME);
  console.log(`\n2. Conectando a "${DEV_DB_NAME}" y aplicando migraciones…\n`);

  const devPool = new Pool({
    connectionString: devUrl,
    ssl: sslConfig,
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  try {
    const result = await runMigrations(devPool, {
      log: (msg) => console.log("  " + msg),
    });

    console.log("\n✅ Migraciones completadas:");
    console.log(`   Aplicadas : ${result.applied.length}`);
    console.log(`   Saltadas  : ${result.skipped.length}`);
  } finally {
    await devPool.end();
  }

  // 3. Mostrar la URL para configurar la variable de entorno
  // No imprimir credenciales — solo host y base
  const displayUrl = buildDevUrl(adminUrl, DEV_DB_NAME).replace(/:\/\/[^@]+@/, "://***:***@");
  console.log("\n──────────────────────────────────────────────────────────────");
  console.log("Configurá esta variable de entorno en el entorno de desarrollo:");
  console.log(`\n  CLINICA_DEV_DB_URL=${displayUrl}\n`);
  console.log("Podés configurarla en Replit → Secrets con el valor completo.");
  console.log("──────────────────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message ?? err);
  process.exit(1);
});
