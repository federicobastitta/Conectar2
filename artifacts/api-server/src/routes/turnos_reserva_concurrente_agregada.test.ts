import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray, sql } from "drizzle-orm";
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
import turnosRouter from "./turnos";
import turnerasRouter from "./turneras";

// Escenario de la vista combinada "Todos los profesionales": la lista de
// huecos libres se refresca cada 30 s, así que dos puestos de recepción pueden
// ver el MISMO hueco libre y reservarlo a la vez. Estos tests verifican de
// punta a punta que:
//  1. Ante dos reservas concurrentes sobre el mismo slot, exactamente una gana
//     (201) y la otra recibe 409 con un mensaje claro (nunca pisa el turno).
//  2. La disponibilidad agregada que consulta la UI después del error ya no
//     ofrece ese hueco, pero sigue ofreciendo los demás.
// Crean sus propios datos (RUN_ID) y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN = `test-token-conc-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let sedeId: number;
let especialidadId: number;
let profAId: number;
let profBId: number;
let turneraAId: number;
let turneraBId: number;
const pacienteIds: number[] = [];
const turneraIds: number[] = [];

// Próxima fecha futura (>= mañana) que caiga en el día de semana pedido (UTC).
function proximaFecha(diaSemana: number): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  while (d.getUTCDay() !== diaSemana) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0]!;
}

const FECHA = proximaFecha(4); // un jueves futuro

async function api(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
}

async function reservar(turneraId: number, pacienteId: number, horaInicio: string) {
  return api("/turnos", {
    method: "POST",
    body: JSON.stringify({ turneraId, pacienteId, fecha: FECHA, horaInicio }),
  });
}

async function slotsAgregados() {
  const res = await api(`/turneras/disponibilidad-agregada?fecha=${FECHA}&sedeId=${sedeId}&especialidadId=${especialidadId}`);
  expect(res.status).toBe(200);
  const slots = (await res.json()) as { turneraId: number; horaInicio: string }[];
  // Solo los slots de este RUN (la DB es compartida entre suites).
  return slots
    .filter((s) => [turneraAId, turneraBId].includes(s.turneraId))
    .map((s) => `${s.turneraId}|${s.horaInicio}`);
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
  app.use("/api", turnerasRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [user] = await db.insert(usersTable).values({
    email: `conc-${RUN_ID}@test.local`,
    passwordHash: "x",
    nombre: `Test Conc ${RUN_ID}`,
    rol: "recepcionista",
  }).returning();
  userId = user.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [sede] = await db.insert(sedesTable).values({ nombre: `Sede Conc ${RUN_ID}` }).returning();
  sedeId = sede.id;
  const [esp] = await db.insert(especialidadesTable).values({ nombre: `Ecografía Conc ${RUN_ID}` }).returning();
  especialidadId = esp.id;
  const [profA] = await db.insert(profesionalesTable).values({
    nombre: "Ana", apellido: `PerezConc${RUN_ID}`,
  }).returning();
  profAId = profA.id;
  const [profB] = await db.insert(profesionalesTable).values({
    nombre: "Beto", apellido: `GomezConc${RUN_ID}`,
  }).returning();
  profBId = profB.id;

  const base = {
    duracionMinutos: 30,
    modalidad: "presencial",
    activa: true,
    diasAtencion: "4",
    sedeId,
    especialidadId,
  };
  // Turnera A: jueves 08-09, 30 min → 08:00 y 08:30
  const [tA] = await db.insert(turnerasTable).values({
    ...base, nombre: `Conc A ${RUN_ID}`, profesionalId: profAId, horaInicio: "08:00", horaFin: "09:00",
  }).returning();
  turneraAId = tA.id;
  turneraIds.push(tA.id);
  // Turnera B: jueves 08:15-08:45, 30 min → 08:15 (otro profesional, mismo pool combinado)
  const [tB] = await db.insert(turnerasTable).values({
    ...base, nombre: `Conc B ${RUN_ID}`, profesionalId: profBId, horaInicio: "08:15", horaFin: "08:45",
  }).returning();
  turneraBId = tB.id;
  turneraIds.push(tB.id);

  // Dos pacientes: uno por puesto de recepción.
  for (const nombre of ["Uno", "Dos"]) {
    const [p] = await db.insert(pacientesTable).values({
      nombre, apellido: `Conc${RUN_ID}`, dni: `8${RUN_ID.slice(0, 5)}${pacienteIds.length}`,
    }).returning();
    pacienteIds.push(p.id);
  }
});

