// Tests de integración del check-in público (POST /publico/turnos/:id/validar-token)
// y no-regresión del flujo staff (POST /turnos/:id/validar-token).
//
// El handler compartido `ejecutarValidacionTokenTurno` (sala_espera.ts) es el
// corazón del circuito; ambos canales delegan en él. Los tests fijan:
//
//  Canal público — guardas previas a la delegación:
//    1. DNI ajeno al turno → 404 uniforme (no revela existencia del turno)
//    2. Turno inexistente   → 404 uniforme
//    3. Agenda de guardia   → 409
//    4. Agenda de práctica  → 409
//    5. Agenda con Pixel (enviaWorklist)  → 409
//    6. Estado cancelado    → 409
//    7. Estado finalizado   → 409
//
//  Handler compartido — guardas internas (testeadas vía canal público):
//    8. Cobertura no IOMA   → 409
//    9. Turno de otro día   → 409
//
//  Staff — no-regresión:
//   10. Token aceptado → auditoría "token_validado" en DB
//   11. Token aceptado → recepción automática (estado "arribo" + auditoría "admitir"
//       con motivo "token_validado") + recepcionadoAutomatico:true en respuesta
//   12. Regla cardinal: nroBono null en mock → respuesta NO es TOKEN_ACCEPTED
//   13. Regla cardinal: TOKEN_ACCEPTED siempre viene con nroBono != null
//
// Convenciones:
//   - RUN_ID en todos los nombres/DNIs para aislar corridas paralelas
//   - Siembra propia en beforeAll, limpieza FK-safe en afterAll
//   - vi.mock de klinicos-worker (opción A): autorizarConsultaConToken devuelve
//     la forma exacta que consume autorizarConTope internamente en sala_espera.ts
//   - KLINICOS_USUARIO/PASSWORD fake para que validacionInternaDisponible()=true
//     → el handler toma el path interno que llama autorizarConsultaConToken
//   - NO se corre la suite completa; solo este archivo

import { vi } from "vitest";

// ── Mock de klinicos-worker (opción A) ────────────────────────────────────
// vi.hoisted() garantiza que la variable exista ANTES de que vi.mock() se hoist
// al tope del módulo. Sin esto, la closure del factory referencia una variable
// aún no inicializada y vitest lanza ReferenceError.
const { mockAutorizarConsultaConToken } = vi.hoisted(() => ({
  mockAutorizarConsultaConToken: vi.fn().mockResolvedValue({
    nroBono: "BONO-TEST-999",
    resultado: "aceptado" as const,
    detalle: "ok",
  }),
}));

