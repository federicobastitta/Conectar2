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
  studyOrdersFirmaLogTable,
  practicasCatalogoTable,
  auditLogTable,
} from "@workspace/db";
import consultorioDocsRouter from "./consultorio_docs";

// Tests de integración del circuito de aprobación y firma de planillas IOMA.
// Crean sus propios datos (RUN_ID) y los limpian al terminar.
//
// Reglas cubiertas:
// - 401 sin token
// - SOLO el médico prescriptor puede firmar: otro médico 403, admin 403,
//   recepcionista 403
// - firmar registra evento inmutable con hash y deja firmaEstado=firmada
// - re-firmar una planilla ya firmada devuelve 409
// - una orden sin planilla (sin practicaId) devuelve 422
// - rechazar exige motivo y deja firmaEstado=rechazada
// - nueva versión: crea orden pendiente v+1 enlazada y marca la anterior
//   como reemplazada; una reemplazada no admite otra nueva versión
// - pendientes-firma solo lista las planillas pendientes del propio médico

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let pacienteId: number;
let profAId: number;
let profBId: number;
let practicaId: number;

const TOKEN_ADMIN = `test-token-fpl-admin-${RUN_ID}`;
const TOKEN_MEDICO_A = `test-token-fpl-medA-${RUN_ID}`;
const TOKEN_MEDICO_B = `test-token-fpl-medB-${RUN_ID}`;
const TOKEN_RECEPCION = `test-token-fpl-recep-${RUN_ID}`;

const userIds: number[] = [];
const ordenIds: number[] = [];
let createdBy: number;

async function crearUsuarioConSesion(opts: { rol: string; token: string; profesionalId?: number }): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-fpl-${opts.rol}-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
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

async function crearOrdenPlanilla(professionalId = profAId, conPractica = true): Promise<number> {
  const [orden] = await db
    .insert(studyOrdersTable)
    .values({
      patientId: pacienteId,
      professionalId,
      studyName: `Planilla-${crypto.randomBytes(3).toString("hex")}-${RUN_ID}`,
      status: "solicitado",
      practicaId: conPractica ? practicaId : null,
      createdBy,
    })
    .returning();
  ordenIds.push(orden!.id);
  return orden!.id;
}

function post(path: string, token?: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
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
    .values({ nombre: "Firma", apellido: `Planilla${RUN_ID}`, dni: `FPL${RUN_ID}`, activo: true })
    .returning();
  pacienteId = paciente!.id;

  const [profA] = await db
    .insert(profesionalesTable)
    .values({ nombre: "ProfA", apellido: `FPL${RUN_ID}`, matricula: `MPFPL-A-${RUN_ID}`, activo: true })
    .returning();
  profAId = profA!.id;

  const [profB] = await db
    .insert(profesionalesTable)
    .values({ nombre: "ProfB", apellido: `FPL${RUN_ID}`, matricula: `MPFPL-B-${RUN_ID}`, activo: true })
    .returning();
  profBId = profB!.id;

  const [practica] = await db
    .insert(practicasCatalogoTable)
    .values({
      nombre: `Practica FPL ${RUN_ID}`,
      codigo: `FPL-${RUN_ID}`,
      categoria: "resonancia",
      activo: true,
    })
    .returning();
  practicaId = practica!.id;

  createdBy = await crearUsuarioConSesion({ rol: "admin", token: TOKEN_ADMIN });
  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO_A, profesionalId: profAId });
  await crearUsuarioConSesion({ rol: "medico", token: TOKEN_MEDICO_B, profesionalId: profBId });
  await crearUsuarioConSesion({ rol: "recepcionista", token: TOKEN_RECEPCION });
});

