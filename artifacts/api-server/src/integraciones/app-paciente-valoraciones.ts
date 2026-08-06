// Push saliente de invitaciones a valorar la atención, hacia la app del
// paciente (portal Diagnosticar Clinic). Contrato propuesto (jul 2026):
//   POST {APP_PACIENTE_PUSH_URL}/api/integracion/valoraciones
//   Header: Authorization: Bearer {APP_PACIENTE_PUSH_TOKEN}
//   Body: { dni, profesional, fechaConsulta, token }
// La app muestra "¿Cómo fue tu atención con {profesional}?" (1 a 5 estrellas)
// y responde a Conectar vía POST /api/publico/valoraciones/{token} (x-api-key).
//
// Diseño: la fila de valoraciones_atencion ES la cola (estado_envio + backoff),
// igual criterio que certificados_app_envios. El envío nunca bloquea la
// consulta; sin URL/token configurados queda pendiente y sale solo después.
// Nunca se loguean DNI ni claves.

import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db, valoracionesAtencionTable, pacientesTable, profesionalesTable } from "@workspace/db";
import { randomBytes } from "node:crypto";
import { logger } from "../lib/logger";

const MAX_INTENTOS = 8;
// La invitación a valorar se manda recién unas horas después de terminada la
// consulta (pedido del usuario, jul 2026). Configurable por env en horas.
const DEMORA_INVITACION_MS =
  Math.max(0, Number(process.env.VALORACIONES_DEMORA_HORAS ?? "3") || 0) * 60 * 60 * 1000;
// Ventana horaria de envío (hora argentina): solo entre las 10 y las 22.
// Si la invitación cae después de las 22, pasa a las 10 del día siguiente;
// si cae antes de las 10, espera a las 10 de ese mismo día.
const VENTANA_TZ = "America/Argentina/Buenos_Aires";
const VENTANA_DESDE = 10;
const VENTANA_HASTA = 22;

export function ajustarAVentanaDeEnvio(fecha: Date): Date {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: VENTANA_TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(fecha);
  const hora = Number(partes.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minuto = Number(partes.find((p) => p.type === "minute")?.value ?? "0");
  if (hora >= VENTANA_DESDE && (hora < VENTANA_HASTA || (hora === VENTANA_HASTA && minuto === 0))) return fecha;
  // Horas que faltan hasta las 10 (del mismo día si es de madrugada, si no del día siguiente)
  const horasHasta10 = hora < VENTANA_DESDE ? VENTANA_DESDE - hora : 24 - hora + VENTANA_DESDE;
  // Redondea a las 10:00:00.000 exactas descontando minutos, segundos y ms.
  const ajustada = new Date(fecha.getTime() + horasHasta10 * 3_600_000 - minuto * 60_000);
  ajustada.setUTCSeconds(0, 0);
  return ajustada;
}
const INTERVALO_MS = 30_000;
const TIMEOUT_MS = 30_000;

function appPacienteUrl(): string | null {
  const u = process.env.APP_PACIENTE_PUSH_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

export function pushValoracionesHabilitado(): boolean {
  if (process.env.APP_PACIENTE_PUSH_ENABLED?.trim().toLowerCase() === "false") return false;
  return Boolean(appPacienteUrl() && process.env.APP_PACIENTE_PUSH_TOKEN?.trim());
}

/**
 * Crea (idempotente por encounterId) la valoración pendiente de una consulta
 * y la deja encolada para empujar la invitación a la app del paciente.
 * Fire-and-forget: nunca falla hacia arriba.
 */
export async function crearValoracionPendiente(args: {
  encounterId: number;
  pacienteId: number;
  profesionalId: number;
}): Promise<void> {
  try {
    await db
      .insert(valoracionesAtencionTable)
      .values({
        ...args,
        token: randomBytes(24).toString("hex"),
        proximoIntentoEn: ajustarAVentanaDeEnvio(new Date(Date.now() + DEMORA_INVITACION_MS)),
      })
      .onConflictDoNothing({ target: valoracionesAtencionTable.encounterId });
    logger.info({ encounterId: args.encounterId }, "valoraciones: invitación encolada para la app del paciente");
  } catch (err) {
    logger.error({ err, encounterId: args.encounterId }, "valoraciones: error encolando invitación");
  }
}

interface ValoracionAppPayload {
  dni: string;
  profesional: string; // "Apellido, Nombre"
  fechaConsulta: string; // ISO 8601
  token: string;
}

async function armarPayload(
  valoracionId: number,
): Promise<{ ok: true; payload: ValoracionAppPayload } | { ok: false; error: string; permanente: boolean }> {
  const [v] = await db.select().from(valoracionesAtencionTable).where(eq(valoracionesAtencionTable.id, valoracionId)).limit(1);
  if (!v) return { ok: false, error: "Valoración no encontrada", permanente: true };
  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, v.pacienteId)).limit(1);
  if (!paciente) return { ok: false, error: "Paciente no encontrado", permanente: true };
  const dni = paciente.dni?.replace(/\D/g, "") ?? "";
  if (!dni) return { ok: false, error: "El paciente no tiene DNI cargado", permanente: true };
  const [profesional] = await db
    .select()
    .from(profesionalesTable)
    .where(eq(profesionalesTable.id, v.profesionalId))
    .limit(1);
  return {
    ok: true,
    payload: {
      dni,
      profesional: profesional ? `${profesional.apellido ? profesional.apellido + ", " : ""}${profesional.nombre}` : "",
      fechaConsulta: v.creadoEn.toISOString(),
      token: v.token,
    },
  };
}

