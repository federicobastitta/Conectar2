import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq } from "drizzle-orm";
import { db, usersTable, sesionesTable, turnerasTable } from "@workspace/db";
import turnerasRouter from "./turneras";

// Tests de integración de horarios por día en turneras.
// Crean sus propios datos y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN = `test-token-hdia-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
const turneraIds: number[] = [];

// Próxima fecha futura (>= mañana) que caiga en el día de semana pedido.
function proximaFecha(diaSemana: number): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  while (d.getUTCDay() !== diaSemana) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0]!;
}

async function api(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
}

const BASE_TURNERA = {
  duracionMinutos: 30,
  horaInicio: "08:00",
  horaFin: "12:00",
  modalidad: "presencial",
  activa: true,
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
    email: `test-hdia-${RUN_ID}@test.local`,
    passwordHash: "irrelevante",
    nombre: "Test Horarios Dia",
    rol: "admin",
  }).returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
});

afterAll(async () => {
  for (const id of turneraIds) {
    await db.delete(turnerasTable).where(eq(turnerasTable.id, id));
  }
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Turneras con horarios por día", () => {
  it("POST crea con horariosDia, deriva días y rango global", async () => {
    const res = await api("/turneras", {
      method: "POST",
      body: JSON.stringify({
        ...BASE_TURNERA,
        nombre: `HDia POST ${RUN_ID}`,
        diasAtencion: [1],
        horariosDia: [
          { dia: 1, horaInicio: "08:00", horaFin: "12:00" },
          { dia: 3, horaInicio: "14:00", horaFin: "18:00" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const t = (await res.json()) as Record<string, any>;
    turneraIds.push(t.id);
    expect(t.horariosDia).toHaveLength(2);
    expect(t.diasAtencion).toEqual([1, 3]);
    expect(t.horaInicio.substring(0, 5)).toBe("08:00");
    expect(t.horaFin.substring(0, 5)).toBe("18:00");
  });

  it("disponibilidad usa el horario del día correspondiente", async () => {
    const [row] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, turneraIds[0]!)).limit(1);
    expect(row).toBeDefined();

    const lunes = await api(`/turneras/${turneraIds[0]}/disponibilidad/${proximaFecha(1)}`);
    expect(lunes.status).toBe(200);
    const slotsLunes = (await lunes.json()) as { horaInicio: string }[];
    const horasLunes = slotsLunes.map((s) => s.horaInicio.substring(0, 5));
    expect(horasLunes[0]).toBe("08:00");
    expect(horasLunes).toContain("11:30");
    expect(horasLunes).not.toContain("14:00");

    const miercoles = await api(`/turneras/${turneraIds[0]}/disponibilidad/${proximaFecha(3)}`);
    expect(miercoles.status).toBe(200);
    const slotsMie = (await miercoles.json()) as { horaInicio: string }[];
    const horasMie = slotsMie.map((s) => s.horaInicio.substring(0, 5));
    expect(horasMie[0]).toBe("14:00");
    expect(horasMie).toContain("17:30");
    expect(horasMie).not.toContain("08:00");

    // Martes no figura en horariosDia → sin turnos
    const martes = await api(`/turneras/${turneraIds[0]}/disponibilidad/${proximaFecha(2)}`);
    expect(martes.status).toBe(200);
    expect(await martes.json()).toEqual([]);
  });

  it("POST rechaza horariosDia con fin <= inicio", async () => {
    const res = await api("/turneras", {
      method: "POST",
      body: JSON.stringify({
        ...BASE_TURNERA,
        nombre: `HDia inválida ${RUN_ID}`,
        diasAtencion: [1],
        horariosDia: [{ dia: 1, horaInicio: "10:00", horaFin: "09:00" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH actualiza horariosDia y sincroniza días/rango", async () => {
    const res = await api(`/turneras/${turneraIds[0]}`, {
      method: "PATCH",
      body: JSON.stringify({
        horariosDia: [{ dia: 5, horaInicio: "09:00", horaFin: "13:00" }],
      }),
    });
    expect(res.status).toBe(200);
    const t = (await res.json()) as Record<string, any>;
    expect(t.horariosDia).toHaveLength(1);
    expect(t.diasAtencion).toEqual([5]);
    expect(t.horaInicio.substring(0, 5)).toBe("09:00");
    expect(t.horaFin.substring(0, 5)).toBe("13:00");
  });

  it("PATCH con horariosDia=[] limpia y vuelve al rango global", async () => {
    const res = await api(`/turneras/${turneraIds[0]}`, {
      method: "PATCH",
      body: JSON.stringify({ horariosDia: [], horaInicio: "08:00", horaFin: "10:00", diasAtencion: [1, 2] }),
    });
    expect(res.status).toBe(200);
    const t = (await res.json()) as Record<string, any>;
    expect(t.horariosDia == null || t.horariosDia.length === 0).toBe(true);
    expect(t.diasAtencion).toEqual([1, 2]);

    const lunes = await api(`/turneras/${turneraIds[0]}/disponibilidad/${proximaFecha(1)}`);
    const slots = (await lunes.json()) as { horaInicio: string }[];
    const horas = slots.map((s) => s.horaInicio.substring(0, 5));
    expect(horas[0]).toBe("08:00");
    expect(horas).not.toContain("10:00");
  });
});
