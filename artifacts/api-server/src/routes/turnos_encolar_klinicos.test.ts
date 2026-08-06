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
  turnerasTable,
  turnosTable,
  klinicosTrabajos,
} from "@workspace/db";
import turnosRouter from "./turnos";
import { hoyArgentina } from "../lib/tiempo";

// Tests del encolado manual POST /turnos/:id/encolar-klinicos.
// Crean y limpian sus propios datos contra la DB de desarrollo.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TEST_EMAIL = `test-encolar-${RUN_ID}@test.local`;
const TEST_DNI = `E${RUN_ID}`;
const TOKEN = `test-token-encolar-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let pacienteId: number;
let pacienteSinDniId: number;
let turneraId: number;
let turnoId: number;
let turnoSinDniId: number;

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", turnosRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [user] = await db
    .insert(usersTable)
    .values({ email: TEST_EMAIL, passwordHash: "x", nombre: "Test Encolar", rol: "recepcionista" })
    .returning();
  userId = user!.id;

  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [paciente] = await db
    .insert(pacientesTable)
    .values({
      nombre: "Encolar",
      apellido: `Test${RUN_ID}`,
      dni: TEST_DNI,
      telefono: "3510000000",
      sexo: "M",
      activo: true,
    })
    .returning();
  pacienteId = paciente!.id;

  const [pacienteSinDni] = await db
    .insert(pacientesTable)
    .values({
      nombre: "SinDni",
      apellido: `Test${RUN_ID}`,
      dni: null,
      telefono: "3510000001",
      sexo: "F",
      activo: true,
    })
    .returning();
  pacienteSinDniId = pacienteSinDni!.id;

  const [turnera] = await db
    .insert(turnerasTable)
    .values({ nombre: `Ecografías Encolar Test ${RUN_ID}` })
    .returning();
  turneraId = turnera!.id;

  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      cobertura: "IOMA",
      fecha: hoyArgentina(),
      horaInicio: "09:00",
      horaFin: "09:30",
      estado: "arribo",
      motivoConsulta: "Ecografía de abdomen",
    })
    .returning();
  turnoId = turno!.id;

  const [turnoSinDni] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId: pacienteSinDniId,
      cobertura: "IOMA",
      fecha: hoyArgentina(),
      horaInicio: "09:30",
      horaFin: "10:00",
      estado: "arribo",
      motivoConsulta: "Ecografía de abdomen",
    })
    .returning();
  turnoSinDniId = turnoSinDni!.id;
});

afterAll(async () => {
  await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.pacienteId, pacienteId));
  await db.delete(turnosTable).where(eq(turnosTable.pacienteId, pacienteId));
  await db.delete(turnosTable).where(eq(turnosTable.pacienteId, pacienteSinDniId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteSinDniId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("POST /turnos/:id/encolar-klinicos", () => {
  it("rechaza sin autenticación", async () => {
    const res = await fetch(`${baseUrl}/api/turnos/${turnoId}/encolar-klinicos`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("devuelve 404 si el turno no existe", async () => {
    const res = await fetch(`${baseUrl}/api/turnos/999999999/encolar-klinicos`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  it("encola el trabajo la primera vez", async () => {
    const res = await fetch(`${baseUrl}/api/turnos/${turnoId}/encolar-klinicos`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { encolado: boolean; yaExistia: boolean; trabajoId?: number };
    expect(body.encolado).toBe(true);
    expect(body.yaExistia).toBe(false);
    expect(body.trabajoId).toBeTypeOf("number");

    const trabajos = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.turnoId, turnoId));
    expect(trabajos).toHaveLength(1);
  });

  it("informa que ya había un trabajo activo al reintentar", async () => {
    const res = await fetch(`${baseUrl}/api/turnos/${turnoId}/encolar-klinicos`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { encolado: boolean; yaExistia: boolean; trabajoId?: number };
    expect(body.encolado).toBe(false);
    expect(body.yaExistia).toBe(true);

    const trabajos = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.turnoId, turnoId));
    expect(trabajos).toHaveLength(1);
  });

  it("vuelve a encolar si el trabajo anterior quedó cancelado", async () => {
    await db
      .update(klinicosTrabajos)
      .set({ estado: "cancelado" })
      .where(eq(klinicosTrabajos.turnoId, turnoId));

    const res = await fetch(`${baseUrl}/api/turnos/${turnoId}/encolar-klinicos`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { encolado: boolean; yaExistia: boolean };
    expect(body.encolado).toBe(true);
    expect(body.yaExistia).toBe(false);

    const trabajos = await db
      .select()
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.turnoId, turnoId));
    expect(trabajos).toHaveLength(2);
  });

  it("devuelve 422 si el paciente no tiene DNI", async () => {
    const res = await fetch(`${baseUrl}/api/turnos/${turnoSinDniId}/encolar-klinicos`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(422);
  });

  // Regla general (02/08/2026): a Klinicos solo van coberturas de la
  // allowlist (hoy IOMA). PAMI/particulares/sin cobertura no encolan.
  it("devuelve 422 si la cobertura no valida en Klinicos (PAMI)", async () => {
    const [turnoPami] = await db
      .insert(turnosTable)
      .values({
        turneraId,
        pacienteId,
        cobertura: "PAMI",
        fecha: hoyArgentina(),
        horaInicio: "10:00",
        horaFin: "10:30",
        estado: "arribo",
        motivoConsulta: "Ecografía de abdomen",
      })
      .returning();
    const res = await fetch(`${baseUrl}/api/turnos/${turnoPami!.id}/encolar-klinicos`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(422);
    const trabajos = await db
      .select({ id: klinicosTrabajos.id })
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.turnoId, turnoPami!.id));
    expect(trabajos).toHaveLength(0);
    await db.delete(turnosTable).where(eq(turnosTable.id, turnoPami!.id));
  });
});
