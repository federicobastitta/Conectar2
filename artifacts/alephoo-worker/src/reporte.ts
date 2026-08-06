/**
 * Genera reportes JSON/CSV para S3:
 *   - staging: todas las filas con su estado post-pipeline
 *   - rechazados: filas en cuarentena con razón
 *   - conciliacion: resumen ejecutivo del lote
 */

import type { FilaNormalizada, SesionImportacion } from "@workspace/clinica-db";

export interface ReporteResumen {
  loteId: number;
  uploadId: string;
  archivoS3Key: string;
  sha256: string;
  generadoEn: string;
  estadoPipeline: string;
  totalFilas: number;
  filasStaging: number;
  filasNormalizadas: number;
  filasDuplicadoExacto: number;
  filasDuplicadoProbable: number;
  filasCuarentena: number;
  filasAprobadas: number;
  filasIncorporadas: number;
  filasRechazadas: number;
  errores: unknown[];
  aprobacionRequerida: boolean;
  pasosSiguientes: string[];
}

export function generarResumen(
  loteId: number,
  sesion: SesionImportacion,
  aprobado: boolean,
): ReporteResumen {
  const aprobacionRequerida = !aprobado && (sesion.filasAprobadas ?? 0) > 0;
  const pasosSiguientes: string[] = [];

  if (aprobacionRequerida) {
    pasosSiguientes.push(
      `Revisar el reporte de staging en S3 y ejecutar con --approve --upload-id=${sesion.uploadId} para incorporar.`,
    );
  }
  if ((sesion.filasCuarentena ?? 0) > 0) {
    pasosSiguientes.push(
      `${sesion.filasCuarentena} filas en cuarentena. Revisar el reporte de rechazados para corregir y re-importar.`,
    );
  }
  if (aprobado && (sesion.filasIncorporadas ?? 0) === 0) {
    pasosSiguientes.push("Incorporación en modo dry-run o sin filas aprobadas.");
  }

  return {
    loteId,
    uploadId: sesion.uploadId,
    archivoS3Key: sesion.archivoS3Key,
    sha256: sesion.archivoSha256,
    generadoEn: new Date().toISOString(),
    estadoPipeline: sesion.estado,
    totalFilas: sesion.totalFilas,
    filasStaging: sesion.filasStaging ?? 0,
    filasNormalizadas: sesion.filasNormalizadas ?? 0,
    filasDuplicadoExacto: sesion.filasDuplicadoExacto ?? 0,
    filasDuplicadoProbable: sesion.filasDuplicadoProbable ?? 0,
    filasCuarentena: sesion.filasCuarentena ?? 0,
    filasAprobadas: sesion.filasAprobadas ?? 0,
    filasIncorporadas: sesion.filasIncorporadas ?? 0,
    filasRechazadas: sesion.filasRechazadas ?? 0,
    errores: sesion.errores ?? [],
    aprobacionRequerida,
    pasosSiguientes,
  };
}

export function generarReporteStaging(filas: FilaNormalizada[]): string {
  return JSON.stringify({ generadoEn: new Date().toISOString(), total: filas.length, filas }, null, 2);
}

export function generarReporteRechazados(filas: FilaNormalizada[]): string {
  const rechazadas = filas.filter((f) => f.estado === "cuarentena" || f.estado === "rechazada");
  return JSON.stringify(
    {
      generadoEn: new Date().toISOString(),
      total: rechazadas.length,
      filas: rechazadas.map((f) => ({
        fila: f.filaNumero,
        razon: f.erroresValidacion?.join("; ") ?? "desconocida",
        datos: f,
      })),
    },
    null,
    2,
  );
}
