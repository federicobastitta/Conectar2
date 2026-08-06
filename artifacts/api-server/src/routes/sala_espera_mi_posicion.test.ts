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
import salaEsperaRouter from "./sala_espera";
import { hoyArgentina } from "../lib/tiempo";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuarios, sesiones, pacientes, turnera, turnos) y los limpian al terminar.
//
// Verifican el aislamiento de datos del endpoint GET /api/sala-espera/mi-posicion:
// - 401 sin token / token inválido
// - 403 para roles no-paciente (admin/medico/recepcionista)
// - cada paciente ve SOLO sus propios turnos (jamás los de otro paciente)
// - la posición en la cola es coherente con la vista del staff
// - paciente sin pacienteId vinculado recibe respuesta vacía

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let turneraId: number;
let pacienteAId: number;
let pacienteBId: number;

const TOKEN_PACIENTE_A = `test-token-mp-a-${RUN_ID}`;
const TOKEN_PACIENTE_B = `test-token-mp-b-${RUN_ID}`;
const TOKEN_PACIENTE_SIN_VINCULO = `test-token-mp-sv-${RUN_ID}`;
const TOKEN_ADMIN = `test-token-mp-admin-${RUN_ID}`;
const TOKEN_MEDICO = `test-token-mp-medico-${RUN_ID}`;
const TOKEN_RECEPCION = `test-token-mp-recep-${RUN_ID}`;

const userIds: number[] = [];
const turnoIds: number[] = [];

function hoy(): string {
  // Debe coincidir con el "hoy" del server (hora argentina), no con la fecha UTC:
  // entre 21:00 y 24:00 AR difieren y los tests fallarían.
  return hoyArgentina();
}

async function crearUsuarioConSesion(opts: {
  rol: string;
  token: string;
  pacienteId?: number;
}): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-miposicion-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `Test ${opts.rol}`,
      rol: opts.rol,
      pacienteId: opts.pacienteId !== undefined ? String(opts.pacienteId) : undefined,
    })
    .returning();
  userIds.push(user!.id);

  await db.insert(sesionesTable).values({
    token: opts.token,
    usuarioId: user!.id,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return user!.id;
}

async function crearTurno(opts: {
  pacienteId: number;
  horaInicio: string;
  estado: string;
  admitidoEn?: Date;
}): Promise<number> {
  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId: opts.pacienteId,
      fecha: hoy(),
      horaInicio: opts.horaInicio,
      horaFin: `${opts.horaInicio.split(":")[0]}:59`,
      estado: opts.estado,
      admitidoEn: opts.admitidoEn,
    })
    .returning();
  turnoIds.push(turno!.id);
  return turno!.id;
}

function miPosicion(token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/sala-espera/mi-posicion`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

// Turnos de prueba (misma turnera): A admitido a las 09:00, B admitido a las 10:00
let turnoAId: number;
let turnoBId: number;

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

  const [turnera] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera MiPosicion Test ${RUN_ID}` })
    .returning();
  turneraId = turnera!.id;

  const [pacienteA] = await db
    .insert(pacientesTable)
    .values({ nombre: "Alicia", apellido: `PosTestA${RUN_ID}`, dni: `PA${RUN_ID}`, activo: true })
    .returning();
  pacienteAId = pacienteA!.id;

  const [pacienteB] = await db
    .insert(pacientesTable)
    .values({ nombre: "Bruno", apellido: `PosTestB${RUN_ID}`, dni: `PB${RUN_ID}`, activo: true })
    .returning();
  pacienteBId = pacienteB!.id;

  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_A, pacienteId: pacienteAId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_B, pacienteId: pacienteBId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_SIN_VINCULO });
  await crearUsuarioConSesion({ rol: "admin", token: TOKEN_ADMIN });
  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO });
  await crearUsuarioConSesion({ rol: "recepcionista", token: TOKEN_RECEPCION });

  // Ambos en espera en la misma turnera: A llegó antes (09:00) que B (10:00)
  turnoAId = await crearTurno({
    pacienteId: pacienteAId,
    horaInicio: "09:00",
    estado: "arribo",
    admitidoEn: new Date(Date.now() - 20 * 60 * 1000),
  });
  turnoBId = await crearTurno({
    pacienteId: pacienteBId,
    horaInicio: "10:00",
    estado: "en_sala",
    admitidoEn: new Date(Date.now() - 5 * 60 * 1000),
  });
});

afterAll(async () => {
  if (turnoIds.length > 0) await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(pacientesTable).where(inArray(pacientesTable.id, [pacienteAId, pacienteBId]));
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

type MiPosicionTurno = {
  turnoId: number;
  estado: string;
  turneraId: number;
  posicion: number | null;
  enEsperaTurnera: number;
};

describe("GET /api/sala-espera/mi-posicion — autenticación y roles", () => {
  it("sin token responde 401", async () => {
    const res = await miPosicion();
    expect(res.status).toBe(401);
  });

  it("con token inválido responde 401", async () => {
    const res = await miPosicion(`token-inexistente-${RUN_ID}`);
    expect(res.status).toBe(401);
  });

  it("rol admin responde 403", async () => {
    const res = await miPosicion(TOKEN_ADMIN);
    expect(res.status).toBe(403);
  });

  it("rol medico responde 403", async () => {
    const res = await miPosicion(TOKEN_MEDICO);
    expect(res.status).toBe(403);
  });

  it("rol recepcionista responde 403", async () => {
    const res = await miPosicion(TOKEN_RECEPCION);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/sala-espera/mi-posicion — aislamiento entre pacientes", () => {
  it("el paciente A ve solo su propio turno, nunca el de B", async () => {
    const res = await miPosicion(TOKEN_PACIENTE_A);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { turnos: MiPosicionTurno[] };

    const ids = data.turnos.map((t) => t.turnoId);
    expect(ids).toContain(turnoAId);
    expect(ids).not.toContain(turnoBId);

    // Está 1° en la fila (llegó antes que B), y la cola de la turnera tiene 2
    const turnoA = data.turnos.find((t) => t.turnoId === turnoAId)!;
    expect(turnoA.posicion).toBe(1);
    expect(turnoA.enEsperaTurnera).toBe(2);
  });

  it("el paciente B ve solo su propio turno, nunca el de A", async () => {
    const res = await miPosicion(TOKEN_PACIENTE_B);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { turnos: MiPosicionTurno[] };

    const ids = data.turnos.map((t) => t.turnoId);
    expect(ids).toContain(turnoBId);
    expect(ids).not.toContain(turnoAId);

    // Está 2° en la fila detrás de A; ve el tamaño de la cola pero no la identidad de A
    const turnoB = data.turnos.find((t) => t.turnoId === turnoBId)!;
    expect(turnoB.posicion).toBe(2);
    expect(turnoB.enEsperaTurnera).toBe(2);
  });

  it("la respuesta no expone datos personales de otros pacientes", async () => {
    const res = await miPosicion(TOKEN_PACIENTE_A);
    expect(res.status).toBe(200);
    const texto = JSON.stringify(await res.json());
    // Ni el apellido ni el DNI de B aparecen en la respuesta de A
    expect(texto).not.toContain(`PosTestB${RUN_ID}`);
    expect(texto).not.toContain(`PB${RUN_ID}`);
  });

  it("paciente sin pacienteId vinculado recibe respuesta vacía (no un error ni datos ajenos)", async () => {
    const res = await miPosicion(TOKEN_PACIENTE_SIN_VINCULO);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { turnos: MiPosicionTurno[] };
    expect(data.turnos).toEqual([]);
  });
});
