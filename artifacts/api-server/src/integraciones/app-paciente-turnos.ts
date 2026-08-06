// Avisos salientes al portal del paciente cuando la CLÍNICA cancela o mueve
// un turno. Contrato del portal (ago 2026):
//   POST {APP_PACIENTE_PUSH_URL}/api/integracion/turnos
//   Header: Authorization: Bearer {APP_PACIENTE_PUSH_TOKEN} (misma clave que
//   certificados, indicaciones y videollamadas).
//   Body: { turnoId, dni, evento: "cancelado"|"reprogramado", motivo?,
//           fecha?, horaInicio?, fechaAnterior?, horaAnterior?, especialidad? }
// Reglas del portal: en "reprogramado" fecha y horaInicio nuevas son
// obligatorias; motivo se le muestra al paciente TAL CUAL; los reenvíos son
// seguros (repetido:true, no duplican avisos); 409 turno_ambiguo cuenta como
// error permanente (no reintentar a ciegas).
//
// Diseño: cola durable (turnos_avisos_envios) + worker con backoff, mismo
// patrón que videollamadas. El payload se congela al encolar. Nunca se
// loguean DNI ni el token. Los avisos solo salen por acciones del staff:
// las cancelaciones que pide el paciente desde la app NO se avisan (el
// portal ya las conoce, las originó él).

import { and, asc, eq, lte, sql } from "drizzle-orm";
import {
  db,
  turnosTable,
  turnosAvisosEnviosTable,
  pacientesTable,
  turnerasTable,
  especialidadesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";

const MAX_INTENTOS = 8;
const INTERVALO_MS = 20_000;
const TIMEOUT_MS = 30_000;

export type EventoAvisoTurno = "cancelado" | "reprogramado";

function appPacienteUrl(): string | null {
  const u = process.env.APP_PACIENTE_PUSH_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

export function pushAvisosTurnosHabilitado(): boolean {
  if (process.env.APP_PACIENTE_PUSH_ENABLED?.trim().toLowerCase() === "false") return false;
  return Boolean(appPacienteUrl() && process.env.APP_PACIENTE_PUSH_TOKEN?.trim());
}

/**
 * Encola un aviso al portal por un turno cancelado o movido por la clínica.
 * El payload se congela acá. Fire-and-forget: nunca falla hacia arriba.
 * Si el paciente no tiene DNI no se puede avisar (el portal ubica por DNI).
 */
export async function encolarAvisoTurno(
  turnoId: number,
  evento: EventoAvisoTurno,
  // fecha/horaInicio permiten overridear los datos del turno referenciado:
  // en el flujo staff de reprogramación (cancela el viejo + crea uno nuevo)
  // el aviso sale con el id del turno viejo (el que conoce el portal) pero
  // el horario del nuevo.
  extra?: { motivo?: string; fechaAnterior?: string; horaAnterior?: string; fecha?: string; horaInicio?: string },
): Promise<void> {
  try {
    const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, turnoId)).limit(1);
    if (!turno || turno.pacienteId == null) return;
    const [pac] = await db.select({ dni: pacientesTable.dni }).from(pacientesTable)
      .where(eq(pacientesTable.id, turno.pacienteId)).limit(1);
    const dni = pac?.dni?.trim();
    if (!dni) {
      logger.warn({ turnoId, evento }, "avisos-turnos: paciente sin DNI — aviso NO encolado");
      return;
    }
    let especialidad: string | null = null;
    const [turnera] = await db.select({ especialidadId: turnerasTable.especialidadId })
      .from(turnerasTable).where(eq(turnerasTable.id, turno.turneraId)).limit(1);
    if (turnera?.especialidadId != null) {
      const [esp] = await db.select({ nombre: especialidadesTable.nombre })
        .from(especialidadesTable).where(eq(especialidadesTable.id, turnera.especialidadId)).limit(1);
      especialidad = esp?.nombre ?? null;
    }

    const payload = {
      turnoId,
      dni,
      evento,
      // En "reprogramado" el portal exige fecha y horaInicio nuevas; en
      // "cancelado" también las mandamos para ayudar a ubicar el turno.
      fecha: extra?.fecha ?? turno.fecha,
      horaInicio: extra?.horaInicio ?? turno.horaInicio,
      ...(extra?.motivo?.trim() ? { motivo: extra.motivo.trim() } : {}),
      ...(extra?.fechaAnterior ? { fechaAnterior: extra.fechaAnterior } : {}),
      ...(extra?.horaAnterior ? { horaAnterior: extra.horaAnterior } : {}),
      ...(especialidad ? { especialidad } : {}),
    };
    await db.insert(turnosAvisosEnviosTable).values({ turnoId, evento, payload });
    logger.info({ turnoId, evento }, "avisos-turnos: aviso encolado para el portal");
  } catch (err) {
    logger.error({ err, turnoId, evento }, "avisos-turnos: error encolando aviso");
  }
}

