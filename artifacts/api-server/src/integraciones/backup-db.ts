/**
 * Backup lógico diario de la base clinica-db (AWS RDS) a Object Storage.
 *
 * Por qué existe: no tenemos acceso a la consola AWS para confirmar la
 * retención de snapshots automáticos de RDS, así que garantizamos desde la
 * app un dump lógico diario (pg_dump -Fc) subido al almacenamiento de
 * objetos, con retención mínima configurable.
 *
 * Piezas:
 *  - ensurePgTools(): garantiza un pg_dump compatible (v18) descargando una
 *    build portable verificada por SHA-256 si el binario del sistema es viejo.
 *  - correrBackupDb(): ejecuta pg_dump contra la base resuelta por
 *    resolverClinicaUrl (prod → CLINICA_DB_URL; dev → clinica_dev), sube el
 *    dump a `${PRIVATE_OBJECT_DIR}/backups/<base>/…` y aplica retención.
 *  - iniciarBackupDbWorker(): chequea cada 30 min si el último backup exitoso
 *    tiene más de ~24 h y corre uno nuevo (patrón robusto frente a autoscale:
 *    cualquier tráfico que despierte la instancia dispara el catch-up).
 *
 * Estado persistido en config_sistema (clave backup_db_estado) para que el
 * cronograma sobreviva reinicios y sea visible desde /api/backups-db/estado.
 *
 * Restauración: ver docs/backups-db.md (procedimiento probado).
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { db, configSistemaTable, RDS_CA } from "@workspace/db";
import { logger } from "../lib/logger";
import { objectStorageClient } from "../lib/objectStorage";
import { resolverClinicaUrl } from "./clinica-url-resolver";

// ── Configuración ───────────────────────────────────────────────────────────

const CLAVE_ESTADO = "backup_db_estado";

/** Build portable de PostgreSQL 18 con pg_dump/pg_restore (theseus-rs). */
const PG_TOOLS_URL =
  "https://github.com/theseus-rs/postgresql-binaries/releases/download/18.3.0/postgresql-18.3.0-x86_64-unknown-linux-gnu.tar.gz";
const PG_TOOLS_SHA256 = "71066f6534cfbc1f6d1f645b3c5c7d2d352eb6a53280fe863a5b3d82614e9f7b";
/** Versión mayor requerida: pg_dump debe ser >= a la versión del servidor. */
const PG_MAJOR_REQUERIDO = 18;

const INTERVALO_CHEQUEO_MS = 30 * 60 * 1000; // cada 30 min se evalúa si toca
const DELAY_INICIAL_MS = 60 * 1000; // dejar estabilizar el server al arrancar
/** 23.5 h en vez de 24 para que el horario no se corra un poco cada día. */
const ANTIGUEDAD_MAXIMA_MS = 23.5 * 60 * 60 * 1000;

function retencionDias(): number {
  const raw = process.env["BACKUP_DB_RETENCION_DIAS"]?.trim();
  const n = raw ? Number(raw) : NaN;
  // Mínimo 7 días por requisito; default 14.
  return Number.isFinite(n) && n >= 7 ? Math.floor(n) : 14;
}

// ── Estado persistido ───────────────────────────────────────────────────────

export interface BackupDbEstado {
  /** ISO de la última corrida (exitosa o no) */
  ultimaCorrida?: string;
  /** ISO del último backup exitoso */
  ultimaExitosa?: string;
  /** Ruta del objeto del último backup exitoso (gs://bucket/…) */
  ultimoObjeto?: string;
  /** Tamaño en bytes del último dump exitoso */
  ultimoTamanoBytes?: number;
  /** Base de datos respaldada (nombre) */
  base?: string;
  /** Duración de la última corrida exitosa en ms */
  duracionMs?: number;
  /** Error de la última corrida fallida (se limpia al lograr una exitosa) */
  ultimoError?: string;
  /** Cantidad de dumps borrados por retención en la última corrida */
  borradosPorRetencion?: number;
}

