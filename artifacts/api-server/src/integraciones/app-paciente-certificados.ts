// Push saliente de certificados médicos a la app del paciente (portal
// Diagnosticar Clinic). Contrato propuesto (jul 2026):
//   POST {APP_PACIENTE_PUSH_URL}/api/integracion/certificados
//   Header: Authorization: Bearer {APP_PACIENTE_PUSH_TOKEN}
//   Body: { dni, tipo, diagnostico, diasReposo, fechaEmision, profesional,
//           matricula, codigoVerificacion, pdfBase64 }
// Idempotencia del lado de la app por codigoVerificacion (201 nuevo / 200 repetido).
//
// Diseño: cola durable (certificados_app_envios) + worker con backoff, igual
// que el push de órdenes al Robot. El envío NUNCA bloquea la emisión del
// certificado; si la app está caída o todavía no está configurada, queda
// pendiente y se reintenta solo cuando se configuren URL y token.
// El token vive EXCLUSIVAMENTE en el backend. Nunca se loguean DNI ni claves.

import { and, asc, eq, lte, sql } from "drizzle-orm";
import {
  db,
  certificadosAppEnvios,
  certificatesTable,
  pacientesTable,
  profesionalesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { cargarFuente } from "../pdf/fuente_documento";
import { generarPdfDocumento } from "../pdf/documento_pdf";

const MAX_INTENTOS = 8;
const INTERVALO_MS = 30_000;
const TIMEOUT_MS = 30_000;

function appPacienteUrl(): string | null {
  const u = process.env.APP_PACIENTE_PUSH_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

/** Habilitado si hay URL y token de la app del paciente. */
export function pushCertificadosHabilitado(): boolean {
  if (process.env.APP_PACIENTE_PUSH_ENABLED?.trim().toLowerCase() === "false") return false;
  return Boolean(appPacienteUrl() && process.env.APP_PACIENTE_PUSH_TOKEN?.trim());
}

export interface CertificadoAppPayload {
  dni: string;
  // Pedido de la app (ago 2026): nombre para poder crear la ficha del
  // paciente al recibir el push. Opcionales del lado de la app.
  pacienteNombre?: string;
  pacienteApellido?: string;
  pacienteTelefono?: string;
  tipo: string;
  diagnostico: string | null;
  diasReposo: number | null;
  fechaEmision: string; // ISO 8601
  profesional: string; // "Apellido, Nombre"
  matricula: string;
  codigoVerificacion: string;
  pdfBase64?: string;
}

/**
 * Encola el envío de un certificado a la app del paciente. Idempotente por
 * certificadoId. Fire-and-forget: los llamadores la invocan con `void` y
 * nunca falla hacia arriba.
 */
export async function encolarEnvioCertificadoApp(certificadoId: number): Promise<void> {
  try {
    await db
      .insert(certificadosAppEnvios)
      .values({ certificadoId })
      .onConflictDoUpdate({
        target: certificadosAppEnvios.certificadoId,
        set: {
          estado: "pendiente",
          intentos: 0,
          ultimoError: null,
          proximoIntentoEn: new Date(),
          actualizadoEn: new Date(),
        },
        setWhere: sql`${certificadosAppEnvios.estado} = 'error_permanente'`,
      });
    logger.info({ certificadoId }, "app-paciente: certificado encolado para envío a la app");
  } catch (err) {
    logger.error({ err, certificadoId }, "app-paciente: error encolando certificado");
  }
}

/** Genera el PDF del certificado en memoria y lo devuelve como base64 (o null si falla). */
async function pdfCertificadoBase64(certificadoId: number): Promise<string | null> {
  try {
    const fuente = await cargarFuente("certificado", certificadoId);
    if (!fuente) return null;
    const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, fuente.patientId)).limit(1);
    const [profesional] = await db
      .select()
      .from(profesionalesTable)
      .where(eq(profesionalesTable.id, fuente.professionalId))
      .limit(1);
    if (!paciente || !profesional) return null;
    const doc = generarPdfDocumento({
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
    logger.error({ err, certificadoId }, "app-paciente: error generando PDF del certificado");
    return null;
  }
}

/**
 * Arma el payload del contrato desde el certificado. Devuelve un error
 * legible si faltan datos obligatorios, para marcarlo y no reintentar a ciegas.
 */
export async function armarPayloadCertificadoApp(
  certificadoId: number,
): Promise<{ ok: true; payload: CertificadoAppPayload } | { ok: false; error: string; permanente: boolean }> {
  const [cert] = await db.select().from(certificatesTable).where(eq(certificatesTable.id, certificadoId)).limit(1);
  if (!cert) return { ok: false, error: "Certificado no encontrado", permanente: true };
  if (!cert.verificationCode) return { ok: false, error: "El certificado no tiene código de verificación", permanente: true };

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, cert.patientId)).limit(1);
  if (!paciente) return { ok: false, error: "Paciente no encontrado", permanente: true };
  const dni = paciente.dni?.replace(/\D/g, "") ?? "";
  if (!dni) return { ok: false, error: "El paciente no tiene DNI cargado", permanente: false };

  const [profesional] = await db
    .select()
    .from(profesionalesTable)
    .where(eq(profesionalesTable.id, cert.professionalId))
    .limit(1);

  const pdfBase64 = await pdfCertificadoBase64(certificadoId);

  const telefonoPaciente = paciente.telefono?.trim();
  const payload: CertificadoAppPayload = {
    dni,
    ...(paciente.nombre ? { pacienteNombre: paciente.nombre } : {}),
    ...(paciente.apellido ? { pacienteApellido: paciente.apellido } : {}),
    ...(telefonoPaciente ? { pacienteTelefono: telefonoPaciente } : {}),
    tipo: cert.certificateType,
    diagnostico: cert.diagnosis ?? null,
    diasReposo: cert.restDays ?? null,
    fechaEmision: cert.createdAt.toISOString(),
    profesional: profesional
      ? `${profesional.apellido ? profesional.apellido + ", " : ""}${profesional.nombre}`
      : "",
    matricula: profesional?.matricula ?? "",
    codigoVerificacion: cert.verificationCode,
    ...(pdfBase64 ? { pdfBase64 } : {}),
  };
  return { ok: true, payload };
}

