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
  prescriptionsTable,
  referralsTable,
  certificatesTable,
  studyOrdersTable,
  auditLogTable,
} from "@workspace/db";
import consultorioDocsRouter from "./consultorio_docs";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuarios, sesiones, pacientes, profesional, historia clínica, recetas,
// derivaciones, certificados, órdenes de estudio) y los limpian al terminar.
//
// Verifican el aislamiento de datos de los LISTADOS por paciente protegidos por
// puedeLeerPaciente:
// - GET /api/consultorio/patients/:id/prescriptions
// - GET /api/consultorio/patients/:id/referrals
// - GET /api/consultorio/patients/:id/certificates
// - GET /api/consultorio/patients/:id/study-orders
// y de la vista agregada, solo para profesionales:
// - GET /api/consultorio/patients/:id/workspace
//
// Reglas: 401 sin token / token inválido; el paciente A lee LO SUYO (200) y sin
// que se filtren datos de B; recibe 403 al pedir los datos de B; un paciente sin
// pacienteId vinculado siempre 403; recepcionista 403 (estos listados son para
// profesionales o el propio paciente); admin/medico mantienen acceso. El
// workspace es exclusivo de profesionales (paciente 403 incluso para lo suyo).

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let pacienteAId: number;
let pacienteBId: number;
let profesionalId: number;
let turneraScopeId: number;
let turnoScopeId: number;

let recordAId: number;
let recordBId: number;
let encounterAId: number;
let recetaAId: number;
let recetaBId: number;
let referralAId: number;
let referralBId: number;
let certAId: number;
let certBId: number;
let ordenAId: number;
let ordenBId: number;

const TOKEN_PACIENTE_A = `test-token-cdl-a-${RUN_ID}`;
const TOKEN_PACIENTE_B = `test-token-cdl-b-${RUN_ID}`;
const TOKEN_PACIENTE_SIN_VINCULO = `test-token-cdl-sv-${RUN_ID}`;
const TOKEN_ADMIN = `test-token-cdl-admin-${RUN_ID}`;
const TOKEN_MEDICO = `test-token-cdl-medico-${RUN_ID}`;
const TOKEN_RECEPCION = `test-token-cdl-recep-${RUN_ID}`;

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
      email: `test-cdlist-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
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

function listado(
  recurso: "prescriptions" | "referrals" | "certificates" | "study-orders" | "workspace",
  patientId: number,
  token?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/consultorio/patients/${patientId}/${recurso}`, {
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
    .values({ nombre: "Alicia", apellido: `DocListA${RUN_ID}`, dni: `LA${RUN_ID}`, activo: true })
    .returning();
  pacienteAId = pacienteA!.id;

  const [pacienteB] = await db
    .insert(pacientesTable)
    .values({ nombre: "Bruno", apellido: `DocListB${RUN_ID}`, dni: `LB${RUN_ID}`, activo: true })
    .returning();
  pacienteBId = pacienteB!.id;

  const [profesional] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Prof", apellido: `DocList${RUN_ID}`, matricula: `MPL-${RUN_ID}`, activo: true })
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

  // Recetas
  const [recetaA] = await db
    .insert(prescriptionsTable)
    .values({ medication: `Medicamento-A-${RUN_ID}`, dosage: "500mg", patientId: pacienteAId, professionalId: profesionalId, createdBy: adminId })
    .returning();
  recetaAId = recetaA!.id;
  const [recetaB] = await db
    .insert(prescriptionsTable)
    .values({ medication: `Medicamento-B-${RUN_ID}`, dosage: "250mg", patientId: pacienteBId, professionalId: profesionalId, createdBy: adminId })
    .returning();
  recetaBId = recetaB!.id;

  // Derivaciones
  const [referralA] = await db
    .insert(referralsTable)
    .values({ patientId: pacienteAId, professionalId: profesionalId, targetSpecialty: `Cardio-A-${RUN_ID}`, reason: `Derivacion-A-${RUN_ID}`, createdBy: adminId })
    .returning();
  referralAId = referralA!.id;
  const [referralB] = await db
    .insert(referralsTable)
    .values({ patientId: pacienteBId, professionalId: profesionalId, targetSpecialty: `Cardio-B-${RUN_ID}`, reason: `Derivacion-B-${RUN_ID}`, createdBy: adminId })
    .returning();
  referralBId = referralB!.id;

  // Certificados
  const [certA] = await db
    .insert(certificatesTable)
    .values({ patientId: pacienteAId, professionalId: profesionalId, content: `Certificado-A-${RUN_ID}`, createdBy: adminId })
    .returning();
  certAId = certA!.id;
  const [certB] = await db
    .insert(certificatesTable)
    .values({ patientId: pacienteBId, professionalId: profesionalId, content: `Certificado-B-${RUN_ID}`, createdBy: adminId })
    .returning();
  certBId = certB!.id;

  // Órdenes de estudio
  const [ordenA] = await db
    .insert(studyOrdersTable)
    .values({ patientId: pacienteAId, professionalId: profesionalId, studyName: `Estudio-A-${RUN_ID}`, createdBy: adminId })
    .returning();
  ordenAId = ordenA!.id;
  const [ordenB] = await db
    .insert(studyOrdersTable)
    .values({ patientId: pacienteBId, professionalId: profesionalId, studyName: `Estudio-B-${RUN_ID}`, createdBy: adminId })
    .returning();
  ordenBId = ordenB!.id;
});

