import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sesionesTable,
  pacientesTable,
  turnerasTable,
  sedesTable,
  turnosTable,
  auditLogTable,
  klinicosTrabajos,
  profesionalesTable,
  consultoriosTable,
  turneraParticipantesTable,
} from "@workspace/db";
import salaEsperaRouter from "./sala_espera";
import { hoyArgentina } from "../lib/tiempo";

// Tests de integración contra la DB de desarrollo. Crean sus propios datos
// (usuario, sesión, paciente, turnera, turno) y los limpian al terminar.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const TEST_EMAIL = `test-sala-espera-${RUN_ID}@test.local`;
const TEST_DNI = `T${RUN_ID}`;
const TOKEN = `test-token-${RUN_ID}`;

let server: Server;
let baseUrl: string;
let userId: number;
let pacienteId: number;
let turneraId: number;
let turnoId: number;

function hoy(): string {
  // Debe coincidir con el "hoy" del server (hora argentina), no con la fecha UTC:
  // entre 21:00 y 24:00 AR difieren y los tests fallarían.
  return hoyArgentina();
}

// Cada turno usa un slot distinto: el índice único turnos_slot_activo_unique
// impide dos turnos activos en el mismo (turnera, fecha, horaInicio).
let slotSeq = 0;
async function crearTurnoPendiente(): Promise<number> {
  const inicio = 9 * 60 + slotSeq * 30;
  slotSeq += 1;
  const hi = `${String(Math.floor(inicio / 60)).padStart(2, "0")}:${String(inicio % 60).padStart(2, "0")}`;
  const hf = `${String(Math.floor((inicio + 30) / 60)).padStart(2, "0")}:${String((inicio + 30) % 60).padStart(2, "0")}`;
  const [turno] = await db
    .insert(turnosTable)
    .values({
      turneraId,
      pacienteId,
      fecha: hoy(),
      horaInicio: hi,
      horaFin: hf,
      estado: "pendiente",
    })
    .returning();
  return turno!.id;
}

