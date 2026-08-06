/**
 * Registro de lotes en la tabla lotes_importacion.
 * Garantiza idempotencia por SHA-256 del archivo Excel.
 */

import { createHash } from "node:crypto";
import type { Pool } from "pg";

export interface LoteRecord {
  id: number;
  uploadId: string;
  archivoS3Key: string;
  archivoSha256: string;
  estado: string;
}

export function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export async function buscarLotePorSha(pool: Pool, sha256: string): Promise<LoteRecord | null> {
  const res = await pool.query<LoteRecord>(
    `SELECT id, upload_id AS "uploadId", archivo_s3_key AS "archivoS3Key",
            archivo_sha256 AS "archivoSha256", estado
     FROM lotes_importacion WHERE archivo_sha256 = $1 LIMIT 1`,
    [sha256],
  );
  return res.rows[0] ?? null;
}

export async function crearLote(
  pool: Pool,
  params: {
    uploadId: string;
    s3Bucket: string;
    s3Key: string;
    nombre: string;
    sha256: string;
    iniciadoPor: string;
  },
): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO lotes_importacion
       (upload_id, archivo_s3_bucket, archivo_s3_key, archivo_nombre, archivo_sha256,
        estado, iniciado_por)
     VALUES ($1, $2, $3, $4, $5, 'iniciado', $6)
     RETURNING id`,
    [params.uploadId, params.s3Bucket, params.s3Key, params.nombre, params.sha256, params.iniciadoPor],
  );
  return res.rows[0].id;
}

export async function actualizarLote(
  pool: Pool,
  id: number,
  campos: Record<string, unknown>,
): Promise<void> {
  const setClauses = Object.keys(campos)
    .map((k, i) => `${camelToSnake(k)} = $${i + 2}`)
    .join(", ");
  const valores = Object.values(campos);
  await pool.query(
    `UPDATE lotes_importacion SET ${setClauses}, actualizado_en = NOW() WHERE id = $1`,
    [id, ...valores],
  );
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export async function marcarAprobado(pool: Pool, id: number, aprobadoPor: string): Promise<void> {
  await pool.query(
    `UPDATE lotes_importacion
     SET estado = 'aprobado', aprobado_por = $2, aprobado_en = NOW(), actualizado_en = NOW()
     WHERE id = $1`,
    [id, aprobadoPor],
  );
}

export async function marcarCompletado(
  pool: Pool,
  id: number,
  stats: {
    totalFilas: number;
    filasStaging: number;
    filasNormalizadas: number;
    filasDuplicadoExacto: number;
    filasDuplicadoProbable: number;
    filasCuarentena: number;
    filasAprobadas: number;
    filasIncorporadas: number;
    filasRechazadas: number;
  },
  reporteKeys: { staging: string | null; rechazados: string | null; conciliacion: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE lotes_importacion SET
       estado = 'incorporado',
       total_filas = $2, filas_staging = $3, filas_normalizadas = $4,
       filas_duplicado_exacto = $5, filas_duplicado_probable = $6, filas_cuarentena = $7,
       filas_aprobadas = $8, filas_incorporadas = $9, filas_rechazadas = $10,
       reporte_staging_key = $11, reporte_rechazados_key = $12, reporte_conciliacion_key = $13,
       completado_en = NOW(), actualizado_en = NOW()
     WHERE id = $1`,
    [
      id, stats.totalFilas, stats.filasStaging, stats.filasNormalizadas,
      stats.filasDuplicadoExacto, stats.filasDuplicadoProbable, stats.filasCuarentena,
      stats.filasAprobadas, stats.filasIncorporadas, stats.filasRechazadas,
      reporteKeys.staging, reporteKeys.rechazados, reporteKeys.conciliacion,
    ],
  );
}

export async function marcarError(pool: Pool, id: number, errores: unknown[]): Promise<void> {
  await pool.query(
    `UPDATE lotes_importacion SET estado = 'error', errores = $2, actualizado_en = NOW() WHERE id = $1`,
    [id, JSON.stringify(errores)],
  );
}
