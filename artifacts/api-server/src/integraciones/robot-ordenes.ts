// Push saliente de órdenes de estudio al Robot Klinicos.
// Contrato (jul 2026): POST {ROBOT_API_URL}/api/integraciones/ordenes
// Header: x-api-key (la misma ROBOT_API_KEY que avisos y turnos).
// Body: { orden_id, dni, fecha_atencion, paciente "APELLIDO, NOMBRE", medico,
//         matricula, especialidad, practicas: [string], diagnostico,
//         obra_social, numero_afiliado, pdf_base64 }
//
// Diseño: cola durable (robot_ordenes_envios) + worker con backoff. El envío
// NUNCA bloquea la atención médica ni la recepción; si el Robot está caído
// la orden queda pendiente y se reintenta sola.
//
// ESTADO (jul 2026): el encolado automático está DESACTIVADO por decisión del
// usuario — las planillas no deben viajar con "PENDIENTE DE FIRMA". La cola y
// el worker quedan operativos para cuando se habilite el envío desde el
// circuito de firma (encolar al pasar firma_estado a 'firmada' y reencolar
// nuevas versiones firmadas).
// La X-Api-Key vive EXCLUSIVAMENTE en el backend. Nunca se loguean DNI ni claves.

import { and, asc, eq, lte, sql } from "drizzle-orm";
import {
  db,
  robotOrdenesEnvios,
  studyOrdersTable,
  pacientesTable,
  profesionalesTable,
  especialidadesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { robotApiUrl } from "./robot-cliente";
import { cargarFuente } from "../pdf/fuente_documento";
import { generarPdfDocumento } from "../pdf/documento_pdf";
import { prepararDatosPdf } from "../pdf/escaneado";

const MAX_INTENTOS = 8;
const INTERVALO_MS = 30_000;
const TIMEOUT_MS = 30_000;

/** Habilitado si hay URL y clave del Robot, salvo apagado explícito por env. */
export function pushOrdenesHabilitado(): boolean {
  if (process.env.ROBOT_ORDENES_PUSH_ENABLED?.trim().toLowerCase() === "false") return false;
  return Boolean(robotApiUrl() && process.env.ROBOT_API_KEY?.trim());
}

/** Payload según el contrato del Robot. */
export interface OrdenRobotPayload {
  orden_id: string;
  dni: string;
  fecha_atencion: string; // YYYY-MM-DD
  paciente: string; // "APELLIDO, NOMBRE"
  medico: string;
  matricula: string;
  especialidad: string;
  practicas: string[];
  diagnostico: string;
  obra_social: string;
  numero_afiliado: string;
  pdf_base64?: string;
}

/**
 * Encola el envío de una orden al Robot. Idempotente por ordenId.
 * Fire-and-forget: los llamadores la invocan con `void` y nunca falla hacia arriba.
 */
export async function encolarEnvioOrdenRobot(ordenId: number): Promise<void> {
  try {
    // Upsert: si el envío anterior quedó en error_permanente, se rearma la
    // cola (reintentos desde cero). Un envío ya "enviado" nunca se repite.
    await db
      .insert(robotOrdenesEnvios)
      .values({ ordenId })
      .onConflictDoUpdate({
        target: robotOrdenesEnvios.ordenId,
        set: {
          estado: "pendiente",
          intentos: 0,
          ultimoError: null,
          proximoIntentoEn: new Date(),
          actualizadoEn: new Date(),
        },
        setWhere: sql`${robotOrdenesEnvios.estado} = 'error_permanente'`,
      });
    logger.info({ ordenId }, "robot-ordenes: orden encolada para envío al Robot");
  } catch (err) {
    logger.error({ err, ordenId }, "robot-ordenes: error encolando orden");
  }
}

/** Genera el PDF de la orden en memoria y lo devuelve como base64 (o null si falla). */
async function pdfOrdenBase64(ordenId: number): Promise<string | null> {
  try {
    const fuente = await cargarFuente("orden_estudio", ordenId);
    if (!fuente) return null;
    const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, fuente.patientId)).limit(1);
    const [profesional] = await db
      .select()
      .from(profesionalesTable)
      .where(eq(profesionalesTable.id, fuente.professionalId))
      .limit(1);
    if (!paciente || !profesional) return null;
    let especialidad: string | null = null;
    if (profesional.especialidadId != null) {
      const [esp] = await db
        .select()
        .from(especialidadesTable)
        .where(eq(especialidadesTable.id, profesional.especialidadId))
        .limit(1);
      especialidad = esp?.nombre ?? null;
    }
    const doc = generarPdfDocumento(await prepararDatosPdf({
      ...fuente.datos,
      paciente: {
        nombre: paciente.nombre,
        apellido: paciente.apellido,
        dni: paciente.dni,
        cobertura: paciente.cobertura,
        nroAfiliado: paciente.nroAfiliado,
        fechaNacimiento: paciente.fechaNacimiento,
        sexo: paciente.sexo,
        direccion: paciente.direccion,
        localidad: paciente.localidad,
        telefono: paciente.telefono,
      },
      profesional: {
        id: profesional.id,
        nombre: profesional.nombre,
        apellido: profesional.apellido,
        matricula: profesional.matricula,
        especialidad,
        telefonoMovil: profesional.telefonoMovil,
        telefono: profesional.telefono,
        firmaImagen: profesional.firmaImagen,
      },
    }));
    const chunks: Buffer[] = [];
    return await new Promise<string | null>((resolve) => {
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      doc.on("error", () => resolve(null));
      doc.end();
    });
  } catch (err) {
    logger.error({ err, ordenId }, "robot-ordenes: error generando PDF de la orden");
    return null;
  }
}

