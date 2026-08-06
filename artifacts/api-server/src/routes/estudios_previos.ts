/**
 * Estudios previos aportados por el paciente ("Subir estudios previos").
 *
 * El paciente sube desde Mi Diagnosticar un PDF o foto de un estudio hecho en
 * otro lado (laboratorio, imagen, informe). El equipo clínico lo ve en la HC
 * como "Aportado por el paciente".
 *
 * Archivos → object storage (URL prefirmada). Metadatos → clinica-db
 * (datos de pacientes → AWS; fallback DATABASE_URL solo en dev).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { eq } from "drizzle-orm";
import { db, usersTable, pacientesTable } from "@workspace/db";
import {
  CreateEstudioPrevioBody,
  RequestEstudioPrevioUploadUrlBody,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { getUserIdFromToken } from "./auth";
import {
  listarEstudiosPrevios,
  obtenerEstudioPrevio,
  crearEstudioPrevio,
  eliminarEstudioPrevio,
  type EstudioPrevioRow,
} from "../integraciones/estudios-previos-db";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

const CONTENT_TYPES_PERMITIDOS = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const TAMANO_MAXIMO_BYTES = 20 * 1024 * 1024; // 20 MB

type AuthUser = { id: number; rol: string; pacienteId: number | null };

async function getUser(req: Request): Promise<AuthUser | null> {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const userId = await getUserIdFromToken(token);
  if (!userId) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return null;
  return {
    id: user.id,
    rol: user.rol,
    pacienteId: user.pacienteId ? parseInt(user.pacienteId) : null,
  };
}

// Lectura: staff siempre; paciente solo su propia ficha
function puedeLeer(user: AuthUser, pacienteId: number): boolean {
  if (["admin", "medico", "recepcionista"].includes(user.rol)) return true;
  if (user.rol === "paciente") return user.pacienteId === pacienteId;
  return false;
}

// Escritura (subir/eliminar): el paciente sobre su propia ficha, o staff
// administrativo/médico en su nombre (ej. recepción ayuda a cargar).
function puedeEscribir(user: AuthUser, pacienteId: number): boolean {
  return puedeLeer(user, pacienteId);
}

function parsePacienteId(req: Request): number | null {
  const id = parseInt(String(req.params.id));
  return Number.isNaN(id) ? null : id;
}

function mapRow(row: EstudioPrevioRow) {
  return {
    id: row.id,
    pacienteId: row.conectar_paciente_id,
    tipo: row.tipo,
    titulo: row.titulo,
    descripcion: row.descripcion,
    fechaEstudio: row.fecha_estudio,
    nombreArchivo: row.nombre_archivo,
    contentType: row.content_type,
    tamanoBytes: row.tamano_bytes == null ? null : Number(row.tamano_bytes),
    subidoPorRol: row.subido_por_rol,
    createdAt: row.created_at,
  };
}

async function existePaciente(pacienteId: number): Promise<boolean> {
  const [pac] = await db.select({ id: pacientesTable.id }).from(pacientesTable).where(eq(pacientesTable.id, pacienteId)).limit(1);
  return Boolean(pac);
}

// ── POST /pacientes/:id/estudios-previos/upload-url ──────────────────────
router.post("/pacientes/:id/estudios-previos/upload-url", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const pacienteId = parsePacienteId(req);
  if (pacienteId == null) { res.status(400).json({ error: "id inválido" }); return; }
  if (!puedeEscribir(user, pacienteId)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const parsed = RequestEstudioPrevioUploadUrlBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  if (!CONTENT_TYPES_PERMITIDOS.includes(parsed.data.contentType)) {
    res.status(400).json({ error: "Formato no soportado: subí un PDF o una foto (JPG/PNG)" });
    return;
  }
  if (parsed.data.size > TAMANO_MAXIMO_BYTES) {
    res.status(400).json({ error: "El archivo supera el máximo de 20 MB" });
    return;
  }

  try {
    const uploadURL = await objectStorage.getObjectEntityUploadURL();
    const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
    res.json({ uploadURL, objectPath });
  } catch (error) {
    req.log.error({ err: error }, "Error generando URL de subida de estudio previo");
    res.status(500).json({ error: "No se pudo iniciar la subida" });
  }
});

// ── POST /pacientes/:id/estudios-previos ──────────────────────────────────
router.post("/pacientes/:id/estudios-previos", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const pacienteId = parsePacienteId(req);
  if (pacienteId == null) { res.status(400).json({ error: "id inválido" }); return; }
  if (!puedeEscribir(user, pacienteId)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const parsed = CreateEstudioPrevioBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  if (!(await existePaciente(pacienteId))) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }
  if (!parsed.data.objectPath.startsWith("/objects/")) {
    res.status(400).json({ error: "objectPath inválido" });
    return;
  }

  const row = await crearEstudioPrevio({
    pacienteId,
    tipo: parsed.data.tipo,
    titulo: parsed.data.titulo.trim(),
    descripcion: parsed.data.descripcion?.trim() || null,
    fechaEstudio: parsed.data.fechaEstudio?.trim() || null,
    objectPath: parsed.data.objectPath,
    nombreArchivo: parsed.data.nombreArchivo,
    contentType: parsed.data.contentType ?? null,
    tamanoBytes: parsed.data.tamanoBytes ?? null,
    subidoPorUserId: user.id,
    subidoPorRol: user.rol,
  });

  req.log.info({ pacienteId, estudioPrevioId: row.id, tipo: row.tipo }, "Estudio previo cargado");
  res.status(201).json(mapRow(row));
});

// ── GET /pacientes/:id/estudios-previos ───────────────────────────────────
router.get("/pacientes/:id/estudios-previos", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const pacienteId = parsePacienteId(req);
  if (pacienteId == null) { res.status(400).json({ error: "id inválido" }); return; }
  if (!puedeLeer(user, pacienteId)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const rows = await listarEstudiosPrevios(pacienteId);
  res.json(rows.map(mapRow));
});

// ── GET /pacientes/:id/estudios-previos/:estudioPrevioId/archivo ──────────
// Sirve el archivo con control de permisos (no expuesto por /storage, que es solo staff).
router.get("/pacientes/:id/estudios-previos/:estudioPrevioId/archivo", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const pacienteId = parsePacienteId(req);
  const estudioPrevioId = parseInt(String(req.params.estudioPrevioId));
  if (pacienteId == null || Number.isNaN(estudioPrevioId)) { res.status(400).json({ error: "Parámetros inválidos" }); return; }
  if (!puedeLeer(user, pacienteId)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const estudio = await obtenerEstudioPrevio(pacienteId, estudioPrevioId);
  if (!estudio) { res.status(404).json({ error: "Estudio previo no encontrado" }); return; }

  try {
    const objectFile = await objectStorage.getObjectEntityFile(estudio.object_path);
    const response = await objectStorage.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (estudio.content_type) res.setHeader("Content-Type", estudio.content_type);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${estudio.nombre_archivo.replace(/[^\w.\- ]/g, "_")}"`,
    );

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Archivo no encontrado" });
      return;
    }
    req.log.error({ err: error }, "Error sirviendo archivo de estudio previo");
    res.status(500).json({ error: "No se pudo descargar el archivo" });
  }
});

// ── DELETE /pacientes/:id/estudios-previos/:estudioPrevioId ───────────────
router.delete("/pacientes/:id/estudios-previos/:estudioPrevioId", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const pacienteId = parsePacienteId(req);
  const estudioPrevioId = parseInt(String(req.params.estudioPrevioId));
  if (pacienteId == null || Number.isNaN(estudioPrevioId)) { res.status(400).json({ error: "Parámetros inválidos" }); return; }
  if (!puedeEscribir(user, pacienteId)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const ok = await eliminarEstudioPrevio(pacienteId, estudioPrevioId);
  if (!ok) { res.status(404).json({ error: "Estudio previo no encontrado" }); return; }
  req.log.info({ pacienteId, estudioPrevioId }, "Estudio previo eliminado");
  res.sendStatus(204);
});

export default router;
