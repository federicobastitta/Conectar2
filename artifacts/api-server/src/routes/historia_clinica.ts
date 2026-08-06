import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db, pacientesTable, evolucionesTable, recetasTable, diagnosticosTable, adjuntosTable, profesionalesTable,
} from "@workspace/db";
import {
  GetHistoriaClinicaParams,
  ListEvolucionesParams,
  CreateEvolucionBody,
  UpdateEvolucionBody,
  UpdateEvolucionParams,
  ListRecetasParams,
  CreateRecetaBody,
  ListDiagnosticosParams,
  CreateDiagnosticoBody,
  ListAdjuntosParams,
  CreateAdjuntoBody,
} from "@workspace/api-zod";
import { requireRol } from "./auth";

const router: IRouter = Router();

// HC legacy: solo staff. El paciente accede a su propia historia vía /hce con chequeo de ownership.
// Scoped a "/historia-clinica" para no interceptar rutas de otros routers del mismo prefijo.
router.use("/historia-clinica", requireRol("admin", "recepcionista", "medico"));

async function enrichWithProfesional<T extends { profesionalId?: number | null }>(item: T) {
  if (item.profesionalId) {
    const [p] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, item.profesionalId)).limit(1);
    return { ...item, profesional: p ?? null };
  }
  return { ...item, profesional: null };
}

// GET /historia-clinica/:pacienteId
router.get("/historia-clinica/:pacienteId", async (req, res): Promise<void> => {
  const params = GetHistoriaClinicaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { pacienteId } = params.data;
  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, pacienteId)).limit(1);
  if (!paciente) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }
  const [evoluciones, recetas, diagnosticos, adjuntos] = await Promise.all([
    db.select().from(evolucionesTable).where(eq(evolucionesTable.pacienteId, pacienteId)).orderBy(evolucionesTable.createdAt),
    db.select().from(recetasTable).where(eq(recetasTable.pacienteId, pacienteId)).orderBy(recetasTable.createdAt),
    db.select().from(diagnosticosTable).where(eq(diagnosticosTable.pacienteId, pacienteId)).orderBy(diagnosticosTable.createdAt),
    db.select().from(adjuntosTable).where(eq(adjuntosTable.pacienteId, pacienteId)).orderBy(adjuntosTable.createdAt),
  ]);
  res.json({ paciente, antecedentes: null, alergias: [], evoluciones, diagnosticos, recetas, adjuntos });
});

// Evoluciones
router.get("/historia-clinica/:pacienteId/evoluciones", async (req, res): Promise<void> => {
  const params = ListEvolucionesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db.select().from(evolucionesTable)
    .where(eq(evolucionesTable.pacienteId, params.data.pacienteId))
    .orderBy(evolucionesTable.createdAt);
  const enriched = await Promise.all(rows.map(enrichWithProfesional));
  res.json(enriched);
});

router.post("/historia-clinica/:pacienteId/evoluciones", async (req, res): Promise<void> => {
  const pathParams = ListEvolucionesParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }
  const parsed = CreateEvolucionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [ev] = await db.insert(evolucionesTable).values({ ...parsed.data, pacienteId: pathParams.data.pacienteId }).returning();
  res.status(201).json(await enrichWithProfesional(ev));
});

router.patch("/historia-clinica/:pacienteId/evoluciones/:evolucionId", async (req, res): Promise<void> => {
  const params = UpdateEvolucionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateEvolucionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [ev] = await db.update(evolucionesTable).set(parsed.data).where(eq(evolucionesTable.id, params.data.evolucionId)).returning();
  if (!ev) {
    res.status(404).json({ error: "Evolución no encontrada" });
    return;
  }
  res.json(await enrichWithProfesional(ev));
});

// Recetas
router.get("/historia-clinica/:pacienteId/recetas", async (req, res): Promise<void> => {
  const params = ListRecetasParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db.select().from(recetasTable)
    .where(eq(recetasTable.pacienteId, params.data.pacienteId))
    .orderBy(recetasTable.createdAt);
  const enriched = await Promise.all(rows.map(enrichWithProfesional));
  res.json(enriched);
});

router.post("/historia-clinica/:pacienteId/recetas", async (req, res): Promise<void> => {
  const pathParams = ListRecetasParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }
  const parsed = CreateRecetaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [receta] = await db.insert(recetasTable).values({ ...parsed.data, pacienteId: pathParams.data.pacienteId }).returning();
  res.status(201).json(await enrichWithProfesional(receta));
});

// Diagnosticos
router.get("/historia-clinica/:pacienteId/diagnosticos", async (req, res): Promise<void> => {
  const params = ListDiagnosticosParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db.select().from(diagnosticosTable)
    .where(eq(diagnosticosTable.pacienteId, params.data.pacienteId))
    .orderBy(diagnosticosTable.createdAt);
  const enriched = await Promise.all(rows.map(enrichWithProfesional));
  res.json(enriched);
});

router.post("/historia-clinica/:pacienteId/diagnosticos", async (req, res): Promise<void> => {
  const pathParams = ListDiagnosticosParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }
  const parsed = CreateDiagnosticoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [d] = await db.insert(diagnosticosTable).values({ ...parsed.data, pacienteId: pathParams.data.pacienteId }).returning();
  res.status(201).json(await enrichWithProfesional(d));
});

// Adjuntos
router.get("/historia-clinica/:pacienteId/adjuntos", async (req, res): Promise<void> => {
  const params = ListAdjuntosParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db.select().from(adjuntosTable)
    .where(eq(adjuntosTable.pacienteId, params.data.pacienteId))
    .orderBy(adjuntosTable.createdAt);
  res.json(rows);
});

router.post("/historia-clinica/:pacienteId/adjuntos", async (req, res): Promise<void> => {
  const pathParams = ListAdjuntosParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }
  const parsed = CreateAdjuntoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [adjunto] = await db.insert(adjuntosTable).values({ ...parsed.data, pacienteId: pathParams.data.pacienteId }).returning();
  res.status(201).json(adjunto);
});

export default router;
