/**
 * Conexión a conectar-clinica-dev (AWS RDS PostgreSQL).
 * Usa TLS en staging/production. En AWS: IAM Role, no credenciales fijas.
 */

import { Pool } from "pg";
import type { WorkerConfig } from "./config.js";

let pool: Pool | null = null;

export async function conectarDB(cfg: WorkerConfig): Promise<Pool> {
  if (pool) return pool;

  const sslOpts =
    cfg.nodeEnv === "production" || cfg.nodeEnv === "staging"
      ? {
          ssl: cfg.clinicaDbSslCa
            ? { rejectUnauthorized: true, ca: cfg.clinicaDbSslCa }
            : { rejectUnauthorized: true },
        }
      : cfg.clinicaDbSslCa
        ? { ssl: { rejectUnauthorized: false, ca: cfg.clinicaDbSslCa } }
        : {};

  pool = new Pool({
    connectionString: cfg.clinicaDbUrl,
    ...sslOpts,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });

  // Verificar conectividad
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT version(), current_database()");
    const row = res.rows[0] as { version: string; current_database: string };
    console.log(`[db] Conectado a ${row.current_database}`);
    console.log(`[db] PostgreSQL: ${row.version.split(",")[0]}`);
  } finally {
    client.release();
  }

  return pool;
}

export async function cerrarDB(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
