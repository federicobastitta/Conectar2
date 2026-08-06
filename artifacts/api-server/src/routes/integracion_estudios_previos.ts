/**
 * Integración servidor a servidor para subir estudios previos desde el
 * backend de Mi Diagnosticar (u otro sistema externo autorizado).
 *
 * Autenticación: header x-api-key comparado en tiempo constante contra
 * ESTUDIOS_PREVIOS_API_KEY. El paciente se identifica por DNI (nunca por
 * ids internos de otro sistema). El token de sesión del paciente del
 * sistema externo NUNCA viaja a Conectar.
 *
 * Flujo (2 pasos, igual que la subida del paciente logueado):
 *   1) POST /integraciones/estudios-previos/upload-url
 *      { dni, contentType, size } → { uploadURL, objectPath }
 *      El externo hace PUT del binario a uploadURL.
 *   2) POST /integraciones/estudios-previos
 *      { dni, tipo, titulo, descripcion?, fechaEstudio?, objectPath,
 *        nombreArchivo, contentType?, tamanoBytes? } → 201 con el registro.
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, pacientesTable } from "@workspace/db";
import { ObjectStorageService } from "../lib/objectStorage";
import { crearEstudioPrevio } from "../integraciones/estudios-previos-db";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

const CONTENT_TYPES_PERMITIDOS = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const TAMANO_MAXIMO_BYTES = 20 * 1024 * 1024; // 20 MB
const ROL_INTEGRACION = "integracion-diagnosticar";

function claveValida(provista: string | undefined): boolean {
  const esperada = process.env.ESTUDIOS_PREVIOS_API_KEY?.trim();
  if (!esperada || !provista) return false;
  const a = Buffer.from(provista);
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!process.env.ESTUDIOS_PREVIOS_API_KEY?.trim()) {
    res.status(503).json({ error: "Integración de estudios previos no configurada" });
    return;
  }
  if (!claveValida(req.header("x-api-key"))) {
    req.log.warn("integracion-estudios-previos: x-api-key inválida o faltante");
    res.status(401).json({ error: "Clave de API inválida o faltante" });
    return;
  }
  next();
}

// Scopear SOLO a este prefijo para no filtrar el middleware a otros routers.
router.use("/integraciones/estudios-previos", requireApiKey);

const DniSchema = z
  .string()
  .trim()
  .regex(/^\d{6,9}$/, "dni inválido: se esperan 6 a 9 dígitos");

async function buscarPacientePorDni(dni: string): Promise<{ id: number } | null> {
  const [pac] = await db
    .select({ id: pacientesTable.id })
    .from(pacientesTable)
    .where(and(eq(pacientesTable.activo, true), sql`btrim(${pacientesTable.dni}) = ${dni}`))
    .limit(1);
  return pac ?? null;
}

const UploadUrlBody = z.object({
  dni: DniSchema,
  contentType: z.string(),
  size: z.number().int().positive(),
});

// ── POST /integraciones/estudios-previos/upload-url ──────────────────────
router.post("/integraciones/estudios-previos/upload-url", async (req: Request, res: Response) => {
  const parsed = UploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!CONTENT_TYPES_PERMITIDOS.includes(parsed.data.contentType)) {
    res.status(400).json({ error: "Formato no soportado: PDF, JPG, PNG o WEBP" });
    return;
  }
  if (parsed.data.size > TAMANO_MAXIMO_BYTES) {
    res.status(400).json({ error: "El archivo supera el máximo de 20 MB" });
    return;
  }
  const paciente = await buscarPacientePorDni(parsed.data.dni);
  if (!paciente) {
    res.status(404).json({ error: "Paciente no encontrado por DNI" });
    return;
  }

  try {
    const uploadURL = await objectStorage.getObjectEntityUploadURL();
    const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
    res.json({ uploadURL, objectPath });
  } catch (error) {
    req.log.error({ err: error }, "integracion-estudios-previos: error generando URL de subida");
    res.status(500).json({ error: "No se pudo iniciar la subida" });
  }
});

const CrearBody = z.object({
  dni: DniSchema,
  tipo: z.enum(["laboratorio", "imagen", "informe", "otro"]),
  titulo: z.string().trim().min(1).max(200),
  descripcion: z.string().trim().max(2000).optional(),
  fechaEstudio: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "fechaEstudio inválida: formato YYYY-MM-DD")
    .optional(),
  objectPath: z.string(),
  nombreArchivo: z.string().trim().min(1).max(255),
  contentType: z.string().optional(),
  tamanoBytes: z.number().int().positive().optional(),
});

// ── POST /integraciones/estudios-previos ──────────────────────────────────
router.post("/integraciones/estudios-previos", async (req: Request, res: Response) => {
  const parsed = CrearBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!parsed.data.objectPath.startsWith("/objects/")) {
    res.status(400).json({ error: "objectPath inválido" });
    return;
  }
  if (parsed.data.contentType && !CONTENT_TYPES_PERMITIDOS.includes(parsed.data.contentType)) {
    res.status(400).json({ error: "Formato no soportado: PDF, JPG, PNG o WEBP" });
    return;
  }
  if (parsed.data.tamanoBytes && parsed.data.tamanoBytes > TAMANO_MAXIMO_BYTES) {
    res.status(400).json({ error: "El archivo supera el máximo de 20 MB" });
    return;
  }

  const paciente = await buscarPacientePorDni(parsed.data.dni);
  if (!paciente) {
    res.status(404).json({ error: "Paciente no encontrado por DNI" });
    return;
  }

  const row = await crearEstudioPrevio({
    pacienteId: paciente.id,
    tipo: parsed.data.tipo,
    titulo: parsed.data.titulo,
    descripcion: parsed.data.descripcion || null,
    fechaEstudio: parsed.data.fechaEstudio || null,
    objectPath: parsed.data.objectPath,
    nombreArchivo: parsed.data.nombreArchivo,
    contentType: parsed.data.contentType ?? null,
    tamanoBytes: parsed.data.tamanoBytes ?? null,
    subidoPorUserId: null,
    subidoPorRol: ROL_INTEGRACION,
  });

  req.log.info(
    { pacienteId: paciente.id, estudioPrevioId: row.id, tipo: row.tipo, origen: ROL_INTEGRACION },
    "Estudio previo cargado vía integración",
  );
  res.status(201).json({
    id: row.id,
    pacienteId: row.conectar_paciente_id,
    tipo: row.tipo,
    titulo: row.titulo,
    createdAt: row.created_at,
  });
});

export default router;
