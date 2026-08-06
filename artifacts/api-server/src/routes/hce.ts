import { Router, type IRouter, type Request, type Response } from "express";
import { desc, eq, inArray } from "drizzle-orm";
import {
  db,
  pacientesTable,
  profesionalesTable,
  usersTable,
  clinicalRecordsTable,
  encountersTable,
  vitalSignsTable,
  prescriptionsTable,
  encounterAttachmentsTable,
  auditLogTable,
} from "@workspace/db";
import {
  GetHceHistoryParams,
  UpsertHceHistoryBody,
  ListHceEncountersParams,
  CreateHceEncounterBody,
  CreateHceVitalsBody,
  CreateHcePrescriptionBody,
  CreateHceAttachmentBody,
} from "@workspace/api-zod";
import { getUserIdFromToken } from "./auth";
import { medicoPuedeVerPaciente } from "../lib/alcance-medico";
import { crearValoracionPendiente } from "../integraciones/app-paciente-valoraciones";

const router: IRouter = Router();

// ── Auth y permisos ───────────────────────────────────────────────────────
// admin: acceso total | medico: lectura y escritura
// recepcionista (secretaria) y auditor: solo lectura
// paciente: solo lectura de su propia historia clínica

type HceUser = {
  id: number;
  email: string;
  rol: string;
  pacienteId: number | null;
  profesionalId: number | null;
};

async function getHceUser(req: Request): Promise<HceUser | null> {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const userId = await getUserIdFromToken(token);
  if (!userId) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    rol: user.rol,
    pacienteId: user.pacienteId ? parseInt(user.pacienteId) : null,
    profesionalId: user.profesionalId ? parseInt(user.profesionalId) : null,
  };
}

const ROLES_LECTURA = ["admin", "medico", "recepcionista", "secretaria", "auditor", "paciente"];
const ROLES_ESCRITURA = ["admin", "medico"];

async function puedeLeer(user: HceUser, patientId: number): Promise<boolean> {
  if (!ROLES_LECTURA.includes(user.rol)) return false;
  if (user.rol === "paciente") return user.pacienteId === patientId;
  // Un médico solo lee historias de pacientes dentro de su alcance
  // (turnos suyos o de turneras grupales en las que participa).
  if (user.rol === "medico") {
    if (user.profesionalId == null) return false;
    return medicoPuedeVerPaciente(user.profesionalId, patientId);
  }
  return true;
}

function puedeEscribir(user: HceUser): boolean {
  return ROLES_ESCRITURA.includes(user.rol);
}

// Escritura sobre un paciente concreto: el médico solo puede escribir en
// historias de pacientes dentro de su alcance (mismo criterio que la lectura).
async function puedeEscribirSobre(user: HceUser, patientId: number): Promise<boolean> {
  if (!puedeEscribir(user)) return false;
  if (user.rol === "medico") {
    if (user.profesionalId == null) return false;
    return medicoPuedeVerPaciente(user.profesionalId, patientId);
  }
  return true;
}

async function registrarAuditoria(
  user: HceUser,
  accion: string,
  entidad: string,
  entidadId: number | null,
  pacienteId: number | null,
  detalle: unknown,
): Promise<void> {
  await db.insert(auditLogTable).values({
    usuarioId: user.id,
    usuarioEmail: user.email,
    rol: user.rol,
    accion,
    entidad,
    entidadId,
    pacienteId,
    detalle,
  });
}

async function getOrCreateRecord(patientId: number) {
  const [existing] = await db
    .select()
    .from(clinicalRecordsTable)
    .where(eq(clinicalRecordsTable.patientId, patientId))
    .limit(1);
  if (existing) return existing;
  const [created] = await db.insert(clinicalRecordsTable).values({ patientId }).returning();
  return created;
}

