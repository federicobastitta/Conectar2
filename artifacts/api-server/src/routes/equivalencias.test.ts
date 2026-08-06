import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  obrasSocialesTable,
  nomencladorPracticasTable,
  equivalenciasTable,
} from "@workspace/db";
import equivalenciasRouter from "./equivalencias";

// Tests de integración del módulo Equivalencias (cobro obra social / pago profesional).
// Crean sus propios datos (usuarios, sesiones, obra social, práctica del nomenclador)
// y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;
let obraSocialId: number;

const TOKEN_ADMIN = `test-token-eq-admin-${RUN_ID}`;
const TOKEN_PACIENTE = `test-token-eq-pac-${RUN_ID}`;
const CODIGO_NOM = `EQNOM${RUN_ID}`;
const userIds: number[] = [];

async function crearUsuarioConSesion(rol: string, token: string): Promise<void> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-eq-${rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
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

function req(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((r, _res, next) => {
    (r as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", equivalenciasRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await crearUsuarioConSesion("admin", TOKEN_ADMIN);
  await crearUsuarioConSesion("paciente", TOKEN_PACIENTE);

  const [os] = await db
    .insert(obrasSocialesTable)
    .values({ nombre: `Test OS Equivalencias ${RUN_ID}` })
    .returning();
  obraSocialId = os!.id;

  await db.insert(nomencladorPracticasTable).values({
    obraSocialId,
    codigo: CODIGO_NOM,
    descripcion: "Práctica de prueba equivalencias",
    valorTotal: 10000,
  });
});

afterAll(async () => {
  await db.delete(obrasSocialesTable).where(eq(obrasSocialesTable.id, obraSocialId)); // cascade borra nomenclador y equivalencias
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("Equivalencias — autorización", () => {
  it("401 sin token", async () => {
    const res = await req("GET", `/equivalencias?obraSocialId=${obraSocialId}`);
    expect(res.status).toBe(401);
  });

  it("403 con rol paciente", async () => {
    const res = await req("GET", `/equivalencias?obraSocialId=${obraSocialId}`, TOKEN_PACIENTE);
    expect(res.status).toBe(403);
  });
});

describe("Equivalencias — CRUD y cálculos", () => {
  it("crea con pago fijo y cobro propio", async () => {
    const res = await req("POST", "/equivalencias", TOKEN_ADMIN, {
      obraSocialId,
      codigo: `EQFIJO${RUN_ID}`,
      descripcion: "Fija",
      cobroObraSocial: 20000,
      pagoTipo: "fijo",
      pagoValor: 8000,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, number>;
    expect(body.cobroEfectivo).toBe(20000);
    expect(body.pagoCalculado).toBe(8000);
  });

  it("crea con porcentaje y toma el valor del nomenclador como cobro", async () => {
    const res = await req("POST", "/equivalencias", TOKEN_ADMIN, {
      obraSocialId,
      codigo: CODIGO_NOM,
      pagoTipo: "porcentaje",
      pagoValor: 40,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, number>;
    expect(body.valorNomenclador).toBe(10000);
    expect(body.cobroEfectivo).toBe(10000);
    expect(body.pagoCalculado).toBe(4000);
  });

  it("repetir el mismo código hace upsert (no duplica)", async () => {
    const res = await req("POST", "/equivalencias", TOKEN_ADMIN, {
      obraSocialId,
      codigo: CODIGO_NOM,
      pagoTipo: "porcentaje",
      pagoValor: 50,
    });
    expect(res.status).toBe(201);
    const filas = await db
      .select()
      .from(equivalenciasTable)
      .where(eq(equivalenciasTable.obraSocialId, obraSocialId));
    const delCodigo = filas.filter((f) => f.codigo === CODIGO_NOM);
    expect(delCodigo).toHaveLength(1);
    expect(delCodigo[0]!.pagoValor).toBe(50);
  });

  it("rechaza valores inválidos (negativo y porcentaje > 100)", async () => {
    const neg = await req("POST", "/equivalencias", TOKEN_ADMIN, {
      obraSocialId,
      codigo: `EQNEG${RUN_ID}`,
      pagoTipo: "fijo",
      pagoValor: -5,
    });
    expect(neg.status).toBe(400);
    const pct = await req("POST", "/equivalencias", TOKEN_ADMIN, {
      obraSocialId,
      codigo: `EQPCT${RUN_ID}`,
      pagoTipo: "porcentaje",
      pagoValor: 150,
    });
    expect(pct.status).toBe(400);
  });

  it("PATCH actualiza y recalcula, DELETE elimina", async () => {
    const lista = (await (
      await req("GET", `/equivalencias?obraSocialId=${obraSocialId}&buscar=EQFIJO`, TOKEN_ADMIN)
    ).json()) as { total: number; equivalencias: { id: number }[] };
    expect(lista.total).toBe(1);
    const id = lista.equivalencias[0].id;

    const patch = await req("PATCH", `/equivalencias/${id}`, TOKEN_ADMIN, {
      pagoTipo: "porcentaje",
      pagoValor: 25,
    });
    expect(patch.status).toBe(200);
    const actualizado = (await patch.json()) as Record<string, number>;
    expect(actualizado.pagoCalculado).toBe(5000); // 25% de 20000

    const del = await req("DELETE", `/equivalencias/${id}`, TOKEN_ADMIN);
    expect(del.status).toBe(204);
    const del2 = await req("DELETE", `/equivalencias/${id}`, TOKEN_ADMIN);
    expect(del2.status).toBe(404);
  });
});
