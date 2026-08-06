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
  studyOrdersTable,
  turnerasTable,
  turnosTable,
  auditLogTable,
} from "@workspace/db";
import consultorioDocsRouter from "./consultorio_docs";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuarios, sesiones, dos pacientes, un profesional y una orden de estudio con
// eventos de auditoría) y los limpian al terminar (audit_log por usuarioId y por
// entidadId de la orden).
//
// Verifican la autorización de lectura de:
//   GET /api/consultorio/study-orders/:id/historial
//
// Reglas cubiertas:
// - 401 sin token / token inválido
// - 404 orden inexistente
// - el paciente dueño ve su propio historial (200)
// - un paciente ajeno recibe 403
// - staff (admin/medico) mantiene acceso (200)
// - el historial refleja los eventos de cambio de estado en orden descendente

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let pacienteDuenoId: number;
let pacienteAjenoId: number;
let profId: number;
let turneraScopeId: number;
let turnoScopeId: number;
let ordenId: number;

const TOKEN_ADMIN = `test-token-oha-admin-${RUN_ID}`;
const TOKEN_MEDICO = `test-token-oha-medico-${RUN_ID}`;
const TOKEN_PAC_DUENO = `test-token-oha-pacduenio-${RUN_ID}`;
const TOKEN_PAC_AJENO = `test-token-oha-pacajeno-${RUN_ID}`;

const userIds: number[] = [];

async function crearUsuarioConSesion(opts: {
  rol: string;
  token: string;
  profesionalId?: number;
  pacienteId?: number;
}): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-oha-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `Test ${opts.rol}`,
      rol: opts.rol,
      profesionalId: opts.profesionalId !== undefined ? String(opts.profesionalId) : undefined,
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

let createdBy: number;

function getHistorial(id: number, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/consultorio/study-orders/${id}/historial`, {
    method: "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

type EventoHistorial = {
  fecha: string;
  accion: string;
  usuarioEmail: string | null;
  rol: string | null;
  estadoAnterior: string | null;
  estadoNuevo: string | null;
  observaciones: string | null;
};

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

  const [pacDueno] = await db
    .insert(pacientesTable)
    .values({ nombre: "Dueno", apellido: `OrdenHist${RUN_ID}`, dni: `OHAD${RUN_ID}`, activo: true })
    .returning();
  pacienteDuenoId = pacDueno!.id;

  const [pacAjeno] = await db
    .insert(pacientesTable)
    .values({ nombre: "Ajeno", apellido: `OrdenHist${RUN_ID}`, dni: `OHAA${RUN_ID}`, activo: true })
    .returning();
  pacienteAjenoId = pacAjeno!.id;

  const [prof] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Prof", apellido: `OHA${RUN_ID}`, matricula: `MPOHA-${RUN_ID}`, activo: true })
    .returning();
  profId = prof!.id;

  // Alcance del médico: turnera propia + turno con el paciente dueño de la orden
  const [turneraScope] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera OHA ${RUN_ID}`, profesionalId: profId, activa: true })
    .returning();
  turneraScopeId = turneraScope!.id;
  const [turnoScope] = await db
    .insert(turnosTable)
    .values({ turneraId: turneraScopeId, pacienteId: pacienteDuenoId, profesionalId: profId, fecha: "2026-01-05", horaInicio: "09:00", horaFin: "09:30" })
    .returning();
  turnoScopeId = turnoScope!.id;

  createdBy = await crearUsuarioConSesion({ rol: "admin", token: TOKEN_ADMIN });
  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO, profesionalId: profId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PAC_DUENO, pacienteId: pacienteDuenoId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PAC_AJENO, pacienteId: pacienteAjenoId });

  // Orden del paciente dueño, en un estado avanzado.
  const [orden] = await db
    .insert(studyOrdersTable)
    .values({
      patientId: pacienteDuenoId,
      professionalId: profId,
      studyName: `Estudio-hist-${RUN_ID}`,
      status: "programado",
      createdBy,
    })
    .returning();
  ordenId = orden!.id;

  // Dos eventos de cambio de estado con timestamps explícitos y distintos, para
  // poder verificar el orden descendente en la respuesta del historial.
  const base = Date.now();
  await db.insert(auditLogTable).values([
    {
      usuarioId: createdBy,
      usuarioEmail: `admin-${RUN_ID}@test.local`,
      rol: "admin",
      accion: "cambiar_estado",
      entidad: "orden_estudio",
      entidadId: ordenId,
      pacienteId: pacienteDuenoId,
      detalle: { estadoAnterior: "solicitado", estadoNuevo: "pendiente_programacion", observaciones: "primero" },
      createdAt: new Date(base - 60_000),
    },
    {
      usuarioId: createdBy,
      usuarioEmail: `admin-${RUN_ID}@test.local`,
      rol: "admin",
      accion: "cambiar_estado",
      entidad: "orden_estudio",
      entidadId: ordenId,
      pacienteId: pacienteDuenoId,
      detalle: { estadoAnterior: "pendiente_programacion", estadoNuevo: "programado", observaciones: "segundo" },
      createdAt: new Date(base),
    },
  ]);
});