afterAll(async () => {
  // Las reservas encolan trabajos Klinicos en segundo plano (fire-and-forget):
  // borrarlos antes que los turnos evita la violación de FK intermitente.
  await db.execute(
    sql`DELETE FROM klinicos_trabajos WHERE turno_id IN (SELECT id FROM turnos WHERE turnera_id IN (${sql.join(turneraIds.map((id) => sql`${id}`), sql`, `)}))`,
  );
  await db.delete(turnosTable).where(inArray(turnosTable.turneraId, turneraIds));
  await db.delete(pacientesTable).where(inArray(pacientesTable.id, pacienteIds));
  await db.delete(turnerasTable).where(inArray(turnerasTable.id, turneraIds));
  await db.delete(profesionalesTable).where(inArray(profesionalesTable.id, [profAId, profBId]));
  await db.delete(especialidadesTable).where(eq(especialidadesTable.id, especialidadId));
  await db.delete(sedesTable).where(eq(sedesTable.id, sedeId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Reserva concurrente desde la vista combinada", () => {
  it("la vista combinada arranca ofreciendo los huecos de ambos profesionales", async () => {
    expect(await slotsAgregados()).toEqual([
      `${turneraAId}|08:00`,
      `${turneraBId}|08:15`,
      `${turneraAId}|08:30`,
    ]);
  });

  it("dos reservas simultáneas del mismo slot: una gana, la otra recibe 409 con mensaje claro", async () => {
    // Ambos puestos vieron "08:00 — Conc A" libre en la vista combinada y
    // disparan la reserva a la vez (las dos pasan el pre-chequeo; decide el
    // índice único de slot).
    const [r1, r2] = await Promise.all([
      reservar(turneraAId, pacienteIds[0]!, "08:00"),
      reservar(turneraAId, pacienteIds[1]!, "08:00"),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const perdedor = r1.status === 409 ? r1 : r2;
    const ganador = r1.status === 201 ? r1 : r2;
    // El mensaje es el que la UI muestra en el toast de error: debe ser claro.
    const err = (await perdedor.json()) as { error?: string };
    expect(err.error).toBe("Ese horario ya fue reservado. Elegí otro horario disponible.");

    // El turno ganador quedó intacto: exactamente UN turno activo en el slot,
    // del paciente que ganó (nunca se pisa la reserva existente).
    const ganadorBody = (await ganador.json()) as { id: number; pacienteId: number };
    const activos = await db.select().from(turnosTable).where(eq(turnosTable.turneraId, turneraAId));
    const enSlot = activos.filter((t) => t.horaInicio.startsWith("08:0") && !["cancelado", "ausente"].includes(t.estado));
    expect(enSlot).toHaveLength(1);
    expect(enSlot[0]!.id).toBe(ganadorBody.id);
    expect(enSlot[0]!.pacienteId).toBe(ganadorBody.pacienteId);
  });

  it("tras el 409, la disponibilidad combinada refrescada ya no ofrece ese hueco pero sí el resto", async () => {
    // Es exactamente lo que hace la UI: ante el error invalida las queries de
    // /disponibilidad y vuelve a pedir la agregada.
    expect(await slotsAgregados()).toEqual([
      `${turneraBId}|08:15`,
      `${turneraAId}|08:30`,
    ]);
  });

  it("un intento tardío sobre el mismo slot (lista vieja de 30 s) también recibe 409 y no pisa nada", async () => {
    // Caso más común: el segundo puesto hace clic segundos después, con la
    // lista desactualizada. Acá corta el pre-chequeo, con el mismo mensaje.
    const res = await reservar(turneraAId, pacienteIds[1]!, "08:00");
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error?: string };
    expect(err.error).toBe("Ese horario ya fue reservado. Elegí otro horario disponible.");
    const activos = await db.select().from(turnosTable).where(eq(turnosTable.turneraId, turneraAId));
    expect(activos.filter((t) => t.horaInicio.startsWith("08:0") && !["cancelado", "ausente"].includes(t.estado))).toHaveLength(1);
  });

  it("el perdedor puede tomar otro hueco de la vista combinada (otro profesional) sin conflicto", async () => {
    const res = await reservar(turneraBId, pacienteIds[1]!, "08:15");
    expect(res.status).toBe(201);
    expect(await slotsAgregados()).toEqual([`${turneraAId}|08:30`]);
  });
});