beforeAll(async () => {
  // App mínima: solo el router de sala de espera, con logger silencioso
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

  // Usuario recepcionista + sesión válida (el auth hace fallback a la tabla sesiones)
  const [user] = await db
    .insert(usersTable)
    .values({
      email: TEST_EMAIL,
      passwordHash: "irrelevante",
      nombre: "Test Recepción",
      rol: "recepcionista",
    })
    .returning();
  userId = user!.id;

  await db.insert(sesionesTable).values({
    token: TOKEN,
    usuarioId: userId,
    activa: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  // Paciente con acento en el apellido para el test de unaccent
  const [paciente] = await db
    .insert(pacientesTable)
    .values({
      nombre: "Ana",
      apellido: `LópezTest${RUN_ID}`,
      dni: TEST_DNI,
      activo: true,
    })
    .returning();
  pacienteId = paciente!.id;

  const [turnera] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera Test ${RUN_ID}` })
    .returning();
  turneraId = turnera!.id;

  turnoId = await crearTurnoPendiente();
});

afterAll(async () => {
  await db.delete(auditLogTable).where(eq(auditLogTable.usuarioId, userId));
  // El hook de admitir encola trabajos Klinicos que referencian estos turnos
  await db.delete(klinicosTrabajos).where(eq(klinicosTrabajos.pacienteId, pacienteId));
  await db.delete(turnosTable).where(eq(turnosTable.pacienteId, pacienteId));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraId));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function admitir(id: number): Promise<Response> {
  return fetch(`${baseUrl}/api/turnos/${id}/admitir`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

describe("admisión concurrente", () => {
  it("dos admisiones simultáneas sobre el mismo turno: solo una gana, la otra recibe 422", async () => {
    const [res1, res2] = await Promise.all([admitir(turnoId), admitir(turnoId)]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 422]);

    const ganadora = res1.status === 200 ? res1 : res2;
    const perdedora = res1.status === 422 ? res1 : res2;

    const turnoActualizado = (await ganadora.json()) as { id: number; estado: string };
    expect(turnoActualizado.id).toBe(turnoId);
    expect(turnoActualizado.estado).toBe("arribo");

    const error = (await perdedora.json()) as { error: string };
    expect(error.error).toContain("Transición no permitida");

    // Estado final en DB: arribo (sin estados inválidos intermedios)
    const [turno] = await db
      .select()
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoId))
      .limit(1);
    expect(turno!.estado).toBe("arribo");
    expect(turno!.admitidoEn).not.toBeNull();
  });

  it("el audit_log registra exactamente una transición exitosa", async () => {
    const rows = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.accion, "admitir"),
          eq(auditLogTable.entidad, "turno"),
          eq(auditLogTable.entidadId, turnoId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usuarioId).toBe(userId);
    expect(rows[0]!.detalle).toMatchObject({
      estadoAnterior: "pendiente",
      estadoNuevo: "arribo",
    });
  });

  it("ráfaga de N admisiones concurrentes sobre un turno fresco: exactamente una gana", async () => {
    const turnoFresco = await crearTurnoPendiente();
    const respuestas = await Promise.all(
      Array.from({ length: 5 }, () => admitir(turnoFresco)),
    );
    const exitosas = respuestas.filter((r) => r.status === 200);
    const rechazadas = respuestas.filter((r) => r.status === 422);
    expect(exitosas).toHaveLength(1);
    expect(rechazadas).toHaveLength(4);

    const auditorias = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.accion, "admitir"),
          eq(auditLogTable.entidad, "turno"),
          eq(auditLogTable.entidadId, turnoFresco),
        ),
      );
    expect(auditorias).toHaveLength(1);
  });
});

describe("pantalla de sala (acceso público)", () => {
  it("responde 200 sin autenticación y solo expone nombre parcial", async () => {
    const res = await fetch(`${baseUrl}/api/sala-espera/pantalla`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      llamados: unknown[];
      enEspera: Array<{ paciente: string }>;
    };
    expect(Array.isArray(body.llamados)).toBe(true);
    expect(Array.isArray(body.enEspera)).toBe(true);
    // El paciente de prueba está en "arribo" (admitido en los tests anteriores):
    // por pedido del usuario, la pantalla muestra el nombre y apellido completos
    // Buscar por RUN_ID exacto: puede haber pacientes de otras corridas de
    // tests (paralelas o abortadas) que también empiecen con "Ana ".
    const item = body.enEspera.find((p) => p.paciente === `Ana LópezTest${RUN_ID}`);
    expect(item).toBeTruthy();
  });
});

describe("búsqueda insensible a acentos (unaccent)", () => {
  it("la extensión unaccent está disponible en la DB", async () => {
    // Falla explícitamente si la extensión no está instalada
    const result = await db.execute("SELECT unaccent('López') AS sin_acentos");
    const rows = result.rows as Array<{ sin_acentos: string }>;
    expect(rows[0]!.sin_acentos).toBe("Lopez");
  });

  it('"lopeztest" (sin acento) encuentra al paciente "LópezTest"', async () => {
    const res = await fetch(
      `${baseUrl}/api/admision/buscar?q=${encodeURIComponent(`lopeztest${RUN_ID}`)}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const resultados = (await res.json()) as Array<{ paciente: { id: number; apellido: string } }>;
    const encontrado = resultados.find((r) => r.paciente.id === pacienteId);
    expect(encontrado).toBeDefined();
    expect(encontrado!.paciente.apellido).toBe(`LópezTest${RUN_ID}`);
  });

  it('"LÓPEZTEST" (mayúsculas con acento) también lo encuentra', async () => {
    const res = await fetch(
      `${baseUrl}/api/admision/buscar?q=${encodeURIComponent(`LÓPEZTEST${RUN_ID}`)}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const resultados = (await res.json()) as Array<{ paciente: { id: number } }>;
    expect(resultados.some((r) => r.paciente.id === pacienteId)).toBe(true);
  });
});

describe("pantalla de sala filtrada por turnera y sede", () => {
  type Pantalla = {
    llamados: Array<{ turnoId: number; turneraNombre: string }>;
    enEspera: Array<{ turnoId: number; turneraNombre: string }>;
    filtroNombre: string | null;
  };

  let sedeId: number;
  let turneraConSedeId: number;
  let turnoLlamadoId: number;
  let turnoEsperaId: number;

  beforeAll(async () => {
    const [sede] = await db
      .insert(sedesTable)
      .values({ nombre: `Sede Test ${RUN_ID}` })
      .returning();
    sedeId = sede!.id;

    const [turnera] = await db
      .insert(turnerasTable)
      .values({ nombre: `Turnera Sede Test ${RUN_ID}`, sedeId })
      .returning();
    turneraConSedeId = turnera!.id;

    // Turno llamado en la turnera con sede
    const [llamado] = await db
      .insert(turnosTable)
      .values({
        turneraId: turneraConSedeId,
        pacienteId,
        fecha: hoy(),
        horaInicio: "10:00",
        horaFin: "10:30",
        estado: "llamado",
        llamadoEn: new Date(),
      })
      .returning();
    turnoLlamadoId = llamado!.id;

    // Turno en espera en la turnera original (sin sede)
    const [espera] = await db
      .insert(turnosTable)
      .values({
        turneraId,
        pacienteId,
        fecha: hoy(),
        horaInicio: "10:30",
        horaFin: "11:00",
        estado: "arribo",
        admitidoEn: new Date(),
      })
      .returning();
    turnoEsperaId = espera!.id;
  });

  afterAll(async () => {
    await db.delete(turnosTable).where(inArray(turnosTable.id, [turnoLlamadoId, turnoEsperaId]));
    await db.delete(turnerasTable).where(eq(turnerasTable.id, turneraConSedeId));
    await db.delete(sedesTable).where(eq(sedesTable.id, sedeId));
  });

  async function pantalla(query = ""): Promise<Pantalla> {
    const res = await fetch(`${baseUrl}/api/sala-espera/pantalla${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Pantalla;
  }

  it("sin filtro incluye ambos turnos y filtroNombre es null", async () => {
    const data = await pantalla();
    expect(data.filtroNombre).toBeNull();
    expect(data.llamados.some((l) => l.turnoId === turnoLlamadoId)).toBe(true);
    expect(data.enEspera.some((e) => e.turnoId === turnoEsperaId)).toBe(true);
  });

  it("?turneraId= muestra solo esa turnera y devuelve su nombre", async () => {
    const data = await pantalla(`?turneraId=${turneraConSedeId}`);
    expect(data.filtroNombre).toBe(`Turnera Sede Test ${RUN_ID}`);
    expect(data.llamados.some((l) => l.turnoId === turnoLlamadoId)).toBe(true);
    expect(data.enEspera.some((e) => e.turnoId === turnoEsperaId)).toBe(false);
  });

  it("?sedeId= muestra solo las turneras de esa sede y devuelve su nombre", async () => {
    const data = await pantalla(`?sedeId=${sedeId}`);
    expect(data.filtroNombre).toBe(`Sede Test ${RUN_ID}`);
    expect(data.llamados.some((l) => l.turnoId === turnoLlamadoId)).toBe(true);
    expect(data.enEspera.some((e) => e.turnoId === turnoEsperaId)).toBe(false);
  });

  it("un filtro inválido se ignora (no rompe la pantalla)", async () => {
    const data = await pantalla("?turneraId=abc");
    expect(data.filtroNombre).toBeNull();
    expect(data.llamados.some((l) => l.turnoId === turnoLlamadoId)).toBe(true);
    expect(data.enEspera.some((e) => e.turnoId === turnoEsperaId)).toBe(true);
  });
});

describe("consultorio del médico que llamó (guardia / demanda espontánea)", () => {
  type Pantalla = {
    llamados: Array<{
      turnoId: number;
      profesionalNombre: string | null;
      consultorioNombre: string | null;
      turneraNombre: string;
    }>;
  };

  const TOKEN_MEDICO = `test-token-medico-${RUN_ID}`;
  const TOKEN_MEDICO_SIN = `test-token-medico-sin-${RUN_ID}`;
  let consultorioId: number;
  let medicoProfId: number;
  let medicoSinProfId: number;
  let medicoUserId: number;
  let medicoSinUserId: number;
  let guardiaId: number;
  let turnoGuardiaId: number;
  let turnoGuardia2Id: number;

  beforeAll(async () => {
    const [consultorio] = await db
      .insert(consultoriosTable)
      .values({ nombre: `Consultorio Test ${RUN_ID}` })
      .returning();
    consultorioId = consultorio!.id;

    const [prof] = await db
      .insert(profesionalesTable)
      .values({ nombre: "Guardia", apellido: `MédicoTest${RUN_ID}`, consultorioId })
      .returning();
    medicoProfId = prof!.id;

    const [profSin] = await db
      .insert(profesionalesTable)
      .values({ nombre: "Guardia", apellido: `SinConsultorio${RUN_ID}` })
      .returning();
    medicoSinProfId = profSin!.id;

    const [medicoUser] = await db
      .insert(usersTable)
      .values({
        email: `test-medico-${RUN_ID}@test.local`,
        passwordHash: "irrelevante",
        nombre: "Test Médico",
        rol: "medico",
        profesionalId: String(medicoProfId),
      })
      .returning();
    medicoUserId = medicoUser!.id;

    const [medicoSinUser] = await db
      .insert(usersTable)
      .values({
        email: `test-medico-sin-${RUN_ID}@test.local`,
        passwordHash: "irrelevante",
        nombre: "Test Médico Sin Consultorio",
        rol: "medico",
        profesionalId: String(medicoSinProfId),
      })
      .returning();
    medicoSinUserId = medicoSinUser!.id;

    await db.insert(sesionesTable).values([
      {
        token: TOKEN_MEDICO,
        usuarioId: medicoUserId,
        activa: true,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        token: TOKEN_MEDICO_SIN,
        usuarioId: medicoSinUserId,
        activa: true,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ]);

    // Turnera de guardia: sin profesional titular, ambos médicos participan
    const [guardia] = await db
      .insert(turnerasTable)
      .values({ nombre: `Guardia Test ${RUN_ID}`, esGuardia: true })
      .returning();
    guardiaId = guardia!.id;
    await db.insert(turneraParticipantesTable).values([
      { turneraId: guardiaId, profesionalId: medicoProfId },
      { turneraId: guardiaId, profesionalId: medicoSinProfId },
    ]);

    // Turnos de demanda espontánea: sin profesional propio, ya en sala
    const [t1] = await db
      .insert(turnosTable)
      .values({
        turneraId: guardiaId,
        pacienteId,
        fecha: hoy(),
        horaInicio: "11:00",
        horaFin: "11:30",
        estado: "arribo",
        admitidoEn: new Date(),
      })
      .returning();
    turnoGuardiaId = t1!.id;
    const [t2] = await db
      .insert(turnosTable)
      .values({
        turneraId: guardiaId,
        pacienteId,
        fecha: hoy(),
        horaInicio: "11:30",
        horaFin: "12:00",
        estado: "arribo",
        admitidoEn: new Date(),
      })
      .returning();
    turnoGuardia2Id = t2!.id;
  });

  afterAll(async () => {
    await db.delete(auditLogTable).where(
      inArray(auditLogTable.usuarioId, [medicoUserId, medicoSinUserId]),
    );
    await db.delete(turnosTable).where(
      inArray(turnosTable.id, [turnoGuardiaId, turnoGuardia2Id]),
    );
    await db.delete(turneraParticipantesTable).where(
      eq(turneraParticipantesTable.turneraId, guardiaId),
    );
    await db.delete(turnerasTable).where(eq(turnerasTable.id, guardiaId));
    await db.delete(sesionesTable).where(
      inArray(sesionesTable.token, [TOKEN_MEDICO, TOKEN_MEDICO_SIN]),
    );
    await db.delete(usersTable).where(inArray(usersTable.id, [medicoUserId, medicoSinUserId]));
    await db.delete(profesionalesTable).where(
      inArray(profesionalesTable.id, [medicoProfId, medicoSinProfId]),
    );
    await db.delete(consultoriosTable).where(eq(consultoriosTable.id, consultorioId));
  });

  async function pantallaGuardia(): Promise<Pantalla> {
    const res = await fetch(`${baseUrl}/api/sala-espera/pantalla?turneraId=${guardiaId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Pantalla;
  }

  it("médico de guardia llama y la pantalla muestra su consultorio", async () => {
    const res = await fetch(`${baseUrl}/api/turnos/${turnoGuardiaId}/llamar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_MEDICO}` },
    });
    expect(res.status).toBe(200);

    const [turno] = await db
      .select()
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoGuardiaId))
      .limit(1);
    expect(turno!.llamadoPorProfesionalId).toBe(medicoProfId);

    const data = await pantallaGuardia();
    const llamado = data.llamados.find((l) => l.turnoId === turnoGuardiaId);
    expect(llamado).toBeTruthy();
    expect(llamado!.consultorioNombre).toBe(`Consultorio Test ${RUN_ID}`);
    expect(llamado!.profesionalNombre).toContain(`MédicoTest${RUN_ID}`);
  });

  it("médico sin consultorio configurado: la pantalla muestra la agenda, sin error", async () => {
    const res = await fetch(`${baseUrl}/api/turnos/${turnoGuardia2Id}/llamar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_MEDICO_SIN}` },
    });
    expect(res.status).toBe(200);

    const data = await pantallaGuardia();
    const llamado = data.llamados.find((l) => l.turnoId === turnoGuardia2Id);
    expect(llamado).toBeTruthy();
    expect(llamado!.consultorioNombre).toBeNull();
    expect(llamado!.turneraNombre).toBe(`Guardia Test ${RUN_ID}`);
  });

  it("paciente llamado por un médico queda EN CONSULTA: ni staff ni otro médico pueden re-llamarlo", async () => {
    // El primer test lo llamó el médico ⇒ estado "llamado" + bloqueado.
    const [antes] = await db
      .select()
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoGuardiaId))
      .limit(1);
    expect(antes!.estado).toBe("llamado");
    expect(antes!.llamadoPorProfesionalId).toBe(medicoProfId);

    // Staff no puede re-llamar mientras está en consulta con un médico.
    const resStaff = await fetch(`${baseUrl}/api/turnos/${turnoGuardiaId}/llamar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resStaff.status).toBe(409);

    // Otro médico tampoco.
    const resOtro = await fetch(`${baseUrl}/api/turnos/${turnoGuardiaId}/llamar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_MEDICO_SIN}` },
    });
    expect(resOtro.status).toBe(409);

    // El mismo médico sí puede volver a llamarlo (re-anuncio en la TV).
    const resMismo = await fetch(`${baseUrl}/api/turnos/${turnoGuardiaId}/llamar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_MEDICO}` },
    });
    expect(resMismo.status).toBe(200);

    const [turno] = await db
      .select()
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoGuardiaId))
      .limit(1);
    expect(turno!.llamadoPorProfesionalId).toBe(medicoProfId);
  });

  it("recepción destraba al paciente EN CONSULTA: devolver-sala → en_sala y limpia el bloqueo", async () => {
    // Sigue "llamado" y bloqueado por el médico (tests anteriores).
    // Un médico DISTINTO al que llamó NO puede devolverlo (no es su llamado).
    const resMedicoAjeno = await fetch(`${baseUrl}/api/turnos/${turnoGuardiaId}/devolver-sala`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_MEDICO_SIN}` },
    });
    expect(resMedicoAjeno.status).toBe(422);

    // El médico que lo llamó SÍ puede deshacer su propio llamado (ago 2026).
    const resMedico = await fetch(`${baseUrl}/api/turnos/${turnoGuardiaId}/devolver-sala`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_MEDICO}` },
    });
    expect(resMedico.status).toBe(200);
    const [turnoDevuelto] = await db
      .select()
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoGuardiaId))
      .limit(1);
    expect(turnoDevuelto!.estado).toBe("en_sala");
    expect(turnoDevuelto!.llamadoPorProfesionalId).toBeNull();

    // Lo vuelve a llamar para probar el destrabe por parte de recepción.
    const resReLlamar = await fetch(`${baseUrl}/api/turnos/${turnoGuardiaId}/llamar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_MEDICO}` },
    });
    expect(resReLlamar.status).toBe(200);

    // Staff lo devuelve a la sala de espera con un clic.
    const res = await fetch(`${baseUrl}/api/turnos/${turnoGuardiaId}/devolver-sala`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);

    const [turno] = await db
      .select()
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoGuardiaId))
      .limit(1);
    expect(turno!.estado).toBe("en_sala");
    expect(turno!.llamadoPorProfesionalId).toBeNull();
    expect(turno!.llamadoEn).toBeNull();

    // Ya no está "llamado": repetir la acción es una transición inválida.
    const resRepetido = await fetch(`${baseUrl}/api/turnos/${turnoGuardiaId}/devolver-sala`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resRepetido.status).toBe(422);

    // Y cualquier médico puede volver a llamarlo.
    const resLlamar = await fetch(`${baseUrl}/api/turnos/${turnoGuardiaId}/llamar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_MEDICO_SIN}` },
    });
    expect(resLlamar.status).toBe(200);
  });
});

