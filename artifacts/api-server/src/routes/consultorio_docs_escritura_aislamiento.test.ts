import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  turnerasTable,
  turnosTable,
  usersTable,
  sesionesTable,
  pacientesTable,
  profesionalesTable,
  clinicalRecordsTable,
  encountersTable,
  vitalSignsTable,
  prescriptionsTable,
  referralsTable,
  certificatesTable,
  studyOrdersTable,
  encounterAttachmentsTable,
  auditLogTable,
} from "@workspace/db";
import consultorioDocsRouter from "./consultorio_docs";
import hceRouter from "./hce";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuarios, sesiones, dos pacientes, un profesional, una historia clínica con
// un encuentro) y los limpian al terminar (incluyendo audit_log por usuarioId).
//
// Verifican el aislamiento de ESCRITURA clínica: un paciente NO puede crear
// recetas, derivaciones, certificados, órdenes de estudio, evoluciones ni signos
// vitales para NINGÚN paciente (ni el suyo ni el de otro). Endpoints cubiertos:
//   POST /api/consultorio/prescriptions
//   POST /api/consultorio/referrals
//   POST /api/consultorio/certificates
//   POST /api/consultorio/study-orders
//   POST /api/consultorio/consultas/finalizar
//   POST /api/hce/history | /hce/encounters | /hce/vitals
//   POST /api/hce/prescriptions | /hce/attachments
//
// Reglas: 401 sin token / token inválido; el rol paciente recibe 403 (tanto
// escribiendo en su propia historia como en la de otro paciente); el rol
// recepcionista recibe 403 en toda escritura clínica; admin y medico pueden
// escribir (201).

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let pacienteAId: number;
let pacienteBId: number;
let profesionalId: number;
let turneraScopeId: number;
let turnoScopeId: number;
let encounterAId: number;

const TOKEN_PACIENTE_A = `test-token-cde-a-${RUN_ID}`;
const TOKEN_PACIENTE_B = `test-token-cde-b-${RUN_ID}`;
const TOKEN_ADMIN = `test-token-cde-admin-${RUN_ID}`;
const TOKEN_MEDICO = `test-token-cde-medico-${RUN_ID}`;
const TOKEN_RECEPCION = `test-token-cde-recep-${RUN_ID}`;

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
      email: `test-cdesc-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
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

function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
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
  app.use("/api", hceRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [pacienteA] = await db
    .insert(pacientesTable)
    .values({ nombre: "Alicia", apellido: `DocEscA${RUN_ID}`, dni: `EA${RUN_ID}`, activo: true })
    .returning();
  pacienteAId = pacienteA!.id;

  const [pacienteB] = await db
    .insert(pacientesTable)
    .values({ nombre: "Bruno", apellido: `DocEscB${RUN_ID}`, dni: `EB${RUN_ID}`, activo: true })
    .returning();
  pacienteBId = pacienteB!.id;

  const [profesional] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Prof", apellido: `DocEsc${RUN_ID}`, matricula: `MPE-${RUN_ID}`, activo: true })
    .returning();
  profesionalId = profesional!.id;

  // Alcance del médico: turnera propia + turno con el paciente A
  const [turneraScope] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera Scope ${RUN_ID}`, profesionalId, activa: true })
    .returning();
  turneraScopeId = turneraScope!.id;
  const [turnoScope] = await db
    .insert(turnosTable)
    .values({ turneraId: turneraScopeId, pacienteId: pacienteAId, profesionalId, fecha: "2026-01-05", horaInicio: "09:00", horaFin: "09:30" })
    .returning();
  turnoScopeId = turnoScope!.id;

  await crearUsuarioConSesion({ rol: "admin", token: TOKEN_ADMIN });
  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO, profesionalId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_A, pacienteId: pacienteAId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_B, pacienteId: pacienteBId });
  await crearUsuarioConSesion({ rol: "recepcionista", token: TOKEN_RECEPCION });

  // Historia clínica + encuentro de A: necesarios para vitals/prescriptions/
  // attachments de la HCE, que resuelven el paciente a partir del encounterId.
  const [recordA] = await db
    .insert(clinicalRecordsTable)
    .values({ patientId: pacienteAId, allergies: `Alergia-A-${RUN_ID}` })
    .returning();
  const [encounterA] = await db
    .insert(encountersTable)
    .values({
      clinicalRecordId: recordA!.id,
      professionalId: profesionalId,
      chiefComplaint: `Motivo-A-${RUN_ID}`,
    })
    .returning();
  encounterAId = encounterA!.id;
});

