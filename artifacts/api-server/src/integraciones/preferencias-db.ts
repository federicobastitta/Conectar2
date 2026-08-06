/**
 * Acceso a la tabla preferencias_usuario (datos de usuario → AWS clinica-db).
 *
 * Regla de almacenamiento: todo dato de pacientes o usuarios va a AWS
 * (CLINICA_DB_URL, RDS conectar-clinica-dev). En dev sin CLINICA_DB_URL se usa
 * DATABASE_URL como fallback (misma convención que createTestPool de clinica-db),
 * y la tabla se crea idempotente al arrancar.
 *
 * En AWS la tabla la crea la migración 016_preferencias_usuario.sql de
 * @workspace/clinica-db.
 */

import { RDS_CA } from "@workspace/db";
import type { Logger } from "pino";
import { resolverClinicaUrl } from "./clinica-url-resolver.js";

interface PgPool {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

let pool: PgPool | null = null;
let initPromise: Promise<PgPool> | null = null;

const DDL = `
CREATE TABLE IF NOT EXISTS preferencias_usuario (
  id                    SERIAL PRIMARY KEY,
  conectar_user_id      INTEGER     NOT NULL UNIQUE,
  hobbies               TEXT        NOT NULL DEFAULT '',
  gustos_libres         TEXT,
  fecha_nacimiento      DATE,
  apodo                 TEXT,
  encuesta_completada   BOOLEAN     NOT NULL DEFAULT FALSE,
  ultimo_saludo_cumple  DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

async function crearPool(logger?: Logger): Promise<PgPool> {
  const { url, esAws, destino } = resolverClinicaUrl("preferencias-db");

  logger?.info(
    { modulo: "preferencias-db", destino },
    "preferencias_usuario: inicializando pool",
  );

  const { Pool } = (await import("pg")) as typeof import("pg");
  const p = new Pool({
    connectionString: url,
    // AWS RDS exige TLS; se valida contra los certificados raíz oficiales de RDS.
    ssl: esAws ? { ca: RDS_CA } : false,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  }) as unknown as PgPool;

  if (!esAws) {
    // Fallback SOLO dev/test: asegurar la tabla (en AWS la crea la migración 016)
    await p.query(DDL);
    logger?.warn(
      { modulo: "preferencias-db" },
      "preferencias_usuario usando DATABASE_URL como fallback (solo válido en desarrollo)",
    );
  }
  logger?.info(
    { modulo: "preferencias-db", destino },
    "preferencias_usuario: pool inicializado",
  );
  return p;
}

export async function getPreferenciasPool(logger?: Logger): Promise<PgPool> {
  if (pool) return pool;
  if (!initPromise) {
    initPromise = crearPool(logger).then((p) => {
      pool = p;
      return p;
    });
    initPromise.catch(() => {
      initPromise = null;
    });
  }
  return initPromise;
}

export interface PreferenciasRow extends Record<string, unknown> {
  hobbies: string;
  gustos_libres: string | null;
  fecha_nacimiento: string | null;
  apodo: string | null;
  encuesta_completada: boolean;
  ultimo_saludo_cumple: string | null;
}

export async function obtenerPreferencias(
  userId: number,
): Promise<PreferenciasRow | null> {
  const p = await getPreferenciasPool();
  const res = await p.query<PreferenciasRow>(
    `SELECT hobbies, gustos_libres, fecha_nacimiento::text, apodo,
            encuesta_completada, ultimo_saludo_cumple::text
       FROM preferencias_usuario WHERE conectar_user_id = $1`,
    [userId],
  );
  return res.rows[0] ?? null;
}

export async function guardarPreferencias(
  userId: number,
  datos: {
    hobbies: string;
    gustosLibres: string | null;
    fechaNacimiento: string | null;
    apodo: string | null;
  },
): Promise<void> {
  const p = await getPreferenciasPool();
  await p.query(
    `INSERT INTO preferencias_usuario
       (conectar_user_id, hobbies, gustos_libres, fecha_nacimiento, apodo, encuesta_completada)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     ON CONFLICT (conectar_user_id) DO UPDATE SET
       hobbies = EXCLUDED.hobbies,
       gustos_libres = EXCLUDED.gustos_libres,
       fecha_nacimiento = EXCLUDED.fecha_nacimiento,
       apodo = EXCLUDED.apodo,
       encuesta_completada = TRUE,
       updated_at = now()`,
    [userId, datos.hobbies, datos.gustosLibres, datos.fechaNacimiento, datos.apodo],
  );
}

export async function marcarSaludoCumpleVisto(
  userId: number,
  fecha: string,
): Promise<void> {
  const p = await getPreferenciasPool();
  await p.query(
    `UPDATE preferencias_usuario
        SET ultimo_saludo_cumple = $2, updated_at = now()
      WHERE conectar_user_id = $1`,
    [userId, fecha],
  );
}
