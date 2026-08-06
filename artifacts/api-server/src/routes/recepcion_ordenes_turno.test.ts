import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  profesionalesTable,
  turnerasTable,
  turnosTable,
  auditLogTable,
  studyOrdersTable,
} from "@workspace/db";
import recepcionRouter from "./recepcion";
import { hoyArgentina } from "../lib/tiempo";

// Tests de integración de la asignación de turnos a órdenes de estudio desde
// recepción. Crean sus propios datos y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN = `test-token-ordenes-${RUN_ID}`;
const DNI = `O${RUN_ID}`;
const DNI_OTRO = `X${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let profesionalId: number;
let pacienteId: number;
let pacienteOtroId: number;
let turneraId: number;
let ordenId: number;
const turnoIds: Record<string, number> = {};

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", recepcionRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-ordenes-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: "Test Ordenes",
      rol: "recepcionista",
    })
    .returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [prof] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Derivante", apellido: `Test${RUN_ID}`, matricula: "9999" })
    .returning();
  profesionalId = prof!.id;

  const [pac] = await db
    .insert(pacientesTable)
    .values({ nombre: "Orden", apellido: `Test${RUN_ID}`, dni: DNI, activo: true })
    .returning();
  pacienteId = pac!.id;
  const [pacOtro] = await db
    .insert(pacientesTable)
    .values({ nombre: "Otro", apellido: `Test${RUN_ID}`, dni: DNI_OTRO, activo: true })
    .returning();
  pacienteOtroId = pacOtro!.id;

  const [turnera] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera Ordenes Test ${RUN_ID}` })
    .returning();
  turneraId = turnera!.id;

  const fecha = hoyArgentina();
  const defs: Array<[string, number, string]> = [
    ["pendiente", pacienteId, "08:00"],
    ["cancelado", pacienteId, "08:30"],
    ["atendido", pacienteId, "09:00"],
    ["pendiente_otro", pacienteOtroId, "09:30"],
  ];
  for (const [clave, pid, hora] of defs) {
    const [t] = await db
      .insert(turnosTable)
      .values({
        turneraId,
        pacienteId: pid,
        fecha,
        horaInicio: hora,
        horaFin: hora.replace(":00", ":20").replace(":30", ":50"),
        estado: clave.startsWith("pendiente") ? "pendiente" : clave,
      })
      .returning();
    turnoIds[clave] = t!.id;
  }

  const [orden] = await db
    .insert(studyOrdersTable)
    .values({
      patientId: pacienteId,
      professionalId: profesionalId,
      studyType: "imagenes",
      studyName: `TC Test ${RUN_ID}`,
      clinicalJustification: "Justificación de prueba",
      billingCodes: "34.02.01",
      status: "solicitado",
      createdBy: userId,
    })
    .returning();
  ordenId = orden!.id;
});

afterAll(async () => {
  await db.delete(auditLogTable).where(eq(auditLogTable.usuarioId, userId));
  await db.delete(studyOrdersTable).where(eq(studyOrdersTable.id, ordenId));
  await db.delete(turnosTable).where(eq(turnosTable.turneraId, turneraId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteOtroId));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profesionalId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
}

function patchTurno(turnoId: number | null): Promise<Response> {
  return fetch(`${baseUrl}/api/recepcion/ordenes-estudio/${ordenId}/turno`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ turnoId }),
  });
}

describe("asignación de turnos a órdenes de estudio (recepción)", () => {
  it("requiere autenticación", async () => {
    const res = await fetch(`${baseUrl}/api/recepcion/ordenes-estudio?dni=${DNI}`);
    expect(res.status).toBe(401);
  });

  it("la búsqueda por DNI trae la orden con datos de validación y matrícula", async () => {
    const res = await get(`/api/recepcion/ordenes-estudio?dni=${DNI}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      paciente: { id: number };
      ordenes: Array<{
        id: number;
        derivante: string | null;
        clinicalJustification: string | null;
        billingCodes: string | null;
      }>;
    };
    expect(body.paciente.id).toBe(pacienteId);
    const orden = body.ordenes.find((o) => o.id === ordenId);
    expect(orden).toBeDefined();
    expect(orden!.derivante).toContain("MP 9999");
    expect(orden!.clinicalJustification).toBe("Justificación de prueba");
    expect(orden!.billingCodes).toBe("34.02.01");
  });

  it("rechaza turno de otro paciente (422)", async () => {
    const res = await patchTurno(turnoIds.pendiente_otro!);
    expect(res.status).toBe(422);
  });

  it("rechaza turno cancelado (422)", async () => {
    const res = await patchTurno(turnoIds.cancelado!);
    expect(res.status).toBe(422);
  });

  it("rechaza turno ya atendido (422)", async () => {
    const res = await patchTurno(turnoIds.atendido!);
    expect(res.status).toBe(422);
  });

  it("rechaza turno inexistente (404)", async () => {
    const res = await patchTurno(99999999);
    expect(res.status).toBe(404);
  });

  it("asigna turno válido y pasa la orden a programado", async () => {
    const res = await patchTurno(turnoIds.pendiente!);
    expect(res.status).toBe(200);
    const orden = (await res.json()) as { status: string; turnoId: number | null };
    expect(orden.status).toBe("programado");
    expect(orden.turnoId).toBe(turnoIds.pendiente);
  });

  it("desvincular vuelve la orden a pendiente_programacion", async () => {
    const res = await patchTurno(null);
    expect(res.status).toBe(200);
    const orden = (await res.json()) as { status: string; turnoId: number | null };
    expect(orden.status).toBe("pendiente_programacion");
    expect(orden.turnoId).toBeNull();
  });
});
