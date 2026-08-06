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

// Tests del endpoint de disponibilidad agregada (vista "Todos los
// profesionales"): junta huecos libres de todas las agendas activas de una
// sede+especialidad, identificados por turnera/profesional y ordenados por hora.
// Crean sus propios datos (RUN_ID) y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN = `test-token-dagg-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let sedeId: number;
let otraSedeId: number;
let especialidadId: number;
let otraEspecialidadId: number;
let profAId: number;
let profBId: number;
let turneraAId: number;
let turneraBId: number;
let turneraInactivaId: number;
let turneraGuardiaId: number;
let turneraOtraEspId: number;
let pacienteId: number;
const turnoIds: number[] = [];

// Próxima fecha futura (>= mañana) que caiga en el día de semana pedido (UTC).
function proximaFecha(diaSemana: number): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  while (d.getUTCDay() !== diaSemana) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0]!;
}

const FECHA = proximaFecha(2); // un martes futuro

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
    email: `dagg-${RUN_ID}@test.local`,
    passwordHash: "x",
    nombre: `Test DAgg ${RUN_ID}`,
    rol: "recepcionista",
  }).returning();
  userId = user.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [sede] = await db.insert(sedesTable).values({ nombre: `Sede DAgg ${RUN_ID}` }).returning();
  sedeId = sede.id;
  const [otraSede] = await db.insert(sedesTable).values({ nombre: `Sede DAgg B ${RUN_ID}` }).returning();
  otraSedeId = otraSede.id;
  const [esp] = await db.insert(especialidadesTable).values({ nombre: `Ecografía DAgg ${RUN_ID}` }).returning();
  especialidadId = esp.id;
  const [otraEsp] = await db.insert(especialidadesTable).values({ nombre: `Clínica DAgg ${RUN_ID}` }).returning();
  otraEspecialidadId = otraEsp.id;
  const [profA] = await db.insert(profesionalesTable).values({
    nombre: "Ana", apellido: `PerezDAgg${RUN_ID}`,
  }).returning();
  profAId = profA.id;
  const [profB] = await db.insert(profesionalesTable).values({
    nombre: "Beto", apellido: `GomezDAgg${RUN_ID}`,
  }).returning();
  profBId = profB.id;

  // Turnera A: martes 08-09, 30 min → 08:00 y 08:30
  const base = {
    duracionMinutos: 30,
    modalidad: "presencial",
    activa: true,
    diasAtencion: "2",
    sedeId,
    especialidadId,
  };
  const [tA] = await db.insert(turnerasTable).values({
    ...base, nombre: `DAgg A ${RUN_ID}`, profesionalId: profAId, horaInicio: "08:00", horaFin: "09:00",
  }).returning();
  turneraAId = tA.id;
  // Turnera B: martes 08:15-09:15, 30 min → 08:15 y 08:45 (intercalado con A)
  const [tB] = await db.insert(turnerasTable).values({
    ...base, nombre: `DAgg B ${RUN_ID}`, profesionalId: profBId, horaInicio: "08:15", horaFin: "09:15",
  }).returning();
  turneraBId = tB.id;
  // Turnera inactiva de la misma especialidad: no debe aparecer
  const [tI] = await db.insert(turnerasTable).values({
    ...base, nombre: `DAgg Inactiva ${RUN_ID}`, activa: false, horaInicio: "08:00", horaFin: "09:00",
  }).returning();
  turneraInactivaId = tI.id;
  // Guardia de la misma especialidad: excluida (demanda espontánea)
  const [tG] = await db.insert(turnerasTable).values({
    ...base, nombre: `DAgg Guardia ${RUN_ID}`, esGuardia: true, horaInicio: "08:00", horaFin: "12:00",
  }).returning();
  turneraGuardiaId = tG.id;
  // Turnera activa de OTRA especialidad: no debe aparecer al filtrar
  const [tO] = await db.insert(turnerasTable).values({
    ...base, nombre: `DAgg OtraEsp ${RUN_ID}`, especialidadId: otraEspecialidadId, horaInicio: "08:00", horaFin: "09:00",
  }).returning();
  turneraOtraEspId = tO.id;

  // Paciente + turno ocupando el 08:00 de la turnera A
  const [pac] = await db.insert(pacientesTable).values({
    nombre: "Pac", apellido: `DAgg${RUN_ID}`, dni: `9${RUN_ID.slice(0, 6)}`,
  }).returning();
  pacienteId = pac.id;
  const [turno] = await db.insert(turnosTable).values({
    turneraId: turneraAId,
    pacienteId,
    fecha: FECHA,
    horaInicio: "08:00",
    horaFin: "08:30",
    estado: "reservado",
  }).returning();
  turnoIds.push(turno.id);
});

