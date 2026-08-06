import { eq, sql } from "drizzle-orm";
import {
  db,
  turnosTable,
  turnerasTable,
  pacientesTable,
  profesionalesTable,
  especialidadesTable,
  sedesTable,
} from "@workspace/db";
import { logger } from "./logger";

// Los tipos de las nuevas tablas se importan por nombre para no romper
// la lib antes de que se regenere; se usan solo en runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dbDynamic(): Promise<any> {
  return db;
}

export type TipoEvento =
  | "ALTA"
  | "ACTUALIZACION"
  | "REPROGRAMACION"
  | "CANCELACION"
  | "TOKEN_DISPONIBLE";

// Estados de turno que NO generan evento ALTA (pero sí CANCELACION cuando corresponde)
const ESTADOS_EXCLUIDOS_ALTA = new Set([
  "cancelado",
  "ausente",
  "a_reprogramar",
  "reprogramado",
  "anulado",
]);

/**
 * Calcula la fecha de elegibilidad: 00:01 del día del turno en
 * America/Argentina/Buenos_Aires (UTC-3). El Robot no debe ejecutar antes.
 * Si esa fecha ya pasó (horario AR), la elegibilidad es NOW().
 */
export function fechaElegibilidad(fechaTurno: string): Date {
  const objetivo = new Date(`${fechaTurno}T00:01:00.000-03:00`);
  const ahora = new Date();
  return objetivo > ahora ? objetivo : ahora;
}

/**
 * Resuelve las equivalencias Klinicos para un turno dado, leyendo las
 * tablas klinicos_eq_* desde la DB. Si alguna falta, se incluye en alertas.
 * No lanza excepciones: devuelve alertas en el objeto.
 */
async function resolverEquivalencias(
  sedeId: number | null | undefined,
  especialidadId: number | null | undefined,
  profesionalId: number | null | undefined,
): Promise<{
  sedeKlinicos: string | null;
  sectorKlinicos: string | null;
  especialidadKlinicos: string | null;
  profesionalKlinicos: string | null;
  alertas: string[];
}> {
  const alertas: string[] = [];
  let sedeKlinicos: string | null = null;
  let sectorKlinicos: string | null = null;
  let especialidadKlinicos: string | null = null;
  let profesionalKlinicos: string | null = null;

  try {
    if (sedeId) {
      const eq = (
        await db.execute(
          sql`SELECT klinicos_establecimiento, klinicos_sector FROM klinicos_eq_sedes
              WHERE sede_id = ${sedeId} AND activo = true LIMIT 1`,
        )
      ).rows[0];
      if (eq) {
        const r = eq as Record<string, string | null>;
        sedeKlinicos = r.klinicos_establecimiento ?? null;
        sectorKlinicos = r.klinicos_sector ?? null;
      } else {
        alertas.push("sin_equiv_sede");
      }
    } else {
      alertas.push("sin_sede");
    }

    if (especialidadId) {
      const eq = (
        await db.execute(
          sql`SELECT klinicos_especialidad FROM klinicos_eq_especialidades
              WHERE especialidad_id = ${especialidadId} AND activo = true LIMIT 1`,
        )
      ).rows[0];
      if (eq) {
        especialidadKlinicos = (eq as Record<string, string | null>).klinicos_especialidad ?? null;
      } else {
        alertas.push("sin_equiv_especialidad");
      }
    } else {
      alertas.push("sin_especialidad");
    }

    if (profesionalId) {
      const eq = (
        await db.execute(
          sql`SELECT klinicos_profesional_nombre FROM klinicos_eq_profesionales
              WHERE profesional_id = ${profesionalId} AND activo = true LIMIT 1`,
        )
      ).rows[0];
      if (eq) {
        profesionalKlinicos =
          (eq as Record<string, string | null>).klinicos_profesional_nombre ?? null;
      } else {
        alertas.push("sin_equiv_profesional");
      }
    } else {
      alertas.push("sin_profesional");
    }
  } catch (err) {
    logger.warn({ err }, "outbox-emitter: error resolviendo equivalencias");
    alertas.push("error_equiv");
  }

  return { sedeKlinicos, sectorKlinicos, especialidadKlinicos, profesionalKlinicos, alertas };
}

/**
 * Construye el payload completo del evento (snapshot del turno + contexto).
 * El Robot necesita todo lo que necesita para ejecutar en Klinicos sin
 * volver a consultar a Conectar.
 */