async function buildEncountersFull(clinicalRecordId: number) {
  const encounters = await db
    .select()
    .from(encountersTable)
    .where(eq(encountersTable.clinicalRecordId, clinicalRecordId))
    .orderBy(desc(encountersTable.encounterDate));

  const ids = encounters.map((e) => e.id);
  const [vitals, prescriptions, attachments] = ids.length
    ? await Promise.all([
        db.select().from(vitalSignsTable).where(inArray(vitalSignsTable.encounterId, ids)),
        db.select().from(prescriptionsTable).where(inArray(prescriptionsTable.encounterId, ids)),
        db.select().from(encounterAttachmentsTable).where(inArray(encounterAttachmentsTable.encounterId, ids)),
      ])
    : [[], [], []];

  const profIds = [...new Set(encounters.map((e) => e.professionalId).filter((x): x is number => x != null))];
  const profesionales = profIds.length
    ? await db.select().from(profesionalesTable).where(inArray(profesionalesTable.id, profIds))
    : [];
  const profMap = new Map(profesionales.map((p) => [p.id, p]));

  return encounters.map((e) => ({
    ...e,
    professional: e.professionalId != null ? (profMap.get(e.professionalId) ?? null) : null,
    vitals: vitals.filter((v) => v.encounterId === e.id),
    prescriptions: prescriptions.filter((p) => p.encounterId === e.id),
    attachments: attachments.filter((a) => a.encounterId === e.id),
  }));
}

async function patientIdOfEncounter(encounterId: number): Promise<number | null> {
  const [enc] = await db.select().from(encountersTable).where(eq(encountersTable.id, encounterId)).limit(1);
  if (!enc) return null;
  const [rec] = await db
    .select()
    .from(clinicalRecordsTable)
    .where(eq(clinicalRecordsTable.id, enc.clinicalRecordId))
    .limit(1);
  return rec?.patientId ?? null;
}

// ── GET /hce/history/:patientId ───────────────────────────────────────────
router.get("/hce/history/:patientId", async (req: Request, res: Response): Promise<void> => {
  const user = await getHceUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }

  const params = GetHceHistoryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { patientId } = params.data;

  if (!(await puedeLeer(user, patientId))) { res.status(403).json({ error: "Sin permisos para ver esta historia clínica" }); return; }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, patientId)).limit(1);
  if (!paciente) { res.status(404).json({ error: "Paciente no encontrado" }); return; }

  const [record] = await db
    .select()
    .from(clinicalRecordsTable)
    .where(eq(clinicalRecordsTable.patientId, patientId))
    .limit(1);

  const encounters = record ? await buildEncountersFull(record.id) : [];

  res.json({ paciente, record: record ?? null, encounters });
});

// ── POST /hce/history ─────────────────────────────────────────────────────
router.post("/hce/history", async (req: Request, res: Response): Promise<void> => {
  const user = await getHceUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos de escritura en la HCE" }); return; }

  const parsed = UpsertHceHistoryBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { patientId, ...fields } = parsed.data;

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, patientId)).limit(1);
  if (!paciente) { res.status(404).json({ error: "Paciente no encontrado" }); return; }
  if (!(await puedeEscribirSobre(user, patientId))) { res.status(403).json({ error: "Sin permisos sobre este paciente" }); return; }

  const [existing] = await db
    .select()
    .from(clinicalRecordsTable)
    .where(eq(clinicalRecordsTable.patientId, patientId))
    .limit(1);

  let record;
  if (existing) {
    [record] = await db
      .update(clinicalRecordsTable)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(clinicalRecordsTable.id, existing.id))
      .returning();
    await registrarAuditoria(user, "actualizar", "clinical_record", existing.id, patientId, fields);
  } else {
    [record] = await db.insert(clinicalRecordsTable).values({ patientId, ...fields }).returning();
    await registrarAuditoria(user, "crear", "clinical_record", record.id, patientId, fields);
  }

  res.status(201).json(record);
});

// ── GET /hce/encounters/:patientId ────────────────────────────────────────
router.get("/hce/encounters/:patientId", async (req: Request, res: Response): Promise<void> => {
  const user = await getHceUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }

  const params = ListHceEncountersParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { patientId } = params.data;

  if (!(await puedeLeer(user, patientId))) { res.status(403).json({ error: "Sin permisos para ver esta historia clínica" }); return; }

  const [record] = await db
    .select()
    .from(clinicalRecordsTable)
    .where(eq(clinicalRecordsTable.patientId, patientId))
    .limit(1);

  res.json(record ? await buildEncountersFull(record.id) : []);
});

