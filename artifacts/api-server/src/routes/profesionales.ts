import { Router, type IRouter } from "express";
import { eq, ilike, and, type SQL } from "drizzle-orm";
import { db, profesionalesTable, especialidadesTable, salasLlamadoTable } from "@workspace/db";
import {
  CreateProfesionalBody,
  UpdateProfesionalBody,
  GetProfesionalParams,
  UpdateProfesionalParams,
  DeleteProfesionalParams,
  ListProfesionalesQueryParams,
} from "@workspace/api-zod";
import { requireRol, getUserFromRequest } from "./auth";

const router: IRouter = Router();

// Escrituras solo staff; las lecturas quedan publicas (las usa la reserva online sin cuenta).
const soloStaff = requireRol("admin", "recepcionista", "medico");

// La firma escaneada NUNCA sale por los endpoints públicos: se sirve solo por
// el endpoint dedicado (staff). En las lecturas se expone solo tieneFirma.
function sinFirma<T extends { firmaImagen?: string | null }>(p: T) {
  const { firmaImagen, ...resto } = p;
  return { ...resto, tieneFirma: Boolean(firmaImagen) };
}

router.get("/profesionales", async (req, res): Promise<void> => {
  const params = ListProfesionalesQueryParams.safeParse(req.query);
  const conditions: SQL[] = [];
  if (params.success) {
    if (params.data.especialidadId != null)
      conditions.push(eq(profesionalesTable.especialidadId, params.data.especialidadId));
    if (params.data.activo != null)
      conditions.push(eq(profesionalesTable.activo, params.data.activo));
    if (params.data.q)
      conditions.push(ilike(profesionalesTable.nombre, `%${params.data.q}%`));
  }
  const rows = await db
    .select({
      profesional: profesionalesTable,
      especialidad: especialidadesTable,
    })
    .from(profesionalesTable)
    .leftJoin(especialidadesTable, eq(profesionalesTable.especialidadId, especialidadesTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(profesionalesTable.apellido, profesionalesTable.nombre);

  const result = rows.map((r) => ({
    ...sinFirma(r.profesional),
    especialidad: r.especialidad ?? null,
  }));
  res.json(result);
});

router.post("/profesionales", soloStaff, async (req, res): Promise<void> => {
  const parsed = CreateProfesionalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [prof] = await db.insert(profesionalesTable).values(parsed.data).returning();
  const [row] = await db
    .select({ profesional: profesionalesTable, especialidad: especialidadesTable })
    .from(profesionalesTable)
    .leftJoin(especialidadesTable, eq(profesionalesTable.especialidadId, especialidadesTable.id))
    .where(eq(profesionalesTable.id, prof.id))
    .limit(1);
  res.status(201).json({ ...sinFirma(row.profesional), especialidad: row.especialidad ?? null });
});

router.get("/profesionales/:id", async (req, res): Promise<void> => {
  const params = GetProfesionalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select({ profesional: profesionalesTable, especialidad: especialidadesTable })
    .from(profesionalesTable)
    .leftJoin(especialidadesTable, eq(profesionalesTable.especialidadId, especialidadesTable.id))
    .where(eq(profesionalesTable.id, params.data.id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Profesional no encontrado" });
    return;
  }
  res.json({ ...sinFirma(row.profesional), especialidad: row.especialidad ?? null });
});

router.patch("/profesionales/:id", soloStaff, async (req, res): Promise<void> => {
  const params = UpdateProfesionalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Un médico solo puede editar su propia ficha (ej: elegir su consultorio).
  const user = await getUserFromRequest(req);
  if (user?.rol === "medico" && Number(user.profesionalId) !== params.data.id) {
    res.status(403).json({ error: "Un médico solo puede editar su propia ficha" });
    return;
  }
  const parsed = UpdateProfesionalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // La sala de llamado elegida debe existir y estar activa.
  if (parsed.data.salaLlamadoId != null) {
    const [sala] = await db
      .select({ id: salasLlamadoTable.id, activa: salasLlamadoTable.activa })
      .from(salasLlamadoTable)
      .where(eq(salasLlamadoTable.id, parsed.data.salaLlamadoId))
      .limit(1);
    if (!sala || !sala.activa) {
      res.status(400).json({ error: "Sala de llamado no encontrada o inactiva" });
      return;
    }
  }
  await db.update(profesionalesTable).set(parsed.data).where(eq(profesionalesTable.id, params.data.id));
  const [row] = await db
    .select({ profesional: profesionalesTable, especialidad: especialidadesTable })
    .from(profesionalesTable)
    .leftJoin(especialidadesTable, eq(profesionalesTable.especialidadId, especialidadesTable.id))
    .where(eq(profesionalesTable.id, params.data.id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Profesional no encontrado" });
    return;
  }
  res.json({ ...sinFirma(row.profesional), especialidad: row.especialidad ?? null });
});

// ── Firma escaneada del profesional ─────────────────────────────────────────
// La puede subir/ver el admin o el propio médico. Data URL PNG/JPEG, máx 500KB.

const FIRMA_MAX_BYTES = 500 * 1024;
const FIRMA_DATAURL_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

router.get("/profesionales/:id/firma", async (req, res): Promise<void> => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const params = GetProfesionalParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const esPropia = user.rol === "medico" && Number(user.profesionalId) === params.data.id;
  if (user.rol !== "admin" && !esPropia) {
    res.status(403).json({ error: "Solo el admin o el propio médico pueden ver la firma" });
    return;
  }
  const [prof] = await db
    .select({ firmaImagen: profesionalesTable.firmaImagen, matricula: profesionalesTable.matricula })
    .from(profesionalesTable)
    .where(eq(profesionalesTable.id, params.data.id))
    .limit(1);
  if (!prof) { res.status(404).json({ error: "Profesional no encontrado" }); return; }
  res.json({ firmaImagen: prof.firmaImagen ?? null, matricula: prof.matricula ?? null });
});

router.put("/profesionales/:id/firma", async (req, res): Promise<void> => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const params = GetProfesionalParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  // Solo el administrador puede cargar/modificar firmas y matrículas de médicos.
  if (user.rol !== "admin") {
    res.status(403).json({ error: "Solo el administrador puede cargar la firma" });
    return;
  }
  const body = req.body as { firmaImagen?: string | null; matricula?: string | null };
  const { firmaImagen, matricula } = body;
  if (firmaImagen != null) {
    if (typeof firmaImagen !== "string" || !FIRMA_DATAURL_RE.test(firmaImagen)) {
      res.status(400).json({ error: "firmaImagen debe ser una data URL PNG o JPEG en base64" });
      return;
    }
    if (Buffer.byteLength(firmaImagen, "utf8") > FIRMA_MAX_BYTES) {
      res.status(413).json({ error: "La imagen de firma no puede superar 500KB" });
      return;
    }
  }
  if (matricula !== undefined && matricula !== null && typeof matricula !== "string") {
    res.status(400).json({ error: "matricula debe ser texto" });
    return;
  }
  // Solo tocar cada campo si vino en el body: mandar solo matricula no borra la firma.
  const cambios: Partial<typeof profesionalesTable.$inferInsert> = {};
  if ("firmaImagen" in body) cambios.firmaImagen = firmaImagen ?? null;
  if ("matricula" in body) cambios.matricula = matricula?.trim() || null;
  if (Object.keys(cambios).length === 0) {
    res.status(400).json({ error: "Sin cambios" });
    return;
  }
  const [prof] = await db
    .update(profesionalesTable)
    .set(cambios)
    .where(eq(profesionalesTable.id, params.data.id))
    .returning({ id: profesionalesTable.id, firmaImagen: profesionalesTable.firmaImagen, matricula: profesionalesTable.matricula });
  if (!prof) { res.status(404).json({ error: "Profesional no encontrado" }); return; }
  req.log.info({ profesionalId: prof.id, borrada: "firmaImagen" in body && firmaImagen == null }, "firma/sello de profesional actualizado");
  res.json({ id: prof.id, tieneFirma: Boolean(prof.firmaImagen), matricula: prof.matricula ?? null });
});

router.delete("/profesionales/:id", soloStaff, async (req, res): Promise<void> => {
  const params = DeleteProfesionalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, params.data.id));
  res.sendStatus(204);
});

export default router;
