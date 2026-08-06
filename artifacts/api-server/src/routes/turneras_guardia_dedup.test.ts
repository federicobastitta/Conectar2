import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, and } from "drizzle-orm";
import { db, usersTable, sesionesTable, turnerasTable, sedesTable } from "@workspace/db";
import turnerasRouter from "./turneras";

// Anti-duplicados de turneras de guardia: POST /turneras con esGuardia=true y
// mismo nombre+sede debe REUTILIZAR la turnera existente en vez de crear otra
// (las reimportaciones no deben ensuciar el dropdown "Pantalla por guardia").

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN = `test-token-gdedup-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let sedeId: number;
const turneraIds: number[] = [];

async function api(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
}

const BASE = {
  duracionMinutos: 30,
  horaInicio: "08:00",
  horaFin: "20:00",
  modalidad: "presencial",
  diasAtencion: [1, 2, 3, 4, 5],
  esGuardia: true,
};

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
    email: `test-gdedup-${RUN_ID}@test.local`,
    passwordHash: "irrelevante",
    nombre: "Test Guardia Dedup",
    rol: "admin",
  }).returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const [sede] = await db.insert(sedesTable).values({ nombre: `Sede Guardia Dedup ${RUN_ID}` }).returning();
  sedeId = sede!.id;
});

afterAll(async () => {
  for (const id of turneraIds) {
    await db.delete(turnerasTable).where(eq(turnerasTable.id, id));
  }
  await db.delete(sedesTable).where(eq(sedesTable.id, sedeId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Dedup de turneras de guardia por nombre+sede", () => {
  it("re-crear la misma guardia reutiliza la turnera existente (no duplica)", async () => {
    const nombre = `Guardia Clinica ${RUN_ID}`;
    const res1 = await api("/turneras", {
      method: "POST",
      body: JSON.stringify({ ...BASE, nombre, sedeId }),
    });
    expect(res1.status).toBe(201);
    const t1 = (await res1.json()) as { id: number };
    turneraIds.push(t1.id);

    // Mismo nombre con acentos/mayúsculas distintas y misma sede → reutiliza
    const res2 = await api("/turneras", {
      method: "POST",
      body: JSON.stringify({ ...BASE, nombre: `  GUARDIA CLÍNICA ${RUN_ID} `, sedeId }),
    });
    expect(res2.status).toBe(200);
    const t2 = (await res2.json()) as { id: number };
    expect(t2.id).toBe(t1.id);

    const filas = await db
      .select({ id: turnerasTable.id })
      .from(turnerasTable)
      .where(and(eq(turnerasTable.sedeId, sedeId), eq(turnerasTable.esGuardia, true)));
    expect(filas).toHaveLength(1);
  });

  it("reutilizar una guardia desactivada la reactiva en vez de duplicar", async () => {
    const nombre = `Guardia Odontologica ${RUN_ID}`;
    const res1 = await api("/turneras", {
      method: "POST",
      body: JSON.stringify({ ...BASE, nombre, sedeId }),
    });
    expect(res1.status).toBe(201);
    const t1 = (await res1.json()) as { id: number };
    turneraIds.push(t1.id);
    await db.update(turnerasTable).set({ activa: false }).where(eq(turnerasTable.id, t1.id));

    const res2 = await api("/turneras", {
      method: "POST",
      body: JSON.stringify({ ...BASE, nombre, sedeId }),
    });
    expect(res2.status).toBe(200);
    const t2 = (await res2.json()) as { id: number; activa: boolean };
    expect(t2.id).toBe(t1.id);
    expect(t2.activa).toBe(true);
  });

  it("mismo nombre en otra sede o sin esGuardia sí crea una turnera nueva", async () => {
    const nombre = `Guardia Traumatologica ${RUN_ID}`;
    const res1 = await api("/turneras", {
      method: "POST",
      body: JSON.stringify({ ...BASE, nombre, sedeId }),
    });
    expect(res1.status).toBe(201);
    const t1 = (await res1.json()) as { id: number };
    turneraIds.push(t1.id);

    // Sin sede (sedeId null) → no matchea la de la sede
    const res2 = await api("/turneras", {
      method: "POST",
      body: JSON.stringify({ ...BASE, nombre }),
    });
    expect(res2.status).toBe(201);
    const t2 = (await res2.json()) as { id: number };
    turneraIds.push(t2.id);
    expect(t2.id).not.toBe(t1.id);

    // No-guardia con mismo nombre → crea aparte (el dedup es solo de guardias)
    const res3 = await api("/turneras", {
      method: "POST",
      body: JSON.stringify({ ...BASE, esGuardia: false, nombre, sedeId }),
    });
    expect(res3.status).toBe(201);
    const t3 = (await res3.json()) as { id: number };
    turneraIds.push(t3.id);
    expect(t3.id).not.toBe(t1.id);
  });
});
