import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, sedesTable } from "@workspace/db";
import {
  CreateSedeBody,
  UpdateSedeBody,
  GetSedeParams,
  UpdateSedeParams,
  DeleteSedeParams,
  ListSedesQueryParams,
} from "@workspace/api-zod";
import { requireRol } from "./auth";

const router: IRouter = Router();

// Escrituras solo staff; las lecturas quedan publicas (las usa la reserva online sin cuenta).
const soloStaff = requireRol("admin", "recepcionista", "medico");

router.get("/sedes", async (req, res): Promise<void> => {
  const params = ListSedesQueryParams.safeParse(req.query);
  let query = db.select().from(sedesTable);
  if (params.success && params.data.activa !== undefined) {
    query = query.where(eq(sedesTable.activa, params.data.activa)) as typeof query;
  }
  const sedes = await query.orderBy(sedesTable.nombre);
  res.json(sedes);
});

router.post("/sedes", soloStaff, async (req, res): Promise<void> => {
  const parsed = CreateSedeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [sede] = await db.insert(sedesTable).values(parsed.data).returning();
  res.status(201).json(sede);
});

router.get("/sedes/:id", async (req, res): Promise<void> => {
  const params = GetSedeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [sede] = await db.select().from(sedesTable).where(eq(sedesTable.id, params.data.id)).limit(1);
  if (!sede) {
    res.status(404).json({ error: "Sede no encontrada" });
    return;
  }
  res.json(sede);
});

router.patch("/sedes/:id", soloStaff, async (req, res): Promise<void> => {
  const params = UpdateSedeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateSedeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [sede] = await db.update(sedesTable).set(parsed.data).where(eq(sedesTable.id, params.data.id)).returning();
  if (!sede) {
    res.status(404).json({ error: "Sede no encontrada" });
    return;
  }
  res.json(sede);
});

router.delete("/sedes/:id", soloStaff, async (req, res): Promise<void> => {
  const params = DeleteSedeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db.delete(sedesTable).where(eq(sedesTable.id, params.data.id));
  res.sendStatus(204);
});

export default router;
