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
  profesionalesTable,
  especialidadesTable,
  turnerasTable,
  turnosTable,
  auditLogTable,
  klinicosTrabajos,
} from "@workspace/db";
import turnosRouter from "./turnos";
import salaEsperaRouter from "./sala_espera";
import recepcionRouter from "./recepcion";
import { hoyArgentina } from "../lib/tiempo";

// Tests del circuito de guardia (jul 2026):
// 1) Entrada directa a Esperando: POST /turnos en turnera esGuardia con fecha
//    de HOY crea el turno en estado "arribo" con admitidoEn/admitidoPor (sin
//    el paso Recepcionar). Con fecha futura, o en turnera común, queda
//    "pendiente" como siempre.
// 2) Visibilidad del rol médico: el alcance incluye TODAS las turneras de
//    guardia (aun desactivadas, con profesional NULL) en sala de espera,
//    planilla del día y guarda de operación (llamar).
// Crean sus propios datos (patrón RUN_ID) y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN_RECEP = `test-token-gc-recep-${RUN_ID}`;
const TOKEN_MEDICO = `test-token-gc-med-${RUN_ID}`;

let server: Server;
let baseUrl: string;

let especialidadId: number;
let profMedicoId: number;
let profOtroId: number;
let turneraGuardiaId: number; // esGuardia, INACTIVA, sin profesional
let turneraPropiaId: number; // del médico de test
let turneraAjenaId: number; // de otro profesional
let pacienteId: number;

const userIds: number[] = [];
const turnoIds: number[] = [];

// Turnos de la parte de visibilidad (creados directo en DB, fecha hoy)
let turnoGuardiaId: number;
let turnoPropioId: number;
let turnoAjenoId: number;

const MANANA = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];

async function crearUsuario(opts: {
  token: string;
  rol: string;
  profesionalId?: number;
}): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-gc-${crypto.randomBytes(4).toString("hex")}-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: `Test Guardia Circuito ${RUN_ID}`,
      rol: opts.rol,
      profesionalId: opts.profesionalId != null ? String(opts.profesionalId) : undefined,
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

function reservar(body: Record<string, unknown>, token = TOKEN_RECEP): Promise<Response> {
  return fetch(`${baseUrl}/api/turnos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ pacienteId, ...body }),
  });
}

// Slots distintos para no chocar con el índice único de slot activo.
let slotSeq = 0;
async function crearTurnoHoy(turneraId: number, opts: { profesionalId?: number } = {}): Promise<number> {
  const inicio = 8 * 60 + slotSeq * 15;
  slotSeq += 1;
  const hi = `${String(Math.floor(inicio / 60)).padStart(2, "0")}:${String(inicio % 60).padStart(2, "0")}`;
  const hf = `${String(Math.floor((inicio + 15) / 60)).padStart(2, "0")}:${String((inicio + 15) % 60).padStart(2, "0")}`;
  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      profesionalId: opts.profesionalId,
      fecha: hoyArgentina(),
      horaInicio: hi,
      horaFin: hf,
      estado: "arribo",
      admitidoEn: new Date(),
      admitidoPor: "test",
    })
    .returning();
  turnoIds.push(turno!.id);
  return turno!.id;
}

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", turnosRouter);
  app.use("/api", salaEsperaRouter);
  app.use("/api", recepcionRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [esp] = await db
    .insert(especialidadesTable)
    .values({ nombre: `Guardia Circuito Test ${RUN_ID}` })
    .returning();
  especialidadId = esp!.id;

  const [profMedico] = await db
    .insert(profesionalesTable)
    .values({
      nombre: "Test",
      apellido: `CircuitoMed${RUN_ID}`,
      especialidadId,
      atiendeGuardia: true,
      activo: true,
    })
    .returning();
  profMedicoId = profMedico!.id;

  const [profOtro] = await db
    .insert(profesionalesTable)
    .values({
      nombre: "Test",
      apellido: `CircuitoOtro${RUN_ID}`,
      especialidadId,
      activo: true,
    })
    .returning();
  profOtroId = profOtro!.id;

  // Turnera de guardia DESACTIVADA y sin profesional: el caso duro del
  // alcance (guardias duplicadas desactivadas que igual reciben pacientes).
  const [tGuardia] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Guardia Circuito Test ${RUN_ID}`,
      especialidadId,
      esGuardia: true,
      activa: false,
      duracionMinutos: 15,
    })
    .returning();
  turneraGuardiaId = tGuardia!.id;

  const [tPropia] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Propia Circuito Test ${RUN_ID}`,
      especialidadId,
      profesionalId: profMedicoId,
      activa: true,
      duracionMinutos: 30,
    })
    .returning();
  turneraPropiaId = tPropia!.id;

  const [tAjena] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Ajena Circuito Test ${RUN_ID}`,
      especialidadId,
      profesionalId: profOtroId,
      activa: true,
      duracionMinutos: 30,
    })
    .returning();
  turneraAjenaId = tAjena!.id;

  const [pac] = await db
    .insert(pacientesTable)
    .values({ nombre: "Circuito", apellido: `Test${RUN_ID}`, dni: `GC${RUN_ID}`, activo: true })
    .returning();
  pacienteId = pac!.id;

  await crearUsuario({ token: TOKEN_RECEP, rol: "recepcionista" });
  await crearUsuario({ token: TOKEN_MEDICO, rol: "medico", profesionalId: profMedicoId });

  // Fixtures de visibilidad: tres turnos de HOY en estado "arribo".
  turnoGuardiaId = await crearTurnoHoy(turneraGuardiaId); // sin profesional
  turnoPropioId = await crearTurnoHoy(turneraPropiaId);
  turnoAjenoId = await crearTurnoHoy(turneraAjenaId, { profesionalId: profOtroId });
});

