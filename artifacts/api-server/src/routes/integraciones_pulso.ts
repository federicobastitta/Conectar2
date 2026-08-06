import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, usersTable, pacientesExternosTable, pulsoEstudiosTable } from "@workspace/db";
import { getUserIdFromToken } from "./auth";
import { logger } from "../lib/logger";
import { pulsoConfigurado } from "../integraciones/pulso-client";
import { sincronizarPacientesPulso, getEstadoSync } from "../integraciones/pulso-sync";
import {
  sincronizarEstudiosPulso,
  getEstadoEstudiosSync,
} from "../integraciones/pulso-estudios-sync";

const router: IRouter = Router();

// ── Integración Pulso ───────────────────────────────────────────────────────
// Pulso es una entrada de pacientes de la clínica. Estos endpoints permiten al
// admin disparar la importación manualmente y consultar el estado del sync.

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
    res.status(403).json({ error: "Solo administradores pueden operar la integración de Pulso" });
    return null;
  }
  return { id: user.id, email: user.email, rol: user.rol };
}

// POST /api/integraciones/pulso/sincronizar — dispara el sync en segundo plano
router.post("/integraciones/pulso/sincronizar", async (req: Request, res: Response): Promise<void> => {
  const admin = await getAdmin(req, res);
  if (!admin) return;

  if (!pulsoConfigurado()) {
    res.status(503).json({ error: "Pulso no está configurado (faltan credenciales)" });
    return;
  }
  if (getEstadoSync().sincronizando) {
    res.status(409).json({ error: "Ya hay una sincronización en curso", estado: getEstadoSync() });
    return;
  }

  const full = req.body?.full === true;
  const log = logger.child({ modulo: "pulso-sync", actor: admin.email });

  // Fire-and-forget: importar 5000+ pacientes puede tardar; el front hace polling
  // del estado. Los errores quedan en el estado del sync y en los logs.
  void sincronizarPacientesPulso({ full, actor: admin, log }).catch((err) => {
    log.error({ err }, "Pulso: sync manual falló");
  });

  res.status(202).json({ mensaje: "Sincronización iniciada", full, estado: getEstadoSync() });
});

// POST /api/integraciones/pulso/estudios/sincronizar — sync de estudios/informes
router.post(
  "/integraciones/pulso/estudios/sincronizar",
  async (req: Request, res: Response): Promise<void> => {
    const admin = await getAdmin(req, res);
    if (!admin) return;

    if (!pulsoConfigurado()) {
      res.status(503).json({ error: "Pulso no está configurado (faltan credenciales)" });
      return;
    }
    if (getEstadoEstudiosSync().sincronizando) {
      res.status(409).json({
        error: "Ya hay una sincronización de estudios en curso",
        estado: getEstadoEstudiosSync(),
      });
      return;
    }

    const full = req.body?.full === true;
    const ventanaDias =
      typeof req.body?.ventanaDias === "number" && req.body.ventanaDias > 0
        ? req.body.ventanaDias
        : undefined;
    const log = logger.child({ modulo: "pulso-estudios-sync", actor: admin.email });

    void sincronizarEstudiosPulso({ full, ventanaDias, actor: admin, log }).catch((err) => {
      log.error({ err }, "Pulso: sync manual de estudios falló");
    });

    res.status(202).json({
      mensaje: "Sincronización de estudios iniciada",
      full,
      estado: getEstadoEstudiosSync(),
    });
  },
);

// GET /api/integraciones/pulso/estado — estado del sync + cuántos importados
router.get("/integraciones/pulso/estado", async (req: Request, res: Response): Promise<void> => {
  const admin = await getAdmin(req, res);
  if (!admin) return;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(pacientesExternosTable)
    .where(eq(pacientesExternosTable.origen, "pulso"));

  const [{ ultimo }] = await db
    .select({ ultimo: sql<string | null>`max(${pacientesExternosTable.lastSyncedAt})` })
    .from(pacientesExternosTable)
    .where(eq(pacientesExternosTable.origen, "pulso"));

  const [{ estudiosTotal }] = await db
    .select({ estudiosTotal: sql<number>`count(*)::int` })
    .from(pulsoEstudiosTable);

  const [{ estudiosVinculados }] = await db
    .select({ estudiosVinculados: sql<number>`count(*)::int` })
    .from(pulsoEstudiosTable)
    .where(sql`${pulsoEstudiosTable.patientId} is not null`);

  const [{ estudiosUltimo }] = await db
    .select({ estudiosUltimo: sql<string | null>`max(${pulsoEstudiosTable.syncedAt})` })
    .from(pulsoEstudiosTable);

  res.json({
    configurado: pulsoConfigurado(),
    importados: total ?? 0,
    ultimaSincronizacion: ultimo ?? null,
    sync: getEstadoSync(),
    estudios: {
      total: estudiosTotal ?? 0,
      vinculados: estudiosVinculados ?? 0,
      ultimaSincronizacion: estudiosUltimo ?? null,
      sync: getEstadoEstudiosSync(),
    },
  });
});

export default router;
