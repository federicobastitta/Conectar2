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
  clinicalRecordsTable,
  encountersTable,
} from "@workspace/db";
import salaEsperaRouter from "./sala_espera";
import { hoyArgentina } from "../lib/tiempo";

// Códigos de práctica según la planilla Conectar: el practice_code que sale
// hacia el Robot debe ser el string EXACTO de la planilla (separadores + / -
// y sufijos /A /B preservados), nunca los códigos unidos con coma.
// Se intercepta el fetch al Robot para capturar el body real.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TEST_EMAIL = `test-practicecode-${RUN_ID}@test.local`;
const TOKEN = `test-token-pc-${RUN_ID}`;
// DNI con puntos: el payload debe salir con solo dígitos
const DNI_DIGITOS = `9${crypto.randomInt(1000000, 9999999)}`;
const DNI_CON_PUNTOS = `${DNI_DIGITOS.slice(0, 2)}.${DNI_DIGITOS.slice(2, 5)}.${DNI_DIGITOS.slice(5)}`;
const ROBOT_URL = "http://robot-test.invalid";

let server: Server;
let baseUrl: string;
let userId: number;
let pacienteId: number;
let turneraConsultaId: number;
let turneraPracticaId: number;
const practicaIds: number[] = [];
const turnoIds: number[] = [];
const encounterIds: number[] = [];
let clinicalRecordId: number | null = null;

const fetchOriginal = globalThis.fetch;
let ultimoBodyRobot: Record<string, unknown> | null = null;

let envPrev: Record<string, string | undefined> = {};

