import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { eq, like } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  sedesTable,
  turnerasTable,
  configSistemaTable,
} from "@workspace/db";
import salaEsperaRouter from "./sala_espera";

// Ciclo de vinculación de TV por código corto: generar → canjear → consumir.
// Tests de integración contra la DB de desarrollo; crean y limpian sus datos.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TEST_EMAIL = `test-tv-${RUN_ID}@test.local`;
const TOKEN = `test-token-tv-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let sedeId: number;
let turneraId: number;
const codigosCreados: string[] = [];

async function crearCodigo(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sala-espera/tv/codigo`, { method: "POST" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { codigo: string; expiraEn: string };
  expect(body.codigo).toMatch(/^[A-Z0-9]{6}$/);
  codigosCreados.push(body.codigo);
  return body.codigo;
}

function canjear(codigo: string, data: unknown, token?: string) {
  return fetch(`${baseUrl}/api/sala-espera/tv/codigo/${codigo}/canjear`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(data),
  });
}

beforeAll(async () => {
  const app = express();
  const pino = (await import("pino")).default;
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof silent }).log = silent;
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

  const [user] = await db
    .insert(usersTable)
    .values({
      email: TEST_EMAIL,
      passwordHash: "irrelevante",
      nombre: "Test Recepción TV",
      rol: "recepcionista",
    })
    .returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [sede] = await db
    .insert(sedesTable)
    .values({ nombre: `Sede TV Test ${RUN_ID}` })
    .returning();
  sedeId = sede!.id;
  const [turnera] = await db
    .insert(turnerasTable)
    .values({ nombre: `Guardia TV Test ${RUN_ID}`, sedeId, esGuardia: true })
    .returning();
  turneraId = turnera!.id;
});

afterAll(async () => {
  await db
    .delete(configSistemaTable)
    .where(like(configSistemaTable.clave, "tv_vinculo_%"))
    .catch(() => {});
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(sedesTable).where(eq(sedesTable.id, sedeId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("vinculación de TV por código corto", () => {
  it("genera un código pendiente consultable por la TV", async () => {
    const codigo = await crearCodigo();
    const res = await fetch(`${baseUrl}/api/sala-espera/tv/codigo/${codigo}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; sedeId: number | null; turneraId: number | null };
    expect(body.estado).toBe("pendiente");
    expect(body.sedeId).toBeNull();
    expect(body.turneraId).toBeNull();
  });

  it("ciclo completo: canjear por sede y consumir una sola vez", async () => {
    const codigo = await crearCodigo();
    const canje = await canjear(codigo, { sedeId }, TOKEN);
    expect(canje.status).toBe(200);

    // La TV recibe la asignación y el código queda consumido
    const res = await fetch(`${baseUrl}/api/sala-espera/tv/codigo/${codigo}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; sedeId: number | null; turneraId: number | null };
    expect(body.estado).toBe("asignado");
    expect(body.sedeId).toBe(sedeId);
    expect(body.turneraId).toBeNull();

    const otraVez = await fetch(`${baseUrl}/api/sala-espera/tv/codigo/${codigo}`);
    expect(otraVez.status).toBe(404);
  });

  it("canjea por turnera (guardia) con prioridad sobre la sede", async () => {
    const codigo = await crearCodigo();
    const canje = await canjear(codigo, { turneraId, sedeId }, TOKEN);
    expect(canje.status).toBe(200);
    const body = (await (await fetch(`${baseUrl}/api/sala-espera/tv/codigo/${codigo}`)).json()) as { estado: string; sedeId: number | null; turneraId: number | null };
    expect(body.estado).toBe("asignado");
    expect(body.turneraId).toBe(turneraId);
    expect(body.sedeId).toBeNull();
  });

  it("canjea sin destino = todas las sedes", async () => {
    const codigo = await crearCodigo();
    expect((await canjear(codigo, {}, TOKEN)).status).toBe(200);
    const body = (await (await fetch(`${baseUrl}/api/sala-espera/tv/codigo/${codigo}`)).json()) as { estado: string; sedeId: number | null; turneraId: number | null };
    expect(body.estado).toBe("asignado");
    expect(body.sedeId).toBeNull();
    expect(body.turneraId).toBeNull();
  });

  it("rechaza el canje sin autenticación", async () => {
    const codigo = await crearCodigo();
    expect((await canjear(codigo, { sedeId })).status).toBe(401);
  });

  it("rechaza códigos inválidos o inexistentes", async () => {
    expect((await fetch(`${baseUrl}/api/sala-espera/tv/codigo/NOEXIS`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/sala-espera/tv/codigo/malo!!`)).status).toBe(404);
    expect((await canjear("NOEXIS", { sedeId }, TOKEN)).status).toBe(404);
  });

  it("rechaza un canje con destino inexistente", async () => {
    const codigo = await crearCodigo();
    expect((await canjear(codigo, { sedeId: 99999999 }, TOKEN)).status).toBe(400);
    expect((await canjear(codigo, { turneraId: 99999999 }, TOKEN)).status).toBe(400);
  });

  it("no permite canjear dos veces el mismo código", async () => {
    const codigo = await crearCodigo();
    expect((await canjear(codigo, { sedeId }, TOKEN)).status).toBe(200);
    expect((await canjear(codigo, { sedeId }, TOKEN)).status).toBe(409);
  });

  it("un código vencido devuelve 404 y se elimina", async () => {
    const codigo = await crearCodigo();
    // Forzar la expiración editando el registro directamente
    const vencido = JSON.stringify({
      estado: "pendiente",
      expiraEn: new Date(Date.now() - 60_000).toISOString(),
    });
    await db
      .update(configSistemaTable)
      .set({ valor: vencido })
      .where(eq(configSistemaTable.clave, `tv_vinculo_${codigo}`));

    expect((await fetch(`${baseUrl}/api/sala-espera/tv/codigo/${codigo}`)).status).toBe(404);
    // El registro vencido fue borrado
    const filas = await db
      .select({ clave: configSistemaTable.clave })
      .from(configSistemaTable)
      .where(eq(configSistemaTable.clave, `tv_vinculo_${codigo}`));
    expect(filas.length).toBe(0);
  });

  it("tampoco deja canjear un código vencido", async () => {
    const codigo = await crearCodigo();
    const vencido = JSON.stringify({
      estado: "pendiente",
      expiraEn: new Date(Date.now() - 60_000).toISOString(),
    });
    await db
      .update(configSistemaTable)
      .set({ valor: vencido })
      .where(eq(configSistemaTable.clave, `tv_vinculo_${codigo}`));
    expect((await canjear(codigo, { sedeId }, TOKEN)).status).toBe(404);
  });
});
