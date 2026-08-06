/**
 * Integración opcional con @workspace/clinica-db (AWS RDS conectar-clinica-dev).
 *
 * Solo se activa si CLINICA_DB_URL está configurada en el entorno.
 * Si no está configurada, el api-server arranca normalmente sin tocar clinica-db.
 *
 * Uso típico:
 *   - Piloto PACS: correlación paciente Conectar ↔ paciente clinica-db
 *   - Health check de clinica-db en /api/healthz-clinica
 *
 * En producción AWS: la variable CLINICA_DB_URL viene de Secrets Manager vía ECS.
 * En dev local: no se configura, el endpoint devuelve { enabled: false }.
 */

import { RDS_CA } from "@workspace/db";
import type { Logger } from "pino";
import { resolverClinicaUrl } from "./clinica-url-resolver.js";

// Pool-like interface sin importar 'pg' directamente (api-server no tiene @types/pg)
interface PgPool {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

interface PgClient {
  query<R extends Record<string, unknown>>(sql: string): Promise<{ rows: R[] }>;
  release(): void;
}

let clinicaPool: PgPool | null = null;

export async function initClinicaDBIfConfigured(logger: Logger): Promise<void> {
  // En desarrollo, solo se activa con CLINICA_DEV_DB_URL (base aislada de dev).
  // En producción/staging, se activa con CLINICA_DB_URL.
  // Si no hay URL adecuada para el entorno, la integración queda deshabilitada.
  let resolved: { url: string; esAws: boolean; destino: string } | null = null;
  try {
    resolved = resolverClinicaUrl("clinica-db-init");
  } catch {
    logger.info(
      { modulo: "clinica-db" },
      "clinica-db: sin URL configurada para este entorno — integración deshabilitada",
    );
    return;
  }

  const { url, destino } = resolved;
  logger.info(
    { modulo: "clinica-db", destino },
    destino === "aws-clinica-dev"
      ? "clinica-db: usando base aislada de desarrollo (CLINICA_DEV_DB_URL)"
      : "clinica-db: usando base de producción (CLINICA_DB_URL)",
  );

  try {
    const { Pool } = (await import("pg")) as typeof import("pg");
    // AWS RDS exige TLS; se valida contra los certificados raíz oficiales de RDS.
    const ssl = { ssl: { ca: RDS_CA } };

    clinicaPool = new Pool({
      connectionString: url,
      ...ssl,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    }) as unknown as PgPool;

    const client = await clinicaPool.connect();
    try {
      const res = await client.query<{ current_database: string }>("SELECT current_database()");
      logger.info(
        { modulo: "clinica-db", db: res.rows[0].current_database, destino },
        "clinica-db: conexión OK",
      );
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ modulo: "clinica-db", err }, "clinica-db: falló la conexión inicial — continuando sin clinica-db");
    clinicaPool = null;
  }
}

export function getClinicaPool(): PgPool | null {
  return clinicaPool;
}

export async function clinicaDBHealthCheck(): Promise<{ ok: boolean; db?: string; error?: string }> {
  if (!clinicaPool) {
    return { ok: false, error: "no_configurada" };
  }
  const client = await clinicaPool.connect();
  try {
    const res = await client.query<{ current_database: string }>("SELECT current_database()");
    return { ok: true, db: res.rows[0].current_database };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    client.release();
  }
}