vi.mock("../integraciones/klinicos-worker", async (importOriginal) => {
  const real = await importOriginal<typeof import("../integraciones/klinicos-worker")>();
  return {
    ...real,
    // La forma del retorno debe coincidir con lo que autorizarConTope consume:
    //   { nroBono: string|null; resultado: "aceptado"|"rechazado"|"incierto"|null; detalle: string }
    autorizarConsultaConToken: mockAutorizarConsultaConToken,
    // releerBonoConsulta: usada en el path de idempotencia (token ya DENIED);
    // devolver null evita queries de lectura sobre Klinicos en sandbox.
    releerBonoConsulta: vi.fn().mockResolvedValue(null),
    // procesarTrabajo / ejecutarTrabajoAprobado: fire-and-forget desde
    // encolarTrabajoKlinicos; mock evita llamadas de red en segundo plano.
    procesarTrabajo: vi.fn().mockResolvedValue(undefined),
    ejecutarTrabajoAprobado: vi.fn().mockResolvedValue(undefined),
  };
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  especialidadesTable,
  turnerasTable,
  turnosTable,
  auditLogTable,
  klinicosTrabajos,
  consultasTokenTable,
  klinicosTokenValidaciones,
} from "@workspace/db";
import apiPublicaRouter from "./api_publica";
import salaEsperaRouter from "./sala_espera";
import { hoyArgentina } from "../lib/tiempo";

// ── Identificadores de corrida ─────────────────────────────────────────────
const RUN_ID = crypto.randomBytes(6).toString("hex");
const API_KEY = `test-checkin-${RUN_ID}`;
const STAFF_TOKEN = `test-staff-token-${RUN_ID}`;

// DNIs numéricos de 7 dígitos derivados del RUN_ID (mismo patrón que
// guardia_virtual.test.ts). El endpoint valida ^\d{7,10}$ antes de cualquier
// lógica: un DNI con letra dispara 400 y nunca llega a las guardas bajo prueba.
const runDigits = String(parseInt(RUN_ID.substring(0, 6), 16)).slice(-6).padStart(6, "0");
const DNI_IOMA  = `1${runDigits}`; // paciente IOMA
const DNI_PAMI  = `2${runDigits}`; // paciente PAMI (cobertura no IOMA)
const DNI_AJENO = `3${runDigits}`; // DNI que no pertenece a ningún turno del test

// ── IDs de fixtures ────────────────────────────────────────────────────────
let server: Server;
let baseUrl: string;

// Staff
let staffUserId: number;

// Pacientes
let pacienteIomaId: number;
let pacientePamiId: number;

// Especialidades
let espNormalId: number;
let espPixelId: number; // enviaAlPacs: true

// Turneras
let turneraNormalId: number;
let turneraGuardiaId: number;
let turneraPracticaId: number;
let turneraPixelId: number; // enviaWorklist: true

// Turnos
let turnoBaseId: number;       // hoy, pendiente, paciente IOMA, turnera normal
let turnoStaffId: number;      // hoy, pendiente, paciente IOMA, turnera normal (para staff tests)
let turnoCanceladoId: number;
let turnoFinalizadoId: number;
let turnoOtroDiaId: number;    // fecha "2020-01-01"
let turnoGuardiaId: number;
let turnoPracticaId: number;
let turnoPixelId: number;
let turnoPamiId: number;       // paciente sin cobertura IOMA

// IDs para limpieza FK-safe
const turnoIdsCleanup: number[] = [];

const HOY = hoyArgentina();

// ── Helpers HTTP ───────────────────────────────────────────────────────────

function publico(turnoId: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/publico/turnos/${turnoId}/validar-token`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function staff(turnoId: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/turnos/${turnoId}/validar-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STAFF_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// ── beforeAll ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Inyectar API key para el middleware requireApiKey.
  process.env.API_PUBLICA_KEY = API_KEY;

  // KLINICOS_USUARIO/PASSWORD fakes para que klinicosHabilitado() → true
  // y validacionInternaDisponible() → true. El handler toma el path interno
  // que llama autorizarConsultaConToken (mockeada arriba).
  process.env.KLINICOS_USUARIO = "test-usuario-fake";
  process.env.KLINICOS_PASSWORD = "test-password-fake";

  // Express app con ambos routers, igual que en producción.
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", apiPublicaRouter);
  app.use("/api", salaEsperaRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // ── Usuario staff (recepcionista) ────────────────────────────────────────
  const [staffUser] = await db
    .insert(usersTable)
    .values({
      email: `staff-checkin-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `StaffCheckin${RUN_ID}`,
      rol: "recepcionista",
    })
    .returning();
  staffUserId = staffUser!.id;

  await db.insert(sesionesTable).values({
    token: STAFF_TOKEN,
    usuarioId: staffUserId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  // ── Especialidades ────────────────────────────────────────────────────────
  const [espNormal] = await db
    .insert(especialidadesTable)
    .values({ nombre: `CkNormal${RUN_ID}`, enviaAlPacs: false })
    .returning();
  espNormalId = espNormal!.id;

  const [espPixel] = await db
    .insert(especialidadesTable)
    .values({ nombre: `CkPixel${RUN_ID}`, enviaAlPacs: true })
    .returning();
  espPixelId = espPixel!.id;

  // ── Pacientes ─────────────────────────────────────────────────────────────
  const [pacIoma] = await db
    .insert(pacientesTable)
    .values({
      nombre: "CheckIn",
      apellido: `IomaCk${RUN_ID}`,
      dni: DNI_IOMA,
      cobertura: "IOMA",
      activo: true,
    })
    .returning();
  pacienteIomaId = pacIoma!.id;

  const [pacPami] = await db
    .insert(pacientesTable)
    .values({
      nombre: "CheckIn",
      apellido: `PamiCk${RUN_ID}`,
      dni: DNI_PAMI,
      cobertura: "PAMI",
      activo: true,
    })
    .returning();
  pacientePamiId = pacPami!.id;

  // ── Turneras ──────────────────────────────────────────────────────────────
  const [tNormal] = await db
    .insert(turnerasTable)
    .values({
      nombre: `CkNormal${RUN_ID}`,
      tipo: "consulta",
      esGuardia: false,
      enviaWorklist: false,
      especialidadId: espNormalId,
      activa: true,
    })
    .returning();
  turneraNormalId = tNormal!.id;

  const [tGuardia] = await db
    .insert(turnerasTable)
    .values({ nombre: `CkGuardia${RUN_ID}`, esGuardia: true, activa: true })
    .returning();
  turneraGuardiaId = tGuardia!.id;

  const [tPractica] = await db
    .insert(turnerasTable)
    .values({ nombre: `CkPractica${RUN_ID}`, tipo: "practica", esGuardia: false, activa: true })
    .returning();
  turneraPracticaId = tPractica!.id;

  // Pixel: enviaWorklist:true (COALESCE: enviaWorklist ?? enviaAlPacs ?? false)
  const [tPixel] = await db
    .insert(turnerasTable)
    .values({
      nombre: `CkPixel${RUN_ID}`,
      tipo: "consulta",
      esGuardia: false,
      enviaWorklist: true,
      activa: true,
    })
    .returning();
  turneraPixelId = tPixel!.id;

  // ── Turnos ────────────────────────────────────────────────────────────────
  // Función auxiliar para registrar IDs para limpieza
  async function insertTurno(values: typeof turnosTable.$inferInsert): Promise<number> {
    const [t] = await db.insert(turnosTable).values(values).returning({ id: turnosTable.id });
    turnoIdsCleanup.push(t!.id);
    return t!.id;
  }

  turnoBaseId = await insertTurno({
    turneraId: turneraNormalId,
    pacienteId: pacienteIomaId,
    fecha: HOY,
    horaInicio: "08:00",
    horaFin: "08:30",
    estado: "pendiente",
  });

  turnoStaffId = await insertTurno({
    turneraId: turneraNormalId,
    pacienteId: pacienteIomaId,
    fecha: HOY,
    horaInicio: "08:30",
    horaFin: "09:00",
    estado: "pendiente",
  });

  turnoCanceladoId = await insertTurno({
    turneraId: turneraNormalId,
    pacienteId: pacienteIomaId,
    fecha: HOY,
    horaInicio: "09:00",
    horaFin: "09:30",
    estado: "cancelado",
  });

  turnoFinalizadoId = await insertTurno({
    turneraId: turneraNormalId,
    pacienteId: pacienteIomaId,
    fecha: HOY,
    horaInicio: "09:30",
    horaFin: "10:00",
    estado: "finalizado",
  });

  // Turno de otro día: fecha fija en el pasado, segura
  turnoOtroDiaId = await insertTurno({
    turneraId: turneraNormalId,
    pacienteId: pacienteIomaId,
    fecha: "2020-01-01",
    horaInicio: "10:00",
    horaFin: "10:30",
    estado: "pendiente",
  });

  turnoGuardiaId = await insertTurno({
    turneraId: turneraGuardiaId,
    pacienteId: pacienteIomaId,
    fecha: HOY,
    horaInicio: "10:30",
    horaFin: "11:00",
    estado: "pendiente",
  });

  turnoPracticaId = await insertTurno({
    turneraId: turneraPracticaId,
    pacienteId: pacienteIomaId,
    fecha: HOY,
    horaInicio: "11:00",
    horaFin: "11:30",
    estado: "pendiente",
  });

  turnoPixelId = await insertTurno({
    turneraId: turneraPixelId,
    pacienteId: pacienteIomaId,
    fecha: HOY,
    horaInicio: "11:30",
    horaFin: "12:00",
    estado: "pendiente",
  });

  turnoPamiId = await insertTurno({
    turneraId: turneraNormalId,
    pacienteId: pacientePamiId,
    fecha: HOY,
    horaInicio: "12:00",
    horaFin: "12:30",
    estado: "pendiente",
  });
});

