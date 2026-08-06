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
  especialidadesTable,
  turnerasTable,
  turneraParticipantesTable,
  turnosTable,
  auditLogTable,
} from "@workspace/db";
import consultorioRouter from "./consultorio";

// Tests de integración de la "bolsa de pacientes" de guardia:
// - POST /api/consultorio/turnos/:id/tomar asigna atómicamente al médico
// - 409 si otro médico ya lo tomó
// - 403 si el médico no atiende guardia de esa especialidad
// - 400 si el turno no es de guardia
// - GET /api/consultorio/agenda: la bolsa solo muestra turnos sin tomar

const RUN_ID = crypto.randomBytes(6).toString("hex");

let server: Server;
let baseUrl: string;

let especialidadId: number;
let otraEspecialidadId: number;
let turneraGuardiaId: number;
let turneraComunId: number;
let pacienteId: number;
let profGuardiaAId: number;
let profGuardiaBId: number;
let profSinGuardiaId: number;

const TOKEN_MEDICO_A = `test-token-ga-${RUN_ID}`;
const TOKEN_MEDICO_B = `test-token-gb-${RUN_ID}`;
const TOKEN_MEDICO_OTRA = `test-token-go-${RUN_ID}`;

const userIds: number[] = [];
const turnoIds: number[] = [];

async function crearMedico(opts: {
  token: string;
  atiendeGuardia: boolean;
  especialidadId: number;
}): Promise<number> {
  const [prof] = await db
    .insert(profesionalesTable)
    .values({
      nombre: "Test",
      apellido: `Guardia${crypto.randomBytes(3).toString("hex")}`,
      especialidadId: opts.especialidadId,
      atiendeGuardia: opts.atiendeGuardia,
      activo: true,
    })
    .returning();

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-guardia-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: "Test Medico Guardia",
      rol: "medico",
      profesionalId: String(prof!.id),
    })
    .returning();
  userIds.push(user!.id);

  await db.insert(sesionesTable).values({
    token: opts.token,
    usuarioId: user!.id,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return prof!.id;
}

async function crearTurnoGuardia(): Promise<number> {
  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId: turneraGuardiaId,
      pacienteId,
      fecha: "2099-01-01",
      horaInicio: `0${turnoIds.length}:00`.slice(-5),
      horaFin: `0${turnoIds.length}:59`.slice(-5),
      estado: "pendiente",
    })
    .returning();
  turnoIds.push(turno!.id);
  return turno!.id;
}

function tomar(turnoId: number, token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/consultorio/turnos/${turnoId}/tomar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function agenda(token: string): Promise<{ turnos: Array<{ id: number; profesionalId: number | null }> }> {
  const res = await fetch(`${baseUrl}/api/consultorio/agenda?fecha=2099-01-01`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()) as { turnos: Array<{ id: number; profesionalId: number | null }> };
}

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", consultorioRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [esp] = await db
    .insert(especialidadesTable)
    .values({ nombre: `Guardia Test ${RUN_ID}` })
    .returning();
  especialidadId = esp!.id;
  const [espOtra] = await db
    .insert(especialidadesTable)
    .values({ nombre: `Otra Test ${RUN_ID}` })
    .returning();
  otraEspecialidadId = espOtra!.id;

  const [tGuardia] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Turnera Guardia Test ${RUN_ID}`,
      especialidadId,
      esGuardia: true,
      activa: true,
    })
    .returning();
  turneraGuardiaId = tGuardia!.id;

  const [tComun] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera Comun Test ${RUN_ID}`, especialidadId, activa: true })
    .returning();
  turneraComunId = tComun!.id;

  const [pac] = await db
    .insert(pacientesTable)
    .values({ nombre: "Guardia", apellido: `Test${RUN_ID}`, dni: `G${RUN_ID}`, activo: true })
    .returning();
  pacienteId = pac!.id;

  profGuardiaAId = await crearMedico({ token: TOKEN_MEDICO_A, atiendeGuardia: true, especialidadId });
  profGuardiaBId = await crearMedico({ token: TOKEN_MEDICO_B, atiendeGuardia: true, especialidadId });
  profSinGuardiaId = await crearMedico({
    token: TOKEN_MEDICO_OTRA,
    atiendeGuardia: true,
    especialidadId: otraEspecialidadId,
  });
});