// ── POST /hce/encounters ──────────────────────────────────────────────────
router.post("/hce/encounters", async (req: Request, res: Response): Promise<void> => {
  const user = await getHceUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos de escritura en la HCE" }); return; }

  const parsed = CreateHceEncounterBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { patientId, ...fields } = parsed.data;

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, patientId)).limit(1);
  if (!paciente) { res.status(404).json({ error: "Paciente no encontrado" }); return; }
  if (!(await puedeEscribirSobre(user, patientId))) { res.status(403).json({ error: "Sin permisos sobre este paciente" }); return; }

  const record = await getOrCreateRecord(patientId);
  const [encounter] = await db
    .insert(encountersTable)
    .values({
      clinicalRecordId: record.id,
      ...fields,
      professionalId: fields.professionalId ?? user.profesionalId ?? null,
    })
    .returning();

  await registrarAuditoria(user, "crear", "encounter", encounter.id, patientId, fields);

  // Invitación a valorar la atención (fire-and-forget, nunca bloquea)
  const profesionalIdValoracion = fields.professionalId ?? user.profesionalId ?? null;
  if (profesionalIdValoracion != null) {
    void crearValoracionPendiente({
      encounterId: encounter.id,
      pacienteId: patientId,
      profesionalId: profesionalIdValoracion,
    });
  }

  res.status(201).json(encounter);
});

// ── POST /hce/vitals ──────────────────────────────────────────────────────
router.post("/hce/vitals", async (req: Request, res: Response): Promise<void> => {
  const user = await getHceUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos de escritura en la HCE" }); return; }

  const parsed = CreateHceVitalsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const pacienteId = await patientIdOfEncounter(parsed.data.encounterId);
  if (pacienteId == null) { res.status(404).json({ error: "Consulta no encontrada" }); return; }
  if (!(await puedeEscribirSobre(user, pacienteId))) { res.status(403).json({ error: "Sin permisos sobre este paciente" }); return; }

  const data = { ...parsed.data, bmi: null as number | null };
  if (data.weight != null && data.height != null && data.height > 0) {
    const alturaMetros = data.height > 3 ? data.height / 100 : data.height;
    data.bmi = Math.round((data.weight / (alturaMetros * alturaMetros)) * 10) / 10;
  }

  const [vitals] = await db.insert(vitalSignsTable).values(data).returning();
  await registrarAuditoria(user, "crear", "vital_signs", vitals.id, pacienteId, data);
  res.status(201).json(vitals);
});

// ── POST /hce/prescriptions ───────────────────────────────────────────────
router.post("/hce/prescriptions", async (req: Request, res: Response): Promise<void> => {
  const user = await getHceUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos de escritura en la HCE" }); return; }

  const parsed = CreateHcePrescriptionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const pacienteId = await patientIdOfEncounter(parsed.data.encounterId);
  if (pacienteId == null) { res.status(404).json({ error: "Consulta no encontrada" }); return; }
  if (!(await puedeEscribirSobre(user, pacienteId))) { res.status(403).json({ error: "Sin permisos sobre este paciente" }); return; }

  const [prescription] = await db.insert(prescriptionsTable).values(parsed.data).returning();
  await registrarAuditoria(user, "crear", "prescription", prescription.id, pacienteId, parsed.data);
  res.status(201).json(prescription);
});

// ── POST /hce/attachments ─────────────────────────────────────────────────
router.post("/hce/attachments", async (req: Request, res: Response): Promise<void> => {
  const user = await getHceUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos de escritura en la HCE" }); return; }

  const parsed = CreateHceAttachmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const pacienteId = await patientIdOfEncounter(parsed.data.encounterId);
  if (pacienteId == null) { res.status(404).json({ error: "Consulta no encontrada" }); return; }
  if (!(await puedeEscribirSobre(user, pacienteId))) { res.status(403).json({ error: "Sin permisos sobre este paciente" }); return; }

  const [attachment] = await db.insert(encounterAttachmentsTable).values(parsed.data).returning();
  await registrarAuditoria(user, "crear", "encounter_attachment", attachment.id, pacienteId, parsed.data);
  res.status(201).json(attachment);
});

export default router;
