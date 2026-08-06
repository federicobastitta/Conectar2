/**
 * Orquestador principal del Alephoo Worker.
 *
 * Flujo:
 *  1. Conectar a RDS (conectar-clinica-dev)
 *  2. Correr migraciones pendientes (idempotente)
 *  3. Descargar Excel de S3 (alephoo/raw/)
 *  4. Verificar idempotencia por SHA-256
 *  5. Ejecutar pipeline: raw → staging → normalización → dedup → cuarentena
 *  6. Subir reportes a S3 (alephoo/staging/, alephoo/rechazados/, alephoo/conciliacion/)
 *  7. Sin --approve: terminar (pendiente de aprobación)
 *     Con --approve: incorporar filas aprobadas
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { runMigrations, ejecutarPipeline } from "@workspace/clinica-db";
import type { WorkerConfig } from "./config.js";
import { conectarDB, cerrarDB } from "./db.js";
import { descargarExcel, subirReporte, listarArchivosRaw } from "./s3-io.js";
import {
  sha256Buffer, buscarLotePorSha, crearLote,
  actualizarLote, marcarCompletado, marcarError,
} from "./lote.js";
import { generarResumen, generarReporteStaging, generarReporteRechazados } from "./reporte.js";

export async function correrWorker(cfg: WorkerConfig): Promise<void> {
  console.log("=== Alephoo Worker — Conectar Red Clínica Digital ===");
  console.log(`Entorno: ${cfg.nodeEnv}`);
  console.log(`Modo: ${cfg.dryRun ? "DRY-RUN" : cfg.approve ? "INCORPORACIÓN (--approve)" : "STAGING (sin --approve)"}`);
  console.log(`Bucket: s3://${cfg.s3Bucket}`);

  const pool = await conectarDB(cfg);

  try {
    // ── 1. Migraciones (idempotente) ─────────────────────────────────────────
    console.log("\n[worker] Aplicando migraciones clinica-db...");
    const migResult = await runMigrations(pool);
    if (migResult.applied.length > 0) {
      console.log(`[worker] Migraciones aplicadas: ${migResult.applied.join(", ")}`);
    } else {
      console.log("[worker] Sin migraciones pendientes.");
    }
    if (migResult.failed) {
      throw new Error(`[worker] Migración fallida: ${migResult.failed.version} — ${migResult.failed.error}`);
    }

    // ── 2. Resolver qué archivo procesar ─────────────────────────────────────
    let s3Key = cfg.s3Key;
    if (!s3Key) {
      const archivos = await listarArchivosRaw(cfg);
      if (archivos.length === 0) {
        console.log(`[worker] Sin archivos Excel en s3://${cfg.s3Bucket}/${cfg.s3RawPrefix}/. Sin trabajo.`);
        return;
      }
      archivos.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
      s3Key = archivos[0].key;
      console.log(`[worker] Usando archivo más reciente: ${s3Key}`);
    }

    const nombre = basename(s3Key);
    const uploadId = cfg.uploadId ?? `worker-${Date.now()}-${randomUUID().split("-")[0]}`;

    // ── 3. Descargar Excel ────────────────────────────────────────────────────
    const buffer = await descargarExcel(cfg, s3Key);
    const sha256 = sha256Buffer(buffer);
    console.log(`[worker] SHA-256: ${sha256}`);

    // ── 4. Idempotencia ───────────────────────────────────────────────────────
    const loteExistente = await buscarLotePorSha(pool, sha256);
    if (loteExistente) {
      if (loteExistente.estado === "incorporado") {
        console.log(`[worker] ¡IDEMPOTENTE! Este Excel ya fue incorporado (lote ${loteExistente.id}). Sin acción.`);
        return;
      }
      if (loteExistente.estado === "pendiente_aprobacion" && !cfg.approve) {
        console.log(
          `[worker] Lote ${loteExistente.id} pendiente de aprobación. ` +
            `Ejecutar con --approve --upload-id=${loteExistente.uploadId} para incorporar.`,
        );
        return;
      }
      console.log(`[worker] Lote existente ${loteExistente.id} en estado "${loteExistente.estado}". Reprocesando.`);
    }

    // ── 5. Registrar lote ─────────────────────────────────────────────────────
    const loteId = loteExistente?.id ?? await crearLote(pool, {
      uploadId, s3Bucket: cfg.s3Bucket, s3Key, nombre, sha256, iniciadoPor: cfg.iniciadoPor,
    });
    console.log(`[worker] Lote ID: ${loteId}`);

    if (cfg.dryRun) {
      console.log("[worker] DRY-RUN activo. No se escribirá nada en la base ni en S3.");
    }

    // ── 6. Ejecutar pipeline ──────────────────────────────────────────────────
    console.log(`[worker] Iniciando pipeline Alephoo (skipIncorporacion=${!cfg.approve})...`);
    await actualizarLote(pool, loteId, { estado: "staging" });

    const resultado = await ejecutarPipeline(buffer, pool, {
      uploadId,
      archivoS3Key: s3Key,
      archivoNombre: nombre,
      archivoSha256: sha256,
      iniciadaPor: cfg.iniciadoPor,
      skipIncorporacion: !cfg.approve,
      log: (msg: string) => console.log(`  ${msg}`),
    });

    const { sesion, filas } = resultado;

    // ── 7. Subir reportes a S3 ────────────────────────────────────────────────
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    let stagingKey: string | null = null;
    let rechazadosKey: string | null = null;
    let conciliacionKey: string | null = null;

    if (!cfg.dryRun) {
      stagingKey = await subirReporte(
        cfg, cfg.s3ReportesPrefix, `${nombre}-${ts}-staging.json`,
        Buffer.from(generarReporteStaging(filas), "utf-8"),
      );
      rechazadosKey = await subirReporte(
        cfg, cfg.s3RechazadosPrefix, `${nombre}-${ts}-rechazados.json`,
        Buffer.from(generarReporteRechazados(filas), "utf-8"),
      );
      const resumen = generarResumen(loteId, sesion, cfg.approve);
      conciliacionKey = await subirReporte(
        cfg, cfg.s3ConciliacionPrefix, `${nombre}-${ts}-conciliacion.json`,
        Buffer.from(JSON.stringify(resumen, null, 2), "utf-8"),
      );
    }

    // ── 8. Finalizar ──────────────────────────────────────────────────────────
    if (!cfg.dryRun) {
      if (cfg.approve) {
        await marcarCompletado(pool, loteId, {
          totalFilas: sesion.totalFilas,
          filasStaging: sesion.filasStaging,
          filasNormalizadas: sesion.filasNormalizadas,
          filasDuplicadoExacto: sesion.filasDuplicadoExacto,
          filasDuplicadoProbable: sesion.filasDuplicadoProbable,
          filasCuarentena: sesion.filasCuarentena,
          filasAprobadas: sesion.filasAprobadas,
          filasIncorporadas: sesion.filasIncorporadas,
          filasRechazadas: sesion.filasRechazadas,
        }, { staging: stagingKey, rechazados: rechazadosKey, conciliacion: conciliacionKey });
      } else {
        await actualizarLote(pool, loteId, { estado: "pendiente_aprobacion" });
      }
    }

    // ── 9. Resumen consola ────────────────────────────────────────────────────
    console.log("\n=== RESULTADO ===");
    console.log(`  Archivo:             ${nombre}`);
    console.log(`  SHA-256:             ${sha256}`);
    console.log(`  Total filas:         ${sesion.totalFilas}`);
    console.log(`  Staging:             ${sesion.filasStaging}`);
    console.log(`  Normalizadas:        ${sesion.filasNormalizadas}`);
    console.log(`  Duplicado exacto:    ${sesion.filasDuplicadoExacto}`);
    console.log(`  Duplicado probable:  ${sesion.filasDuplicadoProbable}`);
    console.log(`  Cuarentena:          ${sesion.filasCuarentena}`);
    console.log(`  Aprobadas:           ${sesion.filasAprobadas}`);
    console.log(`  Incorporadas:        ${sesion.filasIncorporadas}`);
    if (!cfg.approve && !cfg.dryRun && sesion.filasAprobadas > 0) {
      console.log(`\n  ⚠️  Para incorporar: ejecutar con --approve --upload-id=${uploadId}`);
    }
    if (stagingKey) console.log(`  Staging report:      s3://${cfg.s3Bucket}/${stagingKey}`);
    if (conciliacionKey) console.log(`  Conciliación:        s3://${cfg.s3Bucket}/${conciliacionKey}`);

  } catch (err) {
    console.error("[worker] Error fatal:", err);
    throw err;
  } finally {
    await cerrarDB();
  }
}