/**
 * Arma el payload del contrato desde la orden. Devuelve un error legible si
 * faltan datos obligatorios (dni), para marcarlo y no reintentar a ciegas.
 */
export async function armarPayloadOrdenRobot(
  ordenId: number,
): Promise<{ ok: true; payload: OrdenRobotPayload } | { ok: false; error: string; permanente: boolean }> {
  const [orden] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, ordenId)).limit(1);
  if (!orden) return { ok: false, error: "Orden no encontrada", permanente: true };
  if (orden.status === "anulada") return { ok: false, error: "Orden anulada, no se envía", permanente: true };

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, orden.patientId)).limit(1);
  if (!paciente) return { ok: false, error: "Paciente no encontrado", permanente: true };
  const dni = paciente.dni?.replace(/\D/g, "") ?? "";
  if (!dni) return { ok: false, error: "El paciente no tiene DNI cargado", permanente: false };

  const [profesional] = await db
    .select()
    .from(profesionalesTable)
    .where(eq(profesionalesTable.id, orden.professionalId))
    .limit(1);
  let especialidad = "";
  if (profesional?.especialidadId != null) {
    const [esp] = await db
      .select()
      .from(especialidadesTable)
      .where(eq(especialidadesTable.id, profesional.especialidadId))
      .limit(1);
    especialidad = esp?.nombre ?? "";
  }

  const nombrePractica = orden.contraste ? `${orden.studyName} CON CONTRASTE` : orden.studyName;
  const pdfBase64 = await pdfOrdenBase64(ordenId);

  const payload: OrdenRobotPayload = {
    orden_id: String(orden.id),
    dni,
    // Fecha de atención = fecha de emisión de la orden en hora argentina.
    fecha_atencion: fechaArgentinaDe(orden.createdAt),
    paciente: `${paciente.apellido.toUpperCase()}, ${paciente.nombre.toUpperCase()}`,
    medico: profesional ? `${profesional.apellido ? profesional.apellido + ", " : ""}${profesional.nombre}` : "",
    matricula: profesional?.matricula ?? "",
    especialidad,
    practicas: [nombrePractica],
    diagnostico: orden.clinicalJustification ?? "",
    obra_social: paciente.cobertura ?? "",
    numero_afiliado: paciente.nroAfiliado ?? "",
    ...(pdfBase64 ? { pdf_base64: pdfBase64 } : {}),
  };
  return { ok: true, payload };
}

/** YYYY-MM-DD de un Date en hora argentina (el server corre en UTC, AR = -3). */
export function fechaArgentinaDe(fecha: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(fecha);
}

