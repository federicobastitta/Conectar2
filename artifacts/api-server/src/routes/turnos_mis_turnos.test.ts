import { hoyArgentina } from "../lib/tiempo";
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

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuarios, sesiones, pacientes, turnera, turnos) y los limpian al terminar.
//
// Verifican el aislamiento de datos del endpoint GET /api/turnos/mis-turnos:
// - 401 sin token
// - 403 para roles no-paciente (admin/medico/recepcionista)
// - cada paciente ve SOLO sus propios turnos
// - paciente sin pacienteId vinculado recibe lista vacía

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let turneraId: number;

// Dos pacientes distintos, cada uno con su usuario y sesión
let pacienteAId: number;
let pacienteBId: number;
const TOKEN_PACIENTE_A = `test-token-pa-${RUN_ID}`;
const TOKEN_PACIENTE_B = `test-token-pb-${RUN_ID}`;
// Paciente sin pacienteId vinculado
const TOKEN_PACIENTE_SIN_VINCULO = `test-token-psv-${RUN_ID}`;
// Roles de staff
const TOKEN_ADMIN = `test-token-admin-${RUN_ID}`;
const TOKEN_MEDICO = `test-token-medico-${RUN_ID}`;
const TOKEN_RECEPCION = `test-token-recep-${RUN_ID}`;

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
      email: `test-misturnos-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
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

async function crearTurno(pacienteId: number, horaInicio: string): Promise<number> {
  const horaFin = `${horaInicio.split(":")[0]}:59`;
  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      fecha: hoy(),
      horaInicio,
      horaFin,
      estado: "pendiente",
    })
    .returning();
  turnoIds.push(turno!.id);
  return turno!.id;
}

function misTurnos(token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/turnos/mis-turnos`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

beforeAll(async () => {
  // App mínima: solo el router de turnos, con logger silencioso
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

  const [turnera] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera MisTurnos Test ${RUN_ID}` })
    .returning();
  turneraId = turnera!.id;

  // Dos pacientes distintos
  const [pacienteA] = await db
    .insert(pacientesTable)
    .values({ nombre: "Alicia", apellido: `TestA${RUN_ID}`, dni: `A${RUN_ID}`, activo: true })
    .returning();
  pacienteAId = pacienteA!.id;

  const [pacienteB] = await db
    .insert(pacientesTable)
    .values({ nombre: "Bruno", apellido: `TestB${RUN_ID}`, dni: `B${RUN_ID}`, activo: true })
    .returning();
  pacienteBId = pacienteB!.id;

  // Usuarios con sesión: dos pacientes vinculados, uno sin vincular y tres roles de staff
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_A, pacienteId: pacienteAId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_B, pacienteId: pacienteBId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_SIN_VINCULO });
  await crearUsuarioConSesion({ rol: "admin", token: TOKEN_ADMIN });
  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO });
  await crearUsuarioConSesion({ rol: "recepcionista", token: TOKEN_RECEPCION });

  // Turnos: dos para A, uno para B
  await crearTurno(pacienteAId, "09:00");
  await crearTurno(pacienteAId, "10:00");
  await crearTurno(pacienteBId, "11:00");
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

describe("GET /api/turnos/mis-turnos — autenticación y roles", () => {
  it("sin token responde 401", async () => {
    const res = await misTurnos();
    expect(res.status).toBe(401);
  });

  it("con token inválido responde 401", async () => {
    const res = await misTurnos(`token-inexistente-${RUN_ID}`);
    expect(res.status).toBe(401);
  });

  it("rol admin responde 403", async () => {
    const res = await misTurnos(TOKEN_ADMIN);
    expect(res.status).toBe(403);
  });

  it("rol medico responde 403", async () => {
    const res = await misTurnos(TOKEN_MEDICO);
    expect(res.status).toBe(403);
  });

  it("rol recepcionista responde 403", async () => {
    const res = await misTurnos(TOKEN_RECEPCION);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/turnos/mis-turnos — aislamiento entre pacientes", () => {
  type Turno = { id: number; pacienteId: number | null };

  it("el paciente A ve solo sus propios turnos (los 2 suyos, ninguno de B)", async () => {
    const res = await misTurnos(TOKEN_PACIENTE_A);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Turno[];

    // Todos los turnos devueltos pertenecen al paciente A
    expect(data.length).toBeGreaterThanOrEqual(2);
    for (const turno of data) {
      expect(turno.pacienteId).toBe(pacienteAId);
    }
    // Sus dos turnos de prueba están incluidos
    const ids = data.map((t) => t.id);
    expect(ids).toContain(turnoIds[0]);
    expect(ids).toContain(turnoIds[1]);
    // El turno de B jamás aparece
    expect(ids).not.toContain(turnoIds[2]);
  });

  it("el paciente B ve solo sus propios turnos (el suyo, ninguno de A)", async () => {
    const res = await misTurnos(TOKEN_PACIENTE_B);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Turno[];

    expect(data.length).toBeGreaterThanOrEqual(1);
    for (const turno of data) {
      expect(turno.pacienteId).toBe(pacienteBId);
    }
    const ids = data.map((t) => t.id);
    expect(ids).toContain(turnoIds[2]);
    expect(ids).not.toContain(turnoIds[0]);
    expect(ids).not.toContain(turnoIds[1]);
  });

  it("paciente sin pacienteId vinculado recibe lista vacía (no un error ni datos ajenos)", async () => {
    const res = await misTurnos(TOKEN_PACIENTE_SIN_VINCULO);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Turno[];
    expect(data).toEqual([]);
  });
});
