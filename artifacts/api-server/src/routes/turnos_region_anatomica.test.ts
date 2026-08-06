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
  turnerasTable,
  turnosTable,
} from "@workspace/db";
import turnosRouter from "./turnos";

// Región anatómica obligatoria al agendar prácticas (va al PACS como body_part).
// Crea sus propios datos y los limpia al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN = `test-token-region-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let turneraPracticaId: number;
let turneraConsultaId: number;
let pacienteId: number;

// Fecha futura (mañana) para no chocar con la validación de slots pasados.
const FECHA = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];

async function reservar(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/turnos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ fecha: FECHA, pacienteId, ...body }),
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
  app.use("/api", turnosRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [user] = await db.insert(usersTable).values({
    email: `test-region-${RUN_ID}@test.local`,
    passwordHash: "irrelevante",
    nombre: "Test Region",
    rol: "recepcionista",
  }).returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [practica] = await db.insert(turnerasTable).values({
    nombre: `Turnera Práctica Región ${RUN_ID}`,
    tipo: "practica",
    duracionMinutos: 15,
    diasAtencion: "0,1,2,3,4,5,6",
    horaInicio: "08:00",
    horaFin: "20:00",
    visibilidad: "recepcion",
  }).returning();
  turneraPracticaId = practica!.id;

  const [consulta] = await db.insert(turnerasTable).values({
    nombre: `Turnera Consulta Región ${RUN_ID}`,
    tipo: "consulta",
    duracionMinutos: 15,
    diasAtencion: "0,1,2,3,4,5,6",
    horaInicio: "08:00",
    horaFin: "20:00",
    visibilidad: "recepcion",
  }).returning();
  turneraConsultaId = consulta!.id;

  const [p] = await db.insert(pacientesTable).values({
    nombre: "Región",
    apellido: `Anatómica${RUN_ID}`,
    dni: `R${RUN_ID}`,
  }).returning();
  pacienteId = p!.id;
});

afterAll(async () => {
  await db.delete(turnosTable).where(eq(turnosTable.pacienteId, pacienteId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(turnerasTable).where(inArray(turnerasTable.id, [turneraPracticaId, turneraConsultaId]));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("Región anatómica en turnos de práctica", () => {
  it("rechaza con 400 una práctica sin región anatómica", async () => {
    const res = await reservar({ turneraId: turneraPracticaId, horaInicio: "08:00" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/región anatómica/i);
  });

  it("rechaza con 400 una práctica con región anatómica en blanco", async () => {
    const res = await reservar({
      turneraId: turneraPracticaId,
      horaInicio: "08:15",
      regionAnatomica: "   ",
    });
    expect(res.status).toBe(400);
  });

  it("crea la práctica cuando trae región anatómica y la guarda en el turno", async () => {
    const res = await reservar({
      turneraId: turneraPracticaId,
      horaInicio: "08:30",
      regionAnatomica: "Rodilla derecha",
    });
    expect(res.status).toBe(201);
    const turno = (await res.json()) as { id: number; regionAnatomica?: string | null };
    expect(turno.regionAnatomica).toBe("Rodilla derecha");

    const [fila] = await db.select().from(turnosTable).where(eq(turnosTable.id, turno.id));
    expect(fila?.regionAnatomica).toBe("Rodilla derecha");
  });

  it("permite crear una consulta sin región anatómica", async () => {
    const res = await reservar({ turneraId: turneraConsultaId, horaInicio: "09:00" });
    expect(res.status).toBe(201);
  });
});