afterAll(async () => {
  if (userIds.length > 0)
    await db.delete(auditLogTable).where(inArray(auditLogTable.usuarioId, userIds));
  if (ordenIds.length > 0) {
    await db.delete(studyOrdersFirmaLogTable).where(inArray(studyOrdersFirmaLogTable.orderId, ordenIds));
    await db.delete(studyOrdersTable).where(inArray(studyOrdersTable.id, ordenIds));
  }
  await db.delete(practicasCatalogoTable).where(eq(practicasCatalogoTable.id, practicaId));
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

describe("firma de planillas IOMA — permisos", () => {
  it("401 sin token", async () => {
    const id = await crearOrdenPlanilla();
    const res = await post(`/consultorio/study-orders/${id}/firmar`);
    expect(res.status).toBe(401);
  });

  it("otro médico NO puede firmar (403)", async () => {
    const id = await crearOrdenPlanilla();
    const res = await post(`/consultorio/study-orders/${id}/firmar`, TOKEN_MEDICO_B);
    expect(res.status).toBe(403);
  });

  it("admin NO puede firmar (403)", async () => {
    const id = await crearOrdenPlanilla();
    const res = await post(`/consultorio/study-orders/${id}/firmar`, TOKEN_ADMIN);
    expect(res.status).toBe(403);
  });

  it("recepcionista NO puede firmar (403)", async () => {
    const id = await crearOrdenPlanilla();
    const res = await post(`/consultorio/study-orders/${id}/firmar`, TOKEN_RECEPCION);
    expect(res.status).toBe(403);
  });

  it("orden sin planilla IOMA devuelve 422", async () => {
    const id = await crearOrdenPlanilla(profAId, false);
    const res = await post(`/consultorio/study-orders/${id}/firmar`, TOKEN_MEDICO_A);
    expect(res.status).toBe(422);
  });
});

describe("firma de planillas IOMA — circuito", () => {
  it("el prescriptor firma, queda hash y evento inmutable; re-firmar da 409", async () => {
    const id = await crearOrdenPlanilla();
    const res = await post(`/consultorio/study-orders/${id}/firmar`, TOKEN_MEDICO_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { firmaEstado: string; firmaHash: string | null; firmadoEn: string | null };
    expect(body.firmaEstado).toBe("firmada");
    expect(body.firmaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.firmadoEn).toBeTruthy();

    const eventos = await db
      .select()
      .from(studyOrdersFirmaLogTable)
      .where(eq(studyOrdersFirmaLogTable.orderId, id));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.accion).toBe("firmada");
    expect(eventos[0]!.estadoAnterior).toBe("pendiente_firma");
    expect(eventos[0]!.estadoNuevo).toBe("firmada");
    expect(eventos[0]!.hash).toBe(body.firmaHash);
    expect(eventos[0]!.profesionalId).toBe(profAId);

    const re = await post(`/consultorio/study-orders/${id}/firmar`, TOKEN_MEDICO_A);
    expect(re.status).toBe(409);
  });

  it("rechazar exige motivo y deja la planilla rechazada", async () => {
    const id = await crearOrdenPlanilla();
    const sinMotivo = await post(`/consultorio/study-orders/${id}/rechazar-firma`, TOKEN_MEDICO_A, { motivo: "no" });
    expect(sinMotivo.status).toBe(400);

    const res = await post(`/consultorio/study-orders/${id}/rechazar-firma`, TOKEN_MEDICO_A, { motivo: "faltan estudios previos" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { firmaEstado: string; firmaMotivoRechazo: string | null };
    expect(body.firmaEstado).toBe("rechazada");
    expect(body.firmaMotivoRechazo).toBe("faltan estudios previos");

    // ya no se puede firmar
    const firmar = await post(`/consultorio/study-orders/${id}/firmar`, TOKEN_MEDICO_A);
    expect(firmar.status).toBe(409);
  });

  it("nueva versión: crea v+1, marca la anterior como reemplazada y no se repite", async () => {
    const id = await crearOrdenPlanilla();
    await post(`/consultorio/study-orders/${id}/firmar`, TOKEN_MEDICO_A);

    const res = await post(`/consultorio/study-orders/${id}/nueva-version`, TOKEN_MEDICO_A, { observations: "corregida" });
    expect(res.status).toBe(201);
    const nueva = (await res.json()) as { id: number; firmaEstado: string; firmaVersion: number; reemplazaOrdenId: number | null };
    ordenIds.push(nueva.id);
    // Firma automática (ago 2026): el prescriptor real que corrige su propia
    // orden la emite ya firmada; un admin la dejaría pendiente_firma.
    expect(nueva.firmaEstado).toBe("firmada");
    expect(nueva.firmaVersion).toBe(2);
    expect(nueva.reemplazaOrdenId).toBe(id);

    const [vieja] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, id));
    expect(vieja!.firmaEstado).toBe("reemplazada");

    const repetida = await post(`/consultorio/study-orders/${id}/nueva-version`, TOKEN_MEDICO_A, {});
    expect(repetida.status).toBe(409);
  });

  it("otro médico no puede crear nueva versión de una orden ajena (403)", async () => {
    const id = await crearOrdenPlanilla();
    const res = await post(`/consultorio/study-orders/${id}/nueva-version`, TOKEN_MEDICO_B, {});
    expect(res.status).toBe(403);
  });

  it("pendientes-firma lista solo las planillas pendientes del propio médico", async () => {
    const propia = await crearOrdenPlanilla(profAId);
    const ajena = await crearOrdenPlanilla(profBId);

    const res = await fetch(`${baseUrl}/api/consultorio/study-orders/pendientes-firma`, {
      headers: { Authorization: `Bearer ${TOKEN_MEDICO_A}` },
    });
    expect(res.status).toBe(200);
    const lista = (await res.json()) as Array<{ orden: { id: number } }>;
    const ids = lista.map((i) => i.orden.id);
    expect(ids).toContain(propia);
    expect(ids).not.toContain(ajena);

    const admin = await fetch(`${baseUrl}/api/consultorio/study-orders/pendientes-firma`, {
      headers: { Authorization: `Bearer ${TOKEN_ADMIN}` },
    });
    expect(admin.status).toBe(403);
  });
});
