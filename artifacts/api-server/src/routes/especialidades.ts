import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, especialidadesTable } from "@workspace/db";
import {
  CreateEspecialidadBody,
  UpdateEspecialidadBody,
  UpdateEspecialidadParams,
  DeleteEspecialidadParams,
} from "@workspace/api-zod";
import { requireRol } from "./auth";

const router: IRouter = Router();

// Escrituras solo staff; las lecturas quedan publicas (las usa la reserva online sin cuenta).
const soloStaff = requireRol("admin", "recepcionista", "medico");

router.get("/especialidades", async (_req, res): Promise<void> => {
  const especialidades = await db.select().from(especialidadesTable).orderBy(especialidadesTable.nombre);
  res.json(especialidades);
});

router.post("/especialidades", soloStaff, async (req, res): Promise<void> => {
  const parsed = CreateEspecialidadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [especialidad] = await db.insert(especialidadesTable).values(parsed.data).returning();
  res.status(201).json(especialidad);
});

router.patch("/especialidades/:id", soloStaff, async (req, res): Promise<void> => {
  const params = UpdateEspecialidadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateEspecialidadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [esp] = await db.update(especialidadesTable).set(parsed.data).where(eq(especialidadesTable.id, params.data.id)).returning();
  if (!esp) {
    res.status(404).json({ error: "Especialidad no encontrada" });
    return;
  }
  res.json(esp);
});

router.delete("/especialidades/:id", soloStaff, async (req, res): Promise<void> => {
  const params = DeleteEspecialidadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db.delete(especialidadesTable).where(eq(especialidadesTable.id, params.data.id));
  res.sendStatus(204);
});

export default router;
