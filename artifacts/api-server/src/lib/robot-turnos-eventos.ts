import { eq, sql } from "drizzle-orm";
import {
  db,
  turnosTable,
  turnerasTable,
  pacientesTable,
  profesionalesTable,
  especialidadesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { codigoFacturacionPractica } from "./klinicos-codigo-facturacion";

// ── Log de eventos de turnos para el Robot Klinicos (pull) ────────────────
// Complementa el circuito existente (klinicos_trabajos + worker push): cada
// alta / actualización / reprogramación / cancelación / token habilitado se
// persiste como evento append-only con eventoId autoincremental. El Robot
// consume GET /api/robot-klinicos/turnos/eventos con cursor desdeId.
// El Robot es idempotente por turno_id + version: no importa si un evento
// llega dos veces (webhook + pull), pero el eventoId es monótono creciente.

export type EventoTurnoRobot =
  | "alta"
  | "actualizacion"
  | "reprogramacion"
  | "cancelacion"
  | "token_disponible";

/** Migración idempotente de arranque: solo crea la tabla si falta. */
export async function migrarRobotTurnosEventos(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS robot_turnos_eventos (
      id serial PRIMARY KEY,
      turno_id integer NOT NULL,
      version integer NOT NULL,
      evento text NOT NULL,
      payload jsonb NOT NULL,
      creado_en timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT robot_turnos_eventos_turno_version_uidx UNIQUE (turno_id, version)
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS robot_turnos_eventos_turno_idx ON robot_turnos_eventos (turno_id)`,
  );
  logger.info("migraciones: robot_turnos_eventos lista");
}

function soloDigitos(v: string | null | undefined): string | null {
  const limpio = (v ?? "").replace(/\D/g, "");
  return limpio.length >= 6 && limpio.length <= 9 ? limpio : null;
}

/**
 * Snapshot plano del turno con el mismo esquema de campos que el webhook al
 * Robot: dni, paciente_nombre, fecha_atencion, practice_code, especialidad,
 * profesional, token. Los campos sin valor se omiten.
 */
async function construirPayload(
  turnoId: number,
  evento: EventoTurnoRobot,
): Promise<Record<string, unknown> | null> {
  const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, turnoId)).limit(1);
  if (!turno) return null;

  const [paciente] = turno.pacienteId
    ? await db.select().from(pacientesTable).where(eq(pacientesTable.id, turno.pacienteId)).limit(1)
    : [null];
  const [turnera] = turno.turneraId
    ? await db.select().from(turnerasTable).where(eq(turnerasTable.id, turno.turneraId)).limit(1)
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

  // Códigos de las prácticas del nomenclador asociadas al turno. Un turno
  // puede llevar varios estudios: cada práctica resuelve su practice_code
  // EXACTO de la planilla por separado (nunca se inventan combinaciones).
  // practice_code lleva el de la práctica principal (compatibilidad con el
  // Robot actual); practice_codes lista todos los resueltos, en orden.
  let practiceCode: string | null = null;
  let practiceCodes: string[] = [];
  try {
    const r = await db.execute(sql`
      SELECT tp.klinicos_practica_id AS practica_id, kp.codigos, kp.codigo_envio, kp.codigo_facturacion
      FROM turno_practicas tp
      JOIN klinicos_practicas kp ON kp.id = tp.klinicos_practica_id
      WHERE tp.turno_id = ${turno.id}
      ORDER BY tp.id
    `);
    let filas = r.rows as Array<{
      practica_id?: unknown; codigos?: unknown; codigo_envio?: unknown; codigo_facturacion?: unknown;
    }>;
    // Turnos anteriores a turno_practicas: cae al campo singular legado.
    if (filas.length === 0 && turno.klinicosPracticaId) {
      const legacy = await db.execute(
        sql`SELECT id AS practica_id, codigos, codigo_envio, codigo_facturacion FROM klinicos_practicas WHERE id = ${turno.klinicosPracticaId} LIMIT 1`,
      );
      filas = legacy.rows as typeof filas;
    }
    for (const fila of filas) {
      const codigos = Array.isArray(fila?.codigos)
        ? (fila.codigos as unknown[]).filter((c): c is string => typeof c === "string")
        : [];
      // Planilla Conectar: codigo_envio textual exacto → override legado →
      // planilla embebida → código único; null si nada matchea (no inventar).
      const code = codigoFacturacionPractica({
        codigoEnvio: typeof fila?.codigo_envio === "string" ? fila.codigo_envio : null,
        codigoFacturacion: typeof fila?.codigo_facturacion === "string" ? fila.codigo_facturacion : null,
        codigos,
      });
      if (code) practiceCodes.push(code);
      if (code && Number(fila?.practica_id) === turno.klinicosPracticaId) practiceCode = code;
    }
    // practice_code representa SIEMPRE la práctica principal: si esa no
    // resuelve código, se omite (los demás quedan solo en practice_codes).
  } catch {
    /* práctica opcional: no bloquear el evento */
  }

  const payload: Record<string, unknown> = {
    turno_id: `TURNO-${turno.id}`,
    estado_turno: turno.estado,
    fecha_atencion: turno.fecha,
    hora_atencion: turno.horaInicio,
    modalidad: turno.modalidad,
  };

  const dni = soloDigitos(paciente?.dni);
  if (dni) payload.dni = dni;
  if (paciente) {
    payload.paciente_nombre = [paciente.apellido, paciente.nombre]
      .filter(Boolean)
      .join(" ")
      .toUpperCase();
    payload.document_type = "DNI";
    payload.patient_id = `PAC-${paciente.id}`;
    const afiliado = turno.nroAfiliado ?? paciente.nroAfiliado;
    if (afiliado) payload.affiliate_number = afiliado;
    const cobertura = turno.cobertura ?? paciente.cobertura;
    if (cobertura) payload.cobertura = cobertura;
    if (paciente.sexo) payload.sexo = paciente.sexo;
    if (paciente.telefono) payload.telefono = paciente.telefono;
  }
  if (practiceCode) payload.practice_code = practiceCode;
  if (practiceCodes.length > 1) payload.practice_codes = practiceCodes;
  const nombreEspecialidad = turno.klinicosEspecialidad ?? especialidad?.nombre;
  if (nombreEspecialidad) payload.especialidad = nombreEspecialidad;
  if (profesional) {
    payload.profesional = [profesional.apellido, profesional.nombre]
      .filter(Boolean)
      .join(", ")
      .toUpperCase();
    payload.profesional_id = `PROF-${profesional.id}`;
  } else if (turno.klinicosProfesional) {
    payload.profesional = turno.klinicosProfesional;
  } else if (turnera?.esGuardia) {
    // Guardia grupal: sin profesional asignado en Conectar, pero Klinicos
    // exige uno — se carga siempre "SAEZ, IGNACIO" (regla 01/08/2026, nombre
    // exacto del desplegable de Klinicos).
    payload.profesional = "SAEZ, IGNACIO";
  }
  if (turno.motivoConsulta) payload.motivo = turno.motivoConsulta;
  if (evento === "token_disponible" && turno.klinicosToken) payload.token = turno.klinicosToken;

  return payload;
}

/**
 * Registra un evento en el log. Nunca lanza: un fallo acá no debe romper el
 * flujo del turno (el Robot lo recuperará por el webhook o al reintentar).
 * La versión es monótona por turno (1, 2, 3, …); ante una carrera por el
 * unique (turno_id, version) se reintenta una vez.
 */
export async function registrarEventoTurnoRobot(
  turnoId: number,
  evento: EventoTurnoRobot,
): Promise<number | null> {
  try {
    const payload = await construirPayload(turnoId, evento);
    if (!payload) {
      logger.warn({ turnoId, evento }, "robot-turnos-eventos: turno no encontrado, evento omitido");
      return null;
    }
    // Solo los turnos con obra social IOMA van al buffer del Robot.
    const cobertura = typeof payload.cobertura === "string" ? payload.cobertura : "";
    if (!/ioma/i.test(cobertura)) {
      logger.info(
        { turnoId, evento, cobertura: cobertura || null },
        "robot-turnos-eventos: cobertura no es IOMA, evento omitido",
      );
      return null;
    }
    const insertar = () =>
      db.execute(sql`
        INSERT INTO robot_turnos_eventos (turno_id, version, evento, payload)
        SELECT ${turnoId},
               COALESCE(MAX(version), 0) + 1,
               ${evento},
               ${JSON.stringify(payload)}::jsonb
        FROM robot_turnos_eventos WHERE turno_id = ${turnoId}
        RETURNING id, version
      `);
    let fila: Record<string, unknown> | undefined;
    try {
      fila = (await insertar()).rows[0] as Record<string, unknown> | undefined;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "23505") throw err;
      fila = (await insertar()).rows[0] as Record<string, unknown> | undefined;
    }
    const eventoId = Number(fila?.id ?? 0) || null;
    logger.info(
      { turnoId, evento, eventoId, version: Number(fila?.version ?? 0) },
      "robot-turnos-eventos: evento registrado",
    );
    return eventoId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("robot_turnos_eventos")) {
      logger.warn({ turnoId, evento }, "robot-turnos-eventos: tabla no existe todavía, evento omitido");
      return null;
    }
    logger.error({ err, turnoId, evento }, "robot-turnos-eventos: error registrando evento");
    return null;
  }
}
