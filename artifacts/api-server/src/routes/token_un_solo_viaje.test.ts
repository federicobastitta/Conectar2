import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// KLINICOS_BASE_URL se lee al CARGAR klinicos-robot (const de módulo): hay que
// fijarla antes de que los imports de abajo lo traigan. vi.hoisted corre
// antes que todos los imports del archivo.
const { MOCK_PORT, ENV_PREV } = vi.hoisted(() => {
  const prev: Record<string, string | undefined> = {
    KLINICOS_BASE_URL: process.env.KLINICOS_BASE_URL,
    KLINICOS_USUARIO: process.env.KLINICOS_USUARIO,
    KLINICOS_PASSWORD: process.env.KLINICOS_PASSWORD,
    KLINICOS_TOKEN_VALIDATION_ENABLED: process.env.KLINICOS_TOKEN_VALIDATION_ENABLED,
  };
  const port = 38000 + Math.floor(Math.random() * 20000);
  process.env.KLINICOS_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.KLINICOS_USUARIO = "fake-un-viaje";
  process.env.KLINICOS_PASSWORD = "fake";
  delete process.env.KLINICOS_TOKEN_VALIDATION_ENABLED;
  return { MOCK_PORT: port, ENV_PREV: prev };
});
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
  turnerasTable,
  turnosTable,
  auditLogTable,
  klinicosTrabajos,
  klinicosTokenValidaciones,
  consultasTokenTable,
} from "@workspace/db";
import salaEsperaRouter from "./sala_espera";
import { hoyArgentina } from "../lib/tiempo";

// ── Contrato "el token viaja UNA sola vez" (hallazgo 2-ago-2026) ────────────
// La llamada de Klinicos /ordenPrestacion/validarDatosObraSocialPaciente con
// OSToken NO es solo-lectura: IOMA consume el token ahí. Regla: con el
// automatizador interno habilitado, validar-token NUNCA debe pegarle a ese
// endpoint — el token va directo a la autorización, y sin confirmación el
// estado es error técnico reintentable (jamás ACCEPTED sin bono).

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TEST_EMAIL = `test-unviaje-${RUN_ID}@test.local`;
const TOKEN = `test-token-uv-${RUN_ID}`;
const DNI = `9${crypto.randomInt(1000000, 9999999)}`;

let server: Server;
let baseUrl: string;
let userId: number;
let pacienteId: number;
let turneraId: number;
let turnoId: number;

// Servidor que simula el portal Klinicos: registra cada path y devuelve 500
// (login imposible) — ningún paso puede consumir nada.
let klinicosMock: Server;
const pathsKlinicos: string[] = [];

beforeAll(async () => {
  const mock = express();
  mock.use((req, res) => {
    pathsKlinicos.push(req.path);
    res.status(500).send("mock");
  });
  await new Promise<void>((resolve, reject) => {
    klinicosMock = mock.listen(MOCK_PORT, () => resolve());
    klinicosMock.on("error", reject);
  });

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
    .values({ email: TEST_EMAIL, passwordHash: "x", nombre: "Recep UV", rol: "recepcionista" })
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
    .values({ nombre: "Una", apellido: `SolaVez${RUN_ID}`, dni: DNI, nroAfiliado: `AF${RUN_ID}`, activo: true })
    .returning();
  pacienteId = paciente!.id;
  const [turnera] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Turnera UV ${RUN_ID}`,
      klinicosSector: "CONSULTORIO",
      klinicosEspecialidad: "CLINICA MEDICA",
    })
    .returning();
  turneraId = turnera!.id;
  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      cobertura: "IOMA",
      fecha: hoyArgentina(),
      horaInicio: "08:00",
      horaFin: "08:20",
      estado: "pendiente",
    })
    .returning();
  turnoId = turno!.id;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(ENV_PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise<void>((resolve) => klinicosMock.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(klinicosTokenValidaciones).where(eq(klinicosTokenValidaciones.turnoId, turnoId));
  await db.delete(consultasTokenTable).where(eq(consultasTokenTable.consultationId, turnoId));
  await db.delete(auditLogTable).where(eq(auditLogTable.usuarioId, userId));
  await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.pacienteId, pacienteId));
  await db.delete(turnosTable).where(eq(turnosTable.id, turnoId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

describe("validar-token con automatizador interno: el token viaja una sola vez", () => {
  it("nunca llama a validarDatosObraSocialPaciente y sin bono no hay ACCEPTED", async () => {
    const res = await fetch(`${baseUrl}/api/turnos/${turnoId}/validar-token`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ token: "123456" }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { estado: string; nroBono: string | null; reintentable: boolean };

    // El endpoint que consume el token JAMÁS se toca en este flujo.
    expect(pathsKlinicos.some((p) => p.includes("validarDatosObraSocialPaciente"))).toBe(false);
    // El circuito sí intentó operar contra el portal (login del robot).
    expect(pathsKlinicos.length).toBeGreaterThan(0);

    // Sin bono real no existe aceptación: error técnico reintentable.
    expect(j.estado).toBe("TECHNICAL_ERROR");
    expect(j.nroBono).toBeNull();
    expect(j.reintentable).toBe(true);

    const [ct] = await db
      .select()
      .from(consultasTokenTable)
      .where(eq(consultasTokenTable.consultationId, turnoId))
      .limit(1);
    expect(ct).toBeDefined();
    expect(ct!.tokenStatus).not.toBe("ACCEPTED");
    expect(ct!.authorizationNumber).toBeNull();
  }, 120_000);

  it("mismo token con rechazo explícito persistido: no se reenvía nunca", async () => {
    // El primer test dejó turno.klinicosToken = "123456". Se simula que ese
    // token terminó DENIED: reintentar con el MISMO token no debe tocar el
    // portal (la guarda liberada es para tokens NUEVOS, no para repetir).
    await db
      .update(consultasTokenTable)
      .set({ tokenStatus: "DENIED", tokenFailureCode: "DENIED", tokenFailureMessage: "IOMA rechazó" })
      .where(eq(consultasTokenTable.consultationId, turnoId));
    pathsKlinicos.length = 0;

    const res = await fetch(`${baseUrl}/api/turnos/${turnoId}/validar-token`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ token: "123456" }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { estado: string; nroBono: string | null; reintentable: boolean };
    expect(j.estado).toBe("TOKEN_DENIED");
    expect(j.nroBono).toBeNull();
    expect(j.reintentable).toBe(false);
    // Ni un solo request al portal: el token rechazado no vuelve a viajar.
    expect(pathsKlinicos).toHaveLength(0);
  }, 60_000);
});
