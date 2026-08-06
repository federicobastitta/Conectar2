// Push saliente de la guardia virtual (videollamadas) al portal del paciente
// (Mi Diagnosticar). Contrato acordado (ago 2026):
//   POST {APP_PACIENTE_PUSH_URL}/api/integracion/videollamadas
//   Header: Authorization: Bearer {APP_PACIENTE_PUSH_TOKEN}
//   Body: { colaId, estado, dni, pacienteNombre?, pacienteApellido?,
//           pacienteTelefono?, posicion?, demoraMinutos?, linkVideollamada? }
// Estados que acepta el portal: en_cola, tu_turno, cancelada, finalizada.
// Reglas del portal: los reenvíos son seguros (no duplican avisos); los
// cambios de demora NO notifican; `tu_turno` SIN linkVideollamada se rechaza
// con 400 — acá NUNCA se encola un tu_turno sin link.
//
// Diseño: cola durable (videollamadas_envios) + worker con backoff, mismo
// patrón que certificados. El payload se congela al encolar (posición y link
// del momento del evento). Nunca se loguean DNI ni el token.

import { and, asc, eq, lte, sql, inArray } from "drizzle-orm";
import {
  db,
  videollamadasColaTable,
  videollamadasEnviosTable,
  turnosTable,
  turnerasTable,
  configSistemaTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { urlVideollamadaTurno } from "../lib/videollamada-turno";
import { crearEstimadorEspera } from "../lib/espera";

const MAX_INTENTOS = 8;
const INTERVALO_MS = 20_000;
const TIMEOUT_MS = 30_000;

export type EventoVideollamada = "en_cola" | "tu_turno" | "cancelada" | "finalizada";

function appPacienteUrl(): string | null {
  const u = process.env.APP_PACIENTE_PUSH_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

export function pushVideollamadasHabilitado(): boolean {
  if (process.env.APP_PACIENTE_PUSH_ENABLED?.trim().toLowerCase() === "false") return false;
  return Boolean(appPacienteUrl() && process.env.APP_PACIENTE_PUSH_TOKEN?.trim());
}

export interface VideollamadaAppPayload {
  /** Id de la consulta/espera en Conectar. El portal lo exige como TEXTO
   * (con número lo rechaza con 400 "Falta videollamadaId", probado ago 2026). */
  videollamadaId: string;
  colaId: number;
  estado: EventoVideollamada;
  dni: string;
  pacienteNombre?: string;
  pacienteApellido?: string;
  pacienteTelefono?: string;
  posicion?: number;
  demoraMinutos?: number;
  linkVideollamada?: string;
  motivo?: string;
}

/**
 * Encola un aviso al portal para una fila de la cola de guardia virtual.
 * El payload se congela acá. Fire-and-forget: nunca falla hacia arriba.
 * Regla dura: tu_turno sin link NO se encola (el portal lo rechaza con 400).
 */
export async function encolarEnvioVideollamada(
  colaId: number,
  evento: EventoVideollamada,
  extra?: { posicion?: number; demoraMinutos?: number; motivo?: string },
): Promise<void> {
  try {
    const [fila] = await db
      .select()
      .from(videollamadasColaTable)
      .where(eq(videollamadasColaTable.id, colaId))
      .limit(1);
    if (!fila) return;

    let link: string | null = null;
    if (fila.turnoId != null) {
      const [turno] = await db
        .select({
          modalidad: turnosTable.modalidad,
          qrCodigo: turnosTable.qrCodigo,
          estado: turnosTable.estado,
        })
        .from(turnosTable)
        .where(eq(turnosTable.id, fila.turnoId))
        .limit(1);
      if (turno) link = urlVideollamadaTurno(turno);
    }
    if (evento === "tu_turno" && !link) {
      logger.warn({ colaId }, "videollamadas: tu_turno sin link — aviso NO encolado (regla del portal)");
      return;
    }

    const payload: VideollamadaAppPayload = {
      videollamadaId: String(colaId),
      colaId,
      estado: evento,
      dni: fila.dni,
      ...(fila.nombre ? { pacienteNombre: fila.nombre } : {}),
      ...(fila.apellido ? { pacienteApellido: fila.apellido } : {}),
      ...(fila.telefono ? { pacienteTelefono: fila.telefono } : {}),
      ...(extra?.posicion != null ? { posicion: extra.posicion } : {}),
      ...(extra?.demoraMinutos != null ? { demoraMinutos: extra.demoraMinutos } : {}),
      ...(link ? { linkVideollamada: link } : {}),
      ...(extra?.motivo ? { motivo: extra.motivo } : {}),
    };
    await db.insert(videollamadasEnviosTable).values({ colaId, evento, payload });
    logger.info({ colaId, evento }, "videollamadas: aviso encolado para el portal");
  } catch (err) {
    logger.error({ err, colaId, evento }, "videollamadas: error encolando aviso");
  }
}

/**
 * Hook para las transiciones de sala de espera / cancelaciones: si el turno
 * pertenece a una fila de guardia virtual, actualiza su estado y avisa al
 * portal. Fire-and-forget (los llamadores usan `void`).
 */
export async function notificarEventoVideollamadaPorTurno(
  turnoId: number,
  evento: EventoVideollamada,
  motivo?: string,
): Promise<void> {
  try {
    const ESTADOS_VIVOS = ["en_cola", "recepcionado", "tu_turno"];
    const nuevoEstadoCola =
      evento === "tu_turno" ? "tu_turno" : evento === "en_cola" ? "recepcionado" : evento;
    const [fila] = await db
      .update(videollamadasColaTable)
      .set({
        estado: nuevoEstadoCola,
        actualizadoEn: new Date(),
        ...(evento === "finalizada" || evento === "cancelada" ? { finalizadaEn: new Date() } : {}),
        ...(motivo ? { motivoCancelacion: motivo } : {}),
      })
      .where(
        and(
          eq(videollamadasColaTable.turnoId, turnoId),
          inArray(videollamadasColaTable.estado, ESTADOS_VIVOS),
        ),
      )
      .returning({ id: videollamadasColaTable.id });
    if (!fila) return;
    await encolarEnvioVideollamada(fila.id, evento, motivo ? { motivo } : undefined);
  } catch (err) {
    logger.error({ err, turnoId, evento }, "videollamadas: error notificando evento por turno");
  }
}

// ── Avance de fila (avisos "quedan N adelante") ─────────────────────────────
// Cada vez que un turno sale de la fila de una guardia (finalizado, cancelado,
// no presentado), se recalculan las posiciones y se reenvía "en_cola" con la
// posición nueva a cada paciente que avanzó. Anti-spam: solo se avisa cuando
// la posición BAJA respecto de ultima_posicion_avisada (el UPDATE con guard
// atómico evita duplicados entre hooks concurrentes).

const CLAVES_TURNERA_GUARDIA = [
  "guardia_virtual_turnera_id",
  "guardia_virtual_pediatria_turnera_id",
];

// Mismos estados que usa el polling público de la guardia para calcular la
// posición (incluye "llamado": el que está en consulta sigue ocupando lugar).
const ESTADOS_FILA_GUARDIA = ["confirmado", "arribo", "recepcionado", "en_sala", "llamado"];

/**
 * Recalcula la fila de la guardia a la que pertenece el turno dado y avisa al
 * portal a cada paciente cuya posición bajó. Fire-and-forget (usar con void).
 */
export async function avanzarFilaGuardia(turnoId: number): Promise<void> {
  try {
    const [turno] = await db
      .select({ turneraId: turnosTable.turneraId, fecha: turnosTable.fecha })
      .from(turnosTable)
      .where(eq(turnosTable.id, turnoId))
      .limit(1);
    if (!turno?.turneraId) return;

    // Solo turneras configuradas como guardia (clínica o pediátrica).
    const cfg = await db
      .select({ valor: configSistemaTable.valor })
      .from(configSistemaTable)
      .where(inArray(configSistemaTable.clave, CLAVES_TURNERA_GUARDIA));
    const turnerasGuardia = new Set(
      cfg.map((f) => Number(f.valor)).filter((n) => Number.isInteger(n) && n > 0),
    );
    if (!turnerasGuardia.has(turno.turneraId)) return;

    // Fila activa de hoy en esa guardia, en orden de llegada.
    const activos = await db
      .select({ id: turnosTable.id })
      .from(turnosTable)
      .where(
        and(
          eq(turnosTable.turneraId, turno.turneraId),
          eq(turnosTable.fecha, turno.fecha),
          inArray(turnosTable.estado, ESTADOS_FILA_GUARDIA),
        ),
      )
      .orderBy(asc(turnosTable.horaInicio), asc(turnosTable.id));
    if (activos.length === 0) return;
    const posPorTurno = new Map(activos.map((t, i) => [t.id, i + 1]));

    // Filas de la cola que siguen esperando y pertenecen a esos turnos.
    const colas = await db
      .select({
        id: videollamadasColaTable.id,
        turnoId: videollamadasColaTable.turnoId,
        ultimaPosicionAvisada: videollamadasColaTable.ultimaPosicionAvisada,
      })
      .from(videollamadasColaTable)
      .where(
        and(
          inArray(videollamadasColaTable.turnoId, activos.map((t) => t.id)),
          eq(videollamadasColaTable.estado, "recepcionado"),
        ),
      );
    if (colas.length === 0) return;

    const [tn] = await db
      .select({ duracionMinutos: turnerasTable.duracionMinutos })
      .from(turnerasTable)
      .where(eq(turnerasTable.id, turno.turneraId))
      .limit(1);
    const estimador = await crearEstimadorEspera(
      turno.fecha,
      [turno.turneraId],
      new Map([[turno.turneraId, tn?.duracionMinutos ?? 15]]),
    );

    for (const c of colas) {
      const pos = c.turnoId != null ? posPorTurno.get(c.turnoId) : undefined;
      if (pos == null) continue;
      // Guard atómico: solo avisa quien logra bajar ultima_posicion_avisada.
      const [gano] = await db
        .update(videollamadasColaTable)
        .set({ ultimaPosicionAvisada: pos, actualizadoEn: new Date() })
        .where(
          and(
            eq(videollamadasColaTable.id, c.id),
            eq(videollamadasColaTable.estado, "recepcionado"),
            sql`(${videollamadasColaTable.ultimaPosicionAvisada} IS NULL OR ${videollamadasColaTable.ultimaPosicionAvisada} > ${pos})`,
          ),
        )
        .returning({ id: videollamadasColaTable.id });
      if (!gano) continue;
      const demoraMinutos = estimador.estimar(turno.turneraId, pos);
      await encolarEnvioVideollamada(c.id, "en_cola", {
        posicion: pos,
        ...(demoraMinutos != null ? { demoraMinutos } : {}),
      });
    }
  } catch (err) {
    logger.error({ err, turnoId }, "videollamadas: error avisando avance de fila");
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
    const res = await fetch(`${base}/api/integracion/videollamadas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const texto = redactarSensible(await res.text());
    if (res.ok) return { ok: true, respuesta: texto };
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

/** Procesa un envío pendiente. Exportada para tests. */
export async function procesarEnvioVideollamada(envioId: number): Promise<void> {
  const [envio] = await db
    .select()
    .from(videollamadasEnviosTable)
    .where(eq(videollamadasEnviosTable.id, envioId))
    .limit(1);
  if (!envio || envio.estado !== "pendiente") return;

  const intentos = envio.intentos + 1;
  const resultado = await enviarAlPortal(envio.payload);

  if (resultado.ok) {
    await db
      .update(videollamadasEnviosTable)
      .set({
        estado: "enviado",
        intentos,
        ultimoError: null,
        appRespuesta: resultado.respuesta.slice(0, 2000),
        ultimoIntentoEn: new Date(),
        enviadoEn: new Date(),
        actualizadoEn: new Date(),
      })
      .where(eq(videollamadasEnviosTable.id, envioId));
    logger.info({ colaId: envio.colaId, evento: envio.evento, intentos }, "videollamadas: aviso enviado al portal");
    return;
  }

  const agotado = resultado.permanente || intentos >= MAX_INTENTOS;
  await db
    .update(videollamadasEnviosTable)
    .set({
      estado: agotado ? "error_permanente" : "pendiente",
      intentos,
      ultimoError: resultado.error.slice(0, 2000),
      ultimoIntentoEn: new Date(),
      proximoIntentoEn: agotado ? null : proximoIntento(intentos),
      actualizadoEn: new Date(),
    })
    .where(eq(videollamadasEnviosTable.id, envioId));
  logger.warn(
    { colaId: envio.colaId, evento: envio.evento, intentos, agotado, error: resultado.error.slice(0, 300) },
    "videollamadas: falló el aviso al portal",
  );
}

let corriendo = false;

async function tick(): Promise<void> {
  if (corriendo) return;
  if (!pushVideollamadasHabilitado()) return;
  corriendo = true;
  try {
    const pendientes = await db
      .select({ id: videollamadasEnviosTable.id })
      .from(videollamadasEnviosTable)
      .where(
        and(
          eq(videollamadasEnviosTable.estado, "pendiente"),
          sql`${videollamadasEnviosTable.intentos} < ${MAX_INTENTOS}`,
          lte(videollamadasEnviosTable.proximoIntentoEn, new Date()),
        ),
      )
      .orderBy(asc(videollamadasEnviosTable.creadoEn))
      .limit(10);
    for (const p of pendientes) {
      await procesarEnvioVideollamada(p.id);
    }
  } catch (err) {
    logger.error({ err }, "videollamadas: error en tick del worker");
  } finally {
    corriendo = false;
  }
}

export function iniciarVideollamadasAppWorker(): void {
  logger.info(
    pushVideollamadasHabilitado()
      ? "videollamadas: worker de avisos al portal iniciado"
      : "videollamadas: avisos encolados pero deshabilitados (faltan APP_PACIENTE_PUSH_URL / APP_PACIENTE_PUSH_TOKEN)",
  );
  const timer = setInterval(tick, INTERVALO_MS);
  timer.unref();
  void tick();
}
