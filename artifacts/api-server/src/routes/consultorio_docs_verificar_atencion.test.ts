import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pino from "pino";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pacientesTable,
  profesionalesTable,
  certificatesTable,
  certificadoVerificacionesTable,
  clinicalRecordsTable,
  encountersTable,
  sedesTable,
  turnerasTable,
  turnosTable,
} from "@workspace/db";
import consultorioDocsRouter from "./consultorio_docs";

// Tests de integración contra la DB de desarrollo (patrón: sembrar catálogo
// propio con RUN_ID y limpiar al terminar).
//
// Verifican el bloque "atencion" de GET /consultorio/certificados/verificar/:codigo:
// la sede/hora del turno SOLO se muestran cuando el turno del paciente con ese
// profesional ese día es inequívoco. Nunca debe mostrarse una sede equivocada.
//
// Casos:
// - Certificado con consulta vinculada → atencion.fecha y hora de la consulta.
// - Turno único del día → aparecen sede y hora del turno.
// - Dos turnos activos el mismo día (ambiguo) → NI sede NI hora del turno.
// - Turnos cancelado/ausente se ignoran (uno activo entre cancelados → sede;
//   todos cancelados → nada).
// - Certificado directo (sin consulta ni turno) → atencion null, solo horaEmision.

const RUN_ID = crypto.randomBytes(6).toString("hex");
const ZONA_AR = "America/Argentina/Buenos_Aires";

let server: Server;
let baseUrl: string;

let profId: number;
let sedeAId: number;
let sedeBId: number;
let turneraAId: number;
let turneraBId: number;

const pacienteIds: number[] = [];
const certIds: number[] = [];
const turnoIds: number[] = [];
const encounterIds: number[] = [];
const clinicalRecordIds: number[] = [];

// IP propia por corrida para no compartir la ventana del rate limit público
// (30/min por IP) con otras suites que corren en el mismo proceso.
const IP_TEST = `10.77.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;

function hoyAr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: ZONA_AR });
}

async function crearPaciente(tag: string): Promise<number> {
  const [pac] = await db
    .insert(pacientesTable)
    .values({ nombre: "Pac", apellido: `VerifAt-${tag}-${RUN_ID}`, dni: `VA${tag}${RUN_ID}`, activo: true })
    .returning();
  pacienteIds.push(pac!.id);
  return pac!.id;
}

async function crearCertificado(patientId: number, consultationId?: number): Promise<{ id: number; codigo: string }> {
  const codigo = crypto.randomBytes(16).toString("hex");
  const [cert] = await db
    .insert(certificatesTable)
    .values({
      patientId,
      professionalId: profId,
      consultationId: consultationId ?? null,
      certificateType: "reposo",
      content: `Certificado de prueba atencion ${RUN_ID}`,
      verificationCode: codigo,
      createdBy: 1,
    })
    .returning();
  certIds.push(cert!.id);
  return { id: cert!.id, codigo };
}

async function crearTurno(opts: {
  pacienteId: number;
  turneraId: number;
  hora: string;
  estado?: string;
  fecha?: string;
}): Promise<number> {
  const [t] = await db
    .insert(turnosTable)
    .values({
      turneraId: opts.turneraId,
      pacienteId: opts.pacienteId,
      profesionalId: profId,
      fecha: opts.fecha ?? hoyAr(),
      horaInicio: opts.hora,
      horaFin: opts.hora,
      estado: opts.estado ?? "pendiente",
    })
    .returning();
  turnoIds.push(t!.id);
  return t!.id;
}

type RespVerificacion = {
  valido: boolean;
  atencion: { fecha: string; hora: string | null; sede: string | null } | null;
  horaEmision: string | null;
};

async function verificar(codigo: string): Promise<RespVerificacion> {
  const res = await fetch(`${baseUrl}/api/consultorio/certificados/verificar/${codigo}`, {
    headers: { "x-forwarded-for": IP_TEST },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as RespVerificacion;
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

  const [prof] = await db
    .insert(profesionalesTable)
    .values({ nombre: "Prof", apellido: `VerifAt${RUN_ID}`, matricula: `MPVA-${RUN_ID}`, activo: true })
    .returning();
  profId = prof!.id;

  const [sedeA] = await db.insert(sedesTable).values({ nombre: `Sede A ${RUN_ID}` }).returning();
  const [sedeB] = await db.insert(sedesTable).values({ nombre: `Sede B ${RUN_ID}` }).returning();
  sedeAId = sedeA!.id;
  sedeBId = sedeB!.id;

  const [turneraA] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera A ${RUN_ID}`, profesionalId: profId, sedeId: sedeAId, activa: true })
    .returning();
  const [turneraB] = await db
    .insert(turnerasTable)
    .values({ nombre: `Turnera B ${RUN_ID}`, profesionalId: profId, sedeId: sedeBId, activa: true })
    .returning();
  turneraAId = turneraA!.id;
  turneraBId = turneraB!.id;
});