/** POST al Robot. Nunca loguea DNI ni la clave. */
export async function enviarOrdenAlRobot(
  payload: OrdenRobotPayload,
): Promise<{ ok: true; respuesta: string } | { ok: false; error: string; permanente: boolean }> {
  const base = robotApiUrl();
  const apiKey = process.env.ROBOT_API_KEY?.trim();
  if (!base || !apiKey) return { ok: false, error: "ROBOT_API_URL o ROBOT_API_KEY no configuradas", permanente: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/integraciones/ordenes`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const texto = (await res.text().catch(() => "")).slice(0, 2000);
    if (res.ok) return { ok: true, respuesta: texto };
    // 4xx = problema del payload: no tiene sentido martillar. Excepciones que
    // se reintentan: 408/429 (transitorios) y 401/403 (clave rotada: se
    // recupera al corregir la credencial sin perder el envío).
    const permanente =
      res.status >= 400 &&
      res.status < 500 &&
      ![401, 403, 408, 429].includes(res.status);
    return { ok: false, error: `HTTP ${res.status}: ${texto.slice(0, 300)}`, permanente };
  } catch (err) {
    const mensaje = err instanceof Error && err.name === "AbortError" ? "Timeout" : String(err);
    return { ok: false, error: mensaje, permanente: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Backoff exponencial: 1, 2, 4, 8... minutos (tope 60). */
function proximoIntento(intentos: number): Date {
  const minutos = Math.min(2 ** intentos, 60);
  return new Date(Date.now() + minutos * 60_000);
}

/** Procesa un envío pendiente. Exportada para tests. */
export async function procesarEnvioOrden(envioId: number): Promise<void> {
  const [envio] = await db.select().from(robotOrdenesEnvios).where(eq(robotOrdenesEnvios.id, envioId)).limit(1);
  if (!envio || envio.estado !== "pendiente") return;

  const intentos = envio.intentos + 1;
  const armado = await armarPayloadOrdenRobot(envio.ordenId);
  let resultado: { ok: true; respuesta: string } | { ok: false; error: string; permanente: boolean };
  if (!armado.ok) resultado = { ok: false, error: armado.error, permanente: armado.permanente };
  else resultado = await enviarOrdenAlRobot(armado.payload);

  if (resultado.ok) {
    await db
      .update(robotOrdenesEnvios)
      .set({
        estado: "enviado",
        intentos,
        ultimoError: null,
        robotRespuesta: resultado.respuesta.slice(0, 2000),
        ultimoIntentoEn: new Date(),
        enviadoEn: new Date(),
        actualizadoEn: new Date(),
      })
      .where(eq(robotOrdenesEnvios.id, envioId));
    logger.info({ ordenId: envio.ordenId, intentos }, "robot-ordenes: orden enviada al Robot");
    return;
  }

  const agotado = resultado.permanente || intentos >= MAX_INTENTOS;
  await db
    .update(robotOrdenesEnvios)
    .set({
      estado: agotado ? "error_permanente" : "pendiente",
      intentos,
      ultimoError: resultado.error.slice(0, 2000),
      ultimoIntentoEn: new Date(),
      proximoIntentoEn: agotado ? null : proximoIntento(intentos),
      actualizadoEn: new Date(),
    })
    .where(eq(robotOrdenesEnvios.id, envioId));
  logger.warn(
    { ordenId: envio.ordenId, intentos, agotado, error: resultado.error.slice(0, 300) },
    "robot-ordenes: fallo el envío al Robot",
  );
}

let corriendo = false;

async function tick(): Promise<void> {
  if (corriendo) return;
  if (!pushOrdenesHabilitado()) return;
  corriendo = true;
  try {
    const pendientes = await db
      .select({ id: robotOrdenesEnvios.id })
      .from(robotOrdenesEnvios)
      .where(
        and(
          eq(robotOrdenesEnvios.estado, "pendiente"),
          sql`${robotOrdenesEnvios.intentos} < ${MAX_INTENTOS}`,
          lte(robotOrdenesEnvios.proximoIntentoEn, new Date()),
        ),
      )
      .orderBy(asc(robotOrdenesEnvios.creadoEn))
      .limit(5);
    for (const p of pendientes) {
      await procesarEnvioOrden(p.id);
    }
  } catch (err) {
    logger.error({ err }, "robot-ordenes: error en tick del worker");
  } finally {
    corriendo = false;
  }
}

export function iniciarRobotOrdenesWorker(): void {
  if (!pushOrdenesHabilitado()) {
    logger.info("robot-ordenes: push al Robot deshabilitado (faltan ROBOT_API_URL / ROBOT_API_KEY)");
    return;
  }
  logger.info("robot-ordenes: worker de envío de órdenes al Robot iniciado");
  const timer = setInterval(tick, INTERVALO_MS);
  timer.unref();
  void tick();
}
