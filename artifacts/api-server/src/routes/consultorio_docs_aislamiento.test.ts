import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  profesionalesTable,
  clinicalRecordsTable,
  encountersTable,
  prescriptionsTable,
  pdfDocumentsTable,
  auditLogTable,
} from "@workspace/db";
import consultorioDocsRouter from "./consultorio_docs";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuarios, sesiones, pacientes, profesional, historia clínica, recetas,
// registros PDF) y los limpian al terminar.
//
// Verifican el aislamiento de datos de los endpoints protegidos por
// puedeLeerPaciente:
// - GET /api/consultorio/patients/:id/timeline
// - GET /api/consultorio/pdf/:id
//
// Reglas: 401 sin token / token inválido, el paciente A puede leer SU propia
// historia y descargar SUS propios documentos, y recibe 403 al pedir el
// timeline o el PDF de otro paciente. El staff (admin/medico) mantiene acceso.

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let pacienteAId: number;
let pacienteBId: number;
let profesionalId: number;

let recordAId: number;
let recordBId: number;
let encounterAId: number;
let recetaAId: number;
let recetaBId: number;
let pdfAId: number;
let pdfBId: number;

const TOKEN_PACIENTE_A = `test-token-cd-a-${RUN_ID}`;
const TOKEN_PACIENTE_B = `test-token-cd-b-${RUN_ID}`;
const TOKEN_PACIENTE_SIN_VINCULO = `test-token-cd-sv-${RUN_ID}`;
const TOKEN_ADMIN = `test-token-cd-admin-${RUN_ID}`;
const TOKEN_RECEPCION = `test-token-cd-recep-${RUN_ID}`;

const userIds: number[] = [];