/** POST a la app del paciente. Nunca loguea DNI ni el token. */
export async function enviarCertificadoALaApp(
  payload: CertificadoAppPayload,
): Promise<{ ok: true; respuesta: string } | { ok: false; error: string; permanente: boolean }> {
  const base = appPacienteUrl();
  const token = process.env.APP_PACIENTE_PUSH_TOKEN?.trim();
  if (!base || !token) {
    return { ok: false, error: "APP_PACIENTE_PUSH_URL o APP_PACIENTE_PUSH_TOKEN no configuradas", permanente: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/integracion/certificados`, {
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

/**
 * Redacta datos sensibles antes de loguear o persistir respuestas de la app:
 * enmascara secuencias de 7+ dígitos (posibles DNI) y el pdf en base64 si la
 * app lo llegara a devolver en un error de validación.
 */
function redactarSensible(texto: string): string {
  return texto
    .replace(/"pdfBase64"\s*:\s*"[^"]*"/g, '"pdfBase64":"[redactado]"')
    .replace(/\d{7,}/g, (d) => `${d.slice(0, 2)}***`);
}

/** Backoff exponencial (después del 1er intento fallido): 2, 4, 8... minutos (tope 60). */
function proximoIntento(intentos: number): Date {
  const minutos = Math.min(2 ** intentos, 60);
  return new Date(Date.now() + minutos * 60_000);
}

/** Procesa un envío pendiente. Exportada para tests. */
export async function procesarEnvioCertificado(envioId: number): Promise<void> {
  const [envio] = await db.select().from(certificadosAppEnvios).where(eq(certificadosAppEnvios.id, envioId)).limit(1);
  if (!envio || envio.estado !== "pendiente") return;

  const intentos = envio.intentos + 1;
  const armado = await armarPayloadCertificadoApp(envio.certificadoId);
  let resultado: { ok: true; respuesta: string } | { ok: false; error: string; permanente: boolean };
  if (!armado.ok) resultado = { ok: false, error: armado.error, permanente: armado.permanente };
  else resultado = await enviarCertificadoALaApp(armado.payload);

  if (resultado.ok) {
    await db
      .update(certificadosAppEnvios)
      .set({
        estado: "enviado",
        intentos,
        ultimoError: null,
        appRespuesta: resultado.respuesta.slice(0, 2000),
        ultimoIntentoEn: new Date(),
        enviadoEn: new Date(),
        actualizadoEn: new Date(),
      })
      .where(eq(certificadosAppEnvios.id, envioId));
    logger.info({ certificadoId: envio.certificadoId, intentos }, "app-paciente: certificado enviado a la app");
    return;
  }

  const agotado = resultado.permanente || intentos >= MAX_INTENTOS;
  await db
    .update(certificadosAppEnvios)
    .set({
      estado: agotado ? "error_permanente" : "pendiente",
      intentos,
      ultimoError: resultado.error.slice(0, 2000),
      ultimoIntentoEn: new Date(),
      proximoIntentoEn: agotado ? null : proximoIntento(intentos),
      actualizadoEn: new Date(),
    })
    .where(eq(certificadosAppEnvios.id, envioId));
  logger.warn(
    { certificadoId: envio.certificadoId, intentos, agotado, error: resultado.error.slice(0, 300) },
    "app-paciente: fallo el envío del certificado a la app",
  );
}

let corriendo = false;

async function tick(): Promise<void> {
  if (corriendo) return;
  if (!pushCertificadosHabilitado()) return;
  corriendo = true;
  try {
    const pendientes = await db
      .select({ id: certificadosAppEnvios.id })
      .from(certificadosAppEnvios)
      .where(
        and(
          eq(certificadosAppEnvios.estado, "pendiente"),
          sql`${certificadosAppEnvios.intentos} < ${MAX_INTENTOS}`,
          lte(certificadosAppEnvios.proximoIntentoEn, new Date()),
        ),
      )
      .orderBy(asc(certificadosAppEnvios.creadoEn))
      .limit(5);
    for (const p of pendientes) {
      await procesarEnvioCertificado(p.id);
    }
  } catch (err) {
    logger.error({ err }, "app-paciente: error en tick del worker");
  } finally {
    corriendo = false;
  }
}

export function iniciarCertificadosAppWorker(): void {
  // El worker arranca siempre: si todavía no están configuradas la URL y el
  // token, los envíos quedan encolados y salen solos cuando se configuren.
  logger.info(
    pushCertificadosHabilitado()
      ? "app-paciente: worker de envío de certificados a la app iniciado"
      : "app-paciente: push de certificados encolado pero deshabilitado (faltan APP_PACIENTE_PUSH_URL / APP_PACIENTE_PUSH_TOKEN)",
  );
  const timer = setInterval(tick, INTERVALO_MS);
  timer.unref();
  void tick();
}
