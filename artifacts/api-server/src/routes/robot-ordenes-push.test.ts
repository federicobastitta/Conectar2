// Tests del push saliente de órdenes de estudio al Robot Klinicos.
// Levanta un Robot simulado local y verifica: payload del contrato,
// x-api-key, reintentos ante 5xx y error permanente ante 4xx.
import crypto from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import { eq } from "drizzle-orm";
import {
  db,
  robotOrdenesEnvios,
  studyOrdersTable,
  pacientesTable,
  profesionalesTable,
  especialidadesTable,
} from "@workspace/db";
import {
  encolarEnvioOrdenRobot,
  procesarEnvioOrden,
  armarPayloadOrdenRobot,
} from "../integraciones/robot-ordenes";

let robotServer: Server;
let ultimoBody: Record<string, unknown> | null = null;
let ultimaApiKey: string | undefined;
let respuestaHttp = 200;

let urlAnterior: string | undefined;
let keyAnterior: string | undefined;
let flagAnterior: string | undefined;

let pacienteId: number;
let profesionalId: number;
let especialidadId: number;
const ordenIds: number[] = [];
// Identificadores únicos por corrida: la DB es compartida entre validaciones
// concurrentes y corridas abortadas dejan restos (ver convención RUN_ID).
const RUN_ID = crypto.randomBytes(6).toString("hex");
const DNI_TEST = `43${Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0")}`;

async function crearOrden(extra: Partial<typeof studyOrdersTable.$inferInsert> = {}): Promise<number> {
  const [o] = await db
    .insert(studyOrdersTable)
    .values({
      patientId: pacienteId,
      professionalId: profesionalId,
      studyType: "imagenes",
      studyName: "Resonancia de rodilla",
      clinicalJustification: "Gonalgia crónica",
      status: "solicitado",
      statusUpdatedAt: new Date(),
      createdBy: profesionalId,
      ...extra,
    })
    .returning({ id: studyOrdersTable.id });
  ordenIds.push(o.id);
  return o.id;
}

async function envioDe(ordenId: number) {
  const [e] = await db.select().from(robotOrdenesEnvios).where(eq(robotOrdenesEnvios.ordenId, ordenId)).limit(1);
  return e;
}

beforeAll(async () => {
  const robot = express();
  robot.use(express.json({ limit: "20mb" }));
  robot.post("/api/integraciones/ordenes", (req, res) => {
    ultimoBody = req.body;
    ultimaApiKey = req.headers["x-api-key"] as string | undefined;
    if (respuestaHttp !== 200) return void res.status(respuestaHttp).json({ error: "simulado" });
    res.json({ ok: true, id: "ROBOT-1" });
  });
  await new Promise<void>((resolve) => {
    robotServer = robot.listen(0, () => resolve());
  });
  const addr = robotServer.address();
  if (typeof addr === "string" || addr === null) throw new Error("Robot sin puerto");
  urlAnterior = process.env.ROBOT_API_URL;
  keyAnterior = process.env.ROBOT_API_KEY;
  flagAnterior = process.env.ROBOT_ORDENES_PUSH_ENABLED;
  process.env.ROBOT_API_URL = `http://127.0.0.1:${addr.port}`;
  process.env.ROBOT_API_KEY = "clave-test-ordenes";
  delete process.env.ROBOT_ORDENES_PUSH_ENABLED;

  const [esp] = await db
    .insert(especialidadesTable)
    .values({ nombre: `Diagnóstico por Imágenes Test Push ${RUN_ID}` })
    .returning({ id: especialidadesTable.id });
  especialidadId = esp.id;
  const [prof] = await db
    .insert(profesionalesTable)
    .values({
      nombre: "Laura",
      apellido: "Gómez",
      matricula: "MP 5555",
      especialidadId,
    })
    .returning({ id: profesionalesTable.id });
  profesionalId = prof.id;
  const [pac] = await db
    .insert(pacientesTable)
    .values({
      nombre: "Carlos",
      apellido: "Testolini",
      dni: DNI_TEST,
      cobertura: "IOMA",
      nroAfiliado: "AF-778899",
    })
    .returning({ id: pacientesTable.id });
  pacienteId = pac.id;
});

afterAll(async () => {
  for (const id of ordenIds) {
    await db.delete(robotOrdenesEnvios).where(eq(robotOrdenesEnvios.ordenId, id));
    await db.delete(studyOrdersTable).where(eq(studyOrdersTable.id, id));
  }
  await db.delete(pacientesTable).where(eq(pacientesTable.id, pacienteId));
  await db.delete(profesionalesTable).where(eq(profesionalesTable.id, profesionalId));
  await db.delete(especialidadesTable).where(eq(especialidadesTable.id, especialidadId));
  if (urlAnterior === undefined) delete process.env.ROBOT_API_URL;
  else process.env.ROBOT_API_URL = urlAnterior;
  if (keyAnterior === undefined) delete process.env.ROBOT_API_KEY;
  else process.env.ROBOT_API_KEY = keyAnterior;
  if (flagAnterior !== undefined) process.env.ROBOT_ORDENES_PUSH_ENABLED = flagAnterior;
  await new Promise<void>((resolve) => robotServer.close(() => resolve()));
});

