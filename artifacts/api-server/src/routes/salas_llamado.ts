// Salas de llamado: salas de espera con pantalla TV propia. El médico elige
// desde qué sala se anuncia su llamado (profesionales.sala_llamado_id).
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, salasLlamadoTable, profesionalesTable } from "@workspace/db";
import {
  CreateSalaLlamadoBody,
  UpdateSalaLlamadoBody,
  UpdateSalaLlamadoParams,
  DeleteSalaLlamadoParams,
} from "@workspace/api-zod";
import { requireRol } from "./auth";

const router: IRouter = Router();

// Todo el staff puede listar (el médico necesita ver las salas para elegir la
// suya), pero solo admin/recepción gestionan la configuración.
const soloStaff = requireRol("admin", "recepcionista", "medico");
const soloGestion = requireRol("admin", "recepcionista");

router.get("/salas-llamado", soloStaff, async (_req, res): Promise<void> => {
  const rows = await db.select().from(salasLlamadoTable).orderBy(salasLlamadoTable.nombre);
  res.json(rows);
});

router.post("/salas-llamado", soloGestion, async (req, res): Promise<void> => {
  const parsed = CreateSalaLlamadoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(salasLlamadoTable).values(parsed.data).returning();
  res.status(201).json(row);
});

router.patch("/salas-llamado/:id", soloGestion, async (req, res): Promise<void> => {
  const params = UpdateSalaLlamadoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateSalaLlamadoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(salasLlamadoTable)
    .set(parsed.data)
    .where(eq(salasLlamadoTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Sala no encontrada" });
    return;
  }
  res.json(row);
});

router.delete("/salas-llamado/:id", soloGestion, async (req, res): Promise<void> => {
  const params = DeleteSalaLlamadoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Los médicos que llamaban desde esta sala quedan sin sala asignada.
  await db
    .update(profesionalesTable)
    .set({ salaLlamadoId: null })
    .where(eq(profesionalesTable.salaLlamadoId, params.data.id));
  await db.delete(salasLlamadoTable).where(eq(salasLlamadoTable.id, params.data.id));
  res.sendStatus(204);
});

export default router;
