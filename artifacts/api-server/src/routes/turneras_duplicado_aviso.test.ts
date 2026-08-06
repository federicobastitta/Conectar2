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
  turnerasTable,
  profesionalesTable,
  sedesTable,
  especialidadesTable,
} from "@workspace/db";
import turnerasRouter from "./turneras";

// Aviso anti-duplicados al crear agendas a mano: POST /turneras responde 409
// si el mismo profesional ya tiene una agenda activa en la misma
// sede+especialidad con horario superpuesto; confirmarDuplicado=true crea igual.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN = `test-token-dup-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let profesionalId: number;
let sedeId: number;
let especialidadId: number;
const turneraIds: number[] = [];

async function api(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
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
  app.use("/api", turnerasRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [user] = await db.insert(usersTable).values({
    email: `test-dup-${RUN_ID}@test.local`,
    passwordHash: "irrelevante",
    nombre: "Test Duplicado",
    rol: "admin",
  }).returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [esp] = await db.insert(especialidadesTable).values({ nombre: `Esp Dup ${RUN_ID}` }).returning();
  especialidadId = esp!.id;
  const [sede] = await db.insert(sedesTable).values({ nombre: `Sede Dup ${RUN_ID}` }).returning();
  sedeId = sede!.id;
  const [prof] = await db.insert(profesionalesTable).values({
    nombre: `Prof Dup ${RUN_ID}`,
    especialidadId,
    activo: true,
  }).returning();
  profesionalId = prof!.id;
});

afterAll(async () => {
  for (const id of turneraIds) {
    await db.delete(turnerasTable).where(eq(turnerasTable.id, id));
  }
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profesionalId));
  await db.delete(sedesTable).where(eq(sedesTable.id, sedeId));
  await db.delete(especialidadesTable).where(eq(especialidadesTable.id, especialidadId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function baseTurnera(extra: Record<string, unknown> = {}) {
  return {
    nombre: `Dup base ${RUN_ID}`,
    duracionMinutos: 30,
    horaInicio: "08:00",
    horaFin: "12:00",
    modalidad: "presencial",
    activa: true,
    diasAtencion: [1, 3],
    profesionalId,
    sedeId,
    especialidadId,
    ...extra,
  };
}

describe("Aviso de agenda duplicada en POST /turneras", () => {
  it("crea la primera agenda sin aviso", async () => {
    const res = await api("/turneras", { method: "POST", body: JSON.stringify(baseTurnera()) });
    expect(res.status).toBe(201);
    const t = (await res.json()) as { id: number };
    turneraIds.push(t.id);
  });

  it("responde 409 con datos de la existente si hay superposición", async () => {
    const res = await api("/turneras", {
      method: "POST",
      body: JSON.stringify(baseTurnera({ nombre: `Dup repetida ${RUN_ID}`, horaInicio: "10:00", horaFin: "13:00" })),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      codigo: string;
      turneraExistente: { id: number; nombre: string; diasAtencion: number[] };
    };
    expect(body.codigo).toBe("turnera_duplicada");
    expect(body.turneraExistente.id).toBe(turneraIds[0]);
    expect(body.turneraExistente.nombre).toBe(`Dup base ${RUN_ID}`);
    expect(body.turneraExistente.diasAtencion).toEqual([1, 3]);
  });

  it("con confirmarDuplicado=true crea igualmente", async () => {
    const res = await api("/turneras", {
      method: "POST",
      body: JSON.stringify(baseTurnera({
        nombre: `Dup confirmada ${RUN_ID}`,
        horaInicio: "10:00",
        horaFin: "13:00",
        confirmarDuplicado: true,
      })),
    });
    expect(res.status).toBe(201);
    const t = (await res.json()) as { id: number };
    turneraIds.push(t.id);
  });

  it("no avisa si el horario no se superpone", async () => {
    const res = await api("/turneras", {
      method: "POST",
      body: JSON.stringify(baseTurnera({ nombre: `Dup tarde ${RUN_ID}`, horaInicio: "14:00", horaFin: "18:00" })),
    });
    expect(res.status).toBe(201);
    const t = (await res.json()) as { id: number };
    turneraIds.push(t.id);
  });

  it("no avisa si no comparten ningún día de atención", async () => {
    const res = await api("/turneras", {
      method: "POST",
      body: JSON.stringify(baseTurnera({ nombre: `Dup otro dia ${RUN_ID}`, diasAtencion: [2, 4] })),
    });
    expect(res.status).toBe(201);
    const t = (await res.json()) as { id: number };
    turneraIds.push(t.id);
  });

  it("no avisa si es en otra sede", async () => {
    const [otraSede] = await db.insert(sedesTable).values({ nombre: `Sede Dup 2 ${RUN_ID}` }).returning();
    const res = await api("/turneras", {
      method: "POST",
      body: JSON.stringify(baseTurnera({ nombre: `Dup otra sede ${RUN_ID}`, sedeId: otraSede!.id })),
    });
    expect(res.status).toBe(201);
    const t = (await res.json()) as { id: number };
    turneraIds.push(t.id);
    await db.delete(turnerasTable).where(eq(turnerasTable.id, t.id));
    turneraIds.pop();
    await db.delete(sedesTable).where(eq(sedesTable.id, otraSede!.id));
  });

  it("no avisa si la existente está inactiva", async () => {
    await db.update(turnerasTable).set({ activa: false }).where(eq(turnerasTable.id, turneraIds[0]!));
    // También desactivar las otras superpuestas creadas antes
    for (const id of turneraIds.slice(1)) {
      await db.update(turnerasTable).set({ activa: false }).where(eq(turnerasTable.id, id));
    }
    const res = await api("/turneras", {
      method: "POST",
      body: JSON.stringify(baseTurnera({ nombre: `Dup inactiva ${RUN_ID}` })),
    });
    expect(res.status).toBe(201);
    const t = (await res.json()) as { id: number };
    turneraIds.push(t.id);
  });

  it("detecta superposición vía horariosDia", async () => {
    // La última creada (activa) atiende lun/mié 08-12
    const res = await api("/turneras", {
      method: "POST",
      body: JSON.stringify(baseTurnera({
        nombre: `Dup hdia ${RUN_ID}`,
        diasAtencion: [1],
        horariosDia: [{ dia: 1, horaInicio: "11:00", horaFin: "15:00" }],
      })),
    });
    expect(res.status).toBe(409);
  });
});