let slotSeq = 0;
async function crearTurno(turneraId: number, practicaId?: number): Promise<number> {
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

async function crearPractica(nombre: string, codigos: string[], codigoEnvio: string | null): Promise<number> {
  const [p] = await db
    .insert(klinicosPracticas)
    .values({ nombre: `${nombre} TEST ${RUN_ID}`, codigos, codigoEnvio })
    .returning();
  practicaIds.push(p!.id);
  return p!.id;
}

async function validarToken(turnoId: number): Promise<{ status: number; json: Record<string, unknown> }> {
  ultimoBodyRobot = null;
  const res = await fetchOriginal(`${baseUrl}/api/turnos/${turnoId}/validar-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ token: `TK${RUN_ID}${turnoId}` }),
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

  // Interceptar SOLO las llamadas al Robot; el resto pasa al fetch real.
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
    .values({ email: TEST_EMAIL, passwordHash: "x", nombre: "Recep PC", rol: "recepcionista" })
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
      nombre: "Mario",
      apellido: `PracticeCode${RUN_ID}`,
      dni: DNI_CON_PUNTOS,
      // Afiliado obligatorio: sin nroAfiliado la validación se corta antes del Robot
      nroAfiliado: `AF${RUN_ID}`,
      activo: true,
    })
    .returning();
  pacienteId = paciente!.id;

  const [tConsulta] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Turnera Consulta PC ${RUN_ID}`,
      klinicosSector: "CONSULTORIO",
      klinicosEspecialidad: "CARDIOLOGIA",
    })
    .returning();
  turneraConsultaId = tConsulta!.id;
  const [tPractica] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera Practica PC ${RUN_ID}`, klinicosSector: "IMAGENES S/C" })
    .returning();
  turneraPracticaId = tPractica!.id;
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
    await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.pacienteId, pacienteId));
    if (encounterIds.length > 0)
      await db.delete(encountersTable).where(inArray(encountersTable.id, encounterIds));
    if (clinicalRecordId != null)
      await db.delete(clinicalRecordsTable).where(eq(clinicalRecordsTable.id, clinicalRecordId));
    await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  }
  if (practicaIds.length > 0)
    await db.delete(klinicosPracticas).where(inArray(klinicosPracticas.id, practicaIds));
  await db.delete(turnerasTable).where(inArray(turnerasTable.id, [turneraConsultaId, turneraPracticaId]));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("practice_code según planilla Conectar", () => {
  it("EEG: combo con guiones tal cual la planilla", async () => {
    const practicaId = await crearPractica("EEG", ["290101", "290102", "420102"], "290101-290102-420102");
    const turnoId = await crearTurno(turneraPracticaId, practicaId);
    const r = await validarToken(turnoId);
    expect(r.status).toBe(200);
    expect(ultimoBodyRobot).not.toBeNull();
    expect(ultimoBodyRobot!.practice_code).toBe("290101-290102-420102");
  });

  it("Mamografía: combo con + y repeticiones exactas", async () => {
    const practicaId = await crearPractica(
      "MAMOGRAFIA",
      ["340601", "340601", "340602", "340602"],
      "340601+340601+340602+340602",
    );
    const turnoId = await crearTurno(turneraPracticaId, practicaId);
    const r = await validarToken(turnoId);
    expect(r.status).toBe(200);
    expect(ultimoBodyRobot!.practice_code).toBe("340601+340601+340602+340602");
  });

  it("Doppler arterial y venoso: sufijos /A y /B preservados", async () => {
    const practicaId = await crearPractica("DOPPLER AV", ["881841/A", "881841/B"], "881841/A+881841/B");
    const turnoId = await crearTurno(turneraPracticaId, practicaId);
    const r = await validarToken(turnoId);
    expect(r.status).toBe(200);
    expect(ultimoBodyRobot!.practice_code).toBe("881841/A+881841/B");
  });

  it("consulta de especialidad: 420101 + especialidad exacta, DNI solo dígitos", async () => {
    const turnoId = await crearTurno(turneraConsultaId);
    const r = await validarToken(turnoId);
    expect(r.status).toBe(200);
    expect(ultimoBodyRobot!.practice_code).toBe("420101");
    expect(ultimoBodyRobot!.specialty_code).toBe("CARDIOLOGIA");
    const patient = ultimoBodyRobot!.patient as Record<string, unknown>;
    expect(patient.document_number).toBe(DNI_DIGITOS);
  });

  it("práctica sin código de envío: NO llama al Robot y queda en revisión manual", async () => {
    // Combo de varios códigos que no está en la planilla (un código único
    // sí viaja tal cual): no debe inventarse un join.
    const practicaId = await crearPractica("SIN CODIGO", ["999998", "999999"], null);
    const turnoId = await crearTurno(turneraPracticaId, practicaId);
    const r = await validarToken(turnoId);
    expect(r.status).toBe(200);
    expect(ultimoBodyRobot).toBeNull(); // nunca se inventa un código
    expect(r.json.estado).toBe("MANUAL_REVIEW");
    expect(r.json.camposFaltantes).toEqual(["practice_code"]);
    expect(String(r.json.mensaje)).toContain("código de envío");
    // El estado queda persistido para que el staff lo vea en la consola
    const [ct] = await db
      .select()
      .from(consultasTokenTable)
      .where(eq(consultasTokenTable.consultationId, turnoId))
      .limit(1);
    expect(ct?.tokenStatus).toBe("MANUAL_REVIEW");
  });
});

describe("diagnosis_code CIE-10 (opcional según planilla Conectar)", () => {
  it("sin diagnóstico: el campo no viaja", async () => {
    const turnoId = await crearTurno(turneraConsultaId);
    const r = await validarToken(turnoId);
    expect(r.status).toBe(200);
    expect(ultimoBodyRobot!.diagnosis_code).toBeUndefined();
  });

  it("trabajo Klinicos con CIE-10: viaja normalizado (mayúsculas, sin espacios)", async () => {
    const turnoId = await crearTurno(turneraConsultaId);
    await db.insert(klinicosTrabajos).values({
      turnoId,
      pacienteId,
      dni: DNI_DIGITOS,
      especialidad: "CARDIOLOGIA",
      sectorServicio: "CONSULTORIO",
      estado: "pendiente",
      cie10Codigo: " i 10 ",
    });
    const r = await validarToken(turnoId);
    expect(r.status).toBe(200);
    expect(ultimoBodyRobot!.diagnosis_code).toBe("I10");
  });

  it("consulta registrada por el médico (encounter): el CIE-10 viaja como fallback", async () => {
    const turnoId = await crearTurno(turneraConsultaId);
    if (clinicalRecordId == null) {
      const [record] = await db
        .insert(clinicalRecordsTable)
        .values({ patientId: pacienteId })
        .returning();
      clinicalRecordId = record!.id;
    }
    const [encounter] = await db
      .insert(encountersTable)
      .values({ clinicalRecordId, diagnosis: "Diabetes tipo 2", cie10: "e11.9", status: "cerrada" })
      .returning();
    encounterIds.push(encounter!.id);
    // Vínculo turno→encounter tal como lo deja el endpoint de finalizar consulta
    await db.insert(auditLogTable).values({
      usuarioId: userId,
      usuarioEmail: TEST_EMAIL,
      rol: "medico",
      accion: "crear",
      entidad: "encounter",
      entidadId: encounter!.id,
      pacienteId,
      detalle: { origen: "consultorio_unificado", turnoId },
    });
    const r = await validarToken(turnoId);
    expect(r.status).toBe(200);
    expect(ultimoBodyRobot!.diagnosis_code).toBe("E11.9");
  });
});