afterAll(async () => {
  if (certIds.length > 0) {
    await db.delete(certificadoVerificacionesTable).where(inArray(certificadoVerificacionesTable.certificateId, certIds));
    await db.delete(certificatesTable).where(inArray(certificatesTable.id, certIds));
  }
  if (turnoIds.length > 0) await db.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
  if (encounterIds.length > 0) await db.delete(encountersTable).where(inArray(encountersTable.id, encounterIds));
  if (clinicalRecordIds.length > 0) await db.delete(clinicalRecordsTable).where(inArray(clinicalRecordsTable.id, clinicalRecordIds));
  await db.delete(turnerasTable).where(inArray(turnerasTable.id, [turneraAId, turneraBId]));
  await db.delete(sedesTable).where(inArray(sedesTable.id, [sedeAId, sedeBId]));
  if (pacienteIds.length > 0) await db.delete(pacientesTable).where(inArray(pacientesTable.id, pacienteIds));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profId));
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("GET /consultorio/certificados/verificar/:codigo — bloque atencion", () => {
  it("certificado con consulta vinculada → fecha y hora de la consulta", async () => {
    const pacId = await crearPaciente("cons");
    const [cr] = await db.insert(clinicalRecordsTable).values({ patientId: pacId }).returning();
    clinicalRecordIds.push(cr!.id);
    const fechaConsulta = new Date();
    const [enc] = await db
      .insert(encountersTable)
      .values({ clinicalRecordId: cr!.id, professionalId: profId, encounterDate: fechaConsulta })
      .returning();
    encounterIds.push(enc!.id);
    const { codigo } = await crearCertificado(pacId, enc!.id);

    const body = await verificar(codigo);
    expect(body.atencion).not.toBeNull();
    const esperadaFecha = fechaConsulta.toLocaleDateString("es-AR", {
      timeZone: ZONA_AR, day: "2-digit", month: "2-digit", year: "numeric",
    });
    const esperadaHora = fechaConsulta.toLocaleTimeString("es-AR", {
      timeZone: ZONA_AR, hour: "2-digit", minute: "2-digit", hour12: false,
    });
    expect(body.atencion!.fecha).toBe(esperadaFecha);
    expect(body.atencion!.hora).toBe(esperadaHora);
    // Sin turno ese día, la sede no se inventa.
    expect(body.atencion!.sede).toBeNull();
  });

  it("turno único del día → aparecen sede y hora del turno", async () => {
    const pacId = await crearPaciente("uno");
    await crearTurno({ pacienteId: pacId, turneraId: turneraAId, hora: "09:15" });
    const { codigo } = await crearCertificado(pacId);

    const body = await verificar(codigo);
    expect(body.atencion).not.toBeNull();
    expect(body.atencion!.sede).toBe(`Sede A ${RUN_ID}`);
    expect(body.atencion!.hora).toBe("09:15");
  });

  it("dos turnos activos el mismo día (ambiguo) → ni sede ni hora del turno", async () => {
    const pacId = await crearPaciente("dos");
    await crearTurno({ pacienteId: pacId, turneraId: turneraAId, hora: "10:00" });
    await crearTurno({ pacienteId: pacId, turneraId: turneraBId, hora: "11:00" });
    const { codigo } = await crearCertificado(pacId);

    const body = await verificar(codigo);
    // Sin consulta ni turno inequívoco no hay bloque atencion (jamás una sede
    // posiblemente equivocada).
    expect(body.atencion).toBeNull();
  });

  it("turnos cancelado/ausente se ignoran: queda uno activo → su sede", async () => {
    const pacId = await crearPaciente("canc");
    await crearTurno({ pacienteId: pacId, turneraId: turneraAId, hora: "08:00", estado: "cancelado" });
    await crearTurno({ pacienteId: pacId, turneraId: turneraAId, hora: "08:30", estado: "ausente" });
    await crearTurno({ pacienteId: pacId, turneraId: turneraBId, hora: "12:45", estado: "pendiente" });
    const { codigo } = await crearCertificado(pacId);

    const body = await verificar(codigo);
    expect(body.atencion).not.toBeNull();
    expect(body.atencion!.sede).toBe(`Sede B ${RUN_ID}`);
    expect(body.atencion!.hora).toBe("12:45");
  });

  it("todos los turnos del día cancelados/ausentes → atencion null", async () => {
    const pacId = await crearPaciente("todc");
    await crearTurno({ pacienteId: pacId, turneraId: turneraAId, hora: "14:00", estado: "cancelado" });
    await crearTurno({ pacienteId: pacId, turneraId: turneraBId, hora: "15:00", estado: "ausente" });
    const { codigo } = await crearCertificado(pacId);

    const body = await verificar(codigo);
    expect(body.atencion).toBeNull();
  });

  it("certificado directo (sin consulta ni turno) → atencion null, solo horaEmision", async () => {
    const pacId = await crearPaciente("dir");
    const { codigo } = await crearCertificado(pacId);

    const body = await verificar(codigo);
    expect(body.valido).toBe(true);
    expect(body.atencion).toBeNull();
    expect(body.horaEmision).toMatch(/^\d{2}:\d{2}$/);
  });

  it("turno de otro día no aporta sede", async () => {
    const pacId = await crearPaciente("otro");
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: ZONA_AR });
    await crearTurno({ pacienteId: pacId, turneraId: turneraAId, hora: "09:00", fecha: ayer });
    const { codigo } = await crearCertificado(pacId);

    const body = await verificar(codigo);
    expect(body.atencion).toBeNull();
  });
});
