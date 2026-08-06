import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  profesionalesTable,
  informePlantillasTable,
} from "@workspace/db";
import informesRouter from "./informes";

// Aislamiento de plantillas de informe: son personales de cada médico.
// - Médico A no ve ni puede borrar plantillas de médico B.
// - Recepcionista/admin no acceden a los endpoints (solo rol medico).

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;
let profAId: number;
let profBId: number;
let plantillaBId: number;

const TOKEN_MEDICO_A = `test-token-pla-a-${RUN_ID}`;
const TOKEN_MEDICO_B = `test-token-pla-b-${RUN_ID}`;
const TOKEN_RECEPCION = `test-token-pla-r-${RUN_ID}`;

const userIds: number[] = [];

async function crearUsuarioConSesion(opts: {
  rol: string;
  token: string;
  profesionalId?: number;
}): Promise<void> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-pla-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `Test ${opts.rol}`,
      rol: opts.rol,
      profesionalId: opts.profesionalId !== undefined ? String(opts.profesionalId) : undefined,
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

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

beforeAll(async () => {
  const profs = await db
    .insert(profesionalesTable)
    .values([
      { nombre: "PlaA", apellido: `Test${RUN_ID}` },
      { nombre: "PlaB", apellido: `Test${RUN_ID}` },
    ])
    .returning({ id: profesionalesTable.id });
  profAId = profs[0]!.id;
  profBId = profs[1]!.id;

  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO_A, profesionalId: profAId });
  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO_B, profesionalId: profBId });
  await crearUsuarioConSesion({ rol: "recepcionista", token: TOKEN_RECEPCION });

  const [plB] = await db
    .insert(informePlantillasTable)
    .values({ profesionalId: profBId, nombre: `Privada B ${RUN_ID}`, texto: "texto de B" })
    .returning({ id: informePlantillasTable.id });
  plantillaBId = plB!.id;

  const app = express();
  app.use(express.json());
  app.use("/api", informesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await db.delete(informePlantillasTable).where(
    inArray(informePlantillasTable.profesionalId, [profAId, profBId]),
  );
  if (userIds.length) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await db.delete(profesionalesTable).where(inArray(profesionalesTable.id, [profAId, profBId]));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("aislamiento de plantillas de informe", () => {
  it("médico A no ve las plantillas de B", async () => {
    const r = await fetch(`${baseUrl}/api/informe-plantillas`, { headers: headers(TOKEN_MEDICO_A) });
    expect(r.status).toBe(200);
    const lista = (await r.json()) as { id: number }[];
    expect(lista.some((p) => p.id === plantillaBId)).toBe(false);
  });

  it("médico A crea una plantilla y solo él la ve", async () => {
    const rc = await fetch(`${baseUrl}/api/informe-plantillas`, {
      method: "POST",
      headers: headers(TOKEN_MEDICO_A),
      body: JSON.stringify({ nombre: `Mía A ${RUN_ID}`, texto: "texto de A" }),
    });
    expect(rc.status).toBe(201);
    const creada = (await rc.json()) as { id: number; profesionalId: number };
    expect(creada.profesionalId).toBe(profAId);

    const rb = await fetch(`${baseUrl}/api/informe-plantillas`, { headers: headers(TOKEN_MEDICO_B) });
    const listaB = (await rb.json()) as { id: number }[];
    expect(listaB.some((p) => p.id === creada.id)).toBe(false);
  });

  it("médico A no puede borrar la plantilla de B (404)", async () => {
    const r = await fetch(`${baseUrl}/api/informe-plantillas/${plantillaBId}`, {
      method: "DELETE",
      headers: headers(TOKEN_MEDICO_A),
    });
    expect(r.status).toBe(404);
    const [sigue] = await db
      .select({ id: informePlantillasTable.id })
      .from(informePlantillasTable)
      .where(eq(informePlantillasTable.id, plantillaBId));
    expect(sigue?.id).toBe(plantillaBId);
  });

  it("recepcionista no accede a plantillas (403)", async () => {
    const r = await fetch(`${baseUrl}/api/informe-plantillas`, { headers: headers(TOKEN_RECEPCION) });
    expect(r.status).toBe(403);
  });

  it("sin token: 401", async () => {
    const r = await fetch(`${baseUrl}/api/informe-plantillas`);
    expect(r.status).toBe(401);
  });
});