afterAll(async () => {
  if (turnoIds.length) await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(turnerasTable).where(inArray(turnerasTable.id, [turneraAId, turneraBId, turneraInactivaId, turneraGuardiaId, turneraOtraEspId]));
  await db.delete(profesionalesTable).where(inArray(profesionalesTable.id, [profAId, profBId]));
  await db.delete(especialidadesTable).where(inArray(especialidadesTable.id, [especialidadId, otraEspecialidadId]));
  await db.delete(sedesTable).where(inArray(sedesTable.id, [sedeId, otraSedeId]));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /turneras/disponibilidad-agregada", () => {
  it("rechaza sin autenticación", async () => {
    const res = await fetch(`${baseUrl}/api/turneras/disponibilidad-agregada?fecha=${FECHA}&especialidadId=${especialidadId}`);
    expect(res.status).toBe(401);
  });

  it("rechaza fecha inválida", async () => {
    const res = await api(`/turneras/disponibilidad-agregada?fecha=31-07-2026&especialidadId=${especialidadId}`);
    expect(res.status).toBe(400);
  });

  it("combina huecos de varias turneras ordenados por hora, con turnera y profesional", async () => {
    const res = await api(`/turneras/disponibilidad-agregada?fecha=${FECHA}&sedeId=${sedeId}&especialidadId=${especialidadId}`);
    expect(res.status).toBe(200);
    const slots = (await res.json()) as {
      turneraId: number; turneraNombre: string; profesionalNombre: string | null;
      fecha: string; horaInicio: string; horaFin: string;
    }[];
    const propios = slots.filter((s) => [turneraAId, turneraBId].includes(s.turneraId));
    // 08:00 de A está ocupado → libres: A 08:30 + B 08:15 y 08:45
    expect(propios.map((s) => `${s.turneraId}|${s.horaInicio}`)).toEqual([
      `${turneraBId}|08:15`,
      `${turneraAId}|08:30`,
      `${turneraBId}|08:45`,
    ]);
    const deB = propios.find((s) => s.turneraId === turneraBId)!;
    expect(deB.turneraNombre).toBe(`DAgg B ${RUN_ID}`);
    expect(deB.profesionalNombre).toContain(`GomezDAgg${RUN_ID}`);
    expect(deB.fecha).toBe(FECHA);
    // El orden global es por hora
    const horas = slots.map((s) => s.horaInicio);
    expect([...horas].sort()).toEqual(horas);
  });

  it("excluye turneras inactivas y de guardia", async () => {
    const res = await api(`/turneras/disponibilidad-agregada?fecha=${FECHA}&sedeId=${sedeId}&especialidadId=${especialidadId}`);
    const slots = (await res.json()) as { turneraId: number }[];
    expect(slots.some((s) => s.turneraId === turneraInactivaId)).toBe(false);
    expect(slots.some((s) => s.turneraId === turneraGuardiaId)).toBe(false);
    expect(slots.some((s) => s.turneraId === turneraOtraEspId)).toBe(false);
  });

  it("filtra por sede: otra sede no devuelve estas turneras", async () => {
    const res = await api(`/turneras/disponibilidad-agregada?fecha=${FECHA}&sedeId=${otraSedeId}&especialidadId=${especialidadId}`);
    expect(res.status).toBe(200);
    const slots = (await res.json()) as { turneraId: number }[];
    expect(slots.some((s) => [turneraAId, turneraBId].includes(s.turneraId))).toBe(false);
  });

  it("día sin atención devuelve sin huecos de estas turneras", async () => {
    // Las turneras solo atienden martes (dia 2); un miércoles no hay slots.
    const miercoles = proximaFecha(3);
    const res = await api(`/turneras/disponibilidad-agregada?fecha=${miercoles}&sedeId=${sedeId}&especialidadId=${especialidadId}`);
    expect(res.status).toBe(200);
    const slots = (await res.json()) as { turneraId: number }[];
    expect(slots.some((s) => [turneraAId, turneraBId].includes(s.turneraId))).toBe(false);
  });

  it("la disponibilidad por turnera individual no cambia (vista con profesional específico)", async () => {
    const res = await api(`/turneras/${turneraAId}/disponibilidad/${FECHA}`);
    expect(res.status).toBe(200);
    const slots = (await res.json()) as { horaInicio: string; disponible: boolean }[];
    expect(slots.map((s) => `${s.horaInicio}:${s.disponible}`)).toEqual(["08:00:false", "08:30:true"]);
  });
});
