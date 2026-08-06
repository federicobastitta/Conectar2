/**
 * Migration runner — conectar-clinica-dev
 *
 * Aplica migraciones SQL versionadas e idempotentes en orden ascendente.
 * Registra cada migración en la tabla `schema_migrations` (idempotente).
 * Safe para correr múltiples veces; nunca re-aplica una migración ya registrada.
 *
 * Uso desde CLI:
 *   CLINICA_DB_URL=postgres://... node --import tsx/esm src/migrations/cli.ts
 *
 * Uso programático:
 *   import { runMigrations } from "@workspace/clinica-db/migrations";
 *   await runMigrations(pool);
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "sql");

export interface MigrationRecord {
  version: string;
  filename: string;
  appliedAt: Date;
  checksumSha256: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  failed?: { version: string; error: string };
}

// ── Tabla de control ─────────────────────────────────────────────────────────

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version        TEXT        NOT NULL PRIMARY KEY,
  filename       TEXT        NOT NULL,
  applied_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum_sha256 TEXT       NOT NULL
);

COMMENT ON TABLE schema_migrations IS
  'Registro de migraciones aplicadas — no modificar manualmente.';
`;

async function sha256Hex(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── Runner principal ─────────────────────────────────────────────────────────

export async function runMigrations(
  pool: pg.Pool,
  opts: {
    /** Directorio alternativo de SQLs (útil en tests) */
    migrationsDir?: string;
    /** Solo simular — muestra qué se aplicaría, no ejecuta */
    dryRun?: boolean;
    /** Logger; default console.log */
    log?: (msg: string) => void;
  } = {},
): Promise<MigrationResult> {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const dryRun = opts.dryRun ?? false;
  const log = opts.log ?? console.log;
  const result: MigrationResult = { applied: [], skipped: [] };

  const client = await pool.connect();
  try {
    // Bootstrap: crear tabla de control si no existe (solo en modo real, no dry-run)
    if (!dryRun) {
      await client.query(BOOTSTRAP_SQL);
    }

    // Leer migraciones ya aplicadas (si la tabla existe)
    let appliedMap = new Map<string, string>();
    if (!dryRun) {
      const { rows: applied } = await client.query<{ version: string; checksum_sha256: string }>(
        "SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version",
      );
      appliedMap = new Map(applied.map((r) => [r.version, r.checksum_sha256]));
    }

    // Leer archivos .sql del directorio
    let files: string[];
    try {
      const entries = await readdir(dir);
      files = entries
        .filter((f) => f.endsWith(".sql"))
        .sort(); // orden lexicográfico; convención: NNN_nombre.sql
    } catch {
      log(`[migrations] Directorio no encontrado: ${dir}`);
      return result;
    }

    for (const filename of files) {
      // Extraer versión del nombre de archivo (ej: "001" de "001_foundation.sql")
      const version = filename.split("_")[0] ?? filename.replace(".sql", "");
      const filePath = join(dir, filename);
      const sql = await readFile(filePath, "utf8");
      const checksum = await sha256Hex(sql);

      if (appliedMap.has(version)) {
        const storedChecksum = appliedMap.get(version);
        if (storedChecksum !== checksum) {
          // La migración ya aplicada fue modificada — error crítico
          throw new Error(
            `[migrations] INTEGRIDAD: migración ${version} (${filename}) fue modificada después de aplicarse. ` +
              `Checksum esperado: ${storedChecksum}, actual: ${checksum}. ` +
              "Nunca modifiques una migración ya aplicada; creá una nueva migración correctiva.",
          );
        }
        log(`[migrations] ✓ Saltando ${version} (ya aplicada)`);
        result.skipped.push(version);
        continue;
      }

      if (dryRun) {
        log(`[migrations] [DRY RUN] Aplicaría: ${filename}`);
        result.applied.push(version);
        continue;
      }

      log(`[migrations] → Aplicando ${filename}…`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, filename, checksum_sha256) VALUES ($1, $2, $3)",
          [version, filename, checksum],
        );
        await client.query("COMMIT");
        log(`[migrations] ✓ ${filename} aplicada`);
        result.applied.push(version);
      } catch (err) {
        await client.query("ROLLBACK");
        const message = err instanceof Error ? err.message : String(err);
        log(`[migrations] ✗ Error en ${filename}: ${message}`);
        result.failed = { version, error: message };
        throw new Error(`[migrations] Migración ${version} falló: ${message}`);
      }
    }

    log(
      `[migrations] Completado — aplicadas: ${result.applied.length}, saltadas: ${result.skipped.length}`,
    );
    return result;
  } finally {
    client.release();
  }
}

/** Devuelve las migraciones pendientes sin aplicarlas */
export async function pendingMigrations(pool: pg.Pool): Promise<string[]> {
  const dir = MIGRATIONS_DIR;
  const client = await pool.connect();
  try {
    await client.query(BOOTSTRAP_SQL);
    const { rows } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    const applied = new Set(rows.map((r) => r.version));

    let files: string[] = [];
    try {
      const entries = await readdir(dir);
      files = entries.filter((f) => f.endsWith(".sql")).sort();
    } catch {
      return [];
    }

    return files
      .map((f) => f.split("_")[0] ?? f.replace(".sql", ""))
      .filter((v) => !applied.has(v));
  } finally {
    client.release();
  }
}