export async function leerEstadoBackup(): Promise<BackupDbEstado> {
  const [fila] = await db
    .select()
    .from(configSistemaTable)
    .where(eq(configSistemaTable.clave, CLAVE_ESTADO))
    .limit(1);
  if (!fila) return {};
  try {
    return JSON.parse(fila.valor) as BackupDbEstado;
  } catch {
    return {};
  }
}

async function guardarEstadoBackup(estado: BackupDbEstado): Promise<void> {
  await db
    .insert(configSistemaTable)
    .values({ clave: CLAVE_ESTADO, valor: JSON.stringify(estado) })
    .onConflictDoUpdate({
      target: configSistemaTable.clave,
      set: { valor: JSON.stringify(estado), actualizadoEn: sql`now()` },
    });
}

// ── Herramientas pg (pg_dump v18) ───────────────────────────────────────────

let pgToolsDirPromise: Promise<string> | null = null;

async function versionMayorDe(bin: string): Promise<number | null> {
  try {
    const out = await ejecutar(bin, ["--version"], {});
    const m = out.match(/\(PostgreSQL\)\s+(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Devuelve el directorio bin/ con pg_dump y pg_restore compatibles.
 * Usa el del sistema si ya es v18+; si no, descarga la build portable
 * (verificada por SHA-256) a un directorio temporal cacheado por proceso.
 */
export async function ensurePgTools(log: Logger = logger): Promise<string> {
  if (!pgToolsDirPromise) {
    pgToolsDirPromise = (async () => {
      const sistema = await versionMayorDe("pg_dump");
      if (sistema !== null && sistema >= PG_MAJOR_REQUERIDO) return ""; // usar PATH

      const destino = path.join(os.tmpdir(), `pg${PG_MAJOR_REQUERIDO}-tools`);
      const binDir = path.join(destino, "bin");
      if (await existe(path.join(binDir, "pg_dump"))) return binDir;

      log.info({ url: PG_TOOLS_URL }, "backup-db: descargando herramientas pg_dump v18");
      const tarball = path.join(os.tmpdir(), `pg-tools-${randomUUID()}.tar.gz`);
      const res = await fetch(PG_TOOLS_URL, { redirect: "follow" });
      if (!res.ok || !res.body) {
        throw new Error(`backup-db: descarga de pg tools falló (HTTP ${res.status})`);
      }
      await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(tarball));

      const hash = createHash("sha256").update(await fs.readFile(tarball)).digest("hex");
      if (hash !== PG_TOOLS_SHA256) {
        await fs.rm(tarball, { force: true });
        throw new Error("backup-db: SHA-256 del tarball de pg tools no coincide — se aborta");
      }

      await fs.mkdir(destino, { recursive: true });
      await ejecutar("tar", ["xzf", tarball, "-C", destino, "--strip-components=1"], {});
      await fs.rm(tarball, { force: true });
      if (!(await existe(path.join(binDir, "pg_dump")))) {
        throw new Error("backup-db: el tarball no contenía bin/pg_dump");
      }
      return binDir;
    })();
    // Si falló, permitir reintentar en la próxima corrida.
    pgToolsDirPromise.catch(() => {
      pgToolsDirPromise = null;
    });
  }
  return pgToolsDirPromise;
}

// ── Backup ──────────────────────────────────────────────────────────────────

let backupEnCurso = false;

export function backupEstaEnCurso(): boolean {
  return backupEnCurso;
}

export interface ResultadoBackup {
  objeto: string;
  base: string;
  tamanoBytes: number;
  duracionMs: number;
  borradosPorRetencion: number;
}

/**
 * Corre un backup completo ahora. Lanza si ya hay uno en curso.
 * @param urlOverride solo para pruebas/manuales: respaldar otra base del
 *                    mismo servidor (nunca se usa desde el worker).
 */
export async function correrBackupDb(
  log: Logger = logger,
  urlOverride?: string,
): Promise<ResultadoBackup> {
  if (backupEnCurso) throw new Error("Ya hay un backup en curso");
  backupEnCurso = true;
  const inicio = Date.now();
  const estado = await leerEstadoBackup();
  estado.ultimaCorrida = new Date().toISOString();
  try {
    const url = urlOverride ?? resolverClinicaUrl("backup-db").url;
    const parsed = new URL(url);
    const base = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres";

    const binDir = await ensurePgTools(log);
    const pgDump = binDir ? path.join(binDir, "pg_dump") : "pg_dump";

    // CA de RDS a archivo temporal para verificación TLS completa.
    const caPath = path.join(os.tmpdir(), "rds-ca.pem");
    await fs.writeFile(caPath, RDS_CA);

    // Dump en formato custom (comprimido, restaurable con pg_restore).
    const dumpPath = path.join(os.tmpdir(), `backup-${base}-${randomUUID()}.dump`);
    // La URL se pasa como argumento directo a spawn (sin shell): no se
    // interpola en bash ni queda en logs.
    const limpio = new URL(url);
    limpio.search = ""; // params tipo sslmode=no-verify (estilo node-pg) rompen libpq
    log.info({ base }, "backup-db: iniciando pg_dump");
    await ejecutar(
      pgDump,
      ["--format=custom", "--no-password", `--file=${dumpPath}`, `--dbname=${limpio.toString()}`],
      { PGSSLMODE: "verify-full", PGSSLROOTCERT: caPath, PGCONNECT_TIMEOUT: "30" },
    );

    const stat = await fs.stat(dumpPath);
    if (stat.size < 1024) {
      throw new Error(`backup-db: dump sospechosamente chico (${stat.size} bytes)`);
    }

    // Subida a object storage bajo el área privada.
    const { bucketName, prefijo } = rutaBackups(base);
    const ahora = new Date();
    const nombre = `${prefijo}${ahora.toISOString().replace(/[:]/g, "-").slice(0, 16)}.dump`;
    const bucket = objectStorageClient.bucket(bucketName);
    await bucket.upload(dumpPath, {
      destination: nombre,
      resumable: stat.size > 20 * 1024 * 1024,
      metadata: { contentType: "application/octet-stream" },
    });
    await fs.rm(dumpPath, { force: true });

    // Retención: borrar dumps más viejos que N días, conservando siempre
    // al menos los últimos 7 archivos por las dudas.
    const borrados = await aplicarRetencion(bucketName, prefijo, retencionDias(), log);

    const resultado: ResultadoBackup = {
      objeto: `gs://${bucketName}/${nombre}`,
      base,
      tamanoBytes: stat.size,
      duracionMs: Date.now() - inicio,
      borradosPorRetencion: borrados,
    };
    estado.ultimaExitosa = new Date().toISOString();
    estado.ultimoObjeto = resultado.objeto;
    estado.ultimoTamanoBytes = resultado.tamanoBytes;
    estado.base = base;
    estado.duracionMs = resultado.duracionMs;
    estado.borradosPorRetencion = borrados;
    delete estado.ultimoError;
    await guardarEstadoBackup(estado);
    log.info(
      { base, objeto: resultado.objeto, tamanoBytes: stat.size, duracionMs: resultado.duracionMs, borrados },
      "backup-db: backup completado",
    );
    return resultado;
  } catch (err) {
    estado.ultimoError = err instanceof Error ? err.message : String(err);
    await guardarEstadoBackup(estado).catch(() => {});
    throw err;
  } finally {
    backupEnCurso = false;
  }
}

function rutaBackups(base: string): { bucketName: string; prefijo: string } {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) {
    throw new Error("backup-db: PRIVATE_OBJECT_DIR no está configurado (Object Storage)");
  }
  // PRIVATE_OBJECT_DIR tiene forma /<bucket>/<subdir…>
  const partes = dir.replace(/^\//, "").replace(/\/$/, "").split("/");
  const bucketName = partes[0];
  const resto = partes.slice(1).join("/");
  const prefijo = `${resto ? `${resto}/` : ""}backups/${base}/`;
  return { bucketName, prefijo };
}

async function aplicarRetencion(
  bucketName: string,
  prefijo: string,
  dias: number,
  log: Logger,
): Promise<number> {
  const [files] = await objectStorageClient.bucket(bucketName).getFiles({ prefix: prefijo });
  const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
  // Ordenados de más nuevo a más viejo; nunca borrar los últimos 7.
  const ordenados = files
    .map((f) => ({ f, creado: new Date(String(f.metadata.timeCreated)).getTime() }))
    .sort((a, b) => b.creado - a.creado);
  let borrados = 0;
  for (const { f, creado } of ordenados.slice(7)) {
    if (creado < limite) {
      try {
        await f.delete();
        borrados++;
      } catch (err) {
        log.warn({ err, objeto: f.name }, "backup-db: no se pudo borrar dump viejo");
      }
    }
  }
  return borrados;
}

/** Lista los backups disponibles de la base actual (para estado/diagnóstico). */
export async function listarBackups(): Promise<
  Array<{ objeto: string; tamanoBytes: number; creado: string }>
> {
  const url = resolverClinicaUrl("backup-db").url;
  const base = decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || "postgres";
  const { bucketName, prefijo } = rutaBackups(base);
  const [files] = await objectStorageClient.bucket(bucketName).getFiles({ prefix: prefijo });
  return files
    .map((f) => ({
      objeto: `gs://${bucketName}/${f.name}`,
      tamanoBytes: Number(f.metadata.size ?? 0),
      creado: String(f.metadata.timeCreated ?? ""),
    }))
    .sort((a, b) => (a.creado < b.creado ? 1 : -1));
}

// ── Worker ──────────────────────────────────────────────────────────────────

function workerHabilitado(): boolean {
  const flag = process.env["BACKUP_DB_ENABLED"]?.trim();
  if (flag === "false") return false;
  if (flag === "true") return true;
  // Por defecto solo en producción/staging: es donde vive la base real.
  return process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
}

export function iniciarBackupDbWorker(): void {
  const log = logger.child({ modulo: "backup-db" });

  if (!workerHabilitado()) {
    log.info("backup-db: worker deshabilitado en este entorno (BACKUP_DB_ENABLED para forzar)");
    return;
  }
  if (!process.env.PRIVATE_OBJECT_DIR) {
    log.warn("backup-db: PRIVATE_OBJECT_DIR no configurado — worker inactivo");
    return;
  }

  const chequear = async () => {
    if (backupEnCurso) return;
    try {
      const estado = await leerEstadoBackup();
      const ultima = estado.ultimaExitosa ? Date.parse(estado.ultimaExitosa) : 0;
      if (Date.now() - ultima < ANTIGUEDAD_MAXIMA_MS) return;
      await correrBackupDb(log);
    } catch (err) {
      log.error({ err }, "backup-db: ciclo de backup falló");
    }
  };

  log.info(
    { intervaloMs: INTERVALO_CHEQUEO_MS, retencionDias: retencionDias() },
    "backup-db: worker activo (backup diario con catch-up)",
  );
  const primer = setTimeout(() => void chequear(), DELAY_INICIAL_MS);
  primer.unref();
  const timer = setInterval(() => void chequear(), INTERVALO_CHEQUEO_MS);
  timer.unref();
}

// ── Utilidades ──────────────────────────────────────────────────────────────

async function existe(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function ejecutar(
  cmd: string,
  args: string[],
  extraEnv: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (errOut += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} salió con código ${code}: ${errOut.slice(0, 500)}`));
    });
  });
}
