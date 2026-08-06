import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { inArray } from "drizzle-orm";
import { db, usersTable, sesionesTable, pacientesTable } from "@workspace/db";
import pacsRouter from "./pacs";

// Matriz de permisos de los endpoints de DiagnostiPACS:
//   GET  /api/pacs/pacientes/:id/dicom          — staff o paciente propio
//   POST /api/pacs/pacientes/:id/dicom/importar — solo staff
// Solo se prueban los caminos que NO llegan a llamar al PACS externo
// (401/403/400/404), para no depender de un servicio de terceros en los tests.

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;
let pacienteAId: number;
let pacienteBId: number;

const TOKEN_PACIENTE_A = `test-token-dicom-a-${RUN_ID}`;
const TOKEN_ADMIN = `test-token-dicom-admin-${RUN_ID}`;

const userIds: number[] = [];

async function crearUsuarioConSesion(opts: { rol: string; token: string; pacienteId?: number }) {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-dicom-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
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
}

function get(path: string, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function post(path: string, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
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
  app.use("/api", pacsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [pacienteA] = await db
    .insert(pacientesTable)
    .values({ nombre: "Ana", apellido: `DicomA${RUN_ID}`, dni: `DA${RUN_ID}`, activo: true })
    .returning();
  pacienteAId = pacienteA!.id;

  const [pacienteB] = await db
    .insert(pacientesTable)
    .values({ nombre: "Beto", apellido: `DicomB${RUN_ID}`, dni: `DB${RUN_ID}`, activo: true })
    .returning();
  pacienteBId = pacienteB!.id;

  await crearUsuarioConSesion({ rol: "paciente", token: TOKEN_PACIENTE_A, pacienteId: pacienteAId });
  await crearUsuarioConSesion({ rol: "admin", token: TOKEN_ADMIN });
});

afterAll(async () => {
  await db.delete(pacientesTable).where(inArray(pacientesTable.id, [pacienteAId, pacienteBId]));
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("GET /api/pacs/pacientes/:id/dicom — autorización", () => {
  it("sin token responde 401", async () => {
    const res = await get(`/pacs/pacientes/${pacienteAId}/dicom`);
    expect(res.status).toBe(401);
  });

  it("id inválido responde 400", async () => {
    const res = await get(`/pacs/pacientes/abc/dicom`, TOKEN_ADMIN);
    expect(res.status).toBe(400);
  });

  it("paciente NO puede ver el PACS de otro paciente (403)", async () => {
    const res = await get(`/pacs/pacientes/${pacienteBId}/dicom`, TOKEN_PACIENTE_A);
    expect(res.status).toBe(403);
  });

  it("staff con paciente inexistente responde 404 (si la integración está configurada)", async () => {
    const res = await get(`/pacs/pacientes/999999999/dicom`, TOKEN_ADMIN);
    if (process.env.PACS_API_TOKEN?.trim()) {
      expect(res.status).toBe(404);
    } else {
      // Sin token de PACS el endpoint responde 200 con configurado:false.
      expect(res.status).toBe(200);
      expect(((await res.json()) as { configurado: boolean }).configurado).toBe(false);
    }
  });
});

describe("POST /api/pacs/pacientes/:id/dicom/importar — autorización", () => {
  it("sin token responde 401", async () => {
    const res = await post(`/pacs/pacientes/${pacienteAId}/dicom/importar`);
    expect(res.status).toBe(401);
  });

  it("un paciente no puede importar (403), ni siquiera para sí mismo", async () => {
    const res = await post(`/pacs/pacientes/${pacienteAId}/dicom/importar`, TOKEN_PACIENTE_A);
    expect(res.status).toBe(403);
  });

  it("staff con id inválido responde 400", async () => {
    const res = await post(`/pacs/pacientes/0/dicom/importar`, TOKEN_ADMIN);
    expect(res.status).toBe(400);
  });

  it("staff con paciente inexistente responde 404 (si la integración está configurada)", async () => {
    const res = await post(`/pacs/pacientes/999999999/dicom/importar`, TOKEN_ADMIN);
    if (process.env.PACS_API_TOKEN?.trim()) {
      expect(res.status).toBe(404);
    } else {
      expect(res.status).toBe(503);
    }
  });
});
