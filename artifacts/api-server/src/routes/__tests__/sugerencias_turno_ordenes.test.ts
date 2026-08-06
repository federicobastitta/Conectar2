import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import type { Server } from "node:http";
import { eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import {
  db,
  practicasCatalogoTable,
  ordenesPracticasTable,
  ordenesPracticasLogTable,
  pacientesTable,
  profesionalesTable,
  turnerasTable,
  turneraPracticasTable,
  turnosTable,
} from "@workspace/db";
import app from "../../app";
import { hoyArgentina } from "../../lib/tiempo";

// Tests de sugerencias de turno y asignación de turno desde órdenes de práctica.
// Cubren: tipo=opciones con slots reales, tipo=demanda_espontanea (guardia),
// tipo=sin_agenda, asignación exitosa (turno_id + log) y 409 en doble asignación.
// Siembran sus propios datos (RUN_ID) y limpian todo al terminar.

const ADMIN_EMAIL = "admin@diagnosticar.ar";
const ADMIN_PASS = "admin123";

const RUN_ID = crypto.randomBytes(6).toString("hex");
// Códigos de nomenclador numéricos únicos por corrida (evita colisiones en la
// DB compartida): 6 dígitos que arrancan en 9 y salen de bytes aleatorios.
const NUM_PROGRAMADA = String(900000 + (crypto.randomBytes(3).readUIntBE(0, 3) % 33333));
const NUM_GUARDIA = String(933334 + (crypto.randomBytes(3).readUIntBE(0, 3) % 33333));
const NUM_SIN_AGENDA = String(966667 + (crypto.randomBytes(3).readUIntBE(0, 3) % 33333));

let adminToken: string;
let server: Server;
let prevPort: string | undefined;

let pacienteId: number;
let profesionalId: number;
let practicaProgramadaId: number;
let practicaGuardiaId: number;
let practicaSinAgendaId: number;
let turneraProgramadaId: number;
let turneraGuardiaId: number;

const ordenesCreadas: number[] = [];

beforeAll(async () => {
  // El endpoint de asignación crea el turno vía POST /api/turnos interno
  // contra http://localhost:$PORT — levantamos la app en un puerto efímero y
  // apuntamos PORT ahí para que el fetch interno caiga en este mismo proceso.
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Sin puerto asignado");
  prevPort = process.env.PORT;
  process.env.PORT = String(address.port);

  const login = await request(app).post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
  expect(login.status).toBe(200);
  adminToken = login.body.token as string;
  expect(adminToken).toBeTruthy();

  const [pac] = await db
    .insert(pacientesTable)
    .values({ nombre: "Sugerencia", apellido: `Test${RUN_ID}`, dni: `S${RUN_ID}`, activo: true })
    .returning();
  pacienteId = pac!.id;

  const [prof] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Solicitante", apellido: `Test${RUN_ID}`, matricula: `SUG-${RUN_ID}` })
    .returning();
  profesionalId = prof!.id;

  // Prácticas del catálogo — el código numérico embebido es lo que matchea
  // contra turnera_practicas.codigo. Nombres únicos para no matchear por
  // descripción con datos ajenos.
  const [pProg] = await db
    .insert(practicasCatalogoTable)
    .values({
      codigo: `SUGT-${NUM_PROGRAMADA}`,
      nombre: `Práctica sugerencias programada ${RUN_ID}`,
      especialidad: "CARDIOLOGIA",
      categoria: "cardiologia",
      generaDicom: false, // defensa en profundidad: estas prácticas de test no deben ir al PACS
    })
    .returning();
  practicaProgramadaId = pProg!.id;

  const [pGua] = await db
    .insert(practicasCatalogoTable)
    .values({
      codigo: `SUGT-${NUM_GUARDIA}`,
      nombre: `Práctica sugerencias guardia ${RUN_ID}`,
      especialidad: "CARDIOLOGIA",
      categoria: "cardiologia",
      generaDicom: false, // defensa en profundidad: estas prácticas de test no deben ir al PACS
    })
    .returning();
  practicaGuardiaId = pGua!.id;

  const [pSin] = await db
    .insert(practicasCatalogoTable)
    .values({
      codigo: `SUGT-${NUM_SIN_AGENDA}`,
      nombre: `Práctica sugerencias sin agenda ${RUN_ID}`,
      especialidad: "CARDIOLOGIA",
      categoria: "cardiologia",
      generaDicom: false, // defensa en profundidad: estas prácticas de test no deben ir al PACS
    })
    .returning();
  practicaSinAgendaId = pSin!.id;

  // Turnera programada: atiende todos los días para que siempre haya slots
  // dentro de la ventana de 30 días de las sugerencias.
  const [tProg] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Turnera Sugerencias Prog ${RUN_ID}`,
      diasAtencion: "0,1,2,3,4,5,6",
      horaInicio: "08:00",
      horaFin: "12:00",
      duracionMinutos: 30,
      activa: true,
    })
    .returning();
  turneraProgramadaId = tProg!.id;
  await db.insert(turneraPracticasTable).values({
    turneraId: turneraProgramadaId,
    codigo: NUM_PROGRAMADA,
    descripcion: `Sugerencias prog ${RUN_ID}`,
  });

  // Turnera de guardia (demanda espontánea) — única compatible con su práctica.
  const [tGua] = await db
    .insert(turnerasTable)
    .values({
      nombre: `Turnera Sugerencias Guardia ${RUN_ID}`,
      esGuardia: true,
      activa: true,
    })
    .returning();
  turneraGuardiaId = tGua!.id;
  await db.insert(turneraPracticasTable).values({
    turneraId: turneraGuardiaId,
    codigo: NUM_GUARDIA,
    descripcion: `Sugerencias guardia ${RUN_ID}`,
  });
});

afterAll(async () => {
  // Las reservas encolan trabajos Klinicos en segundo plano (fire-and-forget):
  // borrarlos antes que los turnos evita la violación de FK intermitente.
  await db.execute(
    sql`DELETE FROM klinicos_trabajos WHERE turno_id IN (SELECT id FROM turnos WHERE turnera_id IN (${turneraProgramadaId}, ${turneraGuardiaId}))`,
  );
  // Turnos creados por la asignación (programada y guardia)
  await db.delete(turnosTable).where(inArray(turnosTable.turneraId, [turneraProgramadaId, turneraGuardiaId]));
  if (ordenesCreadas.length > 0) {
    await db.delete(ordenesPracticasLogTable).where(inArray(ordenesPracticasLogTable.ordenId, ordenesCreadas));
    await db.delete(ordenesPracticasTable).where(inArray(ordenesPracticasTable.id, ordenesCreadas));
  }
  await db.delete(turneraPracticasTable).where(inArray(turneraPracticasTable.turneraId, [turneraProgramadaId, turneraGuardiaId]));
  await db.delete(turnerasTable).where(inArray(turnerasTable.id, [turneraProgramadaId, turneraGuardiaId]));
  await db
    .delete(practicasCatalogoTable)
    .where(inArray(practicasCatalogoTable.id, [practicaProgramadaId, practicaGuardiaId, practicaSinAgendaId]));
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profesionalId));

  if (prevPort === undefined) delete process.env.PORT;
  else process.env.PORT = prevPort;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function crearOrden(practicaId: number) {
  const res = await request(app)
    .post("/api/ordenes-practicas")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      practicaId,
      patientId: pacienteId,
      professionalId: profesionalId,
      motivoClinico: `Evaluación de prueba sugerencias de turno ${RUN_ID}`,
      fechaOrden: hoyArgentina(),
      prioridad: "normal",
    });
  expect(res.status).toBe(201);
  const orden = (res.body as { orden: { id: number; estado: string } }).orden;
  ordenesCreadas.push(orden.id);
  return orden;
}

function getSugerencias(ordenId: number) {
  return request(app)
    .get(`/api/ordenes-practicas/${ordenId}/sugerencias-turno`)
    .set("Authorization", `Bearer ${adminToken}`);
}

type Opcion = { turneraId: number; fecha: string; horaInicio: string; horaFin: string; turneraNombre: string };

describe("GET /ordenes-practicas/:id/sugerencias-turno", () => {
  it("tipo=opciones con slots reales de la turnera compatible", async () => {
    const orden = await crearOrden(practicaProgramadaId);
    const res = await getSugerencias(orden.id);
    expect(res.status).toBe(200);
    const body = res.body as { tipo: string; opciones: Opcion[]; ordenId: number; turnoId: number | null };
    expect(body.tipo).toBe("opciones");
    expect(body.ordenId).toBe(orden.id);
    expect(body.turnoId).toBeNull();
    expect(body.opciones.length).toBeGreaterThan(0);
    expect(body.opciones.length).toBeLessThanOrEqual(4);
    const hoy = hoyArgentina();
    for (const op of body.opciones) {
      expect(op.turneraId).toBe(turneraProgramadaId);
      expect(op.fecha >= hoy).toBe(true);
      expect(op.horaInicio >= "08:00").toBe(true);
      expect(op.horaFin <= "12:00").toBe(true);
    }
  });

  it("tipo=demanda_espontanea cuando la única turnera compatible es de guardia", async () => {
    const orden = await crearOrden(practicaGuardiaId);
    const res = await getSugerencias(orden.id);
    expect(res.status).toBe(200);
    const body = res.body as { tipo: string; opciones: unknown[]; guardia?: { turneraId: number; nombre: string } };
    expect(body.tipo).toBe("demanda_espontanea");
    expect(body.opciones).toEqual([]);
    expect(body.guardia?.turneraId).toBe(turneraGuardiaId);
  });

  it("tipo=sin_agenda cuando ninguna turnera ofrece la práctica", async () => {
    const orden = await crearOrden(practicaSinAgendaId);
    const res = await getSugerencias(orden.id);
    expect(res.status).toBe(200);
    const body = res.body as { tipo: string; opciones: unknown[] };
    expect(body.tipo).toBe("sin_agenda");
    expect(body.opciones).toEqual([]);
  });

  it("404 para orden inexistente", async () => {
    const res = await getSugerencias(99999999);
    expect(res.status).toBe(404);
  });
});

describe("POST /ordenes-practicas/:id/asignar-turno", () => {
  it("asigna un turno de una opción sugerida, setea turno_id y deja log; 409 si se reintenta", async () => {
    const orden = await crearOrden(practicaProgramadaId);
    const sug = await getSugerencias(orden.id);
    expect(sug.status).toBe(200);
    const opciones = (sug.body as { opciones: Opcion[] }).opciones;
    expect(opciones.length).toBeGreaterThan(0);
    const opcion = opciones[0];

    const asignar = await request(app)
      .post(`/api/ordenes-practicas/${orden.id}/asignar-turno`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ turneraId: opcion.turneraId, fecha: opcion.fecha, horaInicio: opcion.horaInicio });
    expect(asignar.status).toBe(201);
    const turno = (asignar.body as { turno: { id: number; fecha: string; horaInicio: string; esGuardia: boolean } }).turno;
    expect(turno.id).toBeGreaterThan(0);
    expect(turno.fecha).toBe(opcion.fecha);
    expect(turno.horaInicio).toBe(opcion.horaInicio);
    expect(turno.esGuardia).toBe(false);

    // La orden quedó vinculada al turno creado
    const [saved] = await db
      .select({ turnoId: ordenesPracticasTable.turnoId })
      .from(ordenesPracticasTable)
      .where(eq(ordenesPracticasTable.id, orden.id))
      .limit(1);
    expect(saved.turnoId).toBe(turno.id);

    // El turno existe realmente en la turnera elegida
    const [turnoDb] = await db.select().from(turnosTable).where(eq(turnosTable.id, turno.id)).limit(1);
    expect(turnoDb).toBeTruthy();
    expect(turnoDb.turneraId).toBe(turneraProgramadaId);
    expect(turnoDb.pacienteId).toBe(pacienteId);

    // Quedó registrado en el log de la orden con el turnoId en metadata
    const log = await db
      .select()
      .from(ordenesPracticasLogTable)
      .where(eq(ordenesPracticasLogTable.ordenId, orden.id));
    const entrada = log.find((l) => (l.metadata as { turnoId?: number } | null)?.turnoId === turno.id);
    expect(entrada).toBeTruthy();
    expect(entrada!.motivo).toMatch(/Turno asignado desde la orden/);

    // La sugerencia ahora refleja el turno asignado
    const sug2 = await getSugerencias(orden.id);
    expect((sug2.body as { turnoId: number | null }).turnoId).toBe(turno.id);

    // Doble asignación → 409
    const reintento = await request(app)
      .post(`/api/ordenes-practicas/${orden.id}/asignar-turno`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ turneraId: opcion.turneraId, fecha: opcion.fecha, horaInicio: opcion.horaInicio });
    expect(reintento.status).toBe(409);
  });

  it("suma a demanda espontánea (guardia) sin fecha ni hora", async () => {
    const orden = await crearOrden(practicaGuardiaId);
    const res = await request(app)
      .post(`/api/ordenes-practicas/${orden.id}/asignar-turno`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ turneraId: turneraGuardiaId });
    expect(res.status).toBe(201);
    const turno = (res.body as { turno: { id: number; esGuardia: boolean } }).turno;
    expect(turno.esGuardia).toBe(true);

    const [saved] = await db
      .select({ turnoId: ordenesPracticasTable.turnoId })
      .from(ordenesPracticasTable)
      .where(eq(ordenesPracticasTable.id, orden.id))
      .limit(1);
    expect(saved.turnoId).toBe(turno.id);
  });

  it("422 si falta fecha/hora en agenda programada", async () => {
    const orden = await crearOrden(practicaProgramadaId);
    const res = await request(app)
      .post(`/api/ordenes-practicas/${orden.id}/asignar-turno`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ turneraId: turneraProgramadaId });
    expect(res.status).toBe(422);
  });
});