afterAll(async () => {
  const patientIds = [pacienteAId, pacienteBId];

  const records = await db
    .select()
    .from(clinicalRecordsTable)
    .where(inArray(clinicalRecordsTable.patientId, patientIds));
  const recordIds = records.map((r) => r.id);
  const encs = recordIds.length
    ? await db.select().from(encountersTable).where(inArray(encountersTable.clinicalRecordId, recordIds))
    : [];
  const encIds = encs.map((e) => e.id);

  if (userIds.length > 0)
    await db.delete(auditLogTable).where(inArray(auditLogTable.usuarioId, userIds));

  if (encIds.length > 0) {
    await db.delete(vitalSignsTable).where(inArray(vitalSignsTable.encounterId, encIds));
    await db.delete(encounterAttachmentsTable).where(inArray(encounterAttachmentsTable.encounterId, encIds));
    await db.delete(prescriptionsTable).where(inArray(prescriptionsTable.encounterId, encIds));
  }
  await db.delete(prescriptionsTable).where(inArray(prescriptionsTable.patientId, patientIds));
  await db.delete(referralsTable).where(inArray(referralsTable.patientId, patientIds));
  await db.delete(certificatesTable).where(inArray(certificatesTable.patientId, patientIds));
  await db.delete(studyOrdersTable).where(inArray(studyOrdersTable.patientId, patientIds));
  if (encIds.length > 0) await db.delete(encountersTable).where(inArray(encountersTable.id, encIds));
  if (recordIds.length > 0)
    await db.delete(clinicalRecordsTable).where(inArray(clinicalRecordsTable.id, recordIds));

  await db.delete(turnosTable).where(eq(turnosTable.id, turnoScopeId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraScopeId));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profesionalId));
  await db.delete(pacientesTable).where(inArray(pacientesTable.id, patientIds));
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }

  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// Especificaciones de cada endpoint de escritura clínica. `body` recibe el id de
// paciente destino y devuelve un cuerpo válido (incluye el profesional emisor,
// que admin necesita y medico ignora en favor del suyo).
type Spec = {
  nombre: string;
  path: string;
  bodyPaciente: (patientId: number) => Record<string, unknown>;
  bodyEncounter: () => Record<string, unknown>;
};

const SPECS_POR_PACIENTE: Spec[] = [
  {
    nombre: "POST /api/consultorio/prescriptions",
    path: "/api/consultorio/prescriptions",
    bodyPaciente: (patientId) => ({ patientId, profesionalId, medication: `Med-${RUN_ID}`, dosage: "500mg" }),
    bodyEncounter: () => ({}),
  },
  {
    nombre: "POST /api/consultorio/referrals",
    path: "/api/consultorio/referrals",
    bodyPaciente: (patientId) => ({ patientId, profesionalId, targetSpecialty: `Cardio-${RUN_ID}`, reason: `Motivo-${RUN_ID}` }),
    bodyEncounter: () => ({}),
  },
  {
    nombre: "POST /api/consultorio/certificates",
    path: "/api/consultorio/certificates",
    bodyPaciente: (patientId) => ({ patientId, profesionalId, certificateType: "reposo", content: `Cert-${RUN_ID}`, restDays: 2 }),
    bodyEncounter: () => ({}),
  },
  {
    nombre: "POST /api/consultorio/study-orders",
    path: "/api/consultorio/study-orders",
    bodyPaciente: (patientId) => ({ patientId, profesionalId, studyType: "laboratorio", studyName: `Estudio-${RUN_ID}` }),
    bodyEncounter: () => ({}),
  },
  {
    nombre: "POST /api/consultorio/consultas/finalizar",
    path: "/api/consultorio/consultas/finalizar",
    bodyPaciente: (patientId) => ({ patientId, professionalId: profesionalId, chiefComplaint: `Consulta-${RUN_ID}` }),
    bodyEncounter: () => ({}),
  },
  {
    nombre: "POST /api/hce/history",
    path: "/api/hce/history",
    bodyPaciente: (patientId) => ({ patientId, allergies: `AlergiaUpd-${RUN_ID}` }),
    bodyEncounter: () => ({}),
  },
  {
    nombre: "POST /api/hce/encounters",
    path: "/api/hce/encounters",
    bodyPaciente: (patientId) => ({ patientId, chiefComplaint: `Evolucion-${RUN_ID}` }),
    bodyEncounter: () => ({}),
  },
];

