import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { inArray } from "drizzle-orm";
import { db, usersTable, sesionesTable } from "@workspace/db";
import authRouter, { requireRol } from "./auth";

// Tests de integración del modo "ver como" (vista de rol simulada).
// Fronteras que protege:
// - Solo un admin real puede activar la vista (403 para otros roles).
// - Con vista activa, los endpoints admin-only quedan bloqueados (el rol
//   efectivo es el simulado) y /auth/me refleja el usuario simulado.
// - rol: null vuelve al perfil real.

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

const TOKEN_ADMIN = `test-token-vista-admin-${RUN_ID}`;
const TOKEN_MEDICO = `test-token-vista-medico-${RUN_ID}`;

const userIds: number[] = [];

async function crearUsuarioConSesion(rol: string, token: string): Promise<void> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-vista-${rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `Test vista ${rol}`,
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

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof silent }).log = silent;
    next();
  });
  app.use("/api", authRouter);
  // Endpoint admin-only de prueba para verificar la frontera de permisos
  app.get("/api/solo-admin-test", requireRol("admin"), (_req, res) => {
    res.json({ ok: true });
  });

  await crearUsuarioConSesion("admin", TOKEN_ADMIN);
  await crearUsuarioConSesion("medico", TOKEN_MEDICO);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  // Asegurar que no quede vista activa en la sesión del admin de prueba
  await post("/auth/vista-rol", TOKEN_ADMIN, { rol: null });
  await db
    .delete(sesionesTable)
    .where(inArray(sesionesTable.token, [TOKEN_ADMIN, TOKEN_MEDICO]));
  if (userIds.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("modo vista de rol (ver como)", () => {
  it("un no-admin no puede activar la vista (403)", async () => {
    const res = await post("/auth/vista-rol", TOKEN_MEDICO, { rol: "paciente" });
    expect(res.status).toBe(403);
  });

  it("sin token devuelve 401", async () => {
    const res = await post("/auth/vista-rol", undefined, { rol: "medico" });
    expect(res.status).toBe(401);
  });

  it("rol inválido devuelve 400", async () => {
    const res = await post("/auth/vista-rol", TOKEN_ADMIN, { rol: "superusuario" });
    expect(res.status).toBe(400);
  });

  it("admin activa vista medico: /auth/me refleja el rol simulado y pierde acceso admin", async () => {
    const activar = await post("/auth/vista-rol", TOKEN_ADMIN, { rol: "medico" });
    expect(activar.status).toBe(200);
    const activado = (await activar.json()) as { rol: string; vistaRol: string | null };
    expect(activado.rol).toBe("medico");
    expect(activado.vistaRol).toBe("medico");

    const me = await get("/auth/me", TOKEN_ADMIN);
    expect(me.status).toBe(200);
    const meJson = (await me.json()) as {
      rol: string;
      vistaRol: string | null;
      puedeCambiarVista: boolean;
    };
    expect(meJson.rol).toBe("medico");
    expect(meJson.vistaRol).toBe("medico");
    expect(meJson.puedeCambiarVista).toBe(true);

    // Frontera: con la vista activa, los endpoints admin-only quedan bloqueados
    const adminOnly = await get("/solo-admin-test", TOKEN_ADMIN);
    expect(adminOnly.status).toBe(403);
  });

  it("con vista activa el admin real sigue pudiendo cambiar/volver (rol null)", async () => {
    const volver = await post("/auth/vista-rol", TOKEN_ADMIN, { rol: null });
    expect(volver.status).toBe(200);
    const vuelto = (await volver.json()) as { rol: string; vistaRol: string | null };
    expect(vuelto.rol).toBe("admin");
    expect(vuelto.vistaRol).toBeNull();

    const adminOnly = await get("/solo-admin-test", TOKEN_ADMIN);
    expect(adminOnly.status).toBe(200);
  });

  it("la vista de un admin no afecta a otras sesiones", async () => {
    const meMedico = await get("/auth/me", TOKEN_MEDICO);
    const j = (await meMedico.json()) as { rol: string; puedeCambiarVista: boolean };
    expect(j.rol).toBe("medico");
    expect(j.puedeCambiarVista).toBe(false);
  });
});
