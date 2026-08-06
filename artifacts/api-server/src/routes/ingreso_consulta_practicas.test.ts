import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray, asc } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  turnerasTable,
  turnosTable,
  auditLogTable,
  klinicosTrabajos,
  klinicosPracticas,
  turnoPracticasTable,
} from "@workspace/db";
import salaEsperaRouter from "./sala_espera";
import { hoyArgentina } from "../lib/tiempo";

// Task: corregir los ESTUDIOS (varios) de un turno ya cargado desde la ficha
// de recepción: POST /turnos/:id/ingreso-consulta acepta practicaIds[] y el
// GET (más la cola de sala de espera) devuelven todos los estudios.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TEST_EMAIL = `test-ing-practicas-${RUN_ID}@test.local`;
const TOKEN = `test-token-ip-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let pacienteId: number;
let turneraId: number;
let turnoId: number;
let practicaAId: number;
let practicaBId: number;

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      ...(init?.headers ?? {}),
    },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function setPracticas(ids: number[]) {
  return api(`/turnos/${turnoId}/ingreso-consulta`, {
    method: "POST",
    body: JSON.stringify({ practicaIds: ids }),
  });
}

async function filasTurnoPracticas(): Promise<number[]> {
  const filas = await db
    .select({ practicaId: turnoPracticasTable.klinicosPracticaId })
    .from(turnoPracticasTable)
    .where(eq(turnoPracticasTable.turnoId, turnoId))
    .orderBy(asc(turnoPracticasTable.id));
  return filas.map((f) => f.practicaId);
}

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", salaEsperaRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [user] = await db
    .insert(usersTable)
    .values({ email: TEST_EMAIL, passwordHash: "x", nombre: "Recep IP", rol: "recepcionista" })
    .returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [pac] = await db
    .insert(pacientesTable)
    .values({
      nombre: "Elsa",
      apellido: `Estudios${RUN_ID}`,
      dni: `7${crypto.randomInt(1000000, 9999999)}`,
      activo: true,
    })
    .returning();
  pacienteId = pac!.id;

  const [pa] = await db
    .insert(klinicosPracticas)
    .values({ nombre: `Eco Abdomen IP ${RUN_ID}`, codigos: ["180101"], activo: true })
    .returning();
  practicaAId = pa!.id;
  const [pb] = await db
    .insert(klinicosPracticas)
    .values({ nombre: `Eco Tiroides IP ${RUN_ID}`, codigos: ["180109"], activo: true })
    .returning();
  practicaBId = pb!.id;

  const [turnera] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Ecografía IP ${RUN_ID}`,
      klinicosSector: "CONSULTORIO",
      activa: false,
    })
    .returning();
  turneraId = turnera!.id;

  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      fecha: hoyArgentina(),
      horaInicio: "07:05",
      horaFin: "07:25",
      estado: "en_sala",
    })
    .returning();
  turnoId = turno!.id;
});

afterAll(async () => {
  await db.delete(auditLogTable).where(eq(auditLogTable.usuarioId, userId));
  await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.turnoId, turnoId));
  await db.delete(turnoPracticasTable).where(eq(turnoPracticasTable.turnoId, turnoId));
  await db.delete(turnosTable).where(eq(turnosTable.id, turnoId));
  await db.delete(klinicosPracticas).where(inArray(klinicosPracticas.id, [practicaAId, practicaBId]));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("varios estudios por turno desde la ficha de recepción", () => {
  it("guarda el conjunto completo con practicaIds y devuelve practicas[]", async () => {
    const r = await setPracticas([practicaAId, practicaBId]);
    expect(r.status).toBe(200);
    const practicas = r.json.practicas as Array<{ id: number; nombre: string }>;
    expect(practicas.map((p) => p.id)).toEqual([practicaAId, practicaBId]);
    // La primera queda como práctica principal (compatibilidad)
    expect(r.json.practicaId).toBe(practicaAId);
    expect(await filasTurnoPracticas()).toEqual([practicaAId, practicaBId]);
  });

  it("el GET del ingreso devuelve todos los estudios", async () => {
    const r = await api(`/turnos/${turnoId}/ingreso-consulta`);
    expect(r.status).toBe(200);
    const practicas = r.json.practicas as Array<{ id: number }>;
    expect(practicas.map((p) => p.id)).toEqual([practicaAId, practicaBId]);
  });

  it("la cola de sala de espera muestra los nombres de todos los estudios", async () => {
    const r = await api(`/sala-espera/cola?turneraId=${turneraId}`);
    expect(r.status).toBe(200);
    const items = r.json as unknown as Array<{ turnoId: number; practicas: string[] }>;
    const item = items.find((i) => i.turnoId === turnoId);
    expect(item).toBeDefined();
    expect(item!.practicas).toEqual([`Eco Abdomen IP ${RUN_ID}`, `Eco Tiroides IP ${RUN_ID}`]);
  });

  it("reemplaza el conjunto al volver a guardar", async () => {
    const r = await setPracticas([practicaBId]);
    expect(r.status).toBe(200);
    expect(r.json.practicaId).toBe(practicaBId);
    expect(await filasTurnoPracticas()).toEqual([practicaBId]);
  });

  it("una lista vacía quita todos los estudios", async () => {
    const r = await setPracticas([]);
    expect(r.status).toBe(200);
    expect(r.json.practicaId).toBeNull();
    expect((r.json.practicas as unknown[]).length).toBe(0);
    expect(await filasTurnoPracticas()).toEqual([]);
  });

  it("rechaza un conjunto donde ningún estudio existe", async () => {
    const r = await setPracticas([99999999]);
    expect(r.status).toBe(400);
  });
});