for (const spec of SPECS_POR_PACIENTE) {
  describe(`${spec.nombre} — autenticación y aislamiento de escritura`, () => {
    it("sin token responde 401", async () => {
      const res = await post(spec.path, spec.bodyPaciente(pacienteAId));
      expect(res.status).toBe(401);
    });

    it("con token inválido responde 401", async () => {
      const res = await post(spec.path, spec.bodyPaciente(pacienteAId), `token-inexistente-${RUN_ID}`);
      expect(res.status).toBe(401);
    });

    it("el paciente NO puede escribir en la historia de OTRO paciente (403)", async () => {
      const res = await post(spec.path, spec.bodyPaciente(pacienteBId), TOKEN_PACIENTE_A);
      expect(res.status).toBe(403);
    });

    it("el paciente NO puede escribir ni siquiera en su propia historia (403)", async () => {
      const res = await post(spec.path, spec.bodyPaciente(pacienteAId), TOKEN_PACIENTE_A);
      expect(res.status).toBe(403);
    });

    it("el rol recepcionista NO puede escribir historia clínica (403)", async () => {
      const res = await post(spec.path, spec.bodyPaciente(pacienteAId), TOKEN_RECEPCION);
      expect(res.status).toBe(403);
    });

    it("el rol admin puede escribir (201)", async () => {
      const res = await post(spec.path, spec.bodyPaciente(pacienteAId), TOKEN_ADMIN);
      expect(res.status).toBe(201);
    });

    it("el rol medico puede escribir (201)", async () => {
      const res = await post(spec.path, spec.bodyPaciente(pacienteAId), TOKEN_MEDICO);
      expect(res.status).toBe(201);
    });
  });
}

// Endpoints de HCE que operan sobre un encounter (resuelven el paciente por el
// encounterId). El paciente no debe poder escribir signos vitales, recetas ni
// adjuntos sobre la consulta de nadie.
const SPECS_POR_ENCOUNTER: { nombre: string; path: string; body: () => Record<string, unknown> }[] = [
  {
    nombre: "POST /api/hce/vitals",
    path: "/api/hce/vitals",
    body: () => ({ encounterId: encounterAId, heartRate: 72, weight: 70, height: 175 }),
  },
  {
    nombre: "POST /api/hce/prescriptions",
    path: "/api/hce/prescriptions",
    body: () => ({ encounterId: encounterAId, medication: `MedHce-${RUN_ID}` }),
  },
  {
    nombre: "POST /api/hce/attachments",
    path: "/api/hce/attachments",
    body: () => ({ encounterId: encounterAId, type: "estudio", description: `Adj-${RUN_ID}` }),
  },
];

for (const spec of SPECS_POR_ENCOUNTER) {
  describe(`${spec.nombre} — autenticación y aislamiento de escritura`, () => {
    it("sin token responde 401", async () => {
      const res = await post(spec.path, spec.body());
      expect(res.status).toBe(401);
    });

    it("con token inválido responde 401", async () => {
      const res = await post(spec.path, spec.body(), `token-inexistente-${RUN_ID}`);
      expect(res.status).toBe(401);
    });

    it("el paciente NO puede escribir sobre la consulta (403)", async () => {
      const res = await post(spec.path, spec.body(), TOKEN_PACIENTE_A);
      expect(res.status).toBe(403);
    });

    it("otro paciente tampoco puede escribir sobre la consulta (403)", async () => {
      const res = await post(spec.path, spec.body(), TOKEN_PACIENTE_B);
      expect(res.status).toBe(403);
    });

    it("el rol recepcionista NO puede escribir sobre la consulta (403)", async () => {
      const res = await post(spec.path, spec.body(), TOKEN_RECEPCION);
      expect(res.status).toBe(403);
    });

    it("el rol admin puede escribir (201)", async () => {
      const res = await post(spec.path, spec.body(), TOKEN_ADMIN);
      expect(res.status).toBe(201);
    });

    it("el rol medico puede escribir (201)", async () => {
      const res = await post(spec.path, spec.body(), TOKEN_MEDICO);
      expect(res.status).toBe(201);
    });
  });
}