async function crearUsuarioConSesion(opts: {
  rol: string;
  token: string;
  pacienteId?: number;
}): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-cdocs-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `Test ${opts.rol}`,
      rol: opts.rol,
      pacienteId: opts.pacienteId !== undefined ? String(opts.pacienteId) : undefined,
    })
    .returning();
  userIds.push(user!.id);

  await db.insert(sesionesTable).values({
    token: opts.token,
    usuarioId: user!.id,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return user!.id;
}

function timeline(patientId: number, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/consultorio/patients/${patientId}/timeline`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function descargarPdf(pdfId: number, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/consultorio/pdf/${pdfId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", consultorioDocsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [pacienteA] = await db
    .insert(pacientesTable)
    .values({ nombre: "Alicia", apellido: `DocTestA${RUN_ID}`, dni: `DA${RUN_ID}`, activo: true })
    .returning();
  pacienteAId = pacienteA!.id;

  const [pacienteB] = await db
    .insert(pacientesTable)
    .values({ nombre: "Bruno", apellido: `DocTestB${RUN_ID}`, dni: `DB${RUN_ID}`, activo: true })
    .returning();
  pacienteBId = pacienteB!.id;

  const [profesional] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Prof", apellido: `DocTest${RUN_ID}`, matricula: `MP-${RUN_ID}`, activo: true })
    .returning();
  profesionalId = profesional!.id;

  const adminId = await crearUsuarioConSesion({ rol: "admin", token: TOKEN_ADMIN });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_A, pacienteId: pacienteAId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_B, pacienteId: pacienteBId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_SIN_VINCULO });
  await crearUsuarioConSesion({ rol: "recepcionista", token: TOKEN_RECEPCION });

  // Historia clínica de cada paciente, con una consulta para A (contenido del timeline)
  const [recordA] = await db
    .insert(clinicalRecordsTable)
    .values({ patientId: pacienteAId, allergies: `Alergia-A-${RUN_ID}` })
    .returning();
  recordAId = recordA!.id;

  const [recordB] = await db
    .insert(clinicalRecordsTable)
    .values({ patientId: pacienteBId, allergies: `Alergia-B-${RUN_ID}` })
    .returning();
  recordBId = recordB!.id;

  const [encounterA] = await db
    .insert(encountersTable)
    .values({
      clinicalRecordId: recordAId,
      professionalId: profesionalId,
      chiefComplaint: `Motivo-A-${RUN_ID}`,
      diagnosis: `Dx-A-${RUN_ID}`,
    })
    .returning();
  encounterAId = encounterA!.id;

  // Una receta por paciente + su registro PDF (fuente de la descarga)
  const [recetaA] = await db
    .insert(prescriptionsTable)
    .values({
      medication: `Medicamento-A-${RUN_ID}`,
      dosage: "500mg",
      patientId: pacienteAId,
      professionalId: profesionalId,
      createdBy: adminId,
    })
    .returning();
  recetaAId = recetaA!.id;

  const [recetaB] = await db
    .insert(prescriptionsTable)
    .values({
      medication: `Medicamento-B-${RUN_ID}`,
      dosage: "250mg",
      patientId: pacienteBId,
      professionalId: profesionalId,
      createdBy: adminId,
    })
    .returning();
  recetaBId = recetaB!.id;

  const [pdfA] = await db
    .insert(pdfDocumentsTable)
    .values({
      patientId: pacienteAId,
      professionalId: profesionalId,
      sourceType: "receta",
      sourceId: recetaAId,
      pdfContentReference: `generated:receta:${recetaAId}`,
      createdBy: adminId,
    })
    .returning();
  pdfAId = pdfA!.id;

  const [pdfB] = await db
    .insert(pdfDocumentsTable)
    .values({
      patientId: pacienteBId,
      professionalId: profesionalId,
      sourceType: "receta",
      sourceId: recetaBId,
      pdfContentReference: `generated:receta:${recetaBId}`,
      createdBy: adminId,
    })
    .returning();
  pdfBId = pdfB!.id;
});

afterAll(async () => {
  if (userIds.length > 0)
    await db.delete(auditLogTable).where(inArray(auditLogTable.usuarioId, userIds));
  await db.delete(pdfDocumentsTable).where(inArray(pdfDocumentsTable.id, [pdfAId, pdfBId]));
  await db.delete(prescriptionsTable).where(inArray(prescriptionsTable.id, [recetaAId, recetaBId]));
  await db.delete(encountersTable).where(eq(encountersTable.id, encounterAId));
  await db.delete(clinicalRecordsTable).where(inArray(clinicalRecordsTable.id, [recordAId, recordBId]));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profesionalId));
  await db.delete(pacientesTable).where(inArray(pacientesTable.id, [pacienteAId, pacienteBId]));
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

type TimelineItem = {
  tipo: string;
  titulo: string;
  detalle: string | null;
  refId: number;
};

describe("GET /api/consultorio/patients/:id/timeline — autenticación", () => {
  it("sin token responde 401", async () => {
    const res = await timeline(pacienteAId);
    expect(res.status).toBe(401);
  });

  it("con token inválido responde 401", async () => {
    const res = await timeline(pacienteAId, `token-inexistente-${RUN_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/consultorio/patients/:id/timeline — aislamiento entre pacientes", () => {
  it("el paciente A puede leer SU propio timeline (200 con sus datos)", async () => {
    const res = await timeline(pacienteAId, TOKEN_PACIENTE_A);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: TimelineItem[] } | TimelineItem[];
    const items = Array.isArray(data) ? data : data.items;

    const titulos = items.map((i) => i.titulo);
    expect(titulos).toContain(`Motivo-A-${RUN_ID}`);
    expect(titulos).toContain(`Medicamento-A-${RUN_ID}`);
    // Nada del paciente B se filtra en el timeline de A
    expect(JSON.stringify(data)).not.toContain(`Medicamento-B-${RUN_ID}`);
  });

  it("el paciente A recibe 403 al pedir el timeline del paciente B", async () => {
    const res = await timeline(pacienteBId, TOKEN_PACIENTE_A);
    expect(res.status).toBe(403);
    const texto = JSON.stringify(await res.json());
    // La respuesta de error no expone datos clínicos de B
    expect(texto).not.toContain(`Medicamento-B-${RUN_ID}`);
    expect(texto).not.toContain(`Alergia-B-${RUN_ID}`);
  });

  it("el paciente B recibe 403 al pedir el timeline del paciente A", async () => {
    const res = await timeline(pacienteAId, TOKEN_PACIENTE_B);
    expect(res.status).toBe(403);
  });

  it("un paciente sin pacienteId vinculado recibe 403 (nunca datos ajenos)", async () => {
    const res = await timeline(pacienteAId, TOKEN_PACIENTE_SIN_VINCULO);
    expect(res.status).toBe(403);
  });

  it("el rol recepcionista no puede leer timelines (403)", async () => {
    const res = await timeline(pacienteAId, TOKEN_RECEPCION);
    expect(res.status).toBe(403);
  });

  it("el staff (admin) sigue pudiendo leer cualquier timeline (200)", async () => {
    const res = await timeline(pacienteBId, TOKEN_ADMIN);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/consultorio/pdf/:id — autenticación", () => {
  it("sin token responde 401", async () => {
    const res = await descargarPdf(pdfAId);
    expect(res.status).toBe(401);
  });

  it("con token inválido responde 401", async () => {
    const res = await descargarPdf(pdfAId, `token-inexistente-${RUN_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/consultorio/pdf/:id — aislamiento entre pacientes", () => {
  it("el paciente A puede descargar SU propio PDF (200 application/pdf)", async () => {
    const res = await descargarPdf(pdfAId, TOKEN_PACIENTE_A);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    const cuerpo = Buffer.from(await res.arrayBuffer());
    expect(cuerpo.length).toBeGreaterThan(0);
    // Firma binaria de un PDF real
    expect(cuerpo.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("el paciente A recibe 403 al descargar el PDF del paciente B", async () => {
    const res = await descargarPdf(pdfBId, TOKEN_PACIENTE_A);
    expect(res.status).toBe(403);
    // No debe devolver contenido PDF
    expect(res.headers.get("content-type")).not.toContain("application/pdf");
  });

  it("el paciente B recibe 403 al descargar el PDF del paciente A", async () => {
    const res = await descargarPdf(pdfAId, TOKEN_PACIENTE_B);
    expect(res.status).toBe(403);
  });

  it("un paciente sin pacienteId vinculado recibe 403", async () => {
    const res = await descargarPdf(pdfAId, TOKEN_PACIENTE_SIN_VINCULO);
    expect(res.status).toBe(403);
  });

  it("el rol recepcionista no puede descargar PDFs clínicos (403)", async () => {
    const res = await descargarPdf(pdfAId, TOKEN_RECEPCION);
    expect(res.status).toBe(403);
  });

  it("el staff (admin) sigue pudiendo descargar cualquier PDF (200)", async () => {
    const res = await descargarPdf(pdfBId, TOKEN_ADMIN);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    await res.arrayBuffer();
  });
});
