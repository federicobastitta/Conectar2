import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  estudiosExternosTable,
  notificacionesSalientesTable,
  auditLogTable,
} from "@workspace/db";
import integracionesPhiritRouter from "./integraciones_phirit";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuario admin, sesión, paciente, estudios externos) y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TEST_EMAIL = `test-phirit-${RUN_ID}@test.local`;
const TEST_DNI = `P${RUN_ID}`;
const TOKEN = `test-token-phirit-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let pacienteId: number;
let whatsappEnvAnterior: string | undefined;

beforeAll(async () => {
  // El envío de WhatsApp está apagado por defecto (NOTIFICACIONES_WHATSAPP_ENABLED).
  // Estos tests verifican la lógica de dedupe de notificaciones, así que lo
  // habilitamos durante la suite y lo restauramos al final.
  whatsappEnvAnterior = process.env.NOTIFICACIONES_WHATSAPP_ENABLED;
  process.env.NOTIFICACIONES_WHATSAPP_ENABLED = "true";
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", integracionesPhiritRouter);

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
      nombre: "Test Admin Phirit",
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

  const [paciente] = await db
    .insert(pacientesTable)
    .values({
      nombre: "Carlos",
      apellido: `PhiritTest${RUN_ID}`,
      dni: TEST_DNI,
      telefono: "11-0000-0000",
      activo: true,
    })
    .returning();
  pacienteId = paciente!.id;
});

afterAll(async () => {
  if (whatsappEnvAnterior === undefined) {
    delete process.env.NOTIFICACIONES_WHATSAPP_ENABLED;
  } else {
    process.env.NOTIFICACIONES_WHATSAPP_ENABLED = whatsappEnvAnterior;
  }
  await db.delete(auditLogTable).where(eq(auditLogTable.pacienteId, pacienteId));
  await db.delete(notificacionesSalientesTable).where(eq(notificacionesSalientesTable.patientId, pacienteId));
  await db.delete(estudiosExternosTable).where(eq(estudiosExternosTable.patientId, pacienteId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

type SyncResult = {
  estudio: { id: number; estado: string; notificadoEn: string | null };
  notificacionDisparada: boolean;
};

function sync(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/integraciones/phirit/estudios`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function contarNotificaciones(): Promise<number> {
  const rows = await db
    .select()
    .from(notificacionesSalientesTable)
    .where(
      and(
        eq(notificacionesSalientesTable.patientId, pacienteId),
        eq(notificacionesSalientesTable.evento, "informe_disponible_phirit"),
      ),
    );
  return rows.length;
}

describe("webhook Phir-it", () => {
  it("estado pendiente no dispara notificación", async () => {
    const res = await sync({
      externalId: `PT-${RUN_ID}-pendiente`,
      estado: "pendiente",
      pacienteDni: TEST_DNI,
      descripcion: "RX Tórax",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as SyncResult;
    expect(data.notificacionDisparada).toBe(false);
    expect(data.estudio.notificadoEn).toBeNull();
  });

  it("webhooks 'informado' concurrentes para el mismo estudio: exactamente una notificación", async () => {
    const externalId = `PT-${RUN_ID}-concurrente`;
    const antes = await contarNotificaciones();

    const respuestas = await Promise.all(
      Array.from({ length: 6 }, () =>
        sync({ externalId, estado: "informado", pacienteDni: TEST_DNI, descripcion: "Eco abdominal" }),
      ),
    );
    for (const r of respuestas) expect(r.status).toBe(200);
    const datos = (await Promise.all(respuestas.map((r) => r.json()))) as SyncResult[];

    const disparadas = datos.filter((d) => d.notificacionDisparada).length;
    expect(disparadas).toBe(1);

    // Exactamente una fila de notificación en DB
    const despues = await contarNotificaciones();
    expect(despues - antes).toBe(1);

    // Un solo estudio creado pese al insert concurrente (upsert atómico)
    const estudios = await db
      .select()
      .from(estudiosExternosTable)
      .where(and(eq(estudiosExternosTable.externalId, externalId), eq(estudiosExternosTable.origen, "phirit")));
    expect(estudios.length).toBe(1);
    expect(estudios[0]!.estado).toBe("informado");
    expect(estudios[0]!.notificadoEn).not.toBeNull();
  });

  it("re-envío de 'informado' luego del primero no duplica la notificación", async () => {
    const externalId = `PT-${RUN_ID}-repetido`;
    const antes = await contarNotificaciones();

    const r1 = await sync({ externalId, estado: "informado", pacienteDni: TEST_DNI });
    const d1 = (await r1.json()) as SyncResult;
    expect(d1.notificacionDisparada).toBe(true);

    const r2 = await sync({ externalId, estado: "informado", pacienteDni: TEST_DNI });
    const d2 = (await r2.json()) as SyncResult;
    expect(d2.notificacionDisparada).toBe(false);

    const despues = await contarNotificaciones();
    expect(despues - antes).toBe(1);
  });

  it("transición pendiente → informado notifica una sola vez y conserva la fecha de informado", async () => {
    const externalId = `PT-${RUN_ID}-transicion`;

    const r1 = await sync({ externalId, estado: "pendiente", pacienteDni: TEST_DNI });
    expect(((await r1.json()) as SyncResult).notificacionDisparada).toBe(false);

    const fecha = "2026-07-09T10:00:00.000Z";
    const r2 = await sync({ externalId, estado: "informado", pacienteDni: TEST_DNI, fechaCambio: fecha });
    const d2 = (await r2.json()) as SyncResult;
    expect(d2.notificacionDisparada).toBe(true);

    const [estudio] = await db
      .select()
      .from(estudiosExternosTable)
      .where(and(eq(estudiosExternosTable.externalId, externalId), eq(estudiosExternosTable.origen, "phirit")));
    expect(estudio!.informadoEn?.toISOString()).toBe(fecha);
  });

  it("con WhatsApp deshabilitado (default) marca notificadoEn pero NO envía notificación", async () => {
    const externalId = `PT-${RUN_ID}-deshabilitado`;
    const antes = await contarNotificaciones();

    process.env.NOTIFICACIONES_WHATSAPP_ENABLED = "false";
    try {
      const res = await sync({ externalId, estado: "informado", pacienteDni: TEST_DNI });
      expect(res.status).toBe(200);
      const data = (await res.json()) as SyncResult;
      expect(data.notificacionDisparada).toBe(false);

      const despues = await contarNotificaciones();
      expect(despues - antes).toBe(0);

      // El estudio queda marcado como notificado (dedupe) para que el poller no lo reprocese
      const [estudio] = await db
        .select()
        .from(estudiosExternosTable)
        .where(and(eq(estudiosExternosTable.externalId, externalId), eq(estudiosExternosTable.origen, "phirit")));
      expect(estudio!.notificadoEn).not.toBeNull();
      expect(estudio!.notificacionId).toBeNull();
    } finally {
      process.env.NOTIFICACIONES_WHATSAPP_ENABLED = "true";
    }
  });

  it("webhook sin auth es rechazado", async () => {
    const res = await fetch(`${baseUrl}/api/integraciones/phirit/estudios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "x", estado: "informado", pacienteDni: TEST_DNI }),
    });
    expect(res.status).toBe(401);
  });
});
