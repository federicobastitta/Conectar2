import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { inArray } from "drizzle-orm";
import { db, usersTable, sesionesTable } from "@workspace/db";
import importacionV2Router from "./importacion_v2";
import importacionRouter from "./importacion";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuarios y sesiones) y los limpian al terminar.
//
// Verifican que los endpoints de importación (/api/importacion/*) queden
// bloqueados para todo el que no sea staff (admin/recepcionista):
// - 401 sin token o con token inválido
// - 403 con rol paciente
// - 200 con rol admin y recepcionista
// Es una frontera de seguridad: si un refactor futuro elimina el guard,
// cualquiera podría subir archivos enormes y crear datos clínicos.

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

const TOKEN_ADMIN = `test-token-imp-admin-${RUN_ID}`;
const TOKEN_RECEPCION = `test-token-imp-recep-${RUN_ID}`;
const TOKEN_PACIENTE = `test-token-imp-pac-${RUN_ID}`;

const userIds: number[] = [];

async function crearUsuarioConSesion(rol: string, token: string): Promise<void> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-imp-${rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `Test ${rol}`,
      rol,
    })
    .returning();
  userIds.push(user!.id);

  await db.insert(sesionesTable).values({
    token,
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

// Payload válido para el preview legacy: no escribe en la DB, solo simula
const PREVIEW_BODY = {
  entidad: "pacientes",
  datosJson: JSON.stringify([
    { nombre: "Test", apellido: `Importacion${RUN_ID}`, dni: `TI${RUN_ID}` },
  ]),
};

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", importacionV2Router);
  app.use("/api", importacionRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await crearUsuarioConSesion("admin", TOKEN_ADMIN);
  await crearUsuarioConSesion("recepcionista", TOKEN_RECEPCION);
  await crearUsuarioConSesion("paciente", TOKEN_PACIENTE);
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

// Endpoints de solo lectura del motor v2, sin dependencias de datos previos
const RUTAS_GET_V2 = [
  "/importacion/entidades",
  "/importacion/perfiles",
  "/importacion/jobs",
  "/importacion/campos/pacientes",
];

describe("Importación v2 — sin autenticación", () => {
  for (const ruta of RUTAS_GET_V2) {
    it(`GET ${ruta} sin token responde 401`, async () => {
      const res = await get(ruta);
      expect(res.status).toBe(401);
    });
  }

  it("GET /importacion/jobs con token inválido responde 401", async () => {
    const res = await get("/importacion/jobs", `token-inexistente-${RUN_ID}`);
    expect(res.status).toBe(401);
  });

  it("POST /importacion/jobs/1/ejecutar sin token responde 401", async () => {
    const res = await post("/importacion/jobs/1/ejecutar");
    expect(res.status).toBe(401);
  });
});

describe("Importación v2 — rol paciente bloqueado (403)", () => {
  for (const ruta of RUTAS_GET_V2) {
    it(`GET ${ruta} con rol paciente responde 403`, async () => {
      const res = await get(ruta, TOKEN_PACIENTE);
      expect(res.status).toBe(403);
    });
  }

  it("POST /importacion/jobs/1/ejecutar con rol paciente responde 403", async () => {
    const res = await post("/importacion/jobs/1/ejecutar", TOKEN_PACIENTE);
    expect(res.status).toBe(403);
  });
});

describe("Importación v2 — staff con acceso (200)", () => {
  for (const ruta of RUTAS_GET_V2) {
    it(`GET ${ruta} con rol admin responde 200`, async () => {
      const res = await get(ruta, TOKEN_ADMIN);
      expect(res.status).toBe(200);
    });
  }

  it("GET /importacion/jobs con rol recepcionista responde 200", async () => {
    const res = await get("/importacion/jobs", TOKEN_RECEPCION);
    expect(res.status).toBe(200);
  });
});

describe("Importación v1 (legacy) — mismo guard de staff", () => {
  it("POST /importacion/preview sin token responde 401", async () => {
    const res = await post("/importacion/preview");
    expect(res.status).toBe(401);
  });

  it("POST /importacion/preview con rol paciente responde 403", async () => {
    const res = await post("/importacion/preview", TOKEN_PACIENTE);
    expect(res.status).toBe(403);
  });

  it("POST /importacion/ejecutar con rol paciente responde 403", async () => {
    const res = await post("/importacion/ejecutar", TOKEN_PACIENTE);
    expect(res.status).toBe(403);
  });

  it("POST /importacion/preview con rol admin responde 200", async () => {
    const res = await post("/importacion/preview", TOKEN_ADMIN, PREVIEW_BODY);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { nuevos: number };
    expect(json.nuevos).toBe(1);
  });

  it("POST /importacion/preview con rol recepcionista responde 200", async () => {
    const res = await post("/importacion/preview", TOKEN_RECEPCION, PREVIEW_BODY);
    expect(res.status).toBe(200);
  });
});
