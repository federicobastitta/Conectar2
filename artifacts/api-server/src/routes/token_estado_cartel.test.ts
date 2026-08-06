import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  turnerasTable,
  turnosTable,
  auditLogTable,
  consultasTokenTable,
} from "@workspace/db";
import salaEsperaRouter from "./sala_espera";
import { hoyArgentina } from "../lib/tiempo";

// Regla única de verdad (2-ago-2026, incidente del cartel verde falso):
// el frontend decide el cartel EXCLUSIVAMENTE con el estado persistido
// (tokenEstado + nroBono) que devuelve GET /turnos/:id/ingreso-consulta.
// Estos tests fijan el contrato: un token guardado SIN bono nunca puede
// cumplir la condición de éxito (ACCEPTED + bono no vacío).

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TEST_EMAIL = `test-token-cartel-${RUN_ID}@test.local`;
const TOKEN = `test-token-tc-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let pacienteId: number;
let turneraId: number;
let turnoId: number;

async function api(path: string) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// La condición EXACTA que usa el frontend para el cartel verde.
function showSuccess(j: Record<string, unknown>): boolean {
  return Boolean(j.token && j.tokenEstado === "ACCEPTED" && j.nroBono);
}

async function setEstadoToken(campos: Partial<typeof consultasTokenTable.$inferInsert>) {
  await db
    .insert(consultasTokenTable)
    .values({ consultationId: turnoId, tokenStatus: "PENDING", ...campos })
    .onConflictDoUpdate({
      target: consultasTokenTable.consultationId,
      set: { tokenStatus: campos.tokenStatus, authorizationNumber: campos.authorizationNumber ?? null },
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
  app.use("/api", salaEsperaRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [user] = await db
    .insert(usersTable)
    .values({ email: TEST_EMAIL, passwordHash: "x", nombre: "Recep TC", rol: "recepcionista" })
    .returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const [pac] = await db
    .insert(pacientesTable)
    .values({ nombre: "Norma", apellido: `Cartel${RUN_ID}`, dni: `7${crypto.randomInt(1000000, 9999999)}`, activo: true })
    .returning();
  pacienteId = pac!.id;
  const [turnera] = await db
    .insert(turnerasTable)
    .values({ nombre: `Consultorio TC ${RUN_ID}`, klinicosSector: "CONSULTORIO", activa: false })
    .returning();
  turneraId = turnera!.id;
  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      cobertura: "IOMA",
      fecha: hoyArgentina(),
      horaInicio: "07:30",
      horaFin: "07:50",
      estado: "en_sala",
      // Token guardado en el turno: la situación exacta del falso positivo.
      klinicosToken: "999888",
    })
    .returning();
  turnoId = turno!.id;
});

afterAll(async () => {
  await db.delete(auditLogTable).where(eq(auditLogTable.usuarioId, userId));
  await db.delete(consultasTokenTable).where(eq(consultasTokenTable.consultationId, turnoId));
  await db.delete(turnosTable).where(eq(turnosTable.id, turnoId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("cartel del token: solo el estado persistido decide", () => {
  it("token guardado SIN fila de validación → sin verde (tokenEstado null)", async () => {
    const r = await api(`/turnos/${turnoId}/ingreso-consulta`);
    expect(r.status).toBe(200);
    expect(r.json.token).toBe("999888");
    expect(r.json.tokenEstado ?? null).toBeNull();
    expect(showSuccess(r.json)).toBe(false);
  });

  it("error técnico persistido → sin verde", async () => {
    await setEstadoToken({ tokenStatus: "TECHNICAL_ERROR" });
    const r = await api(`/turnos/${turnoId}/ingreso-consulta`);
    expect(r.json.tokenEstado).toBe("TECHNICAL_ERROR");
    expect(showSuccess(r.json)).toBe(false);
  });

  it("MANUAL_REVIEW persistido → sin verde", async () => {
    await setEstadoToken({ tokenStatus: "MANUAL_REVIEW" });
    const r = await api(`/turnos/${turnoId}/ingreso-consulta`);
    expect(r.json.tokenEstado).toBe("MANUAL_REVIEW");
    expect(showSuccess(r.json)).toBe(false);
  });

  it("ACCEPTED pero SIN bono (consulta CONFIRMADA sin autorizar) → sin verde", async () => {
    await setEstadoToken({ tokenStatus: "ACCEPTED", authorizationNumber: null });
    const r = await api(`/turnos/${turnoId}/ingreso-consulta`);
    expect(r.json.tokenEstado).toBe("ACCEPTED");
    expect(r.json.nroBono ?? null).toBeNull();
    expect(showSuccess(r.json)).toBe(false);
  });

  it("DENIED (rechazo explícito) → sin verde, estado rojo disponible", async () => {
    await setEstadoToken({ tokenStatus: "DENIED" });
    const r = await api(`/turnos/${turnoId}/ingreso-consulta`);
    expect(r.json.tokenEstado).toBe("DENIED");
    expect(showSuccess(r.json)).toBe(false);
  });

  it("ACCEPTED con bono persistido → verde permitido", async () => {
    await setEstadoToken({ tokenStatus: "ACCEPTED", authorizationNumber: `B-${RUN_ID}` });
    const r = await api(`/turnos/${turnoId}/ingreso-consulta`);
    expect(r.json.tokenEstado).toBe("ACCEPTED");
    expect(r.json.nroBono).toBe(`B-${RUN_ID}`);
    expect(showSuccess(r.json)).toBe(true);
  });
});
