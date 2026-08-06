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
  obrasSocialesTable,
  turneraObrasSocialesTable,
} from "@workspace/db";
import turnosRouter from "./turnos";
import turnerasRouter from "./turneras";

// Tests de integración de obras sociales por turnera (listado + cupo diario).
// Crean sus propios datos y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN = `test-token-cupos-os-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let turneraId: number;
let osIomaId: number;
let osPamiId: number;
const pacienteIds: number[] = [];

// Fecha futura (mañana) para no chocar con la validación de slots pasados.
const FECHA = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];

async function crearPaciente(nombre: string, cobertura: string | null) {
  const [p] = await db.insert(pacientesTable).values({
    nombre,
    apellido: `CuposOS${RUN_ID}`,
    dni: `C${RUN_ID}${pacienteIds.length}`,
    cobertura: cobertura ?? undefined,
  }).returning();
  pacienteIds.push(p!.id);
  return p!.id;
}

async function reservar(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/turnos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ turneraId, fecha: FECHA, ...body }),
  });
  return res;
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
    email: `test-cupos-os-${RUN_ID}@test.local`,
    passwordHash: "irrelevante",
    nombre: "Test Cupos OS",
    rol: "recepcionista",
  }).returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [ioma] = await db.insert(obrasSocialesTable).values({ nombre: `IOMA-TEST-${RUN_ID}` }).returning();
  const [pami] = await db.insert(obrasSocialesTable).values({ nombre: `PAMÍ-TEST-${RUN_ID}` }).returning();
  osIomaId = ioma!.id;
  osPamiId = pami!.id;

  const [turnera] = await db.insert(turnerasTable).values({
    nombre: `Turnera Cupos OS ${RUN_ID}`,
    duracionMinutos: 15,
    diasAtencion: "0,1,2,3,4,5,6",
    horaInicio: "08:00",
    horaFin: "20:00",
    visibilidad: "recepcion",
  }).returning();
  turneraId = turnera!.id;

  // IOMA con cupo 2 por día; PAMÍ sin límite.
  await db.insert(turneraObrasSocialesTable).values([
    { turneraId, obraSocialId: osIomaId, cupoDiario: 2 },
    { turneraId, obraSocialId: osPamiId, cupoDiario: null },
  ]);
});

afterAll(async () => {
  if (pacienteIds.length > 0) {
    await db.delete(turnosTable).where(inArray(turnosTable.pacienteId, pacienteIds));
    await db.delete(pacientesTable).where(inArray(pacientesTable.id, pacienteIds));
  }
  await db.delete(turneraObrasSocialesTable).where(eq(turneraObrasSocialesTable.turneraId, turneraId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(obrasSocialesTable).where(inArray(obrasSocialesTable.id, [osIomaId, osPamiId]));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("obras sociales por turnera", () => {
  it("GET /turneras/:id devuelve las obras sociales con cupo", async () => {
    const res = await fetch(`${baseUrl}/api/turneras/${turneraId}`);
    expect(res.status).toBe(200);
    const t = (await res.json()) as { obrasSociales: { obraSocialId: number; cupoDiario: number | null }[] };
    expect(t.obrasSociales).toHaveLength(2);
    const ioma = t.obrasSociales.find((o: { obraSocialId: number }) => o.obraSocialId === osIomaId);
    expect(ioma?.cupoDiario).toBe(2);
  });

  it("rechaza cobertura no listada con 422", async () => {
    const pid = await crearPaciente("Otra", "OSDE");
    const res = await reservar({ pacienteId: pid, horaInicio: "08:00", cobertura: "OSDE" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no atiende");
  });

  it("rechaza reserva sin cobertura cuando hay listado", async () => {
    const pid = await crearPaciente("SinCobertura", null);
    const res = await reservar({ pacienteId: pid, horaInicio: "08:15" });
    expect(res.status).toBe(422);
  });

  it("acepta cobertura listada (insensible a acentos) y aplica el cupo diario", async () => {
    const p1 = await crearPaciente("Ioma1", null);
    const p2 = await crearPaciente("Ioma2", null);
    const p3 = await crearPaciente("Ioma3", null);
    // "ioma-test" en minúsculas y sin acento debe matchear igual.
    const cobertura = `ioma-test-${RUN_ID}`;
    const r1 = await reservar({ pacienteId: p1, horaInicio: "09:00", cobertura });
    expect(r1.status).toBe(201);
    const r2 = await reservar({ pacienteId: p2, horaInicio: "09:15", cobertura: `IOMA-TEST-${RUN_ID}` });
    expect(r2.status).toBe(201);
    // Tercer turno del día para IOMA: supera el cupo de 2.
    const r3 = await reservar({ pacienteId: p3, horaInicio: "09:30", cobertura: `IOMA-TEST-${RUN_ID}` });
    expect(r3.status).toBe(409);
    const body = (await r3.json()) as { error: string };
    expect(body.error).toContain("cupo diario");
  });

  it("obra social sin cupo no tiene límite y matchea con acentos", async () => {
    const p1 = await crearPaciente("Pami1", null);
    const p2 = await crearPaciente("Pami2", null);
    const p3 = await crearPaciente("Pami3", null);
    // Sin acento contra nombre con acento (PAMÍ).
    const cobertura = `PAMI-TEST-${RUN_ID}`;
    for (const [pid, hora] of [[p1, "10:00"], [p2, "10:15"], [p3, "10:30"]] as const) {
      const res = await reservar({ pacienteId: pid, horaInicio: hora, cobertura });
      expect(res.status).toBe(201);
    }
  });

  it("usa la cobertura de la ficha del paciente si el turno no trae una", async () => {
    const pid = await crearPaciente("FichaIoma", `IOMA-TEST-${RUN_ID}`);
    // IOMA ya tiene 2 turnos del día: debe rechazar por cupo usando la cobertura de la ficha.
    const res = await reservar({ pacienteId: pid, horaInicio: "11:00" });
    expect(res.status).toBe(409);
  });

  it("turnera sin listado sigue aceptando cualquier cobertura", async () => {
    const [otra] = await db.insert(turnerasTable).values({
      nombre: `Turnera Libre ${RUN_ID}`,
      duracionMinutos: 15,
      diasAtencion: "0,1,2,3,4,5,6",
      horaInicio: "08:00",
      horaFin: "20:00",
      visibilidad: "recepcion",
    }).returning();
    try {
      const pid = await crearPaciente("Libre", "OSDE");
      const res = await fetch(`${baseUrl}/api/turnos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ turneraId: otra!.id, fecha: FECHA, pacienteId: pid, horaInicio: "08:00", cobertura: "OSDE" }),
      });
      expect(res.status).toBe(201);
    } finally {
      await db.delete(turnosTable).where(eq(turnosTable.turneraId, otra!.id));
      await db.delete(turnerasTable).where(eq(turnerasTable.id, otra!.id));
    }
  });
});