afterAll(async () => {
  if (turnoIds.length > 0) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.entidadId, turnoIds));
    await db.execute(
      sql`DELETE FROM robot_turnos_eventos WHERE turno_id IN (${sql.join(turnoIds.map((id) => sql`${id}`), sql`, `)})`,
    );
  }
  await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.pacienteId, pacienteId));
  await db.delete(turnosTable).where(eq(turnosTable.pacienteId, pacienteId));
  await db
    .delete(turnerasTable)
    .where(inArray(turnerasTable.id, [turneraGuardiaId, turneraPropiaId, turneraAjenaId]));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  if (userIds.length > 0) {
    await db.delete(sesionesTable).where(inArray(sesionesTable.usuarioId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await db.delete(profesionalesTable).where(inArray(profesionalesTable.id, [profMedicoId, profOtroId]));
  await db.delete(especialidadesTable).where(eq(especialidadesTable.id, especialidadId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("POST /turnos — entrada directa a Esperando en guardia", () => {
  it("guardia con fecha de hoy entra directo en 'arribo' con admitidoEn/admitidoPor", async () => {
    const res = await reservar({
      turneraId: turneraGuardiaId,
      fecha: hoyArgentina(),
      horaInicio: "10:00",
      horaFin: "10:15",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: number;
      estado: string;
      admitidoEn: string | null;
      admitidoPor: string | null;
      profesionalId: number | null;
    };
    turnoIds.push(body.id);
    expect(body.estado).toBe("arribo");
    expect(body.admitidoEn).not.toBeNull();
    expect(body.admitidoPor).toBeTruthy();
    // La bolsa de guardia queda sin médico asignado.
    expect(body.profesionalId).toBeNull();
  });

  it("guardia con fecha futura queda 'pendiente' sin admisión", async () => {
    const res = await reservar({
      turneraId: turneraGuardiaId,
      fecha: MANANA,
      horaInicio: "10:00",
      horaFin: "10:15",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; estado: string; admitidoEn: string | null };
    turnoIds.push(body.id);
    expect(body.estado).toBe("pendiente");
    expect(body.admitidoEn).toBeNull();
  });

  it("turnera común queda 'pendiente' aunque la fecha sea de reserva normal", async () => {
    const res = await reservar({
      turneraId: turneraPropiaId,
      fecha: MANANA,
      horaInicio: "18:00",
      horaFin: "18:30",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; estado: string; admitidoEn: string | null };
    turnoIds.push(body.id);
    expect(body.estado).toBe("pendiente");
    expect(body.admitidoEn).toBeNull();
  });
});

describe("GET /sala-espera/cola — visibilidad del médico", () => {
  it("el médico ve el turno de guardia (turnera inactiva, sin profesional) y el propio, pero no el ajeno", async () => {
    const res = await fetch(`${baseUrl}/api/sala-espera/cola`, {
      headers: { Authorization: `Bearer ${TOKEN_MEDICO}` },
    });
    expect(res.status).toBe(200);
    const cola = (await res.json()) as Array<{ turnoId: number }>;
    const ids = cola.map((c) => c.turnoId);
    expect(ids).toContain(turnoGuardiaId);
    expect(ids).toContain(turnoPropioId);
    expect(ids).not.toContain(turnoAjenoId);
  });
});

describe("GET /recepcion/turnos-dia — visibilidad del médico", () => {
  it("la planilla del día del médico incluye guardia y propios, sin los ajenos", async () => {
    const res = await fetch(`${baseUrl}/api/recepcion/turnos-dia`, {
      headers: { Authorization: `Bearer ${TOKEN_MEDICO}` },
    });
    expect(res.status).toBe(200);
    const filas = (await res.json()) as Array<{ turnoId: number }>;
    const ids = filas.map((f) => f.turnoId);
    expect(ids).toContain(turnoGuardiaId);
    expect(ids).toContain(turnoPropioId);
    expect(ids).not.toContain(turnoAjenoId);
  });
});

describe("Guarda de operación (llamar) para el médico", () => {
  it("el médico puede llamar un turno de guardia sin médico asignado", async () => {
    const res = await fetch(`${baseUrl}/api/turnos/${turnoGuardiaId}/llamar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_MEDICO}` },
    });
    expect(res.status).toBe(200);
    const [turno] = await db
      .select({ estado: turnosTable.estado })
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoGuardiaId))
      .limit(1);
    expect(turno!.estado).toBe("llamado");
  });

  it("llamar un turno ajeno (no guardia, de otro profesional) da 403", async () => {
    const res = await fetch(`${baseUrl}/api/turnos/${turnoAjenoId}/llamar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_MEDICO}` },
    });
    expect(res.status).toBe(403);
  });
});
