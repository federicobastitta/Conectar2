import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray } from "drizzle-orm";
import { db, pacientesTable, turnerasTable, turnosTable } from "@workspace/db";
import portalRouter from "./portal";

// El QR del turno funciona como credencial de identificación en recepción:
// JAMÁS puede filtrarse por el endpoint público de consulta por DNI.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const DNI = `9${RUN_ID.replace(/\D/g, "").padEnd(7, "3").slice(0, 7)}`;

let server: Server;
let baseUrl: string;
let turneraId: number;
let pacienteId: number;
const turnoIds: number[] = [];

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", portalRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [turnera] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera PortalQr Test ${RUN_ID}` })
    .returning();
  turneraId = turnera!.id;

  const [paciente] = await db
    .insert(pacientesTable)
    .values({ nombre: "Clara", apellido: `TestQr${RUN_ID}`, dni: DNI, activo: true })
    .returning();
  pacienteId = paciente!.id;

  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      fecha: "2099-01-01",
      horaInicio: "09:00",
      horaFin: "09:30",
      estado: "pendiente",
    })
    .returning();
  turnoIds.push(turno!.id);
});

afterAll(async () => {
  if (turnoIds.length > 0) await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("GET /api/portal/turnos — no filtra el QR del turno", () => {
  it("el turno se genera con qrCodigo en la DB", async () => {
    const [row] = await db
      .select({ qrCodigo: turnosTable.qrCodigo })
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoIds[0]!));
    expect(row?.qrCodigo).toBeTruthy();
  });

  it("la consulta pública por DNI devuelve el turno pero NUNCA su qrCodigo", async () => {
    const res = await fetch(`${baseUrl}/api/portal/turnos?dni=${DNI}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { turnos: Record<string, unknown>[] };
    expect(body.turnos.length).toBeGreaterThanOrEqual(1);
    for (const turno of body.turnos) {
      expect(turno).not.toHaveProperty("qrCodigo");
      expect(JSON.stringify(turno)).not.toContain("qrCodigo");
      expect(turno).not.toHaveProperty("videollamadaUrl");
      expect(JSON.stringify(turno)).not.toContain("videollamadaUrl");
    }
  });
});
