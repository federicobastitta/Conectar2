/**
 * Acceso a la tabla estudios_previos_paciente (datos de pacientes → AWS clinica-db).
 *
 * Regla de almacenamiento: todo dato de pacientes va a AWS (CLINICA_DB_URL,
 * RDS conectar-clinica-dev). En dev sin CLINICA_DB_URL se usa DATABASE_URL
 * como fallback (misma convención que preferencias-db), y la tabla se crea
 * idempotente al primer uso.
 *
 * En AWS la tabla la crea la migración 017_estudios_previos_paciente.sql de
 * @workspace/clinica-db. El archivo binario vive en object storage; acá solo
 * se guardan los metadatos y el object_path.
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
CREATE TABLE IF NOT EXISTS estudios_previos_paciente (
  id                    SERIAL PRIMARY KEY,
  conectar_paciente_id  INTEGER     NOT NULL,
  tipo                  TEXT        NOT NULL CHECK (tipo IN ('laboratorio', 'imagen', 'informe', 'otro')),
  titulo                TEXT        NOT NULL,
  descripcion           TEXT,
  fecha_estudio         TEXT,
  object_path           TEXT        NOT NULL,
  nombre_archivo        TEXT        NOT NULL,
  content_type          TEXT,
  tamano_bytes          BIGINT,
  subido_por_user_id    INTEGER,
  subido_por_rol        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_estudios_previos_paciente_pac
  ON estudios_previos_paciente (conectar_paciente_id)
  WHERE deleted_at IS NULL;`;

async function crearPool(logger?: Logger): Promise<PgPool> {
  const { url, esAws, destino } = resolverClinicaUrl("estudios-previos-db");

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
    // Fallback SOLO dev/test: asegurar la tabla (en AWS la crea la migración 017)
    await p.query(DDL);
    logger?.warn(
      { modulo: "estudios-previos-db" },
      "estudios_previos_paciente usando DATABASE_URL como fallback (solo válido en desarrollo)",
    );
  }
  logger?.info(
    { modulo: "estudios-previos-db", destino },
    "estudios_previos_paciente: pool inicializado",
  );
  return p;
}

async function getPool(logger?: Logger): Promise<PgPool> {
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

export interface EstudioPrevioRow extends Record<string, unknown> {
  id: number;
  conectar_paciente_id: number;
  tipo: string;
  titulo: string;
  descripcion: string | null;
  fecha_estudio: string | null;
  object_path: string;
  nombre_archivo: string;
  content_type: string | null;
  tamano_bytes: string | number | null;
  subido_por_user_id: number | null;
  subido_por_rol: string | null;
  created_at: string;
}

const COLS = `id, conectar_paciente_id, tipo, titulo, descripcion, fecha_estudio,
       object_path, nombre_archivo, content_type, tamano_bytes,
       subido_por_user_id, subido_por_rol, created_at::text`;

export async function listarEstudiosPrevios(pacienteId: number): Promise<EstudioPrevioRow[]> {
  const p = await getPool();
  const res = await p.query<EstudioPrevioRow>(
    `SELECT ${COLS}
       FROM estudios_previos_paciente
      WHERE conectar_paciente_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [pacienteId],
  );
  return res.rows;
}

export async function obtenerEstudioPrevio(
  pacienteId: number,
  estudioPrevioId: number,
): Promise<EstudioPrevioRow | null> {
  const p = await getPool();
  const res = await p.query<EstudioPrevioRow>(
    `SELECT ${COLS}
       FROM estudios_previos_paciente
      WHERE id = $1 AND conectar_paciente_id = $2 AND deleted_at IS NULL`,
    [estudioPrevioId, pacienteId],
  );
  return res.rows[0] ?? null;
}

export async function crearEstudioPrevio(datos: {
  pacienteId: number;
  tipo: string;
  titulo: string;
  descripcion: string | null;
  fechaEstudio: string | null;
  objectPath: string;
  nombreArchivo: string;
  contentType: string | null;
  tamanoBytes: number | null;
  subidoPorUserId: number | null;
  subidoPorRol: string;
}): Promise<EstudioPrevioRow> {
  const p = await getPool();
  const res = await p.query<EstudioPrevioRow>(
    `INSERT INTO estudios_previos_paciente
       (conectar_paciente_id, tipo, titulo, descripcion, fecha_estudio,
        object_path, nombre_archivo, content_type, tamano_bytes,
        subido_por_user_id, subido_por_rol)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${COLS}`,
    [
      datos.pacienteId,
      datos.tipo,
      datos.titulo,
      datos.descripcion,
      datos.fechaEstudio,
      datos.objectPath,
      datos.nombreArchivo,
      datos.contentType,
      datos.tamanoBytes,
      datos.subidoPorUserId,
      datos.subidoPorRol,
    ],
  );
  return res.rows[0];
}

export async function eliminarEstudioPrevio(
  pacienteId: number,
  estudioPrevioId: number,
): Promise<boolean> {
  const p = await getPool();
  const res = await p.query<{ id: number }>(
    `UPDATE estudios_previos_paciente
        SET deleted_at = now()
      WHERE id = $1 AND conectar_paciente_id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [estudioPrevioId, pacienteId],
  );
  return res.rows.length > 0;
}

export function inicializarEstudiosPreviosDB(logger: Logger): void {
  void getPool(logger).catch((err) => {
    logger.error({ modulo: "estudios-previos-db", err }, "No se pudo inicializar estudios_previos_paciente");
  });
}
