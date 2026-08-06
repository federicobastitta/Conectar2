// Push saliente de "Indicaciones para el paciente" (plan de atención) a la
// app del paciente (portal Diagnosticar Clinic). Contrato (jul 2026):
//   POST {APP_PACIENTE_PUSH_URL}/api/integracion/indicaciones
//   Header: Authorization: Bearer {APP_PACIENTE_PUSH_TOKEN}
//   Body: { dni, fechaEmision, profesional, matricula, codigoVerificacion,
//           estudios, medicamentos, otrasIndicaciones, pdfBase64 }
// Idempotencia del lado de la app por codigoVerificacion (201 nuevo / 200 repetido).
//
// Mismo diseño que app-paciente-certificados: cola durable + worker con
// backoff. El envío NUNCA bloquea la emisión. Nunca se loguean DNI ni claves.

import { and, asc, eq, lte, sql } from "drizzle-orm";
import {
  db,
  indicacionesAppEnvios,
  indicacionesPacientesTable,
  pacientesTable,
  profesionalesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { generarPdfDocumento } from "../pdf/documento_pdf";
import { armarDatosIndicaciones } from "../pdf/fuente_documento";

const MAX_INTENTOS = 8;
const INTERVALO_MS = 30_000;
const TIMEOUT_MS = 30_000;

function appPacienteUrl(): string | null {
  const u = process.env.APP_PACIENTE_PUSH_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

function pushHabilitado(): boolean {
  if (process.env.APP_PACIENTE_PUSH_ENABLED?.trim().toLowerCase() === "false") return false;
  return Boolean(appPacienteUrl() && process.env.APP_PACIENTE_PUSH_TOKEN?.trim());
}

export interface IndicacionAppPayload {
  dni: string;
  // Pedido de la app (ago 2026): nombre para poder crear la ficha del
  // paciente al recibir el push. Opcionales del lado de la app.
  pacienteNombre?: string;
  pacienteApellido?: string;
  pacienteTelefono?: string;
  fechaEmision: string; // ISO 8601
  profesional: string; // "Apellido, Nombre"
  matricula: string;
  codigoVerificacion: string;
  estudios: string | null;
  medicamentos: string | null;
  otrasIndicaciones: string | null;
  pdfBase64?: string;
}

/** Encola el envío de una indicación. Idempotente por indicacionId; fire-and-forget. */
export async function encolarEnvioIndicacionApp(
  indicacionId: number,
  opciones?: { reenviar?: boolean },
): Promise<void> {
  try {
    // Con reenviar=true se rearma también un envío ya hecho: las indicaciones
    // se actualizan durante el día y el portal hace upsert por codigoVerificacion.
    const rearmar = opciones?.reenviar
      ? sql`${indicacionesAppEnvios.estado} <> 'pendiente'`
      : sql`${indicacionesAppEnvios.estado} = 'error_permanente'`;
    await db
      .insert(indicacionesAppEnvios)
      .values({ indicacionId })
      .onConflictDoUpdate({
        target: indicacionesAppEnvios.indicacionId,
        set: {
          estado: "pendiente",
          intentos: 0,
          ultimoError: null,
          proximoIntentoEn: new Date(),
          actualizadoEn: new Date(),
        },
        setWhere: rearmar,
      });
    logger.info({ indicacionId }, "app-paciente: indicación encolada para envío a la app");
  } catch (err) {
    logger.error({ err, indicacionId }, "app-paciente: error encolando indicación");
  }
}

type FilaIndicacion = typeof indicacionesPacientesTable.$inferSelect;
type FilaPaciente = typeof pacientesTable.$inferSelect;
type FilaProfesional = typeof profesionalesTable.$inferSelect;

/** Genera el PDF de la indicación en memoria y lo devuelve como base64 (o null si falla). */
async function pdfIndicacionBase64(
  ind: FilaIndicacion,
  paciente: FilaPaciente,
  profesional: FilaProfesional | undefined,
): Promise<string | null> {
  try {
    if (!profesional) return null;
    const doc = generarPdfDocumento({
      ...armarDatosIndicaciones({
        fechaEmision: ind.createdAt,
        estudios: ind.estudios,
        medicamentos: ind.medicamentos,
        otrasIndicaciones: ind.otrasIndicaciones,
      }),
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
        especialidad: null,
        telefonoMovil: profesional.telefonoMovil,
        telefono: profesional.telefono,
        firmaImagen: profesional.firmaImagen,
      },
    });
    const chunks: Buffer[] = [];
    return await new Promise<string | null>((resolve) => {
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      doc.on("error", () => resolve(null));
      doc.end();
    });
  } catch (err) {
    logger.error({ err, indicacionId: ind.id }, "app-paciente: error generando PDF de la indicación");
    return null;
  }
}

/** Arma el payload del contrato desde la indicación persistida. */
export async function armarPayloadIndicacionApp(
  indicacionId: number,
): Promise<{ ok: true; payload: IndicacionAppPayload } | { ok: false; error: string; permanente: boolean }> {
  const [ind] = await db.select().from(indicacionesPacientesTable).where(eq(indicacionesPacientesTable.id, indicacionId)).limit(1);
  if (!ind) return { ok: false, error: "Indicación no encontrada", permanente: true };
  if (!ind.verificationCode) return { ok: false, error: "La indicación no tiene código de verificación", permanente: true };

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, ind.patientId)).limit(1);
  if (!paciente) return { ok: false, error: "Paciente no encontrado", permanente: true };
  const dni = paciente.dni?.replace(/\D/g, "") ?? "";
  if (!dni) return { ok: false, error: "El paciente no tiene DNI cargado", permanente: false };

  const [profesional] = await db
    .select()
    .from(profesionalesTable)
    .where(eq(profesionalesTable.id, ind.professionalId))
    .limit(1);

  const pdfBase64 = await pdfIndicacionBase64(ind, paciente, profesional);

  const telefonoPaciente = paciente.telefono?.trim();
  const payload: IndicacionAppPayload = {
    dni,
    ...(paciente.nombre ? { pacienteNombre: paciente.nombre } : {}),
    ...(paciente.apellido ? { pacienteApellido: paciente.apellido } : {}),
    ...(telefonoPaciente ? { pacienteTelefono: telefonoPaciente } : {}),
    fechaEmision: ind.createdAt.toISOString(),
    profesional: profesional
      ? `${profesional.apellido ? profesional.apellido + ", " : ""}${profesional.nombre}`
      : "",
    matricula: profesional?.matricula ?? "",
    codigoVerificacion: ind.verificationCode,
    estudios: ind.estudios ?? null,
    medicamentos: ind.medicamentos ?? null,
    otrasIndicaciones: ind.otrasIndicaciones ?? null,
    ...(pdfBase64 ? { pdfBase64 } : {}),
  };
  return { ok: true, payload };
}

