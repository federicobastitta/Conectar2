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
  turnosTable,
  encountersTable,
  clinicalRecordsTable,
  auditLogTable,
} from "@workspace/db";
import consultorioDocsRouter from "./consultorio_docs";

// Al finalizar la consulta, el turno debe cerrarse (→ visto) aunque no haya
// pasado formalmente por "en_atencion": en guardia, "Llamar" no cambia el
// estado (queda en arribo/en_sala) y recepción seguía viendo "Esperando".

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TOKEN = `test-token-fin-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let especialidadId: number;
let turneraId: number;
let turneraInformeId: number;
let pacienteId: number;
let profesionalId: number;
let userId: number;
const turnoIds: number[] = [];

async function crearTurno(estado: string, enTurneraId?: number): Promise<number> {
  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId: enTurneraId ?? turneraId,
      pacienteId,
      profesionalId,
      fecha: "2099-02-01",
      horaInicio: `0${turnoIds.length}:00`.slice(-5),
      horaFin: `0${turnoIds.length}:59`.slice(-5),
      estado: estado as typeof turnosTable.$inferInsert.estado,
    })
    .returning();
  turnoIds.push(turno!.id);
  return turno!.id;
}

async function finalizar(turnoId: number): Promise<Response> {
  return fetch(`${baseUrl}/api/consultorio/consultas/finalizar`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ patientId: pacienteId, turnoId, diagnosis: `test ${RUN_ID}` }),
  });
}

async function estadoDe(turnoId: number): Promise<string> {
  const [t] = await db.select().from(turnosTable).where(eq(turnosTable.id, turnoId)).limit(1);
  return t!.estado;
}

beforeAll(async () => {
  const app = express();
  const silent = pino({ level: "silent" });
  app.use((req, _res, next) => {
    (req as unknown as { log: pino.Logger }).log = silent;
    next();
  });
  app.use(express.json());
  app.use("/api", consultorioDocsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [esp] = await db
    .insert(especialidadesTable)
    .values({ nombre: `FinEstado Test ${RUN_ID}` })
    .returning();
  especialidadId = esp!.id;

  const [prof] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Test", apellido: `FinEstado${RUN_ID}`, especialidadId, activo: true })
    .returning();
  profesionalId = prof!.id;

  const [turnera] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Turnera FinEstado ${RUN_ID}`,
      especialidadId,
      esGuardia: true,
      activa: true,
      llevaInforme: false,
    })
    .returning();
  turneraId = turnera!.id;

  const [turneraInf] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Turnera FinEstado Informe ${RUN_ID}`,
      especialidadId,
      esGuardia: false,
      activa: true,
      llevaInforme: true,
    })
    .returning();
  turneraInformeId = turneraInf!.id;

  const [pac] = await db
    .insert(pacientesTable)
    .values({ nombre: "Fin", apellido: `Estado${RUN_ID}`, dni: `F${RUN_ID}`, activo: true })
    .returning();
  pacienteId = pac!.id;

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `test-finestado-${RUN_ID}@test.local`,
      passwordHash: "irrelevante",
      nombre: "Test Medico FinEstado",
      rol: "medico",
      profesionalId: String(profesionalId),
    })
    .returning();
  userId = user!.id;
  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
});

afterAll(async () => {
  const [record] = await db
    .select()
    .from(clinicalRecordsTable)
    .where(eq(clinicalRecordsTable.patientId, pacienteId))
    .limit(1);
  if (record) {
    await db.delete(encountersTable).where(eq(encountersTable.clinicalRecordId, record.id));
    await db.delete(clinicalRecordsTable).where(eq(clinicalRecordsTable.id, record.id));
  }
  await db.delete(auditLogTable).where(eq(auditLogTable.pacienteId, pacienteId));
  if (turnoIds.length > 0) await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  await db.delete(turnerasTable).where(inArray(turnerasTable.id, [turneraId, turneraInformeId]));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(sesionesTable).where(eq(sesionesTable.usuarioId, userId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profesionalId));
  await db.delete(especialidadesTable).where(eq(especialidadesTable.id, especialidadId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("POST /consultorio/consultas/finalizar — cierre del turno", () => {
  it("cierra un turno en 'en_atencion' (flujo clásico)", async () => {
    const turnoId = await crearTurno("en_atencion");
    const res = await finalizar(turnoId);
    expect(res.status).toBe(201);
    expect(await estadoDe(turnoId)).toBe("visto");
  });

  it("cierra un turno que quedó en 'arribo' (guardia sin pasar por en_atencion)", async () => {
    const turnoId = await crearTurno("arribo");
    const res = await finalizar(turnoId);
    expect(res.status).toBe(201);
    expect(await estadoDe(turnoId)).toBe("visto");
  });

  it("cierra un turno en 'en_sala'", async () => {
    const turnoId = await crearTurno("en_sala");
    const res = await finalizar(turnoId);
    expect(res.status).toBe(201);
    expect(await estadoDe(turnoId)).toBe("visto");
  });

  it("cierra un turno en 'llamado'", async () => {
    const turnoId = await crearTurno("llamado");
    const res = await finalizar(turnoId);
    expect(res.status).toBe(201);
    expect(await estadoDe(turnoId)).toBe("visto");
  });

  it("con turnera que lleva informe, desde 'arribo' pasa a 'pendiente_informe'", async () => {
    const turnoId = await crearTurno("arribo", turneraInformeId);
    const res = await finalizar(turnoId);
    expect(res.status).toBe(201);
    expect(await estadoDe(turnoId)).toBe("pendiente_informe");
  });

  it("NO toca un turno ausente", async () => {
    const turnoId = await crearTurno("ausente");
    const res = await finalizar(turnoId);
    expect(res.status).toBe(201);
    expect(await estadoDe(turnoId)).toBe("ausente");
  });

  it("NO toca un turno cancelado", async () => {
    const turnoId = await crearTurno("cancelado");
    const res = await finalizar(turnoId);
    expect(res.status).toBe(201); // la consulta se registra igual
    expect(await estadoDe(turnoId)).toBe("cancelado");
  });
});
