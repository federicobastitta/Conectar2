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
  turnerasTable,
  turnosTable,
  ordenesPracticasTable,
  ordenesPracticasLogTable,
} from "@workspace/db";
import ordenesRouter from "./ordenes_practicas";

// Tests del endpoint admin de limpieza de órdenes TEST:
// POST /api/ordenes-practicas/limpiar-test borra las órdenes cuyo motivo
// clínico empieza con "TEST - Orden de prueba", sus logs y sus turnos,
// sin tocar órdenes reales. Crea sus propios datos y los limpia al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN_ADMIN = `test-token-limpiar-admin-${RUN_ID}`;
const TOKEN_RECEP = `test-token-limpiar-recep-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let adminId: number;
let recepId: number;
let profesionalId: number;
let pacienteId: number;
let turneraId: number;
let turnoTestId: number;
let ordenTestId: number;
let ordenRealId: number;

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", ordenesRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `test-limpiar-admin-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: "Admin Limpiar",
      rol: "admin",
    })
    .returning();
  adminId = admin!.id;
  const [recep] = await db
    .insert(usersTable)
    .values({
      email: `test-limpiar-recep-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: "Recep Limpiar",
      rol: "recepcionista",
    })
    .returning();
  recepId = recep!.id;
  await db.insert(sesionesTable).values([
    { token: TOKEN_ADMIN, usuarioId: adminId, activa: true, expiresAt: new Date(Date.now() + 3600_000) },
    { token: TOKEN_RECEP, usuarioId: recepId, activa: true, expiresAt: new Date(Date.now() + 3600_000) },
  ]);

  const [prof] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Limpiar", apellido: `Test${RUN_ID}`, matricula: "9998" })
    .returning();
  profesionalId = prof!.id;

  const [pac] = await db
    .insert(pacientesTable)
    .values({ nombre: "Limpiar", apellido: `Test${RUN_ID}`, dni: `L${RUN_ID}`, activo: true })
    .returning();
  pacienteId = pac!.id;

  const [turnera] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Turnera limpiar ${RUN_ID}`,
      profesionalId,
      activa: true,
    })
    .returning();
  turneraId = turnera!.id;

  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      fecha: "2091-01-05",
      horaInicio: "08:00",
      horaFin: "08:20",
    })
    .returning();
  turnoTestId = turno!.id;

  // Orden TEST (con turno asignado) — debe borrarse
  const [ordenTest] = await db
    .insert(ordenesPracticasTable)
    .values({
      ordenUuid: crypto.randomUUID(),
      numeroOrden: `OP-TEST-${RUN_ID}-1`,
      patientId: pacienteId,
      professionalId: profesionalId,
      practicaId: 1,
      motivoClinico: `TEST - Orden de prueba (${RUN_ID}) para validación`,
      fechaOrden: "2091-01-05",
      turnoId: turnoTestId,
      createdBy: adminId,
    })
    .returning();
  ordenTestId = ordenTest!.id;
  await db.insert(ordenesPracticasLogTable).values({
    ordenId: ordenTestId,
    estadoAnterior: null,
    estadoNuevo: "creada",
    autorId: adminId,
  });

  // Orden real — NO debe borrarse
  const [ordenReal] = await db
    .insert(ordenesPracticasTable)
    .values({
      ordenUuid: crypto.randomUUID(),
      numeroOrden: `OP-REAL-${RUN_ID}-1`,
      patientId: pacienteId,
      professionalId: profesionalId,
      practicaId: 1,
      motivoClinico: `Dolor precordial en esfuerzo (${RUN_ID})`,
      fechaOrden: "2091-01-05",
      createdBy: adminId,
    })
    .returning();
  ordenRealId = ordenReal!.id;
});

afterAll(async () => {
  await db.delete(ordenesPracticasLogTable).where(inArray(ordenesPracticasLogTable.ordenId, [ordenTestId, ordenRealId]));
  await db.delete(ordenesPracticasTable).where(inArray(ordenesPracticasTable.id, [ordenTestId, ordenRealId]));
  await db.delete(turnosTable).where(eq(turnosTable.id, turnoTestId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profesionalId));
  await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, [adminId, recepId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, recepId]));
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("POST /api/ordenes-practicas/limpiar-test", () => {
  it("rechaza a usuarios que no son admin", async () => {
    const res = await fetch(`${baseUrl}/api/ordenes-practicas/limpiar-test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_RECEP}` },
    });
    expect(res.status).toBe(403);
  });

  it("borra las órdenes TEST con sus logs y turnos, sin tocar órdenes reales", async () => {
    const res = await fetch(`${baseUrl}/api/ordenes-practicas/limpiar-test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_ADMIN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ordenesEliminadas: number;
      turnosEliminados: number;
      numeros: string[];
    };
    // La base es compartida: puede haber otras órdenes TEST de otras corridas,
    // así que verificamos inclusión, no igualdad exacta.
    expect(body.ordenesEliminadas).toBeGreaterThanOrEqual(1);
    expect(body.numeros).toContain(`OP-TEST-${RUN_ID}-1`);

    const ordenTest = await db
      .select({ id: ordenesPracticasTable.id })
      .from(ordenesPracticasTable)
      .where(eq(ordenesPracticasTable.id, ordenTestId));
    expect(ordenTest.length).toBe(0);

    const logs = await db
      .select({ id: ordenesPracticasLogTable.id })
      .from(ordenesPracticasLogTable)
      .where(eq(ordenesPracticasLogTable.ordenId, ordenTestId));
    expect(logs.length).toBe(0);

    const turno = await db
      .select({ id: turnosTable.id })
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoTestId));
    expect(turno.length).toBe(0);

    const ordenReal = await db
      .select({ id: ordenesPracticasTable.id })
      .from(ordenesPracticasTable)
      .where(eq(ordenesPracticasTable.id, ordenRealId));
    expect(ordenReal.length).toBe(1);
  });

  it("devuelve 0 cuando ya no quedan órdenes TEST propias", async () => {
    const res = await fetch(`${baseUrl}/api/ordenes-practicas/limpiar-test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_ADMIN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { numeros: string[] };
    expect(body.numeros).not.toContain(`OP-TEST-${RUN_ID}-1`);
  });
});