// ── afterAll (FK-safe) ────────────────────────────────────────────────────

afterAll(async () => {
  // 1. Tablas derivadas del turno que bloquean el DELETE con FK
  if (turnoIdsCleanup.length) {
    await db
      .delete(klinicosTokenValidaciones)
      .where(inArray(klinicosTokenValidaciones.turnoId, turnoIdsCleanup))
      .catch(() => undefined);
    await db
      .delete(consultasTokenTable)
      .where(inArray(consultasTokenTable.consultationId, turnoIdsCleanup))
      .catch(() => undefined);
    // robot_turnos_eventos no tiene tabla Drizzle exportada: raw SQL
    await db
      .execute(sql`DELETE FROM robot_turnos_eventos WHERE turno_id = ANY(${turnoIdsCleanup})`)
      .catch(() => undefined);
  }

  // 2. Auditoría por turnoId (entidad "turno")
  await db
    .delete(auditLogTable)
    .where(eq(auditLogTable.usuarioId, staffUserId))
    .catch(() => undefined);
  // También las auditorías del canal público (usuarioId null, entidadId = turnoId)
  if (turnoIdsCleanup.length) {
    await db
      .delete(auditLogTable)
      .where(inArray(auditLogTable.entidadId, turnoIdsCleanup))
      .catch(() => undefined);
  }

  // 3. klinicos_trabajos: fire-and-forget desde admitir; reintentar con pausa
  const pacienteIds = [pacienteIomaId, pacientePamiId].filter(Boolean);
  for (let intento = 0; intento < 8; intento++) {
    if (turnoIdsCleanup.length) {
      await db
        .delete(klinicosTrabajos)
        .where(inArray(klinicosTrabajos.turnoId, turnoIdsCleanup))
        .catch(() => undefined);
    }
    if (pacienteIds.length) {
      await db
        .delete(klinicosTrabajos)
        .where(inArray(klinicosTrabajos.pacienteId, pacienteIds))
        .catch(() => undefined);
    }
    try {
      if (turnoIdsCleanup.length) {
        await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIdsCleanup));
      }
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // 4. Pacientes
  if (pacienteIds.length) {
    await db.delete(pacientesTable).where(inArray(pacientesTable.id, pacienteIds)).catch(() => undefined);
  }

  // 5. Turneras
  const turneraIds = [turneraNormalId, turneraGuardiaId, turneraPracticaId, turneraPixelId].filter(Boolean);
  if (turneraIds.length) {
    await db.delete(turnerasTable).where(inArray(turnerasTable.id, turneraIds)).catch(() => undefined);
  }

  // 6. Especialidades
  const espIds = [espNormalId, espPixelId].filter(Boolean);
  if (espIds.length) {
    await db.delete(especialidadesTable).where(inArray(especialidadesTable.id, espIds)).catch(() => undefined);
  }

  // 7. Sesión y usuario staff
  await db.delete(sesionesTable).where(eq(sesionesTable.token, STAFF_TOKEN)).catch(() => undefined);
  await db.delete(usersTable).where(eq(usersTable.id, staffUserId)).catch(() => undefined);

  // 8. Variables de entorno inyectadas
  delete process.env.API_PUBLICA_KEY;
  delete process.env.KLINICOS_USUARIO;
  delete process.env.KLINICOS_PASSWORD;

  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Canal público: guardas del endpoint antes de delegar al handler ────────
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /publico/turnos/:id/validar-token — guardas propias", () => {

  // ── Caso 1: DNI ajeno al turno → 404 uniforme ───────────────────────────
  // DNI_AJENO es numérico pero no pertenece a ningún paciente/turno del test.
  // La respuesta no revela si el turno existe ni a quién pertenece.
  it("DNI ajeno al turno devuelve 404 uniforme", async () => {
    const res = await publico(turnoBaseId, { dni: DNI_AJENO, token: "TOKEN-AJENO" });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/no encontrado/i);
  });

  // ── Caso 2: turno inexistente → 404 (mismo cuerpo que el caso anterior) ─
  it("turno inexistente devuelve 404 uniforme", async () => {
    const res = await publico(999_999_999, { dni: DNI_IOMA, token: "TOKEN-X" });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/no encontrado/i);
  });

  // ── Caso 3: agenda de guardia → 409 ────────────────────────────────────
  it("agenda de guardia devuelve 409", async () => {
    const res = await publico(turnoGuardiaId, { dni: DNI_IOMA, token: "TOKEN-X" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/guardia/i);
  });

  // ── Caso 4: agenda de práctica → 409 ────────────────────────────────────
  it("agenda de práctica devuelve 409", async () => {
    const res = await publico(turnoPracticaId, { dni: DNI_IOMA, token: "TOKEN-X" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/estudio|práctica|recepción/i);
  });

  // ── Caso 5: Pixel (enviaWorklist) → 409 ─────────────────────────────────
  it("agenda con enviaWorklist=true (Pixel) devuelve 409", async () => {
    const res = await publico(turnoPixelId, { dni: DNI_IOMA, token: "TOKEN-X" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/estudio|práctica|recepción/i);
  });

  // ── Caso 6: turno cancelado → 409 ───────────────────────────────────────
  it("turno cancelado devuelve 409", async () => {
    const res = await publico(turnoCanceladoId, { dni: DNI_IOMA, token: "TOKEN-X" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/vigente|cancel|anulad/i);
  });

  // ── Caso 7: turno finalizado → 409 ──────────────────────────────────────
  it("turno finalizado devuelve 409", async () => {
    const res = await publico(turnoFinalizadoId, { dni: DNI_IOMA, token: "TOKEN-X" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/vigente|finaliz/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Handler compartido: guardas internas (vía canal público) ──────────────
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /publico/turnos/:id/validar-token — guardas del handler compartido", () => {

  // ── Caso 8: cobertura no IOMA → 409 ─────────────────────────────────────
  // El handler compartido rechaza antes de llamar al Robot.
  // El turno PAMI tiene cobertura "PAMI" en la ficha del paciente.
  it("cobertura no IOMA devuelve 409", async () => {
    const res = await publico(turnoPamiId, { dni: DNI_PAMI, token: "TOKEN-X" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/cobertura|ioma/i);
  });

  // ── Caso 9: turno de otro día → 409 ─────────────────────────────────────
  // fecha "2020-01-01" nunca es hoy.
  it("turno de otro día devuelve 409", async () => {
    const res = await publico(turnoOtroDiaId, { dni: DNI_IOMA, token: "TOKEN-X" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/día|fecha|hoy/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Staff: no-regresión del flujo con token aceptado ──────────────────────
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /turnos/:id/validar-token (staff) — token aceptado", () => {

  // ── Caso 10 + 11: auditoría token_validado + recepción automática ────────
  it("TOKEN_ACCEPTED genera auditoría token_validado, recibe el turno en arribo y responde recepcionadoAutomatico:true", async () => {
    // El mock devuelve nroBono: "BONO-TEST-999" por defecto.
    const res = await staff(turnoStaffId, { token: "TOKEN-STAFF-001" });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      estado: string;
      nroBono: string | null;
      recepcionadoAutomatico: boolean;
    };

    // ── 13: TOKEN_ACCEPTED siempre con nroBono ──────────────────────────
    expect(body.estado).toBe("TOKEN_ACCEPTED");
    expect(body.nroBono).toBeTruthy();
    expect(body.nroBono).toBe("BONO-TEST-999");

    // ── 11b: recepcionadoAutomatico en respuesta ────────────────────────
    expect(body.recepcionadoAutomatico).toBe(true);

    // ── 10: auditoría "token_validado" en DB ────────────────────────────
    const auditorias = await db
      .select()
      .from(auditLogTable)
      .where(
        sql`${auditLogTable.entidadId} = ${turnoStaffId}
          AND ${auditLogTable.entidad} = 'turno'
          AND ${auditLogTable.accion} = 'token_validado'`,
      );
    expect(auditorias.length).toBeGreaterThanOrEqual(1);
    const audToken = auditorias[0]!;
    expect(audToken.usuarioEmail).toBe(`staff-checkin-${RUN_ID}@test.local`);

    // ── 11a: turno en estado "arribo" ───────────────────────────────────
    const [turnoActualizado] = await db
      .select({ estado: turnosTable.estado })
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoStaffId))
      .limit(1);
    expect(turnoActualizado?.estado).toBe("arribo");

    // ── 11c: auditoría "admitir" con motivo token_validado ──────────────
    const auditoriasAdmitir = await db
      .select()
      .from(auditLogTable)
      .where(
        sql`${auditLogTable.entidadId} = ${turnoStaffId}
          AND ${auditLogTable.entidad} = 'turno'
          AND ${auditLogTable.accion} = 'admitir'`,
      );
    expect(auditoriasAdmitir.length).toBeGreaterThanOrEqual(1);
    const audAdmitir = auditoriasAdmitir[0]!;
    const detalle = audAdmitir.detalle as Record<string, unknown>;
    expect(detalle.motivo).toBe("token_validado");
    expect(detalle.estadoNuevo).toBe("arribo");
  });

  // ── Caso 12: regla cardinal — nroBono null → NO TOKEN_ACCEPTED ──────────
  // Si el Robot devuelve nroBono:null (timeout, error técnico, etc.) la
  // respuesta nunca debe indicar que la consulta está habilitada.
  it("mock con nroBono null → respuesta NO es TOKEN_ACCEPTED (regla cardinal)", async () => {
    // Override one-shot: este test usa un turno aparte (turnoBaseId, todavía
    // pendiente) para no depender del estado de turnoStaffId (ya en arribo).
    // El mock devuelve nroBono:null para simular timeout/error técnico.
    mockAutorizarConsultaConToken.mockResolvedValueOnce({
      nroBono: null,
      resultado: "incierto" as const,
      detalle: "Klinicos está tardando (simulado para test de regla cardinal)",
    });

    const res = await staff(turnoBaseId, { token: "TOKEN-SIN-BONO-001" });
    // El endpoint responde 200 con estado ≠ TOKEN_ACCEPTED
    expect(res.status).toBe(200);
    const body = await res.json() as { estado: string; nroBono: string | null };

    // Regla cardinal: sin bono real → el estado no puede ser TOKEN_ACCEPTED
    expect(body.estado).not.toBe("TOKEN_ACCEPTED");
    expect(body.nroBono).toBeFalsy();
  });
});
