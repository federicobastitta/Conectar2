/**
 * Capa de conexión PostgreSQL — conectar-clinica-dev (AWS RDS)
 *
 * Configuración exclusivamente por variables de entorno:
 *   CLINICA_DB_URL            cadena completa (prioridad si existe)
 *   CLINICA_DB_HOST           host del RDS
 *   CLINICA_DB_PORT           puerto (default 5432)
 *   CLINICA_DB_NAME           nombre de la base
 *   CLINICA_DB_USER           usuario
 *   CLINICA_DB_PASSWORD       contraseña (Secrets Manager en AWS)
 *   CLINICA_DB_SSL_CA         CA certificate en PEM (string), requerido en prod/staging
 *   CLINICA_DB_SSL_REJECT_UNAUTHORIZED  "false" solo en dev local sin CA (default true)
 *   CLINICA_DB_POOL_MIN       mínimo de conexiones (default 2)
 *   CLINICA_DB_POOL_MAX       máximo de conexiones (default 10)
 *   CLINICA_DB_CONNECT_TIMEOUT_MS  timeout de conexión ms (default 5000)
 *   CLINICA_DB_IDLE_TIMEOUT_MS     timeout de idle ms (default 30000)
 *   CLINICA_DB_STATEMENT_TIMEOUT_MS statement timeout ms (default 30000)
 *   CLINICA_DB_LOCK_TIMEOUT_MS     lock timeout ms (default 5000)
 *   NODE_ENV                  "production" | "staging" | "development" | "test"
 *
 * En AWS, la contraseña se inyecta vía:
 *   - ECS Task Definition → SecretOptions → CLINICA_DB_PASSWORD desde Secrets Manager
 *   - Lambda → env var desde SSM Parameter Store
 *   - EC2 → IAM instance profile + Secrets Manager SDK (app obtiene el secreto al arrancar)
 *
 * NUNCA incluir credenciales en código fuente, Dockerfiles, ni en este repo.
 */

import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";

export type ClinicaSchema = typeof schema;
export type ClinicaDB = NodePgDatabase<ClinicaSchema>;

const { Pool } = pg;

// ── Configuración ─────────────────────────────────────────────────────────────

