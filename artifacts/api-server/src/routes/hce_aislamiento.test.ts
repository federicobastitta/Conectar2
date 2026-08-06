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
  auditLogTable,
  turnerasTable,
  turnosTable,
} from "@workspace/db";
import hceRouter from "./hce";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuarios, sesiones, pacientes, profesional, historia clínica, consulta,
// receta) y los limpian al terminar.
//
// Verifican el aislamiento de datos de los endpoints de la HCE protegidos por
// puedeLeer:
// - GET /api/hce/history/:patientId
// - GET /api/hce/encounters/:patientId
//
// Reglas: 401 sin token / token inválido; el paciente A lee SU propia historia
// (200) sin que se filtren datos de B; recibe 403 al pedir la historia de B; un
// paciente sin pacienteId vinculado siempre 403; el staff (admin/medico) y los
// roles de solo lectura (recepcionista) mantienen acceso.

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let pacienteAId: number;
let pacienteBId: number;
let profesionalId: number;

let turneraId: number;
let turnoAId: number;
let recordAId: number;
let recordBId: number;
let encounterAId: number;
let encounterBId: number;
let recetaAId: number;

const TOKEN_PACIENTE_A = `test-token-hce-a-${RUN_ID}`;
const TOKEN_PACIENTE_B = `test-token-hce-b-${RUN_ID}`;
const TOKEN_PACIENTE_SIN_VINCULO = `test-token-hce-sv-${RUN_ID}`;
const TOKEN_ADMIN = `test-token-hce-admin-${RUN_ID}`;
const TOKEN_MEDICO = `test-token-hce-medico-${RUN_ID}`;
const TOKEN_RECEPCION = `test-token-hce-recep-${RUN_ID}`;

const userIds: number[] = [];

async function crearUsuarioConSesion(opts: {
  rol: string;
  token: string;
  pacienteId?: number;
  profesionalId?: number;
}): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-hce-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `Test ${opts.rol}`,
      rol: opts.rol,
      pacienteId: opts.pacienteId !== undefined ? String(opts.pacienteId) : undefined,
      profesionalId: opts.profesionalId !== undefined ? String(opts.profesionalId) : undefined,
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

function history(patientId: number, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/hce/history/${patientId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function encounters(patientId: number, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/hce/encounters/${patientId}`, {
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
  app.use("/api", hceRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [pacienteA] = await db
    .insert(pacientesTable)
    .values({ nombre: "Alicia", apellido: `HceA${RUN_ID}`, dni: `HA${RUN_ID}`, activo: true })
    .returning();
  pacienteAId = pacienteA!.id;

  const [pacienteB] = await db
    .insert(pacientesTable)
    .values({ nombre: "Bruno", apellido: `HceB${RUN_ID}`, dni: `HB${RUN_ID}`, activo: true })
    .returning();
  pacienteBId = pacienteB!.id;

  const [profesional] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Prof", apellido: `Hce${RUN_ID}`, matricula: `MPH-${RUN_ID}`, activo: true })
    .returning();
  profesionalId = profesional!.id;

  // Turnera del profesional + turno con el paciente A: define el alcance del
  // médico (solo puede leer historias de pacientes con turnos suyos).
  const [turnera] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera Hce ${RUN_ID}`, profesionalId, activa: true })
    .returning();
  turneraId = turnera!.id;
  const [turnoA] = await db
    .insert(turnosTable)
    .values({ turneraId, pacienteId: pacienteAId, profesionalId, fecha: "2026-01-05", horaInicio: "09:00", horaFin: "09:30" })
    .returning();
  turnoAId = turnoA!.id;

  const adminId = await crearUsuarioConSesion({ rol: "admin", token: TOKEN_ADMIN });
  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO, profesionalId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_A, pacienteId: pacienteAId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_B, pacienteId: pacienteBId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_SIN_VINCULO });
  await crearUsuarioConSesion({ rol: "recepcionista", token: TOKEN_RECEPCION });

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

  const [encounterB] = await db
    .insert(encountersTable)
    .values({
      clinicalRecordId: recordBId,
      professionalId: profesionalId,
      chiefComplaint: `Motivo-B-${RUN_ID}`,
      diagnosis: `Dx-B-${RUN_ID}`,
    })
    .returning();
  encounterBId = encounterB!.id;

  const [recetaA] = await db
    .insert(prescriptionsTable)
    .values({ encounterId: encounterAId, medication: `Medicamento-A-${RUN_ID}`, dosage: "500mg", patientId: pacienteAId, professionalId: profesionalId, createdBy: adminId })
    .returning();
  recetaAId = recetaA!.id;
});

