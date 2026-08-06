/**
 * Orquestador del pipeline Alephoo
 * raw → staging → normalización → dedup → cuarentena → aprobación → incorporación
 */

import type pg from "pg";
import type {
  FilaRaw,
  FilaAlephooStaging,
  FilaNormalizada,
  SesionImportacion,
  OpcionesPipeline,
  EstadoFilaPipeline,
} from "./types.js";
import { leerExcelRaw } from "./stages/raw.js";
import { procesarStaging } from "./stages/staging.js";
import { procesarNormalizacion } from "./stages/normalizacion.js";
import { deduplicarBatch, deduplicarContraDB } from "./stages/deduplicacion.js";
import { incorporarFilasAprobadas } from "./stages/incorporacion.js";

export interface ResultadoPipeline {
  sesion: SesionImportacion;
  filas: FilaNormalizada[];
  resultadosIncorporacion?: Awaited<ReturnType<typeof incorporarFilasAprobadas>>;
}

const DEFAULT_LOG = (msg: string) => console.log(msg);

/**
 * Ejecuta el pipeline completo sobre un buffer Excel.
 * El caller es responsable de haber descargado el Excel de S3
 * (ver descargarExcelDeS3 en stages/raw.ts).
 */
export async function ejecutarPipeline(
  buffer: Buffer,
  pool: pg.Pool,
  opciones: OpcionesPipeline,
): Promise<ResultadoPipeline> {
  const log = opciones.log ? (msg: string) => opciones.log!(msg) : DEFAULT_LOG;
  const umbral = opciones.umbralDuplicadoProbable ?? 0.85;

  const sesion: SesionImportacion = {
    uploadId: opciones.uploadId,
    archivoS3Key: opciones.archivoS3Key,
    archivoNombre: opciones.archivoNombre,
    archivoSha256: opciones.archivoSha256,
    estado: "iniciada",
    totalFilas: 0,
    filasRaw: 0,
    filasStaging: 0,
    filasNormalizadas: 0,
    filasDuplicadoExacto: 0,
    filasDuplicadoProbable: 0,
    filasCuarentena: 0,
    filasAprobadas: 0,
    filasIncorporadas: 0,
    filasRechazadas: 0,
    iniciadaEn: new Date(),
    iniciadaPor: opciones.iniciadaPor,
    errores: [],
  };

  try {
    // ── Stage 1: raw ─────────────────────────────────────────────────────────
    log(`[pipeline:${opciones.uploadId}] Stage 1: raw`);
    const filasRaw: FilaRaw[] = await leerExcelRaw(buffer, {
      uploadId: opciones.uploadId,
      archivoS3Key: opciones.archivoS3Key,
      log,
    });
    sesion.filasRaw = filasRaw.length;
    sesion.totalFilas = filasRaw.length;
    sesion.estado = "raw_completo";
    log(`[pipeline] Raw: ${filasRaw.length} filas`);

    if (filasRaw.length === 0) {
      sesion.estado = "completada";
      return { sesion, filas: [] };
    }

    // ── Stage 2: staging ──────────────────────────────────────────────────────
    log(`[pipeline:${opciones.uploadId}] Stage 2: staging`);
    const filasStaging: FilaAlephooStaging[] = procesarStaging(filasRaw);
    sesion.filasStaging = filasStaging.length;
    sesion.estado = "staging_completo";

    // ── Stage 3: normalización ────────────────────────────────────────────────
    log(`[pipeline:${opciones.uploadId}] Stage 3: normalización`);
    let filas: FilaNormalizada[] = procesarNormalizacion(filasStaging);
    sesion.filasNormalizadas = filas.filter((f) => f.estado === "normalizada").length;
    sesion.filasCuarentena = filas.filter((f) => f.estado === "cuarentena").length;
    sesion.estado = "normalizacion_completa";

    // ── Stage 4: deduplicación ────────────────────────────────────────────────
    log(`[pipeline:${opciones.uploadId}] Stage 4: deduplicación`);
    const soloNormalizadas = filas.filter((f) => f.estado === "normalizada");

    // Dedup intra-batch
    const dedupBatch = deduplicarBatch(soloNormalizadas, umbral);
    // Dedup contra DB
    const dedupDB = await deduplicarContraDB(soloNormalizadas, pool, umbral);

    // Aplicar resultados de dedup
    filas = filas.map((fila) => {
      if (fila.estado !== "normalizada") return fila;

      const resultadoDB = dedupDB.get(fila.filaNumero);
      const resultadoBatch = dedupBatch.get(fila.filaNumero);

      // Prioridad: duplicado exacto en DB > exacto en batch > probable en DB > probable en batch
      const resultado = (() => {
        if (resultadoDB?.tipo === "duplicado_exacto") return resultadoDB;
        if (resultadoBatch?.tipo === "duplicado_exacto") return resultadoBatch;
        if (resultadoDB?.tipo === "duplicado_probable") return resultadoDB;
        if (resultadoBatch?.tipo === "duplicado_probable") return resultadoBatch;
        return resultadoDB;
      })();

      if (!resultado) return fila;

      let nuevoEstado: EstadoFilaPipeline = fila.estado;
      if (resultado.tipo === "duplicado_exacto") {
        nuevoEstado = opciones.omitirDuplicadosExactos ? "cuarentena" : "duplicado_exacto";
      } else if (resultado.tipo === "duplicado_probable") {
        nuevoEstado = opciones.cuarentenaDuplicadosProbables ? "cuarentena" : "duplicado_probable";
      }

      return { ...fila, estado: nuevoEstado };
    });

    sesion.filasDuplicadoExacto = filas.filter((f) => f.estado === "duplicado_exacto").length;
    sesion.filasDuplicadoProbable = filas.filter((f) => f.estado === "duplicado_probable").length;
    sesion.filasCuarentena = filas.filter((f) => f.estado === "cuarentena").length;
    sesion.estado = "dedup_completo";

    // Las filas sin duplicado pasan a "aprobada"
    filas = filas.map((f) =>
      f.estado === "normalizada" ? { ...f, estado: "aprobada" as EstadoFilaPipeline } : f,
    );
    sesion.filasAprobadas = filas.filter((f) => f.estado === "aprobada").length;

    if (sesion.filasCuarentena > 0 || sesion.filasDuplicadoProbable > 0) {
      sesion.estado = "revision_pendiente";
      log(
        `[pipeline] Revisión pendiente: ${sesion.filasCuarentena} en cuarentena, ` +
          `${sesion.filasDuplicadoProbable} duplicados probables`,
      );
    } else {
      sesion.estado = "aprobada";
    }

    // ── Stage 5: incorporación ────────────────────────────────────────────────
    // Solo si hay filas aprobadas y no se pasó skipIncorporacion.
    // El worker Alephoo usa skipIncorporacion=true cuando no se pasa --approve.
    let resultadosIncorporacion;
    if (sesion.filasAprobadas > 0 && !opciones.skipIncorporacion) {
      log(`[pipeline:${opciones.uploadId}] Stage 5: incorporación (${sesion.filasAprobadas} filas)`);
      sesion.estado = "incorporando";
      resultadosIncorporacion = await incorporarFilasAprobadas(filas, pool, {
        incorporadoPor: opciones.iniciadaPor,
        uploadId: opciones.uploadId,
        log,
      });
      sesion.filasIncorporadas = resultadosIncorporacion.filter((r) => r.accion !== "omitido").length;
    } else if (opciones.skipIncorporacion) {
      log(`[pipeline:${opciones.uploadId}] Stage 5 omitida (skipIncorporacion=true). Filas aprobadas pendientes: ${sesion.filasAprobadas}`);
    }

    sesion.completadaEn = new Date();
    sesion.estado = "completada";
    log(
      `[pipeline] Completado: ${sesion.filasIncorporadas} incorporadas, ` +
        `${sesion.filasCuarentena} en cuarentena, ` +
        `${sesion.filasDuplicadoExacto} duplicados exactos`,
    );

    return { sesion, filas, resultadosIncorporacion };
  } catch (err) {
    sesion.estado = "error";
    const mensaje = err instanceof Error ? err.message : String(err);
    sesion.errores.push(mensaje);
    log(`[pipeline] ERROR: ${mensaje}`);
    throw err;
  }
}