function redactarSensible(texto: string): string {
  return texto.replace(/\d{7,}/g, (d) => `${d.slice(0, 2)}***`);
}

async function enviarALaApp(
  payload: ValoracionAppPayload,
): Promise<{ ok: true } | { ok: false; error: string; permanente: boolean }> {
  const base = appPacienteUrl();
  const token = process.env.APP_PACIENTE_PUSH_TOKEN?.trim();
  if (!base || !token) {
    return { ok: false, error: "APP_PACIENTE_PUSH_URL o APP_PACIENTE_PUSH_TOKEN no configuradas", permanente: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/integracion/valoraciones`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const texto = redactarSensible(await res.text());
    if (res.ok) return { ok: true };
    const permanente = res.status >= 400 && res.status < 500 && ![401, 403, 408, 429].includes(res.status);
    return { ok: false, error: `HTTP ${res.status}: ${texto.slice(0, 300)}`, permanente };
  } catch (err) {
    const mensaje = err instanceof Error && err.name === "AbortError" ? "Timeout" : String(err);
    return { ok: false, error: mensaje, permanente: false };
  } finally {
    clearTimeout(timer);
  }
}

function proximoIntento(intentos: number): Date {
  const minutos = Math.min(2 ** intentos, 60);
  return ajustarAVentanaDeEnvio(new Date(Date.now() + minutos * 60_000));
}

/** Procesa una invitación pendiente. Exportada para tests. */
export async function procesarEnvioValoracion(valoracionId: number): Promise<void> {
  const [v] = await db.select().from(valoracionesAtencionTable).where(eq(valoracionesAtencionTable.id, valoracionId)).limit(1);
  if (!v || v.estadoEnvio !== "pendiente") return;

  const intentos = v.intentos + 1;
  const armado = await armarPayload(valoracionId);
  const resultado = armado.ok ? await enviarALaApp(armado.payload) : armado;

  if (resultado.ok) {
    await db
      .update(valoracionesAtencionTable)
      .set({
        estadoEnvio: "enviado",
        intentos,
        ultimoError: null,
        ultimoIntentoEn: new Date(),
        enviadoEn: new Date(),
        actualizadoEn: new Date(),
      })
      .where(eq(valoracionesAtencionTable.id, valoracionId));
    logger.info({ valoracionId, intentos }, "valoraciones: invitación enviada a la app del paciente");
    return;
  }

  const agotado = resultado.permanente || intentos >= MAX_INTENTOS;
  await db
    .update(valoracionesAtencionTable)
    .set({
      estadoEnvio: agotado ? "error_permanente" : "pendiente",
      intentos,
      ultimoError: resultado.error.slice(0, 2000),
      ultimoIntentoEn: new Date(),
      proximoIntentoEn: agotado ? null : proximoIntento(intentos),
      actualizadoEn: new Date(),
    })
    .where(eq(valoracionesAtencionTable.id, valoracionId));
  logger.warn(
    { valoracionId, intentos, agotado, error: resultado.error.slice(0, 300) },
    "valoraciones: falló el envío de la invitación a la app",
  );
}

let corriendo = false;

async function tick(): Promise<void> {
  if (corriendo) return;
  if (!pushValoracionesHabilitado()) return;
  corriendo = true;
  try {
    const pendientes = await db
      .select({ id: valoracionesAtencionTable.id })
      .from(valoracionesAtencionTable)
      .where(
        and(
          eq(valoracionesAtencionTable.estadoEnvio, "pendiente"),
          sql`${valoracionesAtencionTable.intentos} < ${MAX_INTENTOS}`,
          lte(valoracionesAtencionTable.proximoIntentoEn, new Date()),
        ),
      )
      .orderBy(asc(valoracionesAtencionTable.creadoEn))
      .limit(5);
    for (const p of pendientes) await procesarEnvioValoracion(p.id);
  } catch (err) {
    logger.error({ err }, "valoraciones: error en tick del worker");
  } finally {
    corriendo = false;
  }
}

export function iniciarValoracionesAppWorker(): void {
  logger.info(
    pushValoracionesHabilitado()
      ? "valoraciones: worker de invitaciones a la app iniciado"
      : "valoraciones: invitaciones encoladas pero push deshabilitado (faltan APP_PACIENTE_PUSH_URL / APP_PACIENTE_PUSH_TOKEN)",
  );
  const timer = setInterval(tick, INTERVALO_MS);
  timer.unref();
  void tick();
}