async function construirPayload(
  turnoId: number,
  tipoEvento: TipoEvento,
): Promise<Record<string, unknown> | null> {
  const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, turnoId)).limit(1);
  if (!turno) return null;

  const [paciente] = turno.pacienteId
    ? await db
        .select()
        .from(pacientesTable)
        .where(eq(pacientesTable.id, turno.pacienteId))
        .limit(1)
    : [null];

  const [turnera] = turno.turneraId
    ? await db
        .select()
        .from(turnerasTable)
        .where(eq(turnerasTable.id, turno.turneraId))
        .limit(1)
    : [null];

  const [profesional] = turno.profesionalId
    ? await db
        .select()
        .from(profesionalesTable)
        .where(eq(profesionalesTable.id, turno.profesionalId))
        .limit(1)
    : [null];

  const [especialidad] = turnera?.especialidadId
    ? await db
        .select()
        .from(especialidadesTable)
        .where(eq(especialidadesTable.id, turnera.especialidadId))
        .limit(1)
    : [null];

  const [sede] = turnera?.sedeId
    ? await db.select().from(sedesTable).where(eq(sedesTable.id, turnera.sedeId)).limit(1)
    : [null];

  const eq_ = await resolverEquivalencias(
    turnera?.sedeId,
    turnera?.especialidadId,
    turno.profesionalId,
  );

  const alertas = [...eq_.alertas];
  if (!paciente?.nroAfiliado && !turno.nroAfiliado) alertas.push("sin_afiliado");
  if (!turno.klinicosToken) alertas.push("sin_token");

  return {
    tipo: tipoEvento,
    turnoId,
    turno: {
      fecha: turno.fecha,
      horaInicio: turno.horaInicio,
      horaFin: turno.horaFin,
      estado: turno.estado,
      modalidad: turno.modalidad,
      sobreturno: turno.sobreturno,
      motivoConsulta: turno.motivoConsulta ?? null,
      cobertura: turno.cobertura ?? null,
      nroAfiliado: turno.nroAfiliado ?? null,
    },
    paciente: paciente
      ? {
          id: paciente.id,
          dni: paciente.dni ?? null,
          apellido: paciente.apellido ?? null,
          nombre: paciente.nombre ?? null,
          sexo: paciente.sexo ?? null,
          fechaNacimiento: paciente.fechaNacimiento ?? null,
          nroAfiliado: paciente.nroAfiliado ?? null,
          cobertura: paciente.cobertura ?? null,
        }
      : null,
    profesional: profesional
      ? {
          id: profesional.id,
          apellido: profesional.apellido ?? null,
          nombre: profesional.nombre ?? null,
        }
      : null,
    turnera: turnera
      ? {
          id: turnera.id,
          nombre: turnera.nombre,
          modalidad: turnera.modalidad,
          duracionMinutos: turnera.duracionMinutos,
          klinicosSector: turnera.klinicosSector ?? null,
          klinicosEspecialidad: turnera.klinicosEspecialidad ?? null,
          klinicosProfesional: turnera.klinicosProfesional ?? null,
        }
      : null,
    especialidad: especialidad ? { id: especialidad.id, nombre: especialidad.nombre } : null,
    sede: sede ? { id: sede.id, nombre: sede.nombre } : null,
    equivalencias: {
      sedeKlinicos: eq_.sedeKlinicos,
      sectorKlinicos: eq_.sectorKlinicos,
      especialidadKlinicos: eq_.especialidadKlinicos,
      profesionalKlinicos: eq_.profesionalKlinicos,
      resuelta: eq_.alertas.length === 0,
      alertas: eq_.alertas,
    },
    klinicosToken: turno.klinicosToken ?? null,
    fechaElegibilidadIso: fechaElegibilidad(turno.fecha).toISOString(),
    alertas,
    generadoEn: new Date().toISOString(),
  };
}

/**
 * Emite un evento al outbox. Debe llamarse dentro de la misma transacción
 * Drizzle que modificó el turno para garantizar consistencia.
 * Si las tablas aún no existen (primera ejecución), falla silenciosamente
 * para no romper el flujo de creación de turnos.
 *
 * @param turnoId - ID del turno en Conectar
 * @param tipoEvento - tipo del evento
 * @param turnoEstado - estado actual del turno (para validar si es elegible para ALTA)
 */
export async function emitirEventoTurno(
  turnoId: number,
  tipoEvento: TipoEvento,
  turnoEstado?: string,
): Promise<number | null> {
  // Validar: no emitir ALTA si el estado del turno está excluido
  if (tipoEvento === "ALTA" && turnoEstado && ESTADOS_EXCLUIDOS_ALTA.has(turnoEstado)) {
    logger.info(
      { turnoId, estado: turnoEstado },
      "outbox-emitter: ALTA omitida por estado excluido",
    );
    return null;
  }

  try {
    // Versión monotónica por turnoId
    const versionRows = await db.execute(
      sql`SELECT COALESCE(MAX(version), 0) + 1 AS next_version
          FROM klinicos_eventos_salida WHERE turno_id = ${turnoId}`,
    );
    const nextVersion = Number(
      (versionRows.rows[0] as Record<string, unknown>)?.next_version ?? 1,
    );

    const payload = await construirPayload(turnoId, tipoEvento);
    if (!payload) {
      logger.warn({ turnoId }, "outbox-emitter: turno no encontrado, evento omitido");
      return null;
    }

    const inserted = await db.execute(
      sql`INSERT INTO klinicos_eventos_salida
          (turno_id, version, tipo_evento, payload, estado, proximo_intento_en)
          VALUES (
            ${turnoId},
            ${nextVersion},
            ${tipoEvento},
            ${JSON.stringify(payload)},
            'pendiente',
            now()
          )
          RETURNING id`,
    );
    const eventoId = Number((inserted.rows[0] as Record<string, unknown>)?.id ?? 0);

    // Audit log
    await db.execute(
      sql`INSERT INTO klinicos_eventos_log
          (evento_id, turno_id, accion, estado_antes, estado_despues,
           fecha_prevista, fecha_real_intento, timezone, resultado, detalle)
          VALUES (
            ${eventoId}, ${turnoId}, 'crear', null, 'pendiente',
            ${payload.fechaElegibilidadIso as string},
            now(), 'America/Argentina/Buenos_Aires', 'ok',
            ${`Evento ${tipoEvento} v${nextVersion} creado`}
          )`,
    );

    logger.info(
      { turnoId, eventoId, tipoEvento, version: nextVersion },
      "outbox-emitter: evento creado",
    );
    return eventoId;
  } catch (err) {
    // Si las tablas no existen todavía (primera migración), no romper el flujo
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("klinicos_eventos_salida") || msg.includes("does not exist")) {
      logger.warn({ turnoId }, "outbox-emitter: tabla no existe todavía, evento omitido");
      return null;
    }
    logger.error({ err, turnoId, tipoEvento }, "outbox-emitter: error emitiendo evento");
    return null; // nunca romper el flujo del turno
  }
}