export interface ClinicaDBConfig {
  /** Entorno — afecta comportamiento TLS y logging */
  env: "production" | "staging" | "development" | "test";
  /** Cadena de conexión completa (tiene prioridad sobre los campos individuales) */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** CA certificate PEM para TLS (requerido en production/staging) */
  sslCa?: string;
  /** Rechazar certificados inválidos (default true; false solo en dev sin CA) */
  sslRejectUnauthorized?: boolean;
  poolMin?: number;
  poolMax?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

function loadConfigFromEnv(): ClinicaDBConfig {
  const env = (process.env.NODE_ENV ?? "development") as ClinicaDBConfig["env"];
  const sslRejectUnauthorized =
    process.env.CLINICA_DB_SSL_REJECT_UNAUTHORIZED !== "false";

  return {
    env,
    connectionString: process.env.CLINICA_DB_URL,
    host: process.env.CLINICA_DB_HOST,
    port: process.env.CLINICA_DB_PORT ? parseInt(process.env.CLINICA_DB_PORT, 10) : 5432,
    database: process.env.CLINICA_DB_NAME,
    user: process.env.CLINICA_DB_USER,
    password: process.env.CLINICA_DB_PASSWORD,
    sslCa: process.env.CLINICA_DB_SSL_CA,
    sslRejectUnauthorized,
    poolMin: process.env.CLINICA_DB_POOL_MIN ? parseInt(process.env.CLINICA_DB_POOL_MIN, 10) : 2,
    poolMax: process.env.CLINICA_DB_POOL_MAX ? parseInt(process.env.CLINICA_DB_POOL_MAX, 10) : 10,
    connectTimeoutMs: process.env.CLINICA_DB_CONNECT_TIMEOUT_MS
      ? parseInt(process.env.CLINICA_DB_CONNECT_TIMEOUT_MS, 10)
      : 5_000,
    idleTimeoutMs: process.env.CLINICA_DB_IDLE_TIMEOUT_MS
      ? parseInt(process.env.CLINICA_DB_IDLE_TIMEOUT_MS, 10)
      : 30_000,
    statementTimeoutMs: process.env.CLINICA_DB_STATEMENT_TIMEOUT_MS
      ? parseInt(process.env.CLINICA_DB_STATEMENT_TIMEOUT_MS, 10)
      : 30_000,
    lockTimeoutMs: process.env.CLINICA_DB_LOCK_TIMEOUT_MS
      ? parseInt(process.env.CLINICA_DB_LOCK_TIMEOUT_MS, 10)
      : 5_000,
  };
}

function buildSslConfig(cfg: ClinicaDBConfig): pg.PoolConfig["ssl"] {
  const isProduction = cfg.env === "production" || cfg.env === "staging";

  // En producción y staging, TLS es obligatorio e irrenunciable.
  if (isProduction && !cfg.sslCa && cfg.sslRejectUnauthorized !== false) {
    // RDS usa certificados firmados por Amazon Root CA — si no se provee CA,
    // pg usará el store de sistema que puede no incluirlo.
    // Se recomienda siempre proveer CLINICA_DB_SSL_CA.
    console.warn(
      "[clinica-db] ADVERTENCIA: CLINICA_DB_SSL_CA no configurado en entorno productivo. " +
        "Si el certificado RDS no está en el store del sistema, la conexión fallará.",
    );
  }

  if (!cfg.sslCa && cfg.env === "development" && cfg.sslRejectUnauthorized === false) {
    // Dev local sin TLS real (ej: RDS con SSL desactivado temporalmente)
    return false;
  }

  return {
    rejectUnauthorized: cfg.sslRejectUnauthorized ?? true,
    ...(cfg.sslCa ? { ca: cfg.sslCa } : {}),
  };
}

function buildPoolConfig(cfg: ClinicaDBConfig): pg.PoolConfig {
  const ssl = buildSslConfig(cfg);
  const base: pg.PoolConfig = {
    ssl,
    min: cfg.poolMin,
    max: cfg.poolMax,
    connectionTimeoutMillis: cfg.connectTimeoutMs,
    idleTimeoutMillis: cfg.idleTimeoutMs,
    // statement_timeout y lock_timeout se aplican por sesión (ver onConnect)
  };

  if (cfg.connectionString) {
    // Si hay contraseña explícita (CLINICA_DB_PASSWORD), pisa la embebida en la
    // URL: permite rotar la clave del RDS actualizando UN solo secreto.
    let connectionString = cfg.connectionString;
    const passOverride = cfg.password?.trim();
    if (passOverride) {
      try {
        const u = new URL(connectionString);
        u.password = encodeURIComponent(passOverride);
        connectionString = u.toString();
      } catch {
        // URL no parseable — se usa tal cual
      }
    }
    return { ...base, connectionString };
  }

  if (!cfg.host || !cfg.database || !cfg.user) {
    throw new Error(
      "[clinica-db] Configuración incompleta. Proveer CLINICA_DB_URL o los campos " +
        "CLINICA_DB_HOST, CLINICA_DB_NAME, CLINICA_DB_USER, CLINICA_DB_PASSWORD.",
    );
  }

  return {
    ...base,
    host: cfg.host,
    port: cfg.port ?? 5432,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
  };
}

// ── Pool singleton ────────────────────────────────────────────────────────────

let _pool: pg.Pool | null = null;
let _db: ClinicaDB | null = null;

/**
 * Inicializa el pool de conexiones. Llamar una sola vez al arrancar la aplicación.
 * Los tests deben usar createTestPool() en su lugar.
 */
export function initClinicaDB(overrides?: Partial<ClinicaDBConfig>): {
  pool: pg.Pool;
  db: ClinicaDB;
} {
  if (_pool) return { pool: _pool, db: _db! };

  const cfg = { ...loadConfigFromEnv(), ...overrides };
  const poolConfig = buildPoolConfig(cfg);

  _pool = new Pool(poolConfig);

  // Aplicar timeouts de sesión en cada nueva conexión
  _pool.on("connect", async (client) => {
    await client.query(
      `SET statement_timeout = ${cfg.statementTimeoutMs ?? 30_000};
       SET lock_timeout = ${cfg.lockTimeoutMs ?? 5_000};`,
    );
  });

  _pool.on("error", (err) => {
    console.error("[clinica-db] Pool error:", err.message);
  });

  _db = drizzle(_pool, { schema, logger: cfg.env === "development" });
  return { pool: _pool, db: _db };
}

/** Pool y DB tipados para uso directo (requiere haber llamado initClinicaDB) */
export function getClinicaDB(): ClinicaDB {
  if (!_db) throw new Error("[clinica-db] initClinicaDB() no fue llamado.");
  return _db;
}

export function getClinicaPool(): pg.Pool {
  if (!_pool) throw new Error("[clinica-db] initClinicaDB() no fue llamado.");
  return _pool;
}

/**
 * Crea un pool aislado para tests, usando la variable de entorno
 * CLINICA_DB_TEST_URL o DATABASE_URL como fallback.
 * Los tests NO usan el pool singleton.
 */
export function createTestPool(): { pool: pg.Pool; db: ClinicaDB } {
  const connectionString =
    process.env.CLINICA_DB_TEST_URL ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "[clinica-db] Tests requieren CLINICA_DB_TEST_URL o DATABASE_URL.",
    );
  }

  const pool = new Pool({
    connectionString,
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });

  pool.on("error", (err) => {
    console.error("[clinica-db:test] Pool error:", err.message);
  });

  const db = drizzle(pool, { schema });
  return { pool, db };
}

