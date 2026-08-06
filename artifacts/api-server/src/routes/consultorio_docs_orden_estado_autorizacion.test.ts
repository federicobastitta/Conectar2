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
  profesionalesTable,
  studyOrdersTable,
  auditLogTable,
} from "@workspace/db";
import consultorioDocsRouter from "./consultorio_docs";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuarios, sesiones, paciente, dos profesionales y órdenes de estudio) y los
// limpian al terminar (audit_log por usuarioId).
//
// Verifican la autorización fina de:
//   PATCH /api/consultorio/study-orders/:id/estado
//
// Reglas cubiertas:
// - 401 sin token / token inválido
// - el médico dueño puede avanzar su propia orden (200)
// - un médico distinto recibe 403 al operar una orden ajena
// - recepción recibe 403 al intentar un estado clínico y 200 en uno logístico
// - una transición inválida devuelve 422 con transicionesValidas
// - admin puede operar cualquier orden y cualquier estado

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let pacienteId: number;
let profAId: number;
let profBId: number;

const TOKEN_ADMIN = `test-token-oea-admin-${RUN_ID}`;
const TOKEN_MEDICO_A = `test-token-oea-medA-${RUN_ID}`;
const TOKEN_MEDICO_B = `test-token-oea-medB-${RUN_ID}`;
const TOKEN_RECEPCION = `test-token-oea-recep-${RUN_ID}`;

const userIds: number[] = [];
const ordenIds: number[] = [];

async function crearUsuarioConSesion(opts: {
  rol: string;
  token: string;
  profesionalId?: number;
}): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-oea-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
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
  return user!.id;
}

let createdBy: number;

// Crea una orden de estudio del profesional A en el estado indicado.
async function crearOrden(status: string, professionalId = profAId): Promise<number> {
  const [orden] = await db
    .insert(studyOrdersTable)
    .values({
      patientId: pacienteId,
      professionalId,
      studyName: `Estudio-${status}-${crypto.randomBytes(3).toString("hex")}-${RUN_ID}`,
      status,
      createdBy,
    })
    .returning();
  ordenIds.push(orden!.id);
  return orden!.id;
}

function patchEstado(id: number, estado: string, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/consultorio/study-orders/${id}/estado`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ estado }),
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
  app.use("/api", consultorioDocsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [paciente] = await db
    .insert(pacientesTable)
    .values({ nombre: "Orden", apellido: `EstadoAuth${RUN_ID}`, dni: `OEA${RUN_ID}`, activo: true })
    .returning();
  pacienteId = paciente!.id;

  const [profA] = await db
    .insert(profesionalesTable)
    .values({ nombre: "ProfA", apellido: `OEA${RUN_ID}`, matricula: `MPOEA-A-${RUN_ID}`, activo: true })
    .returning();
  profAId = profA!.id;

  const [profB] = await db
    .insert(profesionalesTable)
    .values({ nombre: "ProfB", apellido: `OEA${RUN_ID}`, matricula: `MPOEA-B-${RUN_ID}`, activo: true })
    .returning();
  profBId = profB!.id;

  createdBy = await crearUsuarioConSesion({ rol: "admin", token: TOKEN_ADMIN });
  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO_A, profesionalId: profAId });
  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO_B, profesionalId: profBId });
  await crearUsuarioConSesion({ rol: "recepcionista", token: TOKEN_RECEPCION });
});

afterAll(async () => {
  if (userIds.length > 0)
    await db.delete(auditLogTable).where(inArray(auditLogTable.usuarioId, userIds));
  if (ordenIds.length > 0)
    await db.delete(studyOrdersTable).where(inArray(studyOrdersTable.id, ordenIds));
  await db.delete(profesionalesTable).where(inArray(profesionalesTable.id, [profAId, profBId]));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("PATCH /api/consultorio/study-orders/:id/estado — autenticación", () => {
  it("sin token responde 401", async () => {
    const id = await crearOrden("solicitado");
    const res = await patchEstado(id, "pendiente_programacion");
    expect(res.status).toBe(401);
  });

  it("con token inválido responde 401", async () => {
    const id = await crearOrden("solicitado");
    const res = await patchEstado(id, "pendiente_programacion", `token-inexistente-${RUN_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/consultorio/study-orders/:id/estado — dueño de la orden (medico)", () => {
  it("el médico dueño puede avanzar su propia orden (200)", async () => {
    const id = await crearOrden("solicitado", profAId);
    const res = await patchEstado(id, "pendiente_programacion", TOKEN_MEDICO_A);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("pendiente_programacion");
  });

  it("un médico distinto recibe 403 sobre una orden ajena", async () => {
    const id = await crearOrden("solicitado", profAId);
    const res = await patchEstado(id, "pendiente_programacion", TOKEN_MEDICO_B);
    expect(res.status).toBe(403);

    // La orden no debe haber cambiado de estado
    const [orden] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, id)).limit(1);
    expect(orden!.status).toBe("solicitado");
  });
});

describe("PATCH /api/consultorio/study-orders/:id/estado — recepción", () => {
  it("recepción recibe 403 al intentar un estado clínico (en_realizacion)", async () => {
    const id = await crearOrden("programado", profAId);
    const res = await patchEstado(id, "en_realizacion", TOKEN_RECEPCION);
    expect(res.status).toBe(403);

    const [orden] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, id)).limit(1);
    expect(orden!.status).toBe("programado");
  });

  it("recepción puede setear un estado logístico válido (200)", async () => {
    const id = await crearOrden("solicitado", profAId);
    const res = await patchEstado(id, "programado", TOKEN_RECEPCION);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("programado");
  });
});

describe("PATCH /api/consultorio/study-orders/:id/estado — transiciones y admin", () => {
  it("una transición inválida devuelve 422 con transicionesValidas", async () => {
    const id = await crearOrden("solicitado", profAId);
    const res = await patchEstado(id, "informado", TOKEN_ADMIN);
    expect(res.status).toBe(422);
    const data = (await res.json()) as { transicionesValidas: string[] };
    expect(Array.isArray(data.transicionesValidas)).toBe(true);
    expect(data.transicionesValidas).toEqual(["pendiente_programacion", "programado", "anulada"]);
  });

  it("admin puede operar cualquier orden y avanzar un estado clínico (200)", async () => {
    const id = await crearOrden("en_realizacion", profAId);
    const res = await patchEstado(id, "realizado", TOKEN_ADMIN);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("realizado");
  });
});
