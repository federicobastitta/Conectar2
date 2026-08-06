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
  turnerasTable,
  turnosTable,
  auditLogTable,
  klinicosTrabajos,
  klinicosPracticas,
  klinicosTokenValidaciones,
  consultasTokenTable,
} from "@workspace/db";
import salaEsperaRouter from "./sala_espera";
import { hoyArgentina } from "../lib/tiempo";
import {
  sembrarEspecialidadImagenesTurneras,
  ESPECIALIDAD_KLINICOS_IMAGENES,
} from "../lib/seed-codigos-conectar";

// Task: especialidad IMAGENES S/C en turneras de imágenes + afiliado
// obligatorio antes de enviar la validación de token al Robot.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TEST_EMAIL = `test-afiliado-${RUN_ID}@test.local`;
const TOKEN = `test-token-af-${RUN_ID}`;
const DNI = `9${crypto.randomInt(1000000, 9999999)}`;
const ROBOT_URL = "http://robot-test-afiliado.invalid";

let server: Server;
let baseUrl: string;
let userId: number;
let pacienteSinAfiliadoId: number;
let pacienteConAfiliadoId: number;
const turneraIds: number[] = [];
const practicaIds: number[] = [];
const turnoIds: number[] = [];

const fetchOriginal = globalThis.fetch;
let ultimoBodyRobot: Record<string, unknown> | null = null;
let envPrev: Record<string, string | undefined> = {};

let slotSeq = 0;
async function crearTurno(turneraId: number, pacienteId: number, practicaId?: number): Promise<number> {
  const inicio = 8 * 60 + slotSeq * 20;
  slotSeq += 1;
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      cobertura: "IOMA",
      fecha: hoyArgentina(),
      horaInicio: hhmm(inicio),
      horaFin: hhmm(inicio + 20),
      estado: "pendiente",
      klinicosPracticaId: practicaId ?? null,
    })
    .returning();
  turnoIds.push(turno!.id);
  return turno!.id;
}

