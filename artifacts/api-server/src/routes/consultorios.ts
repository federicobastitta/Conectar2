import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, consultoriosTable } from "@workspace/db";
import {
  CreateConsultorioBody,
  UpdateConsultorioBody,
  UpdateConsultorioParams,
  DeleteConsultorioParams,
} from "@workspace/api-zod";
import { requireRol } from "./auth";

const router: IRouter = Router();

const soloStaff = requireRol("admin", "recepcionista", "medico");

router.get("/consultorios", soloStaff, async (_req, res): Promise<void> => {
  const rows = await db.select().from(consultoriosTable).orderBy(consultoriosTable.nombre);
  res.json(rows);
});

router.post("/consultorios", soloStaff, async (req, res): Promise<void> => {
  const parsed = CreateConsultorioBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(consultoriosTable).values(parsed.data).returning();
  res.status(201).json(row);
});

router.patch("/consultorios/:id", soloStaff, async (req, res): Promise<void> => {
  const params = UpdateConsultorioParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateConsultorioBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(consultoriosTable)
    .set(parsed.data)
    .where(eq(consultoriosTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Consultorio no encontrado" });
    return;
  }
  res.json(row);
});

router.delete("/consultorios/:id", soloStaff, async (req, res): Promise<void> => {
  const params = DeleteConsultorioParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db.delete(consultoriosTable).where(eq(consultoriosTable.id, params.data.id));
  res.sendStatus(204);
});

export default router;
