import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { inArray } from "drizzle-orm";
import { db, usersTable, sesionesTable } from "@workspace/db";
import usuariosRouter from "./usuarios";

// Frontera de seguridad: la gestión de usuarios (/api/usuarios) es exclusiva
// del administrador y el desarrollador. El perfil "gerente" tiene rol admin
// para el resto del sistema, pero NO debe poder gestionar usuarios.

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

const TOKEN_ADMIN = `test-token-usr-admin-${RUN_ID}`;
const TOKEN_DEV = `test-token-usr-dev-${RUN_ID}`;
const TOKEN_GERENTE = `test-token-usr-ger-${RUN_ID}`;
const TOKEN_MEDICO = `test-token-usr-med-${RUN_ID}`;

const userIds: number[] = [];

async function crearUsuarioConSesion(rol: string, token: string, perfil?: string): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-usr-${rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `Test ${rol}`,
      rol,
      perfil: perfil ?? null,
    })
    .returning();
  userIds.push(user!.id);

  await db.insert(sesionesTable).values({
    token,
    usuarioId: user!.id,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return user!.id;
}

function get(path: string, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function post(path: string, token?: string, body: unknown = {}): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function patch(path: string, token?: string, body: unknown = {}): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

let medicoId: number;

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", usuariosRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await crearUsuarioConSesion("admin", TOKEN_ADMIN);
  await crearUsuarioConSesion("admin", TOKEN_DEV, "desarrollador");
  await crearUsuarioConSesion("admin", TOKEN_GERENTE, "gerente");
  medicoId = await crearUsuarioConSesion("medico", TOKEN_MEDICO, "medico");
});

afterAll(async () => {
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("Gestión de usuarios — sin autenticación", () => {
  it("GET /usuarios sin token responde 401", async () => {
    const res = await get("/usuarios");
    expect(res.status).toBe(401);
  });
});

describe("Gestión de usuarios — roles sin permiso (403)", () => {
  it("GET /usuarios con rol medico responde 403", async () => {
    const res = await get("/usuarios", TOKEN_MEDICO);
    expect(res.status).toBe(403);
  });

  it("GET /usuarios con perfil gerente responde 403", async () => {
    const res = await get("/usuarios", TOKEN_GERENTE);
    expect(res.status).toBe(403);
  });

  it("POST /usuarios con perfil gerente responde 403", async () => {
    const res = await post("/usuarios", TOKEN_GERENTE, {
      email: `nuevo-${RUN_ID}@test.local`,
      nombre: "Nuevo",
      password: "clave1234",
      perfil: "tecnico",
    });
    expect(res.status).toBe(403);
  });

  it("PATCH /usuarios/:id con perfil gerente responde 403", async () => {
    const res = await patch(`/usuarios/${medicoId}`, TOKEN_GERENTE, { activo: false });
    expect(res.status).toBe(403);
  });
});

describe("Gestión de usuarios — administrador y desarrollador con acceso", () => {
  it("GET /usuarios con admin (sin perfil) responde 200", async () => {
    const res = await get("/usuarios", TOKEN_ADMIN);
    expect(res.status).toBe(200);
  });

  it("GET /usuarios con perfil desarrollador responde 200", async () => {
    const res = await get("/usuarios", TOKEN_DEV);
    expect(res.status).toBe(200);
  });

  it("PATCH /usuarios/:id con admin responde 200", async () => {
    const res = await patch(`/usuarios/${medicoId}`, TOKEN_ADMIN, { nombre: "Test medico" });
    expect(res.status).toBe(200);
  });
});