/** POST al portal. Nunca loguea DNI ni el token. */
async function enviarAlPortal(
  payload: unknown,
): Promise<{ ok: true; respuesta: string } | { ok: false; error: string; permanente: boolean }> {
  const base = appPacienteUrl();
  const token = process.env.APP_PACIENTE_PUSH_TOKEN?.trim();
  if (!base || !token) {
    return { ok: false, error: "APP_PACIENTE_PUSH_URL o APP_PACIENTE_PUSH_TOKEN no configuradas", permanente: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/integracion/turnos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const texto = redactarSensible(await res.text());
    if (res.ok) return { ok: true, respuesta: texto };
    // 409 turno_ambiguo: el portal no lo va a resolver reintentando lo mismo.
    const permanente = res.status >= 400 && res.status < 500 && ![401, 403, 408, 429].includes(res.status);
    return { ok: false, error: `HTTP ${res.status}: ${texto.slice(0, 300)}`, permanente };
  } catch (err) {
    const mensaje = err instanceof Error && err.name === "AbortError" ? "Timeout" : String(err);
    return { ok: false, error: mensaje, permanente: false };
  } finally {
    clearTimeout(timer);
  }
}

function redactarSensible(texto: string): string {
  return texto.replace(/\d{7,}/g, (d) => `${d.slice(0, 2)}***`);
}

function proximoIntento(intentos: number): Date {
  const minutos = Math.min(2 ** intentos, 60);
  return new Date(Date.now() + minutos * 60_000);
}

/** Procesa un envío pendiente. Exportada para tests.
 * Claim atómico: el UPDATE condicionado (estado pendiente + próximo intento
 * vencido) suma el intento y corre el próximo intento como "lease", así dos
 * workers concurrentes nunca postean el mismo aviso dos veces. */
export async function procesarAvisoTurno(envioId: number): Promise<void> {
  const ahora = new Date();
  const [envio] = await db
    .update(turnosAvisosEnviosTable)
    .set({
      intentos: sql`${turnosAvisosEnviosTable.intentos} + 1`,
      ultimoIntentoEn: ahora,
      // Lease pesimista: si el proceso muere en medio del POST, otro worker
      // recién lo retoma cuando venza este próximo intento.
      proximoIntentoEn: proximoIntento(1),
      actualizadoEn: ahora,
    })
    .where(
      and(
        eq(turnosAvisosEnviosTable.id, envioId),
        eq(turnosAvisosEnviosTable.estado, "pendiente"),
        sql`${turnosAvisosEnviosTable.intentos} < ${MAX_INTENTOS}`,
        lte(turnosAvisosEnviosTable.proximoIntentoEn, ahora),
      ),
    )
    .returning();
  if (!envio) return;

  const intentos = envio.intentos; // ya incluye el intento reclamado
  const resultado = await enviarAlPortal(envio.payload);

  if (resultado.ok) {
    await db
      .update(turnosAvisosEnviosTable)
      .set({
        estado: "enviado",
        intentos,
        ultimoError: null,
        appRespuesta: resultado.respuesta.slice(0, 2000),
        ultimoIntentoEn: new Date(),
        enviadoEn: new Date(),
        actualizadoEn: new Date(),
      })
      .where(eq(turnosAvisosEnviosTable.id, envioId));
    logger.info({ turnoId: envio.turnoId, evento: envio.evento, intentos }, "avisos-turnos: aviso enviado al portal");
    return;
  }

  const agotado = resultado.permanente || intentos >= MAX_INTENTOS;
  await db
    .update(turnosAvisosEnviosTable)
    .set({
      estado: agotado ? "error_permanente" : "pendiente",
      intentos,
      ultimoError: resultado.error.slice(0, 2000),
      ultimoIntentoEn: new Date(),
      proximoIntentoEn: agotado ? null : proximoIntento(intentos),
      actualizadoEn: new Date(),
    })
    .where(eq(turnosAvisosEnviosTable.id, envioId));
  logger.warn(
    { turnoId: envio.turnoId, evento: envio.evento, intentos, agotado, error: resultado.error.slice(0, 300) },
    "avisos-turnos: falló el aviso al portal",
  );
}

let corriendo = false;

async function tick(): Promise<void> {
  if (corriendo) return;
  if (!pushAvisosTurnosHabilitado()) return;
  corriendo = true;
  try {
    const pendientes = await db
      .select({ id: turnosAvisosEnviosTable.id })
      .from(turnosAvisosEnviosTable)
      .where(
        and(
          eq(turnosAvisosEnviosTable.estado, "pendiente"),
          sql`${turnosAvisosEnviosTable.intentos} < ${MAX_INTENTOS}`,
          lte(turnosAvisosEnviosTable.proximoIntentoEn, new Date()),
        ),
      )
      .orderBy(asc(turnosAvisosEnviosTable.creadoEn))
      .limit(10);
    for (const p of pendientes) {
      await procesarAvisoTurno(p.id);
    }
  } catch (err) {
    logger.error({ err }, "avisos-turnos: error en tick del worker");
  } finally {
    corriendo = false;
  }
}

export function iniciarAvisosTurnosWorker(): void {
  logger.info(
    pushAvisosTurnosHabilitado()
      ? "avisos-turnos: worker de avisos al portal iniciado"
      : "avisos-turnos: avisos encolados pero deshabilitados (faltan APP_PACIENTE_PUSH_URL / APP_PACIENTE_PUSH_TOKEN)",
  );
  const timer = setInterval(tick, INTERVALO_MS);
  timer.unref();
  void tick();
}