/** POST a la app del paciente. Nunca loguea DNI ni el token. */
export async function enviarIndicacionALaApp(
  payload: IndicacionAppPayload,
): Promise<{ ok: true; respuesta: string } | { ok: false; error: string; permanente: boolean }> {
  const base = appPacienteUrl();
  const token = process.env.APP_PACIENTE_PUSH_TOKEN?.trim();
  if (!base || !token) {
    return { ok: false, error: "APP_PACIENTE_PUSH_URL o APP_PACIENTE_PUSH_TOKEN no configuradas", permanente: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/integracion/indicaciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const texto = redactarSensible(await res.text());
    if (res.ok) return { ok: true, respuesta: texto };
    // 400/404/422 = problema del payload/contrato → no reintentar a ciegas.
    // 401/403 pueden ser token en rotación → se reintenta.
    const permanente = res.status >= 400 && res.status < 500 && ![401, 403, 408, 429].includes(res.status);
    return { ok: false, error: `HTTP ${res.status}: ${texto.slice(0, 300)}`, permanente };
  } catch (err) {
    const mensaje = err instanceof Error && err.name === "AbortError" ? "Timeout" : String(err);
    return { ok: false, error: mensaje, permanente: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Enmascara posibles DNI y el pdf en base64 antes de loguear/persistir respuestas. */
function redactarSensible(texto: string): string {
  return texto
    .replace(/"pdfBase64"\s*:\s*"[^"]*"/g, '"pdfBase64":"[redactado]"')
    .replace(/\d{7,}/g, (d) => `${d.slice(0, 2)}***`);
}

/** Backoff exponencial: 2, 4, 8... minutos (tope 60). */
function proximoIntento(intentos: number): Date {
  const minutos = Math.min(2 ** intentos, 60);
  return new Date(Date.now() + minutos * 60_000);
}

/** Procesa un envío pendiente. Exportada para tests. */
export async function procesarEnvioIndicacion(envioId: number): Promise<void> {
  const [envio] = await db.select().from(indicacionesAppEnvios).where(eq(indicacionesAppEnvios.id, envioId)).limit(1);
  if (!envio || envio.estado !== "pendiente") return;

  const intentos = envio.intentos + 1;
  const armado = await armarPayloadIndicacionApp(envio.indicacionId);
  let resultado: { ok: true; respuesta: string } | { ok: false; error: string; permanente: boolean };
  if (!armado.ok) resultado = { ok: false, error: armado.error, permanente: armado.permanente };
  else resultado = await enviarIndicacionALaApp(armado.payload);

  if (resultado.ok) {
    await db
      .update(indicacionesAppEnvios)
      .set({
        estado: "enviado",
        intentos,
        ultimoError: null,
        appRespuesta: resultado.respuesta.slice(0, 2000),
        ultimoIntentoEn: new Date(),
        enviadoEn: new Date(),
        actualizadoEn: new Date(),
      })
      .where(eq(indicacionesAppEnvios.id, envioId));
    logger.info({ indicacionId: envio.indicacionId, intentos }, "app-paciente: indicación enviada a la app");
    return;
  }

  const agotado = resultado.permanente || intentos >= MAX_INTENTOS;
  await db
    .update(indicacionesAppEnvios)
    .set({
      estado: agotado ? "error_permanente" : "pendiente",
      intentos,
      ultimoError: resultado.error.slice(0, 2000),
      ultimoIntentoEn: new Date(),
      proximoIntentoEn: agotado ? null : proximoIntento(intentos),
      actualizadoEn: new Date(),
    })
    .where(eq(indicacionesAppEnvios.id, envioId));
  logger.warn(
    { indicacionId: envio.indicacionId, intentos, agotado, error: resultado.error.slice(0, 300) },
    "app-paciente: falló el envío de la indicación a la app",
  );
}

let corriendo = false;

async function tick(): Promise<void> {
  if (corriendo) return;
  if (!pushHabilitado()) return;
  corriendo = true;
  try {
    const pendientes = await db
      .select({ id: indicacionesAppEnvios.id })
      .from(indicacionesAppEnvios)
      .where(
        and(
          eq(indicacionesAppEnvios.estado, "pendiente"),
          sql`${indicacionesAppEnvios.intentos} < ${MAX_INTENTOS}`,
          lte(indicacionesAppEnvios.proximoIntentoEn, new Date()),
        ),
      )
      .orderBy(asc(indicacionesAppEnvios.creadoEn))
      .limit(5);
    for (const p of pendientes) {
      await procesarEnvioIndicacion(p.id);
    }
  } catch (err) {
    logger.error({ err }, "app-paciente: error en tick del worker de indicaciones");
  } finally {
    corriendo = false;
  }
}

export function iniciarIndicacionesAppWorker(): void {
  logger.info(
    pushHabilitado()
      ? "app-paciente: worker de envío de indicaciones a la app iniciado"
      : "app-paciente: push de indicaciones encolado pero deshabilitado (faltan APP_PACIENTE_PUSH_URL / APP_PACIENTE_PUSH_TOKEN)",
  );
  const timer = setInterval(tick, INTERVALO_MS);
  timer.unref();
  void tick();
}