async function validarToken(turnoId: number): Promise<{ status: number; json: Record<string, unknown> }> {
  ultimoBodyRobot = null;
  const res = await fetchOriginal(`${baseUrl}/api/turnos/${turnoId}/validar-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ token: `TA${RUN_ID}${turnoId}` }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  envPrev = {
    KLINICOS_TOKEN_VALIDATION_ENABLED: process.env.KLINICOS_TOKEN_VALIDATION_ENABLED,
    ROBOT_API_URL: process.env.ROBOT_API_URL,
    KLINICOS_USUARIO: process.env.KLINICOS_USUARIO,
    KLINICOS_PASSWORD: process.env.KLINICOS_PASSWORD,
  };
  process.env.KLINICOS_TOKEN_VALIDATION_ENABLED = "true";
  process.env.ROBOT_API_URL = ROBOT_URL;
  // Estos tests cubren el payload al Robot EXTERNO: sin credenciales de
  // Klinicos el proveedor interno queda deshabilitado y la ruta usa el Robot.
  delete process.env.KLINICOS_USUARIO;
  delete process.env.KLINICOS_PASSWORD;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(ROBOT_URL)) {
      ultimoBodyRobot = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      return new Response(
        JSON.stringify({ status: "TOKEN_DENIED", reason_message: "prueba" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return fetchOriginal(input, init);
  }) as typeof fetch;

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
    .values({ email: TEST_EMAIL, passwordHash: "x", nombre: "Recep AF", rol: "recepcionista" })
    .returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const [sinAf] = await db
    .insert(pacientesTable)
    .values({ nombre: "Ana", apellido: `SinAfiliado${RUN_ID}`, dni: DNI, activo: true })
    .returning();
  pacienteSinAfiliadoId = sinAf!.id;
  const [conAf] = await db
    .insert(pacientesTable)
    .values({
      nombre: "Bruno",
      apellido: `ConAfiliado${RUN_ID}`,
      dni: `8${crypto.randomInt(1000000, 9999999)}`,
      nroAfiliado: `AF-${RUN_ID}`,
      activo: true,
    })
    .returning();
  pacienteConAfiliadoId = conAf!.id;
});

afterAll(async () => {
  globalThis.fetch = fetchOriginal;
  for (const [k, v] of Object.entries(envPrev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (turnoIds.length > 0) {
    await db.delete(klinicosTokenValidaciones).where(inArray(klinicosTokenValidaciones.turnoId, turnoIds));
    await db.delete(consultasTokenTable).where(inArray(consultasTokenTable.consultationId, turnoIds));
    await db.delete(auditLogTable).where(eq(auditLogTable.usuarioId, userId));
    await db.delete(klinicosTrabajos).where(
      inArray(klinicosTrabajos.pacienteId, [pacienteSinAfiliadoId, pacienteConAfiliadoId]),
    );
    await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  }
  if (practicaIds.length > 0)
    await db.delete(klinicosPracticas).where(inArray(klinicosPracticas.id, practicaIds));
  if (turneraIds.length > 0)
    await db.delete(turnerasTable).where(inArray(turnerasTable.id, turneraIds));
  await db.delete(pacientesTable).where(
    inArray(pacientesTable.id, [pacienteSinAfiliadoId, pacienteConAfiliadoId]),
  );
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function crearTurnera(values: Partial<typeof turnerasTable.$inferInsert> & { nombre: string }) {
  const [t] = await db.insert(turnerasTable).values(values).returning();
  turneraIds.push(t!.id);
  return t!;
}

describe("seed especialidad IMAGENES S/C en turneras de imágenes", () => {
  it("completa la especialidad en turneras de eco/doppler sin override y respeta las cargadas a mano", async () => {
    const eco = await crearTurnera({ nombre: `Ecografía General AF ${RUN_ID}`, activa: false });
    const doppler = await crearTurnera({
      nombre: `Turnera Sector AF ${RUN_ID}`,
      klinicosSector: "IMAGENES S/C",
      activa: false,
    });
    const override = await crearTurnera({
      nombre: `Doppler Renal AF ${RUN_ID}`,
      klinicosEspecialidad: "ESPECIALIDAD MANUAL",
      activa: false,
    });
    const consulta = await crearTurnera({ nombre: `Clínica Médica AF ${RUN_ID}`, activa: false });

    await sembrarEspecialidadImagenesTurneras();

    const filas = await db
      .select({ id: turnerasTable.id, esp: turnerasTable.klinicosEspecialidad })
      .from(turnerasTable)
      .where(inArray(turnerasTable.id, [eco.id, doppler.id, override.id, consulta.id]));
    const porId = new Map(filas.map((f) => [f.id, f.esp]));
    expect(porId.get(eco.id)).toBe(ESPECIALIDAD_KLINICOS_IMAGENES);
    expect(porId.get(doppler.id)).toBe(ESPECIALIDAD_KLINICOS_IMAGENES);
    expect(porId.get(override.id)).toBe("ESPECIALIDAD MANUAL"); // nunca pisa un override
    expect(porId.get(consulta.id)).toBeNull(); // no toca turneras de consulta
  });
});

describe("validación de token sin nro. de afiliado (el Robot lo completa por padrón)", () => {
  let turneraEcoId: number;
  let practicaEcoId: number;

  beforeAll(async () => {
    const eco = await crearTurnera({
      nombre: `Eco Abdomen AF ${RUN_ID}`,
      klinicosSector: "IMAGENES S/C",
      klinicosEspecialidad: ESPECIALIDAD_KLINICOS_IMAGENES,
    });
    turneraEcoId = eco.id;
    const [p] = await db
      .insert(klinicosPracticas)
      .values({ nombre: `ECO ABDOMEN TEST ${RUN_ID}`, codigos: ["180112", "180113"], codigoEnvio: "180112-180113" })
      .returning();
    practicaIds.push(p!.id);
    practicaEcoId = p!.id;
  });

  it("sin afiliado: la validación se envía igual, sin affiliate_number en el payload", async () => {
    const turnoId = await crearTurno(turneraEcoId, pacienteSinAfiliadoId, practicaEcoId);
    const r = await validarToken(turnoId);
    expect(r.status).toBe(200);
    // El pedido SALE al Robot aunque falte el afiliado (lo completa por padrón).
    expect(ultimoBodyRobot).not.toBeNull();
    const patient = ultimoBodyRobot!.patient as Record<string, unknown>;
    expect(patient.affiliate_number ?? "").toBe(""); // vacío u omitido, nunca inventado
    expect(r.json.estado).not.toBe("DATA_REQUIRED");
    const [ct] = await db
      .select()
      .from(consultasTokenTable)
      .where(eq(consultasTokenTable.consultationId, turnoId))
      .limit(1);
    expect(ct?.affiliateNumber ?? null).toBeNull();
  });

  it("con afiliado cargado: el payload incluye affiliate_number y specialty_code IMAGENES S/C", async () => {
    const turnoId = await crearTurno(turneraEcoId, pacienteConAfiliadoId, practicaEcoId);
    const r = await validarToken(turnoId);
    expect(r.status).toBe(200);
    expect(ultimoBodyRobot).not.toBeNull();
    expect(ultimoBodyRobot!.specialty_code).toBe(ESPECIALIDAD_KLINICOS_IMAGENES);
    expect(ultimoBodyRobot!.practice_code).toBe("180112-180113");
    const patient = ultimoBodyRobot!.patient as Record<string, unknown>;
    expect(patient.affiliate_number).toBe(`AF-${RUN_ID}`);
  });

  it("si luego se carga el afiliado, el reintento lo incluye en el payload", async () => {
    const turnoId = await crearTurno(turneraEcoId, pacienteSinAfiliadoId, practicaEcoId);
    await validarToken(turnoId);
    await db
      .update(pacientesTable)
      .set({ nroAfiliado: `AF-NUEVO-${RUN_ID}` })
      .where(eq(pacientesTable.id, pacienteSinAfiliadoId));
    try {
      await validarToken(turnoId);
      expect(ultimoBodyRobot).not.toBeNull();
      const patient = ultimoBodyRobot!.patient as Record<string, unknown>;
      expect(patient.affiliate_number).toBe(`AF-NUEVO-${RUN_ID}`);
    } finally {
      await db
        .update(pacientesTable)
        .set({ nroAfiliado: null })
        .where(eq(pacientesTable.id, pacienteSinAfiliadoId));
    }
  });
});
