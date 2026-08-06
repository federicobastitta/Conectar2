import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  estudiosExternosTable,
} from "@workspace/db";
import integracionesPhiritRouter from "./integraciones_phirit";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuarios, sesiones, pacientes, estudios externos) y los limpian al terminar.
//
// Verifican el aislamiento de datos del endpoint GET /api/integraciones/phirit/estudios:
// - 401 sin token / token inválido
// - cada paciente ve SOLO sus propios estudios/informes
// - el paciente NO puede saltarse el filtro con ?patientId= de otro paciente
// - paciente sin pacienteId vinculado recibe lista vacía
// - el staff (admin) sigue pudiendo filtrar por paciente

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let pacienteAId: number;
let pacienteBId: number;

const TOKEN_PACIENTE_A = `test-token-pl-a-${RUN_ID}`;
const TOKEN_PACIENTE_B = `test-token-pl-b-${RUN_ID}`;
const TOKEN_PACIENTE_SIN_VINCULO = `test-token-pl-sv-${RUN_ID}`;
const TOKEN_ADMIN = `test-token-pl-admin-${RUN_ID}`;

const EXTERNAL_ID_A = `PL-${RUN_ID}-A`;
const EXTERNAL_ID_B = `PL-${RUN_ID}-B`;

const userIds: number[] = [];
const estudioIds: number[] = [];

async function crearUsuarioConSesion(opts: {
  rol: string;
  token: string;
  pacienteId?: number;
}): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-phiritlist-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
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

async function crearEstudio(patientId: number, externalId: string): Promise<number> {
  const [estudio] = await db
    .insert(estudiosExternosTable)
    .values({
      origen: "phirit",
      externalId,
      patientId,
      descripcion: `Estudio test ${externalId}`,
      estado: "informado",
      informadoEn: new Date(),
      notificadoEn: new Date(), // ya notificado: el poller no lo reprocesa
    })
    .returning();
  estudioIds.push(estudio!.id);
  return estudio!.id;
}

function listar(token?: string, query = ""): Promise<Response> {
  return fetch(`${baseUrl}/api/integraciones/phirit/estudios${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

type EstudioListado = { id: number; externalId: string; patientId: number };

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", integracionesPhiritRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [pacienteA] = await db
    .insert(pacientesTable)
    .values({ nombre: "Alicia", apellido: `PhListA${RUN_ID}`, dni: `LA${RUN_ID}`, activo: true })
    .returning();
  pacienteAId = pacienteA!.id;

  const [pacienteB] = await db
    .insert(pacientesTable)
    .values({ nombre: "Bruno", apellido: `PhListB${RUN_ID}`, dni: `LB${RUN_ID}`, activo: true })
    .returning();
  pacienteBId = pacienteB!.id;

  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_A, pacienteId: pacienteAId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_B, pacienteId: pacienteBId });
  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_SIN_VINCULO });
  await crearUsuarioConSesion({ rol: "admin", token: TOKEN_ADMIN });

  await crearEstudio(pacienteAId, EXTERNAL_ID_A);
  await crearEstudio(pacienteBId, EXTERNAL_ID_B);
});

afterAll(async () => {
  if (estudioIds.length > 0)
    await db.delete(estudiosExternosTable).where(inArray(estudiosExternosTable.id, estudioIds));
  await db.delete(pacientesTable).where(inArray(pacientesTable.id, [pacienteAId, pacienteBId]));
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("GET /api/integraciones/phirit/estudios — autenticación", () => {
  it("sin token responde 401", async () => {
    const res = await listar();
    expect(res.status).toBe(401);
  });

  it("con token inválido responde 401", async () => {
    const res = await listar(`token-inexistente-${RUN_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/integraciones/phirit/estudios — aislamiento entre pacientes", () => {
  it("el paciente A ve solo sus propios estudios (el suyo, ninguno de B)", async () => {
    const res = await listar(TOKEN_PACIENTE_A);
    expect(res.status).toBe(200);
    const data = (await res.json()) as EstudioListado[];

    expect(data.length).toBeGreaterThanOrEqual(1);
    for (const estudio of data) {
      expect(estudio.patientId).toBe(pacienteAId);
    }
    const externalIds = data.map((e) => e.externalId);
    expect(externalIds).toContain(EXTERNAL_ID_A);
    expect(externalIds).not.toContain(EXTERNAL_ID_B);
  });

  it("el paciente B ve solo sus propios estudios (el suyo, ninguno de A)", async () => {
    const res = await listar(TOKEN_PACIENTE_B);
    expect(res.status).toBe(200);
    const data = (await res.json()) as EstudioListado[];

    expect(data.length).toBeGreaterThanOrEqual(1);
    for (const estudio of data) {
      expect(estudio.patientId).toBe(pacienteBId);
    }
    const externalIds = data.map((e) => e.externalId);
    expect(externalIds).toContain(EXTERNAL_ID_B);
    expect(externalIds).not.toContain(EXTERNAL_ID_A);
  });

  it("el paciente A NO puede saltarse el filtro con ?patientId= de B", async () => {
    const res = await listar(TOKEN_PACIENTE_A, `?patientId=${pacienteBId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as EstudioListado[];

    // El query param se ignora: sigue viendo solo lo suyo
    for (const estudio of data) {
      expect(estudio.patientId).toBe(pacienteAId);
    }
    expect(data.map((e) => e.externalId)).not.toContain(EXTERNAL_ID_B);
  });

  it("la respuesta del paciente A no expone datos personales de B", async () => {
    const res = await listar(TOKEN_PACIENTE_A);
    const texto = JSON.stringify(await res.json());
    expect(texto).not.toContain(`PhListB${RUN_ID}`);
  });

  it("paciente sin pacienteId vinculado recibe lista vacía (no un error ni datos ajenos)", async () => {
    const res = await listar(TOKEN_PACIENTE_SIN_VINCULO);
    expect(res.status).toBe(200);
    const data = (await res.json()) as EstudioListado[];
    expect(data).toEqual([]);
  });
});

describe("GET /api/integraciones/phirit/estudios — staff", () => {
  it("admin puede filtrar por paciente (ve los estudios de B)", async () => {
    const res = await listar(TOKEN_ADMIN, `?patientId=${pacienteBId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as EstudioListado[];
    expect(data.length).toBeGreaterThanOrEqual(1);
    for (const estudio of data) {
      expect(estudio.patientId).toBe(pacienteBId);
    }
    expect(data.map((e) => e.externalId)).toContain(EXTERNAL_ID_B);
  });
});