afterAll(async () => {
  if (userIds.length > 0)
    await db.delete(auditLogTable).where(inArray(auditLogTable.usuarioId, userIds));
  await db.delete(studyOrdersTable).where(inArray(studyOrdersTable.id, [ordenAId, ordenBId]));
  await db.delete(certificatesTable).where(inArray(certificatesTable.id, [certAId, certBId]));
  await db.delete(referralsTable).where(inArray(referralsTable.id, [referralAId, referralBId]));
  await db.delete(prescriptionsTable).where(inArray(prescriptionsTable.id, [recetaAId, recetaBId]));
  await db.delete(encountersTable).where(eq(encountersTable.id, encounterAId));
  await db.delete(clinicalRecordsTable).where(inArray(clinicalRecordsTable.id, [recordAId, recordBId]));
  await db.delete(turnosTable).where(eq(turnosTable.id, turnoScopeId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraScopeId));
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

type ConRegistros = Array<Record<string, unknown>>;

// Cada listado con: campo que identifica al registro, marcador de A, marcador de B
const LISTADOS = [
  { recurso: "prescriptions" as const, campo: "medication", marcaA: `Medicamento-A-${RUN_ID}`, marcaB: `Medicamento-B-${RUN_ID}` },
  { recurso: "referrals" as const, campo: "reason", marcaA: `Derivacion-A-${RUN_ID}`, marcaB: `Derivacion-B-${RUN_ID}` },
  { recurso: "certificates" as const, campo: "content", marcaA: `Certificado-A-${RUN_ID}`, marcaB: `Certificado-B-${RUN_ID}` },
  { recurso: "study-orders" as const, campo: "studyName", marcaA: `Estudio-A-${RUN_ID}`, marcaB: `Estudio-B-${RUN_ID}` },
];

for (const { recurso, campo, marcaA, marcaB } of LISTADOS) {
  describe(`GET /api/consultorio/patients/:id/${recurso} — autenticación`, () => {
    it("sin token responde 401", async () => {
      const res = await listado(recurso, pacienteAId);
      expect(res.status).toBe(401);
    });

    it("con token inválido responde 401", async () => {
      const res = await listado(recurso, pacienteAId, `token-inexistente-${RUN_ID}`);
      expect(res.status).toBe(401);
    });
  });

  describe(`GET /api/consultorio/patients/:id/${recurso} — aislamiento entre pacientes`, () => {
    it("el paciente A lee LO SUYO (200) sin filtrar datos de B", async () => {
      const res = await listado(recurso, pacienteAId, TOKEN_PACIENTE_A);
      expect(res.status).toBe(200);
      const data = (await res.json()) as ConRegistros;
      const valores = data.map((d) => d[campo]);
      expect(valores).toContain(marcaA);
      expect(JSON.stringify(data)).not.toContain(marcaB);
    });

    it("el paciente A recibe 403 al pedir los datos de B (sin exponer nada de B)", async () => {
      const res = await listado(recurso, pacienteBId, TOKEN_PACIENTE_A);
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain(marcaB);
    });

    it("el paciente B recibe 403 al pedir los datos de A", async () => {
      const res = await listado(recurso, pacienteAId, TOKEN_PACIENTE_B);
      expect(res.status).toBe(403);
    });

    it("un paciente sin pacienteId vinculado recibe 403", async () => {
      const res = await listado(recurso, pacienteAId, TOKEN_PACIENTE_SIN_VINCULO);
      expect(res.status).toBe(403);
    });

    // Cambio de política (03/08/2026, pestaña Documentación de la ficha):
    // recepción imprime certificados y recetas en mostrador, así que esos dos
    // listados pasan a ser legibles por staff administrativo. Derivaciones y
    // órdenes de estudio siguen restringidas.
    if (recurso === "prescriptions" || recurso === "certificates") {
      it("el rol recepcionista puede leer este listado (200, solo lectura)", async () => {
        const res = await listado(recurso, pacienteAId, TOKEN_RECEPCION);
        expect(res.status).toBe(200);
        const data = (await res.json()) as ConRegistros;
        expect(data.map((d) => d[campo])).toContain(marcaA);
      });
    } else {
      it("el rol recepcionista no puede leer estos listados (403)", async () => {
        const res = await listado(recurso, pacienteAId, TOKEN_RECEPCION);
        expect(res.status).toBe(403);
      });
    }

    it("el staff (admin) mantiene acceso a cualquier paciente (200)", async () => {
      const res = await listado(recurso, pacienteBId, TOKEN_ADMIN);
      expect(res.status).toBe(200);
      const data = (await res.json()) as ConRegistros;
      expect(data.map((d) => d[campo])).toContain(marcaB);
    });

    it("el médico accede a su propio paciente (con turno) (200)", async () => {
      const res = await listado(recurso, pacienteAId, TOKEN_MEDICO);
      expect(res.status).toBe(200);
    });

    it("el médico recibe 403 para un paciente sin turnos con él", async () => {
      const res = await listado(recurso, pacienteBId, TOKEN_MEDICO);
      expect(res.status).toBe(403);
    });
  });
}

describe("GET /api/consultorio/patients/:id/workspace — autenticación", () => {
  it("sin token responde 401", async () => {
    const res = await listado("workspace", pacienteAId);
    expect(res.status).toBe(401);
  });

  it("con token inválido responde 401", async () => {
    const res = await listado("workspace", pacienteAId, `token-inexistente-${RUN_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/consultorio/patients/:id/workspace — solo profesionales", () => {
  it("el paciente A NO puede ver el workspace ni siquiera de lo suyo (403)", async () => {
    const res = await listado("workspace", pacienteAId, TOKEN_PACIENTE_A);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain(`Medicamento-A-${RUN_ID}`);
  });

  it("el paciente A recibe 403 al pedir el workspace de B (sin exponer datos de B)", async () => {
    const res = await listado("workspace", pacienteBId, TOKEN_PACIENTE_A);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain(`Medicamento-B-${RUN_ID}`);
  });

  it("el rol recepcionista no puede ver el workspace (403)", async () => {
    const res = await listado("workspace", pacienteAId, TOKEN_RECEPCION);
    expect(res.status).toBe(403);
  });

  it("el staff (admin) puede ver el workspace de cualquier paciente (200)", async () => {
    const res = await listado("workspace", pacienteBId, TOKEN_ADMIN);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { recetas: ConRegistros };
    expect(JSON.stringify(data.recetas)).toContain(`Medicamento-B-${RUN_ID}`);
  });

  it("el médico ve el workspace de su propio paciente (200)", async () => {
    const res = await listado("workspace", pacienteAId, TOKEN_MEDICO);
    expect(res.status).toBe(200);
  });
});