describe("push de órdenes al Robot Klinicos", () => {
  it("arma el payload del contrato con todos los campos", async () => {
    const ordenId = await crearOrden({ contraste: true });
    const armado = await armarPayloadOrdenRobot(ordenId);
    expect(armado.ok).toBe(true);
    if (!armado.ok) return;
    const p = armado.payload;
    expect(p.orden_id).toBe(String(ordenId));
    expect(p.dni).toBe(DNI_TEST);
    expect(p.paciente).toBe("TESTOLINI, CARLOS");
    expect(p.medico).toBe("Gómez, Laura");
    expect(p.matricula).toBe("MP 5555");
    expect(p.especialidad).toBe(`Diagnóstico por Imágenes Test Push ${RUN_ID}`);
    expect(p.practicas).toEqual(["Resonancia de rodilla CON CONTRASTE"]);
    expect(p.diagnostico).toBe("Gonalgia crónica");
    expect(p.obra_social).toBe("IOMA");
    expect(p.numero_afiliado).toBe("AF-778899");
    expect(/^\d{4}-\d{2}-\d{2}$/.test(p.fecha_atencion)).toBe(true);
    // PDF adjunto en base64 (empieza con %PDF)
    expect(p.pdf_base64).toBeTruthy();
    expect(Buffer.from(p.pdf_base64!, "base64").subarray(0, 4).toString()).toBe("%PDF");
  });

  it("encola idempotente y envía la orden con x-api-key", async () => {
    respuestaHttp = 200;
    ultimoBody = null;
    const ordenId = await crearOrden();
    await encolarEnvioOrdenRobot(ordenId);
    await encolarEnvioOrdenRobot(ordenId); // no duplica
    const filas = await db.select().from(robotOrdenesEnvios).where(eq(robotOrdenesEnvios.ordenId, ordenId));
    expect(filas.length).toBe(1);

    await procesarEnvioOrden(filas[0].id);
    const envio = await envioDe(ordenId);
    expect(envio.estado).toBe("enviado");
    expect(envio.enviadoEn).toBeTruthy();
    expect(ultimaApiKey).toBe("clave-test-ordenes");
    const body = ultimoBody as Record<string, unknown> | null;
    expect(body?.orden_id).toBe(String(ordenId));
    expect(body?.dni).toBe(DNI_TEST);
  });

  it("ante 5xx queda pendiente con reintento programado", async () => {
    respuestaHttp = 503;
    const ordenId = await crearOrden();
    await encolarEnvioOrdenRobot(ordenId);
    const envio0 = await envioDe(ordenId);
    await procesarEnvioOrden(envio0.id);
    const envio = await envioDe(ordenId);
    expect(envio.estado).toBe("pendiente");
    expect(envio.intentos).toBe(1);
    expect(envio.ultimoError).toContain("503");
    expect(envio.proximoIntentoEn && envio.proximoIntentoEn.getTime() > Date.now()).toBe(true);
    respuestaHttp = 200;
  });

  it("ante 4xx marca error permanente sin martillar", async () => {
    respuestaHttp = 422;
    const ordenId = await crearOrden();
    await encolarEnvioOrdenRobot(ordenId);
    const envio0 = await envioDe(ordenId);
    await procesarEnvioOrden(envio0.id);
    const envio = await envioDe(ordenId);
    expect(envio.estado).toBe("error_permanente");
    expect(envio.ultimoError).toContain("422");

    // Reencolar rearma la cola: vuelve a pendiente con intentos en cero
    respuestaHttp = 200;
    await encolarEnvioOrdenRobot(ordenId);
    const rearmado = await envioDe(ordenId);
    expect(rearmado.estado).toBe("pendiente");
    expect(rearmado.intentos).toBe(0);
    await procesarEnvioOrden(rearmado.id);
    expect((await envioDe(ordenId)).estado).toBe("enviado");
  });

  it("reencolar un envío ya enviado no lo repite", async () => {
    respuestaHttp = 200;
    const ordenId = await crearOrden();
    await encolarEnvioOrdenRobot(ordenId);
    const envio0 = await envioDe(ordenId);
    await procesarEnvioOrden(envio0.id);
    expect((await envioDe(ordenId)).estado).toBe("enviado");
    await encolarEnvioOrdenRobot(ordenId);
    const despues = await envioDe(ordenId);
    expect(despues.estado).toBe("enviado");
  });

  it("una orden anulada no se envía (error permanente)", async () => {
    const ordenId = await crearOrden({ status: "anulada" });
    await encolarEnvioOrdenRobot(ordenId);
    const envio0 = await envioDe(ordenId);
    await procesarEnvioOrden(envio0.id);
    const envio = await envioDe(ordenId);
    expect(envio.estado).toBe("error_permanente");
    expect(envio.ultimoError).toContain("anulada");
  });
});