/**
 * Cierra el pool singleton de forma limpia. Llamar en SIGTERM/SIGINT.
 */
export async function closeClinicaDB(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

// ── Health check ──────────────────────────────────────────────────────────────

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string;
  error?: string;
}

/**
 * Verifica conectividad al RDS. Seguro para endpoints /health en ALB/NLB.
 * No expone información sensible en el resultado.
 */
export async function clinicaDBHealthCheck(
  pool?: pg.Pool,
): Promise<HealthCheckResult> {
  const p = pool ?? _pool;
  if (!p) {
    return { ok: false, latencyMs: 0, error: "pool_not_initialized" };
  }

  const t0 = Date.now();
  try {
    const result = await p.query<{ version: string }>(
      "SELECT version() AS version",
    );
    const latencyMs = Date.now() - t0;
    const raw = result.rows[0]?.version ?? "";
    // Extraer solo "PostgreSQL X.Y" sin detalles de SO
    const serverVersion = raw.split(" ").slice(0, 2).join(" ");
    return { ok: true, latencyMs, serverVersion };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

// ── Retry helper ──────────────────────────────────────────────────────────────

/**
 * Reintenta una operación con backoff exponencial.
 * Solo reintenta errores de conexión/timeout, no errores de negocio.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 500, label = "operation" } = opts;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isRetriable =
        lastError.message.includes("Connection terminated") ||
        lastError.message.includes("ECONNREFUSED") ||
        lastError.message.includes("ETIMEDOUT") ||
        lastError.message.includes("connection timeout") ||
        lastError.message.includes("too many clients");

      if (!isRetriable || attempt === maxAttempts) break;

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `[clinica-db] ${label} falló (intento ${attempt}/${maxAttempts}), reintentando en ${delay}ms: ${lastError.message}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError ?? new Error(`[clinica-db] ${label} falló sin error capturado`);
}
