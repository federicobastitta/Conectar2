import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getUserIdFromToken } from "./auth";
import { logger } from "../lib/logger";
import {
  backupEstaEnCurso,
  correrBackupDb,
  leerEstadoBackup,
  listarBackups,
} from "../integraciones/backup-db";

const router: IRouter = Router();

// ── Backups de la base clinica-db ──────────────────────────────────────────
// Estado y disparo manual del backup diario (pg_dump → Object Storage).
// Solo administradores. Ver docs/backups-db.md.

type AuthUser = { id: number; email: string; rol: string };

async function getAdmin(req: Request, res: Response): Promise<AuthUser | null> {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  const userId = await getUserIdFromToken(token);
  if (!userId) {
    res.status(401).json({ error: "Sesión inválida" });
    return null;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    res.status(401).json({ error: "Usuario no encontrado" });
    return null;
  }
  if (user.rol !== "admin") {
    res.status(403).json({ error: "Solo administradores pueden operar los backups" });
    return null;
  }
  return { id: user.id, email: user.email, rol: user.rol };
}

// GET /api/backups-db/estado — estado del backup diario + listado de dumps
router.get("/backups-db/estado", async (req: Request, res: Response): Promise<void> => {
  const admin = await getAdmin(req, res);
  if (!admin) return;
  try {
    const estado = await leerEstadoBackup();
    let backups: Awaited<ReturnType<typeof listarBackups>> = [];
    try {
      backups = await listarBackups();
    } catch {
      // Object storage puede no estar configurado en este entorno.
    }
    res.json({ enCurso: backupEstaEnCurso(), estado, backups });
  } catch (err) {
    logger.error({ err, modulo: "backup-db" }, "backup-db: error consultando estado");
    res.status(500).json({ error: "Error consultando el estado de backups" });
  }
});

// POST /api/backups-db/correr — dispara un backup ahora (en segundo plano)
router.post("/backups-db/correr", async (req: Request, res: Response): Promise<void> => {
  const admin = await getAdmin(req, res);
  if (!admin) return;
  if (backupEstaEnCurso()) {
    res.status(409).json({ error: "Ya hay un backup en curso" });
    return;
  }
  const log = logger.child({ modulo: "backup-db", actor: admin.email });
  // Se corre en segundo plano: un dump puede tardar varios minutos.
  void correrBackupDb(log).catch((err) => {
    log.error({ err }, "backup-db: backup manual falló");
  });
  res.status(202).json({ mensaje: "Backup iniciado en segundo plano" });
});

export default router;