afterAll(async () => {
  if (userIds.length > 0)
    await db.delete(auditLogTable).where(inArray(auditLogTable.usuarioId, userIds));
  await db.delete(prescriptionsTable).where(eq(prescriptionsTable.id, recetaAId));
  await db.delete(encountersTable).where(inArray(encountersTable.id, [encounterAId, encounterBId]));
  await db.delete(clinicalRecordsTable).where(inArray(clinicalRecordsTable.id, [recordAId, recordBId]));
  await db.delete(turnosTable).where(eq(turnosTable.id, turnoAId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
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

describe("GET /api/hce/history/:patientId — autenticación", () => {
  it("sin token responde 401", async () => {
    const res = await history(pacienteAId);
    expect(res.status).toBe(401);
  });

  it("con token inválido responde 401", async () => {
    const res = await history(pacienteAId, `token-inexistente-${RUN_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/hce/history/:patientId — aislamiento entre pacientes", () => {
  it("el paciente A lee SU propia historia (200) sin filtrar datos de B", async () => {
    const res = await history(pacienteAId, TOKEN_PACIENTE_A);
    expect(res.status).toBe(200);
    const texto = JSON.stringify(await res.json());
    expect(texto).toContain(`Motivo-A-${RUN_ID}`);
    expect(texto).toContain(`Medicamento-A-${RUN_ID}`);
    expect(texto).not.toContain(`Motivo-B-${RUN_ID}`);
    expect(texto).not.toContain(`Alergia-B-${RUN_ID}`);
  });

  it("el paciente A recibe 403 al pedir la historia de B (sin exponer datos de B)", async () => {
    const res = await history(pacienteBId, TOKEN_PACIENTE_A);
    expect(res.status).toBe(403);
    const texto = JSON.stringify(await res.json());
    expect(texto).not.toContain(`Motivo-B-${RUN_ID}`);
    expect(texto).not.toContain(`Alergia-B-${RUN_ID}`);
  });

  it("el paciente B recibe 403 al pedir la historia de A", async () => {
    const res = await history(pacienteAId, TOKEN_PACIENTE_B);
    expect(res.status).toBe(403);
  });

  it("un paciente sin pacienteId vinculado recibe 403", async () => {
    const res = await history(pacienteAId, TOKEN_PACIENTE_SIN_VINCULO);
    expect(res.status).toBe(403);
  });

  it("el staff (admin) mantiene acceso a cualquier historia (200)", async () => {
    const res = await history(pacienteBId, TOKEN_ADMIN);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain(`Motivo-B-${RUN_ID}`);
  });

  it("el médico lee la historia de SU paciente (con turno) (200)", async () => {
    const res = await history(pacienteAId, TOKEN_MEDICO);
    expect(res.status).toBe(200);
  });

  it("el médico recibe 403 para un paciente sin turnos con él", async () => {
    const res = await history(pacienteBId, TOKEN_MEDICO);
    expect(res.status).toBe(403);
  });

  it("el rol recepcionista (solo lectura) mantiene acceso (200)", async () => {
    const res = await history(pacienteAId, TOKEN_RECEPCION);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/hce/encounters/:patientId — autenticación", () => {
  it("sin token responde 401", async () => {
    const res = await encounters(pacienteAId);
    expect(res.status).toBe(401);
  });

  it("con token inválido responde 401", async () => {
    const res = await encounters(pacienteAId, `token-inexistente-${RUN_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/hce/encounters/:patientId — aislamiento entre pacientes", () => {
  it("el paciente A lee SUS propias consultas (200) sin filtrar datos de B", async () => {
    const res = await encounters(pacienteAId, TOKEN_PACIENTE_A);
    expect(res.status).toBe(200);
    const texto = JSON.stringify(await res.json());
    expect(texto).toContain(`Motivo-A-${RUN_ID}`);
    expect(texto).not.toContain(`Motivo-B-${RUN_ID}`);
  });

  it("el paciente A recibe 403 al pedir las consultas de B (sin exponer datos de B)", async () => {
    const res = await encounters(pacienteBId, TOKEN_PACIENTE_A);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain(`Motivo-B-${RUN_ID}`);
  });

  it("el paciente B recibe 403 al pedir las consultas de A", async () => {
    const res = await encounters(pacienteAId, TOKEN_PACIENTE_B);
    expect(res.status).toBe(403);
  });

  it("un paciente sin pacienteId vinculado recibe 403", async () => {
    const res = await encounters(pacienteAId, TOKEN_PACIENTE_SIN_VINCULO);
    expect(res.status).toBe(403);
  });

  it("el staff (admin) mantiene acceso a cualquier paciente (200)", async () => {
    const res = await encounters(pacienteBId, TOKEN_ADMIN);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain(`Motivo-B-${RUN_ID}`);
  });

  it("el rol recepcionista (solo lectura) mantiene acceso (200)", async () => {
    const res = await encounters(pacienteAId, TOKEN_RECEPCION);
    expect(res.status).toBe(200);
  });
});