describe("reprogramar turno", () => {
  const TOKEN_PACIENTE = `test-token-paciente-${RUN_ID}`;
  const TOKEN_OTRO_PACIENTE = `test-token-otro-paciente-${RUN_ID}`;
  let pacienteUserId: number;
  let otroPacienteId: number;
  let otroPacienteUserId: number;

  // Próximo día hábil (lunes a viernes, default de diasAtencion de la turnera)
  function proximoDiaHabil(saltearDias = 0): string {
    const d = new Date();
    let habilesEncontrados = -1;
    for (let i = 1; i <= 30; i++) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow >= 1 && dow <= 5) {
        habilesEncontrados++;
        if (habilesEncontrados === saltearDias) {
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        }
      }
    }
    throw new Error("Sin día hábil en rango");
  }

  function proximoDomingo(): string {
    const d = new Date();
    for (let i = 1; i <= 8; i++) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() === 0) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      }
    }
    throw new Error("Sin domingo en rango");
  }

  async function crearTurnoFuturo(hora = "09:00", estado = "pendiente"): Promise<number> {
    const [h, m] = hora.split(":").map(Number);
    const fin = h! * 60 + m! + 30;
    const [turno] = await db
      .insert(turnosTable)
      .values({
        turneraId,
        pacienteId,
        fecha: proximoDiaHabil(),
        horaInicio: hora,
        horaFin: `${String(Math.floor(fin / 60)).padStart(2, "0")}:${String(fin % 60).padStart(2, "0")}`,
        estado,
      })
      .returning();
    return turno!.id;
  }

  function reprogramar(
    id: number,
    body: { fecha: string; horaInicio: string },
    token = TOKEN,
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/turnos/${id}/reprogramar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    // Usuario paciente dueño del paciente de prueba
    const [pacUser] = await db
      .insert(usersTable)
      .values({
        email: `test-paciente-${RUN_ID}@test.local`,
        passwordHash: "irrelevante",
        nombre: "Test Paciente",
        rol: "paciente",
        pacienteId: String(pacienteId),
      })
      .returning();
    pacienteUserId = pacUser!.id;
    await db.insert(sesionesTable).values({
      token: TOKEN_PACIENTE,
      usuarioId: pacienteUserId,
      activa: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    // Otro paciente con su propio usuario (para el test de ownership)
    const [otroPac] = await db
      .insert(pacientesTable)
      .values({ nombre: "Otro", apellido: `PacTest${RUN_ID}`, dni: `O${RUN_ID}`, activo: true })
      .returning();
    otroPacienteId = otroPac!.id;
    const [otroUser] = await db
      .insert(usersTable)
      .values({
        email: `test-otro-paciente-${RUN_ID}@test.local`,
        passwordHash: "irrelevante",
        nombre: "Otro Paciente",
        rol: "paciente",
        pacienteId: String(otroPacienteId),
      })
      .returning();
    otroPacienteUserId = otroUser!.id;
    await db.insert(sesionesTable).values({
      token: TOKEN_OTRO_PACIENTE,
      usuarioId: otroPacienteUserId,
      activa: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  afterAll(async () => {
    await db
      .delete(auditLogTable)
      .where(inArray(auditLogTable.usuarioId, [pacienteUserId, otroPacienteUserId]));
    await db
      .delete(sesionesTable)
      .where(inArray(sesionesTable.token, [TOKEN_PACIENTE, TOKEN_OTRO_PACIENTE]));
    await db.delete(usersTable).where(inArray(usersTable.id, [pacienteUserId, otroPacienteUserId]));
    await db.delete(pacientesTable).where(eq(pacientesTable.id, otroPacienteId));
  });

  it("el paciente reprograma su turno: viejo cancelado + nuevo pendiente, atómico y auditado", async () => {
    const turnoOriginal = await crearTurnoFuturo("09:00");
    const nuevaFecha = proximoDiaHabil(1);
    const res = await reprogramar(turnoOriginal, { fecha: nuevaFecha, horaInicio: "10:00" }, TOKEN_PACIENTE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      turnoAnterior: { id: number; estado: string };
      turnoNuevo: { id: number; estado: string; fecha: string; horaInicio: string; pacienteId: number };
    };
    expect(body.turnoAnterior.id).toBe(turnoOriginal);
    expect(body.turnoAnterior.estado).toBe("cancelado");
    expect(body.turnoNuevo.estado).toBe("pendiente");
    expect(body.turnoNuevo.fecha).toBe(nuevaFecha);
    expect(body.turnoNuevo.horaInicio).toBe("10:00");
    expect(body.turnoNuevo.pacienteId).toBe(pacienteId);

    // Auditoría: cancelación del viejo + creación del nuevo
    const auditsViejo = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.accion, "reprogramar_cancelacion"),
          eq(auditLogTable.entidadId, turnoOriginal),
        ),
      );
    expect(auditsViejo).toHaveLength(1);
    const auditsNuevo = await db
      .select()
      .from(auditLogTable)
      .where(
        and(eq(auditLogTable.accion, "reprogramar"), eq(auditLogTable.entidadId, body.turnoNuevo.id)),
      );
    expect(auditsNuevo).toHaveLength(1);
    expect(auditsNuevo[0]!.detalle).toMatchObject({
      turnoAnteriorId: turnoOriginal,
      origen: "portal_paciente",
    });
  });

  it("si el slot destino está ocupado responde 409 y el turno original NO se cancela (rollback)", async () => {
    const fechaDestino = proximoDiaHabil(2);
    // Ocupamos el slot destino
    await db.insert(turnosTable).values({
      turneraId,
      pacienteId,
      fecha: fechaDestino,
      horaInicio: "11:00",
      horaFin: "11:30",
      estado: "reservado",
    });

    const turnoOriginal = await crearTurnoFuturo("12:00");
    const res = await reprogramar(turnoOriginal, { fecha: fechaDestino, horaInicio: "11:00" });
    expect(res.status).toBe(409);

    const [original] = await db
      .select({ estado: turnosTable.estado })
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoOriginal))
      .limit(1);
    expect(original!.estado).toBe("pendiente");
  });

  it("un paciente NO puede reprogramar el turno de otro paciente (403)", async () => {
    const turnoAjeno = await crearTurnoFuturo("13:00");
    const res = await reprogramar(
      turnoAjeno,
      { fecha: proximoDiaHabil(1), horaInicio: "13:30" },
      TOKEN_OTRO_PACIENTE,
    );
    expect(res.status).toBe(403);
  });

  it("un turno ya atendido no se puede reprogramar (422)", async () => {
    const turnoAtendido = await crearTurnoFuturo("14:00", "atendido");
    const res = await reprogramar(turnoAtendido, { fecha: proximoDiaHabil(1), horaInicio: "14:30" });
    expect(res.status).toBe(422);
  });

  it("no se puede reprogramar a un día que la turnera no atiende (422)", async () => {
    const turno = await crearTurnoFuturo("15:00");
    const res = await reprogramar(turno, { fecha: proximoDomingo(), horaInicio: "15:00" });
    expect(res.status).toBe(422);
  });

  it("no se puede reprogramar a un horario fuera de la grilla de la turnera (422)", async () => {
    const turno = await crearTurnoFuturo("16:00");
    const res = await reprogramar(turno, { fecha: proximoDiaHabil(1), horaInicio: "16:17" });
    expect(res.status).toBe(422);
  });

  it("sin autenticación responde 401", async () => {
    const turno = await crearTurnoFuturo("17:00");
    const res = await fetch(`${baseUrl}/api/turnos/${turno}/reprogramar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fecha: proximoDiaHabil(1), horaInicio: "17:30" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("marcas de color en recepción", () => {
  const TOKEN_ADMIN = `test-token-admin-${RUN_ID}`;
  let adminId: number;

  beforeAll(async () => {
    const [admin] = await db
      .insert(usersTable)
      .values({
        email: `test-sala-admin-${RUN_ID}@test.local`,
        passwordHash: "irrelevante",
        nombre: "Test Admin",
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
    await db.delete(sesionesTable).where(eq(sesionesTable.token, TOKEN_ADMIN));
    await db.delete(usersTable).where(eq(usersTable.id, adminId));
  });

  function admitirCon(id: number, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/api/turnos/${id}/admitir`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function descolorear(id: number, token: string): Promise<Response> {
    return fetch(`${baseUrl}/api/turnos/${id}/descolorear`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("admitir una consulta sin token validado marca naranja y registra quién recepcionó", async () => {
    const turno = await crearTurnoPendiente();
    const res = await admitir(turno);
    expect(res.status).toBe(200);
    const [row] = await db.select().from(turnosTable).where(eq(turnosTable.id, turno)).limit(1);
    expect(row!.marcaColor).toBe("naranja");
    expect(row!.admitidoPor).toBe("Test Recepción");
  });

  it("admitir con tokenPorKlinicos marca amarillo y no exige código de supervisor", async () => {
    const turno = await crearTurnoPendiente();
    const res = await admitirCon(turno, { tokenPorKlinicos: true });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(turnosTable).where(eq(turnosTable.id, turno)).limit(1);
    expect(row!.marcaColor).toBe("amarillo");
  });

  it("un recepcionista NO puede descolorear (403)", async () => {
    const turno = await crearTurnoPendiente();
    await admitir(turno);
    const res = await descolorear(turno, TOKEN);
    expect(res.status).toBe(403);
  });

  it("un admin descolorea y la marca desaparece", async () => {
    const turno = await crearTurnoPendiente();
    await admitir(turno);
    const res = await descolorear(turno, TOKEN_ADMIN);
    expect(res.status).toBe(200);
    const [row] = await db.select().from(turnosTable).where(eq(turnosTable.id, turno)).limit(1);
    expect(row!.marcaColor).toBeNull();
  });

  it("descolorear un turno sin marca responde 422", async () => {
    const turno = await crearTurnoPendiente();
    const res = await descolorear(turno, TOKEN_ADMIN);
    expect(res.status).toBe(422);
  });
});