afterAll(async () => {
  await db.delete(auditLogTable).where(eq(auditLogTable.entidadId, ordenId));
  if (userIds.length > 0)
    await db.delete(auditLogTable).where(inArray(auditLogTable.usuarioId, userIds));
  await db.delete(studyOrdersTable).where(eq(studyOrdersTable.id, ordenId));
  await db.delete(turnosTable).where(eq(turnosTable.id, turnoScopeId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraScopeId));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profId));
  await db
    .delete(pacientesTable)
    .where(inArray(pacientesTable.id, [pacienteDuenoId, pacienteAjenoId]));
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("GET /api/consultorio/study-orders/:id/historial — autenticación", () => {
  it("sin token responde 401", async () => {
    const res = await getHistorial(ordenId);
    expect(res.status).toBe(401);
  });

  it("con token inválido responde 401", async () => {
    const res = await getHistorial(ordenId, `token-inexistente-${RUN_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/consultorio/study-orders/:id/historial — orden inexistente", () => {
  it("responde 404 cuando la orden no existe", async () => {
    const res = await getHistorial(999_000_000, TOKEN_ADMIN);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/consultorio/study-orders/:id/historial — autorización por paciente", () => {
  it("el paciente dueño ve su propio historial (200)", async () => {
    const res = await getHistorial(ordenId, TOKEN_PAC_DUENO);
    expect(res.status).toBe(200);
    const data = (await res.json()) as EventoHistorial[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
  });

  it("un paciente ajeno recibe 403", async () => {
    const res = await getHistorial(ordenId, TOKEN_PAC_AJENO);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/consultorio/study-orders/:id/historial — acceso del staff", () => {
  it("admin mantiene acceso (200)", async () => {
    const res = await getHistorial(ordenId, TOKEN_ADMIN);
    expect(res.status).toBe(200);
    const data = (await res.json()) as EventoHistorial[];
    expect(data.length).toBe(2);
  });

  it("medico mantiene acceso (200)", async () => {
    const res = await getHistorial(ordenId, TOKEN_MEDICO);
    expect(res.status).toBe(200);
    const data = (await res.json()) as EventoHistorial[];
    expect(data.length).toBe(2);
  });
});

describe("GET /api/consultorio/study-orders/:id/historial — contenido y orden", () => {
  it("refleja los eventos de cambio de estado en orden descendente", async () => {
    const res = await getHistorial(ordenId, TOKEN_ADMIN);
    expect(res.status).toBe(200);
    const data = (await res.json()) as EventoHistorial[];

    expect(data.length).toBe(2);
    // Más reciente primero
    expect(data[0]!.estadoNuevo).toBe("programado");
    expect(data[0]!.estadoAnterior).toBe("pendiente_programacion");
    expect(data[1]!.estadoNuevo).toBe("pendiente_programacion");
    expect(data[1]!.estadoAnterior).toBe("solicitado");

    // Orden descendente por fecha
    const t0 = new Date(data[0]!.fecha).getTime();
    const t1 = new Date(data[1]!.fecha).getTime();
    expect(t0).toBeGreaterThan(t1);

    // Campos de auditoría presentes
    expect(data[0]!.accion).toBe("cambiar_estado");
    expect(data[0]!.rol).toBe("admin");
    expect(data[0]!.observaciones).toBe("segundo");
  });
});
