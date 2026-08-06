import { eq, sql } from "drizzle-orm";
import {
  db,
  configSistemaTable,
  klinicosTrabajos,
  klinicosReglasSector,
  pacientesTable,
  turnosTable,
  turnerasTable,
  turneraPracticasTable,
  especialidadesTable,
  profesionalesTable,
  studyOrdersTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { hoyArgentina } from "../lib/tiempo";
import { resolverPractica, resolverCie10PorRegla } from "./klinicos-worker";
import { detectarEspecialidadConsulta } from "./klinicos-robot";
import { elegirProfesionalIngreso } from "../lib/seed-profesionales-ingreso";
import { practicasDeTurno } from "../lib/turno-practicas";

// ── Cola de trabajos del robot Klinicos ────────────────────────────────────
// Al recepcionar (admitir) un paciente en Conectar, encolamos un trabajo para
// que el robot cargue el ingreso ambulatorio en Klinicos (klinicos.aceapp.ar).
// El encolado NUNCA debe romper la recepción: cualquier error se loguea y se
// sigue adelante.

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

const PALABRAS_IMAGENES = ["IMAGEN", "ECOGRAF", "RADIOLOG", "RAYOS", "MAMOGRAF", "DOPPLER", "RX"];

const OBRAS_SOCIALES_KLINICOS = ["IOMA"];
export function esSectorConsultorio(sector: string): boolean {
  return normalizar(sector).startsWith("CONSULTORIO");
}

// Cache corto de reglas de sector: evita releer la tabla completa por cada
// especialidad dentro de un mismo request (N+1 costoso con la DB remota).
let reglasCache: { promesa: Promise<(typeof klinicosReglasSector.$inferSelect)[]>; hasta: number } | null = null;
const REGLAS_TTL_MS = 30_000;

// Al cambiar una regla (upsert desde configuración) hay que invalidar el
// cache: si no, resolverSectorServicio devuelve el sector viejo hasta 30 s.
export function invalidarCacheReglasSector(): void {
  reglasCache = null;
}

function reglasActivas(): Promise<(typeof klinicosReglasSector.$inferSelect)[]> {
  // Se cachea la PROMESA (no el resultado) para que N llamadas simultáneas
  // compartan una única consulta en vuelo.
  if (reglasCache && reglasCache.hasta > Date.now()) return reglasCache.promesa;
  const promesa = db
    .select()
    .from(klinicosReglasSector)
    .where(eq(klinicosReglasSector.activo, true))
    .catch((e) => {
      reglasCache = null; // no cachear errores
      throw e;
    });
  reglasCache = { promesa, hasta: Date.now() + REGLAS_TTL_MS };
  return promesa;
}
export async function resolverSectorServicio(especialidad: string): Promise<string> {
  const norm = normalizar(especialidad);
  const reglas = await reglasActivas();
  const regla = reglas.find((r) => normalizar(r.especialidad) === norm);
  if (regla) return regla.sectorServicio;
  // Heurística por defecto: si suena a imágenes → IMAGENES S/C, si no CONSULTORIO
  if (PALABRAS_IMAGENES.some((p) => norm.includes(p))) return "IMAGENES S/C";
  return "CONSULTORIO";
}

// Orden de estudio automática: cuando el turno recepcionado es de una práctica
// (sector IMAGENES S/C), se genera sola la orden en Conectar con la práctica,
// el profesional y el diagnóstico resueltos por las reglas de equivalencia.
// Idempotente por turno. Nunca rompe la recepción: cualquier error se loguea.
async function crearOrdenEstudioAutomatica(params: {
  turnoId: number;
  pacienteId: number;
  profesionalId: number | null;
  especialidad: string;
  motivo: string | null;
  sectorServicio: string;
  usuarioId: number | null;
}): Promise<void> {
  try {
    if (params.sectorServicio !== "IMAGENES S/C") return;
    if (!params.profesionalId) {
      logger.info({ turnoId: params.turnoId }, "klinicos-cola: turno de práctica sin profesional, no se genera orden automática");
      return;
    }
    // Idempotencia: una orden automática por turno
    const [existente] = await db
      .select({ id: studyOrdersTable.id })
      .from(studyOrdersTable)
      .where(eq(studyOrdersTable.turnoId, params.turnoId))
      .limit(1);
    if (existente) return;

    const [practica, cie10] = await Promise.all([
      resolverPractica(params),
      resolverCie10PorRegla(params),
    ]);
    const studyName = practica.practicaNombre ?? params.especialidad;
    const justificacion = cie10
      ? `${cie10.cie10Descripcion} (${cie10.cie10Codigo})`
      : (params.motivo ?? null);

    const [orden] = await db
      .insert(studyOrdersTable)
      .values({
        patientId: params.pacienteId,
        professionalId: params.profesionalId,
        turnoId: params.turnoId,
        studyType: "imagenes",
        studyName,
        clinicalJustification: justificacion,
        observations: practica.codigos?.length
          ? `Orden generada automáticamente al recepcionar. Códigos: ${practica.codigos.join(", ")}`
          : "Orden generada automáticamente al recepcionar.",
        status: "programado", // el turno ya existe: entra al circuito lista para realizarse
        statusUpdatedAt: new Date(),
        createdBy: params.usuarioId ?? params.profesionalId,
      })
      .returning({ id: studyOrdersTable.id });
    logger.info(
      { turnoId: params.turnoId, ordenId: orden.id, studyName },
      "klinicos-cola: orden de estudio generada automáticamente",
    );
    // Push al Robot Klinicos: DESACTIVADO por decisión del usuario (jul 2026).
    // Solo deben viajar planillas firmadas; el envío se habilitará desde el
    // circuito de firma cuando el usuario lo confirme.
  } catch (err) {
    logger.error({ err, turnoId: params.turnoId }, "klinicos-cola: error generando orden de estudio automática");
  }
}

// Pedido del usuario (01/08/2026): los turnos de prácticas se dejan cargados
// en Klinicos apenas se reservan, quedando pendientes de la carga del token
// (que el paciente genera después). Solo aplica a agendas con prácticas del
// nomenclador; las CONSULTAS se generan recién al Validar Token (regla de
// facturación confirmada el 02/08/2026: la consulta NO debe crearse antes de
// que el paciente traiga el token — la pre-carga anticipada quedó revertida).
export async function encolarTrabajoAlReservar(turnoId: number, turneraId: number, usuarioId: number | null = null): Promise<void> {
  try {
    if (!(await esAgendaDePracticas(turneraId))) return;
    // Origen "manual": reservar el turno es una acción explícita de recepción,
    // así que pasa el kill-switch de autoencolado (que frena solo lo "auto").
    // Sin esto, en prod (autoencolado apagado) las prácticas no se encolaban
    // al reservar (detectado 03/08/2026 con el turno de prueba).
    const trabajoId = await encolarTrabajoKlinicos(turnoId, usuarioId, "manual");
    // Preparación inmediata (pedido 03/08/2026): apenas se reserva se procesa
    // el trabajo (enriquecido + orden automática + simulación) sin esperar el
    // tick del worker, para que con el paciente en el mostrador solo quede
    // validar el token y confirmar. Fire-and-forget: la reserva no espera.
    if (trabajoId) {
      const { procesarTrabajo } = await import("./klinicos-worker");
      void procesarTrabajo(trabajoId).catch((err) =>
        logger.error({ err, trabajoId, turnoId }, "klinicos-cola: falló la preparación inmediata al reservar"),
      );
    }
  } catch (err) {
    logger.error({ err, turnoId }, "klinicos-cola: error encolando trabajo al reservar");
  }
}

// Es una agenda de prácticas si: tiene prácticas del nomenclador cargadas,
// o su sector Klinicos (explícito o resuelto por la heurística habitual)
// NO es consultorio (imágenes, ecografías, cardio, etc.).
async function esAgendaDePracticas(turneraId: number): Promise<boolean> {
  const [practica] = await db
    .select({ id: turneraPracticasTable.id })
    .from(turneraPracticasTable)
    .where(eq(turneraPracticasTable.turneraId, turneraId))
    .limit(1);
  if (practica) return true;
  const [t] = await db
    .select({
      klinicosSector: turnerasTable.klinicosSector,
      klinicosEspecialidad: turnerasTable.klinicosEspecialidad,
      nombre: turnerasTable.nombre,
      especialidad: especialidadesTable.nombre,
    })
    .from(turnerasTable)
    .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .where(eq(turnerasTable.id, turneraId))
    .limit(1);
  if (!t) return false;
  const sector =
    t.klinicosSector ??
    (await resolverSectorServicio(t.klinicosEspecialidad ?? t.especialidad ?? t.nombre));
  return !esSectorConsultorio(sector);
}

// Estados de turno que ya no van a pasar por la carga en Klinicos (o que la
// cancelación del turno ya resolvió por su cuenta).
const ESTADOS_TURNO_NO_ENCOLABLES = ["cancelado", "anulado", "ausente", "atendido", "finalizado"];

// Pedido del usuario (01/08/2026, caso Holter): al corregir una agenda que
// pasa a ser "de prácticas" (se tildan prácticas o se ajusta el sector
// Klinicos), los turnos futuros ya reservados quedaban sin trabajo en la
// bandeja del robot. Esta función los encola retroactivamente, reutilizando
// el mismo dedup por turno de encolarTrabajoKlinicos.
export async function encolarTurnosFuturosDeTurnera(turneraId: number, usuarioId: number | null = null): Promise<void> {
  try {
    if (!(await esAgendaDePracticas(turneraId))) return;
    const turnos = await db
      .select({ id: turnosTable.id })
      .from(turnosTable)
      .where(sql`${turnosTable.turneraId} = ${turneraId}
        AND ${turnosTable.fecha} >= ${hoyArgentina()}
        AND ${turnosTable.estado} NOT IN (${sql.join(ESTADOS_TURNO_NO_ENCOLABLES.map((e) => sql`${e}`), sql`, `)})
        AND NOT EXISTS (
          SELECT 1 FROM ${klinicosTrabajos}
          WHERE ${klinicosTrabajos.turnoId} = ${turnosTable.id}
            AND ${klinicosTrabajos.estado} NOT IN ('cancelado', 'error')
        )`);
    if (turnos.length === 0) return;
    logger.info(
      { turneraId, cantidad: turnos.length },
      "klinicos-cola: encolando turnos futuros ya reservados tras corregir la agenda",
    );
    // Secuencial a propósito: la DB es remota y el volumen es chico.
    // Origen "manual": este camino lo dispara un operador al corregir la
    // agenda, así que no lo frena la llave global de autoencolado.
    for (const t of turnos) {
      await encolarTrabajoKlinicos(t.id, usuarioId, "manual");
    }
  } catch (err) {
    logger.error({ err, turneraId }, "klinicos-cola: error encolando turnos futuros de la agenda corregida");
  }
}

// Si el turno se cancela antes de la carga, el trabajo pendiente se cancela.
// Un trabajo ya completado no se toca (el ingreso ya quedó en Klinicos): se
// loguea para que recepción lo anule a mano si corresponde.
// `anularSiCargado`: la anulación automática en Klinicos SOLO corre para
// cancelaciones individuales (regla de Federico: nunca anulaciones masivas).
// La cancelación masiva de turnera llama con false: cancela los trabajos
// pendientes y deja el warning para anular a mano los ya cargados.
export async function cancelarTrabajosDeTurno(
  turnoId: number,
  opts: { anularSiCargado?: boolean } = {},
): Promise<void> {
  const anularSiCargado = opts.anularSiCargado ?? true;
  try {
    const cancelados = await db
      .update(klinicosTrabajos)
      .set({ estado: "cancelado", ultimoError: "El turno fue cancelado antes de la carga" })
      .where(sql`${klinicosTrabajos.turnoId} = ${turnoId} AND ${klinicosTrabajos.estado} IN ('pendiente', 'esperando_aprobacion', 'error')`)
      .returning({ id: klinicosTrabajos.id });
    if (cancelados.length > 0) {
      logger.info({ turnoId, trabajoIds: cancelados.map((c) => c.id) }, "klinicos-cola: trabajos cancelados por cancelación del turno");
    }
    // Turno cancelado con la consulta YA cargada en Klinicos (caso típico:
    // token validado con bono pero el paciente cancela antes de atenderse):
    // se encola la ANULACIÓN automática de la prestación (capacitación de
    // Federico 05/08/2026, docs/klinicos-flujo-administrativo.md §2.4.1).
    // Solo si el trabajo tiene identificada la atención y la prestación;
    // si falta algún dato, queda el aviso de siempre para anular a mano.
    const [completado] = await db
      .select({
        id: klinicosTrabajos.id,
        atencionUrl: klinicosTrabajos.klinicosAtencionUrl,
        prestacionNumero: klinicosTrabajos.klinicosPrestacionNumero,
      })
      .from(klinicosTrabajos)
      .where(sql`${klinicosTrabajos.turnoId} = ${turnoId} AND ${klinicosTrabajos.estado} = 'completado'`)
      .limit(1);
    if (completado) {
      // Regla de Federico (ampliada 05/08/2026, circuito inverso de la app):
      // la anulación automática aplica a CUALQUIER cancelación individual de
      // turno con la prestación ya cargada (videollamada o presencial, desde
      // la app o recepción). Sigue fail-closed: solo si la atención y la
      // prestación están identificadas; si falta algún dato, queda el aviso
      // para anular a mano. NUNCA hay anulaciones masivas: esta función solo
      // se llama por la cancelación individual de un turno.
      if (anularSiCargado && completado.atencionUrl && completado.prestacionNumero) {
        await db
          .update(klinicosTrabajos)
          .set({ estado: "anulacion_pendiente", ultimoError: "El turno se canceló con la prestación ya cargada: anulación automática encolada" })
          .where(sql`${klinicosTrabajos.id} = ${completado.id} AND ${klinicosTrabajos.estado} = 'completado'`);
        logger.info(
          { turnoId, trabajoId: completado.id, prestacion: completado.prestacionNumero },
          "klinicos-cola: anulación de prestación encolada por cancelación del turno",
        );
      } else {
        logger.warn({ turnoId, trabajoId: completado.id }, "klinicos-cola: el turno se canceló pero el ingreso ya estaba cargado en Klinicos (revisar a mano)");
      }
    }
  } catch (err) {
    logger.error({ err, turnoId }, "klinicos-cola: error cancelando trabajos del turno");
  }
}

// El token llega después de la reserva (lo genera el paciente): si el trabajo
// sigue sin cargarse, se le copia para que viaje en la carga.
export async function actualizarTokenTrabajosDeTurno(turnoId: number, token: string): Promise<void> {
  try {
    await db
      .update(klinicosTrabajos)
      .set({ tokenAutorizacion: token })
      .where(sql`${klinicosTrabajos.turnoId} = ${turnoId} AND ${klinicosTrabajos.estado} IN ('pendiente', 'esperando_aprobacion', 'error')`);
  } catch (err) {
    logger.error({ err, turnoId }, "klinicos-cola: error actualizando token de trabajos del turno");
  }
}

// ── Llave global de autoenvíos ──────────────────────────────────────────────
// config_sistema clave "klinicos_autoencolado": "off" apaga los encolados
// automáticos (al reservar, al recepcionar). El encolado manual desde la
// bandeja o el detalle del turno sigue funcionando siempre.
const AUTOENCOLADO_CLAVE = "klinicos_autoencolado";
let autoencoladoCache: { valor: boolean; hasta: number } | null = null;

export async function autoencoladoKlinicosActivo(): Promise<boolean> {
  const ahora = Date.now();
  if (autoencoladoCache && autoencoladoCache.hasta > ahora) return autoencoladoCache.valor;
  const [row] = await db
    .select({ valor: configSistemaTable.valor })
    .from(configSistemaTable)
    .where(eq(configSistemaTable.clave, AUTOENCOLADO_CLAVE))
    .limit(1);
  const valor = row?.valor !== "off";
  autoencoladoCache = { valor, hasta: ahora + 15_000 };
  return valor;
}

export function invalidarCacheAutoencolado(): void {
  autoencoladoCache = null;
}

export async function encolarTrabajoKlinicos(
  turnoId: number,
  usuarioId: number | null = null,
  // "registro": pre-carga al registrar/recepcionar (Federico 02/08/2026):
  // arranca la carga en Klinicos SIN token apenas recepción registra al
  // paciente, para que "Validar token" solo tenga que mandar el token sobre
  // la atención ya cargada. Pasa el kill-switch (es acción del usuario) pero
  // SOLO aplica a consultas soportadas (clínica médica / cardiología).
  origen: "auto" | "manual" | "registro" = "auto",
): Promise<number | null> {
  try {
    if (origen === "auto" && !(await autoencoladoKlinicosActivo())) {
      logger.info({ turnoId }, "klinicos-cola: autoencolado apagado por configuración, no se encola");
      return null;
    }
    const [row] = await db
      .select({
        turno: turnosTable,
        paciente: pacientesTable,
        especialidad: especialidadesTable.nombre,
        turneraNombre: turnerasTable.nombre,
        turneraKlinicosSector: turnerasTable.klinicosSector,
        turneraKlinicosEspecialidad: turnerasTable.klinicosEspecialidad,
        turneraKlinicosProfesional: turnerasTable.klinicosProfesional,
        turneraKlinicosMotivo: turnerasTable.klinicosMotivo,
        profesional: profesionalesTable,
      })
      .from(turnosTable)
      .innerJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
      .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
      .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
      .leftJoin(profesionalesTable, eq(turnerasTable.profesionalId, profesionalesTable.id))
      .where(eq(turnosTable.id, turnoId))
      .limit(1);

    if (!row) {
      logger.warn({ turnoId }, "klinicos-cola: turno no encontrado, no se encola");
      return null;
    }
    if (!row.paciente.dni) {
      logger.warn({ turnoId, pacienteId: row.paciente.id }, "klinicos-cola: paciente sin DNI, no se encola");
      return null;
    }
    const dniPaciente = row.paciente.dni;

    // Regla general (Federico 02/08/2026): a Klinicos solo van pacientes con
    // obra social que valida ahí (hoy: IOMA). Particulares, PAMI y otras
    // coberturas no validan token, así que no se encola en ningún origen.
    const coberturaTurno = row.turno.cobertura ?? row.paciente.cobertura ?? null;
    if (!coberturaValidaEnKlinicos(coberturaTurno)) {
      logger.info(
        { turnoId, cobertura: coberturaTurno, origen },
        "klinicos-cola: cobertura no valida en Klinicos, no se encola",
      );
      return null;
    }

    // Evitar duplicados: un trabajo activo por turno
    const [existente] = await db
      .select({ id: klinicosTrabajos.id })
      .from(klinicosTrabajos)
      .where(sql`${klinicosTrabajos.turnoId} = ${turnoId} AND ${klinicosTrabajos.estado} NOT IN ('cancelado', 'error')`)
      .limit(1);
    if (existente) {
      logger.info({ turnoId, trabajoId: existente.id }, "klinicos-cola: ya existe trabajo activo para este turno");
      return existente.id;
    }

    // Prioridad: los campos Klinicos propios de la agenda (réplica exacta del
    // portal). Fallback: mapeo por especialidad + heurística (agendas viejas).
    // Máxima prioridad: los datos cargados por recepción en la ficha del
    // turno (ingreso-consulta). Después los de la agenda, y por último la
    // heurística por especialidad.
    const especialidad =
      row.turno.klinicosEspecialidad ??
      row.turneraKlinicosEspecialidad ??
      row.especialidad ??
      row.turneraNombre;
    const sectorServicio =
      row.turneraKlinicosSector ?? (await resolverSectorServicio(especialidad));
    // Prácticas del nomenclador: primero las tildadas en el TURNO (una agenda
    // de consulta puede llevar un estudio puntual, ej. Holter en cardiología);
    // si el turno no tiene, las de la agenda. Cada práctica expande TODOS sus
    // códigos (con repeticiones = cantidad), igual que al tildar en la agenda.
    const practicasTurno = await practicasDeTurno(turnoId);
    const codigosTurno = practicasTurno.flatMap((p) => p.codigos ?? []);
    const practicasAgenda = await db
      .select({ codigo: turneraPracticasTable.codigo })
      .from(turneraPracticasTable)
      .where(eq(turneraPracticasTable.turneraId, row.turno.turneraId))
      .orderBy(turneraPracticasTable.codigo);
    const practicaCodigos =
      codigosTurno.length > 0
        ? codigosTurno
        : practicasAgenda.length > 0
          ? practicasAgenda.map((p) => p.codigo)
          : null;
    const esAgendaPracticas = practicaCodigos != null;

    // Pre-carga al registrar: solo consultas que el robot sabe cargar hoy.
    // Prácticas y especialidades no soportadas siguen su circuito habitual.
    if (origen === "registro") {
      const soportada = !esAgendaPracticas && detectarEspecialidadConsulta(especialidad) !== null;
      if (!soportada) {
        logger.info({ turnoId, especialidad }, "klinicos-cola: pre-carga omitida (consulta no soportada o agenda de prácticas)");
        return null;
      }
    }

    // Profesional a machear en el ingreso ambulatorio.
    // Prioridad: 1) el cargado por recepción en la ficha del turno;
    // 2) regla configurada para la especialidad (Federico 01/08/2026:
    //    CLINICA MEDICA usa SIEMPRE "SAEZ, IGNACIO"; la tabla de rotación
    //    quedó con SAEZ como único activo, ver seed-profesionales-ingreso);
    // 3) el de la agenda o el espejo del profesional de Conectar.
    // Agendas de prácticas (ecografías, etc.): el profesional de Conectar es
    // el ecografista real, que NO existe en el sector de Klinicos. Se deja en
    // null y el worker usa el efector rotado (elegirEfector) como profesional
    // del ingreso.
    // Regla general de CONSULTAS (Federico, 02/08/2026): de Conectar solo se
    // correlaciona DNI + especialidad + día de atención; el profesional y el
    // motivo los decide el robot. Cardiología rota SIEMPRE entre los 5
    // cardiólogos sembrados (sin fallback al médico de Conectar: si la
    // rotación falla, queda sin profesional y el robot corta fail-closed).
    // Clínica Médica sigue igual (profesional fijo vía la misma rotación).
    // Única excepción (igual que en clínica): turno.klinicosProfesional es un
    // override MANUAL que recepción carga en la ficha pensando en Klinicos —
    // no es el médico de Conectar — y por eso mantiene máxima prioridad.
    const configConsulta = esAgendaPracticas ? null : detectarEspecialidadConsulta(especialidad);
    const esCardiologia = configConsulta?.profesionalDeLaCola === true;
    // Las demás especialidades de consulta rotan el profesional directo del
    // desplegable del portal (en el robot); acá no debe viajar el médico de
    // Conectar como fallback — mismo criterio fail-closed que cardiología.
    const esRotacionEnPortal = configConsulta !== null && !configConsulta.profesionalDeLaCola;
    const profesionalRotado =
      row.turno.klinicosProfesional || esAgendaPracticas
        ? null
        : await elegirProfesionalIngreso(normalizar(especialidad)).catch((err: unknown) => {
            logger.error({ err, turnoId }, "klinicos-cola: fallo la rotación de profesional (se usa fallback)");
            return null;
          });
    const profesionalKlinicos =
      row.turno.klinicosProfesional ??
      (esAgendaPracticas
        ? null
        : esCardiologia || esRotacionEnPortal
          ? profesionalRotado
          : profesionalRotado ??
            row.turneraKlinicosProfesional ??
            row.profesional?.klinicosUsuario ??
            (row.profesional
              ? [row.profesional.apellido, row.profesional.nombre].filter(Boolean).join(" ")
              : null));
    // Motivo obligatorio en Klinicos: si el turno tiene una orden de estudio
    // vinculada (derivación), viaja la práctica de la orden; si no, el motivo
    // del turno o el default de la agenda.
    const [ordenVinculada] = await db
      .select({ studyName: studyOrdersTable.studyName, billingCodes: studyOrdersTable.billingCodes })
      .from(studyOrdersTable)
      .where(sql`${studyOrdersTable.turnoId} = ${turnoId} AND ${studyOrdersTable.status} NOT IN ('anulada')`)
      .limit(1);
    const motivo =
      ordenVinculada?.studyName ?? row.turno.motivoConsulta ?? row.turneraKlinicosMotivo ?? null;

    // Anti-carrera: dos validaciones/encolados simultáneos del mismo turno no
    // deben insertar dos trabajos activos. Advisory lock por turno + re-chequeo
    // de duplicado DENTRO de la transacción; el perdedor devuelve el id del
    // ganador (trabajo canónico único por turno).
    const { trabajo, yaExistia } = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`klinicos_encolar_${turnoId}`}))`);
      const [dup] = await tx
        .select({ id: klinicosTrabajos.id })
        .from(klinicosTrabajos)
        .where(sql`${klinicosTrabajos.turnoId} = ${turnoId} AND ${klinicosTrabajos.estado} NOT IN ('cancelado', 'error')`)
        .limit(1);
      if (dup) return { trabajo: dup, yaExistia: true };
      const [nuevo] = await tx
        .insert(klinicosTrabajos)
        .values({
          pacienteId: row.paciente.id,
          turnoId,
          dni: dniPaciente,
          sexo: row.paciente.sexo ?? null,
          celular: row.paciente.telefono ?? row.paciente.telefonoAlternativo ?? null,
          especialidad,
          motivo,
          sectorServicio,
          profesionalKlinicos,
          tokenAutorizacion: row.turno.klinicosToken ?? null,
          practicaCodigos,
        })
        .returning({ id: klinicosTrabajos.id });
      return { trabajo: nuevo, yaExistia: false };
    });
    if (yaExistia) {
      logger.info({ turnoId, trabajoId: trabajo.id }, "klinicos-cola: carrera de encolado, se reusa el trabajo existente");
      return trabajo.id;
    }

    logger.info(
      { turnoId, trabajoId: trabajo.id, especialidad, sectorServicio },
      "klinicos-cola: trabajo encolado",
    );

    await crearOrdenEstudioAutomatica({
      turnoId,
      pacienteId: row.paciente.id,
      profesionalId: row.profesional?.id ?? null,
      especialidad,
      motivo,
      sectorServicio,
      usuarioId,
    });
    return trabajo.id;
  } catch (err) {
    logger.error({ err, turnoId }, "klinicos-cola: error al encolar (la recepción sigue igual)");
    return null;
  }
}

export function coberturaValidaEnKlinicos(cobertura: string | null | undefined): boolean {
  if (!cobertura) return false;
  const norm = normalizar(cobertura).replace(/[^A-Z0-9 ]/g, "");
  return OBRAS_SOCIALES_KLINICOS.some((os) => norm.includes(os));
}
