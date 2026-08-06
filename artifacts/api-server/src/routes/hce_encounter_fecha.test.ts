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
  clinicalRecordsTable,
  encountersTable,
  auditLogTable,
} from "@workspace/db";
import hceRouter from "./hce";

// POST /api/hce/encounters debe respetar encounterDate cuando viene en el
// body (consultas retroactivas / migraciones) y usar "ahora" solo si falta.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN_ADMIN = `test-token-hcefecha-admin-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let pacienteId: number;
let adminId: number;
const encounterIds: number[] = [];

function crearEncounter(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/hce/encounters`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN_ADMIN}` },
    body: JSON.stringify(body),
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
  app.use("/api", hceRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [paciente] = await db
    .insert(pacientesTable)
    .values({ nombre: "Fecha", apellido: `HceF${RUN_ID}`, dni: `HF${RUN_ID}`, activo: true })
    .returning();
  pacienteId = paciente!.id;

  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `test-hcefecha-admin-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: "Test admin",
      rol: "admin",
    })
    .returning();
  adminId = admin!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN_ADMIN,
    usuarioId: adminId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
});

afterAll(async () => {
  await db.delete(auditLogTable).where(eq(auditLogTable.usuarioId, adminId));
  if (encounterIds.length > 0)
    await db.delete(encountersTable).where(inArray(encountersTable.id, encounterIds));
  await db.delete(clinicalRecordsTable).where(eq(clinicalRecordsTable.patientId, pacienteId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN_ADMIN));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("POST /api/hce/encounters — encounterDate", () => {
  it("respeta la fecha enviada en el body (consulta retroactiva)", async () => {
    const res = await crearEncounter({
      patientId: pacienteId,
      encounterDate: "2026-06-10",
      chiefComplaint: `Retro-${RUN_ID}`,
    });
    expect(res.status).toBe(201);
    const enc = (await res.json()) as { id: number; encounterDate: string };
    encounterIds.push(enc.id);
    expect(enc.encounterDate.startsWith("2026-06-10")).toBe(true);
  });

  it("usa 'ahora' cuando no viene encounterDate", async () => {
    const antes = Date.now();
    const res = await crearEncounter({
      patientId: pacienteId,
      chiefComplaint: `Hoy-${RUN_ID}`,
    });
    expect(res.status).toBe(201);
    const enc = (await res.json()) as { id: number; encounterDate: string };
    encounterIds.push(enc.id);
    const fecha = new Date(enc.encounterDate).getTime();
    expect(fecha).toBeGreaterThanOrEqual(antes - 5000);
    expect(fecha).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it("rechaza una fecha inválida", async () => {
    const res = await crearEncounter({
      patientId: pacienteId,
      encounterDate: "no-es-fecha",
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/hce/encounters ordena por encounterDate descendente", async () => {
    const res = await fetch(`${baseUrl}/api/hce/encounters/${pacienteId}`, {
      headers: { Authorization: `Bearer ${TOKEN_ADMIN}` },
    });
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: number; encounterDate: string }[];
    const nuestras = list.filter((e) => encounterIds.includes(e.id));
    expect(nuestras.length).toBe(2);
    const fechas = nuestras.map((e) => new Date(e.encounterDate).getTime());
    const ordenadas = [...fechas].sort((a, b) => b - a);
    expect(fechas).toEqual(ordenadas);
    // La retroactiva (junio) debe quedar después de la de hoy.
    expect(new Date(nuestras[0]!.encounterDate).getTime()).toBeGreaterThan(
      new Date(nuestras[1]!.encounterDate).getTime(),
    );
  });
});