afterAll(async () => {
  if (turnoIds.length > 0) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.entidadId, turnoIds));
    await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  }
  await db.delete(turnerasTable).where(inArray(turnerasTable.id, [turneraGuardiaId, turneraComunId]));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await db
    .delete(profesionalesTable)
    .where(inArray(profesionalesTable.id, [profGuardiaAId, profGuardiaBId, profSinGuardiaId]));
  await db
    .delete(especialidadesTable)
    .where(inArray(especialidadesTable.id, [especialidadId, otraEspecialidadId]));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("POST /api/consultorio/turnos/:id/tomar — bolsa de guardia", () => {
  it("sin token responde 401", async () => {
    const turnoId = await crearTurnoGuardia();
    const res = await fetch(`${baseUrl}/api/consultorio/turnos/${turnoId}/tomar`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("el médico de guardia toma el paciente y queda asignado", async () => {
    const turnoId = await crearTurnoGuardia();
    const res = await tomar(turnoId, TOKEN_MEDICO_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profesionalId: number };
    expect(body.profesionalId).toBe(profGuardiaAId);
  });

  it("el segundo médico recibe 409 si ya fue tomado", async () => {
    const turnoId = await crearTurnoGuardia();
    const primera = await tomar(turnoId, TOKEN_MEDICO_A);
    expect(primera.status).toBe(200);
    const segunda = await tomar(turnoId, TOKEN_MEDICO_B);
    expect(segunda.status).toBe(409);
  });

  it("médico de otra especialidad recibe 403", async () => {
    const turnoId = await crearTurnoGuardia();
    const res = await tomar(turnoId, TOKEN_MEDICO_OTRA);
    expect(res.status).toBe(403);
  });

  it("turno que no es de guardia responde 400", async () => {
    const [turno] = await db
      .insert(turnosTable)
      .values({
        turneraId: turneraComunId,
        pacienteId,
        fecha: "2099-01-01",
        horaInicio: "12:00",
        horaFin: "12:59",
        estado: "pendiente",
      })
      .returning();
    turnoIds.push(turno!.id);
    const res = await tomar(turno!.id, TOKEN_MEDICO_A);
    expect(res.status).toBe(400);
  });

  it("turno cancelado responde 400", async () => {
    const turnoId = await crearTurnoGuardia();
    await db.update(turnosTable).set({ estado: "cancelado" }).where(eq(turnosTable.id, turnoId));
    const res = await tomar(turnoId, TOKEN_MEDICO_A);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/consultorio/agenda — visibilidad de la bolsa", () => {
  it("un turno sin tomar aparece en la agenda de ambos médicos de guardia", async () => {
    const turnoId = await crearTurnoGuardia();
    const [a, b] = await Promise.all([agenda(TOKEN_MEDICO_A), agenda(TOKEN_MEDICO_B)]);
    expect(a.turnos.some((t) => t.id === turnoId)).toBe(true);
    expect(b.turnos.some((t) => t.id === turnoId)).toBe(true);
  });

  it("tras tomarlo, sigue visible para ambos (modo bolsa transitorio) pero asignado al que lo tomó", async () => {
    const turnoId = await crearTurnoGuardia();
    const res = await tomar(turnoId, TOKEN_MEDICO_A);
    expect(res.status).toBe(200);
    const [a, b] = await Promise.all([agenda(TOKEN_MEDICO_A), agenda(TOKEN_MEDICO_B)]);
    const enA = a.turnos.find((t) => t.id === turnoId);
    const enB = b.turnos.find((t) => t.id === turnoId);
    expect(enA).toBeTruthy();
    // Modo "bolsa de médicos": la agenda muestra todos los turnos del día,
    // pero el turno ya quedó asignado (profesionalId no nulo).
    expect(enB).toBeTruthy();
    expect(enB?.profesionalId).not.toBeNull();
  });
});

describe("Participación en la agenda grupal (sin lista de tildes)", () => {
  // La lista de participantes que administraba recepción ya no manda:
  // el criterio es por especialidad (atiende_guardia + misma especialidad),
  // aunque exista una lista vieja en la tabla.
  it("una lista vieja de participantes NO restringe: cualquier médico de la especialidad puede tomar", async () => {
    await db
      .insert(turneraParticipantesTable)
      .values({ turneraId: turneraGuardiaId, profesionalId: profGuardiaAId });
    try {
      const turnoId = await crearTurnoGuardia();

      const [a, b] = await Promise.all([agenda(TOKEN_MEDICO_A), agenda(TOKEN_MEDICO_B)]);
      expect(a.turnos.some((t) => t.id === turnoId)).toBe(true);
      expect(b.turnos.some((t) => t.id === turnoId)).toBe(true);

      // B no está en la lista vieja, pero es de la especialidad: puede tomar.
      const res = await tomar(turnoId, TOKEN_MEDICO_B);
      expect(res.status).toBe(200);
    } finally {
      await db
        .delete(turneraParticipantesTable)
        .where(eq(turneraParticipantesTable.turneraId, turneraGuardiaId));
    }
  });

  it("sin lista, el criterio por especialidad sigue funcionando", async () => {
    const turnoId = await crearTurnoGuardia();
    const res = await tomar(turnoId, TOKEN_MEDICO_B);
    expect(res.status).toBe(200);
  });
});
