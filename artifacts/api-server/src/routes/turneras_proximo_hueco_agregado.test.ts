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
  turnerasTable,
  turnosTable,
  pacientesTable,
  sedesTable,
  especialidadesTable,
  profesionalesTable,
} from "@workspace/db";
import turnerasRouter from "./turneras";

// Tests del endpoint /turneras/proximo-hueco-agregado: cuando el día elegido
// en la vista combinada está completo, devuelve el primer slot libre de los
// días siguientes entre todas las turneras de esa sede+especialidad.
// Crean sus propios datos (RUN_ID) y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN = `test-token-phag-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let sedeId: number;
let especialidadId: number;
let profAId: number;
let profBId: number;
let turneraAId: number;
let turneraBId: number;
let pacienteId: number;
const turnoIds: number[] = [];

// Próxima fecha futura (>= mañana) que caiga en el día de semana pedido (UTC).
function proximaFecha(diaSemana: number): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  while (d.getUTCDay() !== diaSemana) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0]!;
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().split("T")[0]!;
}

const MARTES = proximaFecha(2); // primer martes futuro
const MARTES_SIGUIENTE = sumarDias(MARTES, 7);

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
    email: `phag-${RUN_ID}@test.local`,
    passwordHash: "x",
    nombre: `Test PHAg ${RUN_ID}`,
    rol: "recepcionista",
  }).returning();
  userId = user.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [sede] = await db.insert(sedesTable).values({ nombre: `Sede PHAg ${RUN_ID}` }).returning();
  sedeId = sede.id;
  const [esp] = await db.insert(especialidadesTable).values({ nombre: `Cardio PHAg ${RUN_ID}` }).returning();
  especialidadId = esp.id;
  const [profA] = await db.insert(profesionalesTable).values({
    nombre: "Ana", apellido: `PerezPHAg${RUN_ID}`,
  }).returning();
  profAId = profA.id;
  const [profB] = await db.insert(profesionalesTable).values({
    nombre: "Beto", apellido: `GomezPHAg${RUN_ID}`,
  }).returning();
  profBId = profB.id;

  // Ambas turneras atienden SOLO los martes. Con desde=MARTES (día completo),
  // el próximo hueco tiene que salir del martes siguiente.
  const base = {
    duracionMinutos: 30,
    modalidad: "presencial",
    activa: true,
    diasAtencion: "2",
    sedeId,
    especialidadId,
  };
  // Turnera A: martes 08:00-09:00 → 08:00 y 08:30
  const [tA] = await db.insert(turnerasTable).values({
    ...base, nombre: `PHAg A ${RUN_ID}`, profesionalId: profAId, horaInicio: "08:00", horaFin: "09:00",
  }).returning();
  turneraAId = tA.id;
  // Turnera B: martes 08:15-09:15 → 08:15 y 08:45
  const [tB] = await db.insert(turnerasTable).values({
    ...base, nombre: `PHAg B ${RUN_ID}`, profesionalId: profBId, horaInicio: "08:15", horaFin: "09:15",
  }).returning();
  turneraBId = tB.id;

  const [pac] = await db.insert(pacientesTable).values({
    nombre: "Pac", apellido: `PHAg${RUN_ID}`, dni: `8${RUN_ID.slice(0, 6)}`,
  }).returning();
  pacienteId = pac.id;

  // El primer MARTES queda completo en ambas turneras.
  const ocupar: { turneraId: number; horas: [string, string][] }[] = [
    { turneraId: turneraAId, horas: [["08:00", "08:30"], ["08:30", "09:00"]] },
    { turneraId: turneraBId, horas: [["08:15", "08:45"], ["08:45", "09:15"]] },
  ];
  for (const o of ocupar) {
    for (const [horaInicio, horaFin] of o.horas) {
      const [turno] = await db.insert(turnosTable).values({
        turneraId: o.turneraId,
        pacienteId,
        fecha: MARTES,
        horaInicio,
        horaFin,
        estado: "reservado",
      }).returning();
      turnoIds.push(turno.id);
    }
  }
  // En el MARTES_SIGUIENTE, el 08:00 de A también está tomado → el primer
  // hueco libre debe ser el 08:15 de B.
  const [turno] = await db.insert(turnosTable).values({
    turneraId: turneraAId,
    pacienteId,
    fecha: MARTES_SIGUIENTE,
    horaInicio: "08:00",
    horaFin: "08:30",
    estado: "reservado",
  }).returning();
  turnoIds.push(turno.id);
});

afterAll(async () => {
  if (turnoIds.length) await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(turnerasTable).where(inArray(turnerasTable.id, [turneraAId, turneraBId]));
  await db.delete(profesionalesTable).where(inArray(profesionalesTable.id, [profAId, profBId]));
  await db.delete(especialidadesTable).where(eq(especialidadesTable.id, especialidadId));
  await db.delete(sedesTable).where(eq(sedesTable.id, sedeId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /turneras/proximo-hueco-agregado", () => {
  it("rechaza sin autenticación", async () => {
    const res = await fetch(`${baseUrl}/api/turneras/proximo-hueco-agregado?desde=${MARTES}&especialidadId=${especialidadId}`);
    expect(res.status).toBe(401);
  });

  it("rechaza fecha inválida", async () => {
    const res = await api(`/turneras/proximo-hueco-agregado?desde=31-07-2026&especialidadId=${especialidadId}`);
    expect(res.status).toBe(400);
  });

  it("con el día completo devuelve el primer hueco libre de días siguientes", async () => {
    const res = await api(`/turneras/proximo-hueco-agregado?desde=${MARTES}&sedeId=${sedeId}&especialidadId=${especialidadId}`);
    expect(res.status).toBe(200);
    const huecos = (await res.json()) as {
      turneraId: number; turneraNombre: string; profesionalNombre: string | null;
      fecha: string; horaInicio: string; horaFin: string;
    }[];
    expect(huecos).toHaveLength(1);
    const h = huecos[0]!;
    // El 08:00 de A del martes siguiente está tomado → gana el 08:15 de B.
    expect(h.fecha).toBe(MARTES_SIGUIENTE);
    expect(h.turneraId).toBe(turneraBId);
    expect(h.horaInicio).toBe("08:15");
    expect(h.turneraNombre).toBe(`PHAg B ${RUN_ID}`);
    expect(h.profesionalNombre).toContain(`GomezPHAg${RUN_ID}`);
  });

  it("no incluye slots del mismo día pedido (busca desde el día siguiente)", async () => {
    // desde = el día ANTERIOR al martes completo: los slots ocupados de ese
    // martes no son huecos, pero si hubiera libres ese día sí aparecerían.
    const lunes = sumarDias(MARTES, -1);
    const res = await api(`/turneras/proximo-hueco-agregado?desde=${lunes}&sedeId=${sedeId}&especialidadId=${especialidadId}`);
    expect(res.status).toBe(200);
    const huecos = (await res.json()) as { fecha: string }[];
    expect(huecos).toHaveLength(1);
    // El martes está completo → el hueco viene del martes siguiente.
    expect(huecos[0]!.fecha).toBe(MARTES_SIGUIENTE);
  });

  it("sede sin turneras devuelve lista vacía", async () => {
    const res = await api(`/turneras/proximo-hueco-agregado?desde=${MARTES}&sedeId=999999&especialidadId=${especialidadId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
