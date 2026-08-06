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
  turnerasTable,
  turneraPracticasTable,
  obrasSocialesTable,
  nomencladorPracticasTable,
} from "@workspace/db";
import turnerasRouter from "./turneras";
import obrasSocialesRouter from "./obras_sociales";

// Tests de integración: prácticas del nomenclador asociadas a turneras
// y búsqueda global del nomenclador (sin obraSocialId).
// Crean sus propios datos y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN = `test-token-tpr-${RUN_ID}`;
const CODIGO_A = `TPRA${RUN_ID}`;
const CODIGO_B = `TPRB${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
const obraSocialIds: number[] = [];
const turneraIds: number[] = [];

async function api(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(init?.headers ?? {}),
    },
  });
}

const BASE_TURNERA = {
  duracionMinutos: 30,
  horaInicio: "08:00",
  horaFin: "12:00",
  modalidad: "presencial",
  diasAtencion: [1, 2],
  activa: true,
};

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", turnerasRouter);
  app.use("/api", obrasSocialesRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-tpr-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: "Test Turnera Practicas",
      rol: "admin",
    })
    .returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  // Dos obras sociales con el mismo código de práctica → la búsqueda global debe deduplicar
  for (const nombre of [`OS TPR A ${RUN_ID}`, `OS TPR B ${RUN_ID}`]) {
    const [os] = await db.insert(obrasSocialesTable).values({ nombre }).returning();
    obraSocialIds.push(os!.id);
  }
  await db.insert(nomencladorPracticasTable).values([
    {
      obraSocialId: obraSocialIds[0]!,
      codigo: CODIGO_A,
      descripcion: `Mamografia test ${RUN_ID}`,
      valorTotal: 100,
    },
    {
      obraSocialId: obraSocialIds[1]!,
      codigo: CODIGO_A,
      descripcion: `Mamografia test ${RUN_ID}`,
      valorTotal: 200,
    },
    {
      obraSocialId: obraSocialIds[0]!,
      codigo: CODIGO_B,
      descripcion: `Ecografia test ${RUN_ID}`,
      valorTotal: 150,
    },
  ]);
});

afterAll(async () => {
  if (turneraIds.length > 0) {
    await db.delete(turneraPracticasTable).where(inArray(turneraPracticasTable.turneraId, turneraIds));
    await db.delete(turnerasTable).where(inArray(turnerasTable.id, turneraIds));
  }
  if (obraSocialIds.length > 0) {
    await db
      .delete(nomencladorPracticasTable)
      .where(inArray(nomencladorPracticasTable.obraSocialId, obraSocialIds));
    await db.delete(obrasSocialesTable).where(inArray(obrasSocialesTable.id, obraSocialIds));
  }
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Prácticas por turnera", () => {
  it("POST crea con prácticas, deduplica y descarta códigos vacíos", async () => {
    const res = await api("/turneras", {
      method: "POST",
      body: JSON.stringify({
        ...BASE_TURNERA,
        nombre: `TPR POST ${RUN_ID}`,
        practicas: [
          { codigo: CODIGO_A, descripcion: "Mamografia" },
          { codigo: ` ${CODIGO_A} `, descripcion: "duplicada con espacios" },
          { codigo: "   ", descripcion: "vacía" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const t = (await res.json()) as Record<string, any>;
    turneraIds.push(t.id);
    expect(t.practicas).toEqual([{ codigo: CODIGO_A, descripcion: "Mamografia" }]);
  });

  it("GET detalle devuelve las prácticas", async () => {
    const res = await api(`/turneras/${turneraIds[0]}`);
    expect(res.status).toBe(200);
    const t = (await res.json()) as Record<string, any>;
    expect(t.practicas).toEqual([{ codigo: CODIGO_A, descripcion: "Mamografia" }]);
  });

  it("PATCH reemplaza el set de prácticas", async () => {
    const res = await api(`/turneras/${turneraIds[0]}`, {
      method: "PATCH",
      body: JSON.stringify({
        practicas: [{ codigo: CODIGO_B, descripcion: "Ecografia" }],
      }),
    });
    expect(res.status).toBe(200);
    const t = (await res.json()) as Record<string, any>;
    expect(t.practicas).toEqual([{ codigo: CODIGO_B, descripcion: "Ecografia" }]);

    const filas = await db
      .select()
      .from(turneraPracticasTable)
      .where(eq(turneraPracticasTable.turneraId, turneraIds[0]!));
    expect(filas).toHaveLength(1);
    expect(filas[0]!.codigo).toBe(CODIGO_B);
  });

  it("PATCH sin campo practicas no toca las existentes", async () => {
    const res = await api(`/turneras/${turneraIds[0]}`, {
      method: "PATCH",
      body: JSON.stringify({ nombre: `TPR renombrada ${RUN_ID}` }),
    });
    expect(res.status).toBe(200);
    const t = (await res.json()) as Record<string, any>;
    expect(t.practicas).toEqual([{ codigo: CODIGO_B, descripcion: "Ecografia" }]);
  });

  it("DELETE elimina la turnera y sus prácticas asociadas", async () => {
    const res = await api(`/turneras/${turneraIds[0]}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const filas = await db
      .select()
      .from(turneraPracticasTable)
      .where(eq(turneraPracticasTable.turneraId, turneraIds[0]!));
    expect(filas).toHaveLength(0);
    turneraIds.length = 0;
  });
});

describe("Nomenclador búsqueda global (sin obraSocialId)", () => {
  it("devuelve resultados deduplicados por código", async () => {
    const res = await api(`/nomenclador?buscar=${CODIGO_A}&limite=10`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { total: number; practicas: { codigo: string }[] };
    const coincidencias = data.practicas.filter((p) => p.codigo === CODIGO_A);
    expect(coincidencias).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  it("modo por obra social sigue funcionando", async () => {
    const res = await api(`/nomenclador?obraSocialId=${obraSocialIds[0]}&buscar=test ${RUN_ID}&limite=10`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { total: number; practicas: { codigo: string }[] };
    const codigos = data.practicas.map((p) => p.codigo).sort();
    expect(codigos).toEqual([CODIGO_A, CODIGO_B].sort());
  });
});
