import { Router, type IRouter } from "express";
import { eq, and, or, gte, lte, inArray, notInArray, type SQL } from "drizzle-orm";
import {
  db, turnosTable, turnerasTable, pacientesTable, profesionalesTable, especialidadesTable, sedesTable,
  turneraParticipantesTable, klinicosTrabajos,
} from "@workspace/db";
import {
  CreateTurnoBody,
  UpdateTurnoBody,
  GetTurnoParams,
  UpdateTurnoParams,
  DeleteTurnoParams,
  ListTurnosQueryParams,
  GetTableroQueryParams,
} from "@workspace/api-zod";
import { getUserFromRequest, requireRol } from "./auth";
import { esSlotPasado, hoyArgentina, horaArgentina } from "../lib/tiempo";
import { esViolacionUnique } from "../lib/pg";
import { urlVideollamadaTurno } from "../lib/videollamada-turno";
import { notificarEventoVideollamadaPorTurno, avanzarFilaGuardia } from "../integraciones/app-paciente-videollamadas";
import { encolarAvisoTurno } from "../integraciones/app-paciente-turnos";
import { registrarEventoTurnoRobot } from "../lib/robot-turnos-eventos";
import { encolarTrabajoAlReservar, encolarTrabajoKlinicos, cancelarTrabajosDeTurno, actualizarTokenTrabajosDeTurno } from "../integraciones/klinicos-cola";
import { avisarRecepcionPacs } from "../integraciones/pacs-recepcion";
import { reservarConCupo } from "../lib/cupos-obra-social";
import { sincronizarWorklistTurno } from "../integraciones/pacs-worklist";
import { turneraIdsDelProfesional, turnoEnAlcanceMedico, profesionalIdDe } from "../lib/alcance-medico";
import { practicaUnicaDeTurnera } from "../lib/practica-turnera";
import { guardarPracticasDeTurno, practicasDeTurno, filtrarPracticasValidas } from "../lib/turno-practicas";

// Guard por-turno: un médico solo accede a turnos dentro de su alcance.
// Devuelve true si respondió (403) y hay que cortar.
async function bloquearMedicoFueraDeAlcance(
  req: Parameters<typeof getUserFromRequest>[0],
  res: { status: (n: number) => { json: (b: unknown) => unknown } },
  turno: { turneraId: number; profesionalId: number | null },
): Promise<boolean> {
  const user = await getUserFromRequest(req);
  if (user?.rol !== "medico") return false;
  const pid = profesionalIdDe(user);
  if (pid != null && (await turnoEnAlcanceMedico(pid, turno))) return false;
  res.status(403).json({ error: "Sin permisos sobre este turno" });
  return true;
}

const router: IRouter = Router();

// Solo staff: listados/detalle exponen datos de pacientes; PATCH/DELETE modifican turnos.
// POST /turnos queda público (reserva online sin cuenta) y /turnos/mis-turnos maneja su propia auth.
const soloStaff = requireRol("admin", "recepcionista", "medico");

// Los query params llegan siempre como string, pero el Zod generado espera Date
// para campos con format:date. Coercionamos antes de validar.
function coerceFechasQuery(q: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...q };
  for (const k of ["fecha", "fechaDesde", "fechaHasta"]) {
    const v = out[k];
    if (typeof v === "string" && v) {
      const d = new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v);
      if (!Number.isNaN(d.getTime())) out[k] = d;
    }
  }
  return out;
}

async function enrichTurno(t: typeof turnosTable.$inferSelect) {
  let turnera = null;
  let paciente = null;
  let profesional = null;
  if (t.turneraId) {
    const [tr] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, t.turneraId)).limit(1);
    if (tr) {
      let esp = null;
      if (tr.especialidadId) {
        const [e] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, tr.especialidadId)).limit(1);
        esp = e ?? null;
      }
      let sede = null;
      if (tr.sedeId) {
        const [s] = await db.select().from(sedesTable).where(eq(sedesTable.id, tr.sedeId)).limit(1);
        sede = s ?? null;
      }
      turnera = { ...tr, diasAtencion: tr.diasAtencion?.split(",").map(Number) ?? [], especialidad: esp, profesional: null, sede };
    }
  }
  if (t.pacienteId) {
    const [p] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, t.pacienteId)).limit(1);
    paciente = p ?? null;
  }
  if (t.profesionalId) {
    const [p] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, t.profesionalId)).limit(1);
    if (p) {
      let esp = null;
      if (p.especialidadId) {
        const [e] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, p.especialidadId)).limit(1);
        esp = e ?? null;
      }
      profesional = { ...p, especialidad: esp };
    }
  }
  const practicas = await practicasDeTurno(t.id);
  return { ...t, turnera, paciente, profesional, practicas, videollamadaUrl: urlVideollamadaTurno(t) };
}

router.get("/turnos", soloStaff, async (req, res): Promise<void> => {
  const params = ListTurnosQueryParams.safeParse(coerceFechasQuery(req.query));
  const conditions: SQL[] = [];
  if (params.success) {
    const d = params.data;
    if (d.fecha) conditions.push(eq(turnosTable.fecha, d.fecha instanceof Date ? d.fecha.toISOString().split("T")[0] : d.fecha));
    if (d.fechaDesde) conditions.push(gte(turnosTable.fecha, d.fechaDesde instanceof Date ? d.fechaDesde.toISOString().split("T")[0] : d.fechaDesde));
    if (d.fechaHasta) conditions.push(lte(turnosTable.fecha, d.fechaHasta instanceof Date ? d.fechaHasta.toISOString().split("T")[0] : d.fechaHasta));
    if (d.turneraId != null) conditions.push(eq(turnosTable.turneraId, d.turneraId));
    if (d.profesionalId != null) conditions.push(eq(turnosTable.profesionalId, d.profesionalId));
    if (d.pacienteId != null) conditions.push(eq(turnosTable.pacienteId, d.pacienteId));
    if (d.estado) conditions.push(eq(turnosTable.estado, d.estado));
  }

  // Un médico solo ve turnos de sus turneras (propias o grupales donde participa)
  // o asignados directamente a él, sin importar los filtros que pida.
  const userTurnos = await getUserFromRequest(req);
  if (userTurnos?.rol === "medico") {
    const pid = profesionalIdDe(userTurnos);
    const ids = pid != null ? await turneraIdsDelProfesional(pid) : [];
    if (pid == null) {
      res.json({ data: [], total: 0, page: 1, limit: 50 });
      return;
    }
    const alcance = ids.length
      ? or(inArray(turnosTable.turneraId, ids), eq(turnosTable.profesionalId, pid))
      : eq(turnosTable.profesionalId, pid);
    conditions.push(alcance!);
  }

  const limit = (params.success && params.data.limit) ? params.data.limit : 50;
  const page = (params.success && params.data.page) ? params.data.page : 1;
  const offset = (page - 1) * limit;

  const rows = await db.select().from(turnosTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(turnosTable.fecha, turnosTable.horaInicio)
    .limit(limit).offset(offset);
  const total = await db.select().from(turnosTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const data = await Promise.all(rows.map(enrichTurno));
  res.json({ data, total: total.length, page, limit });
});

router.post("/turnos", async (req, res): Promise<void> => {
  const parsed = CreateTurnoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Paciente logueado: el turno se asocia SIEMPRE a su propio pacienteId,
  // ignorando cualquier dato de paciente que venga en el body.
  const user = await getUserFromRequest(req);
  let pacienteSesionId: number | undefined;
  if (user?.rol === "paciente") {
    const pid = Number(user.pacienteId);
    if (!user.pacienteId || !Number.isInteger(pid)) {
      res.status(400).json({ error: "La sesión de paciente no tiene un paciente asociado" });
      return;
    }
    pacienteSesionId = pid;
  }

  // Resolve pacienteId from DNI if not provided
  let pacienteId = pacienteSesionId ?? parsed.data.pacienteId;
  if (!pacienteId && parsed.data.pacienteDni) {
    const [p] = await db.select().from(pacientesTable).where(eq(pacientesTable.dni, parsed.data.pacienteDni)).limit(1);
    if (p) {
      pacienteId = p.id;
      // Completar datos faltantes del paciente con lo cargado en el turno
      // (Klinicos exige teléfono, sexo y obra social para la consulta).
      const faltantes: Partial<typeof pacientesTable.$inferInsert> = {};
      // Si la ficha estaba inactiva (borrada), se reactiva al asignarle un turno.
      if (!p.activo) faltantes.activo = true;
      if (parsed.data.pacienteTelefono && !p.telefono) faltantes.telefono = parsed.data.pacienteTelefono;
      if (parsed.data.pacienteEmail && !p.email) faltantes.email = parsed.data.pacienteEmail;
      if (parsed.data.pacienteSexo && !p.sexo) faltantes.sexo = parsed.data.pacienteSexo;
      if (parsed.data.cobertura && !p.cobertura) faltantes.cobertura = parsed.data.cobertura;
      if (parsed.data.nroAfiliado && !p.nroAfiliado) faltantes.nroAfiliado = parsed.data.nroAfiliado;
      if (Object.keys(faltantes).length > 0) {
        await db.update(pacientesTable).set(faltantes).where(eq(pacientesTable.id, p.id));
      }
    } else if (parsed.data.pacienteNombre && parsed.data.pacienteApellido) {
      // Auto-create patient
      const [newP] = await db.insert(pacientesTable).values({
        nombre: parsed.data.pacienteNombre,
        apellido: parsed.data.pacienteApellido,
        dni: parsed.data.pacienteDni,
        numeroHc: parsed.data.pacienteDni?.trim() || undefined, // HC = DNI
        telefono: parsed.data.pacienteTelefono ?? undefined,
        email: parsed.data.pacienteEmail ?? undefined,
        sexo: parsed.data.pacienteSexo ?? undefined,
        cobertura: parsed.data.cobertura ?? undefined,
        nroAfiliado: parsed.data.nroAfiliado ?? undefined,
      }).returning();
      pacienteId = newP.id;
    }
  }
  if (!pacienteId) {
    res.status(400).json({ error: "Paciente requerido" });
    return;
  }

  // La duración de la turnera define horaFin (se calcula por intento abajo).
  const [turnera] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, parsed.data.turneraId)).limit(1);
  const dur = turnera?.duracionMinutos ?? 30;

  // Región anatómica: obligatoria para TODAS las prácticas (pedido del PACS
  // jul 2026). Va al PACS como body_part propio, no dentro del nombre.
  const regionAnatomica = (parsed.data.regionAnatomica ?? "").trim() || null;
  if (turnera?.tipo === "practica" && !regionAnatomica) {
    res.status(400).json({
      error: "Falta la región anatómica del estudio (ej: \"Rodilla derecha\", \"Tórax\"). Es obligatoria para agendar prácticas.",
    });
    return;
  }

  // Tipo de estudio: si el cliente no eligió una práctica del catálogo y los
  // códigos de la agenda corresponden a UNA sola práctica, se asocia esa
  // automáticamente (el Robot resuelve el practice_code exacto con ese id).
  // Con varias posibles no se adivina: queda sin práctica → revisión manual.
  // Puede venir una lista (varios estudios en la misma visita) o el campo
  // singular legado; la primera de la lista queda como práctica principal.
  const idsPedidos = parsed.data.klinicosPracticaIds ?? [];
  const practicaIds = await filtrarPracticasValidas(idsPedidos);
  if (idsPedidos.length > 0 && practicaIds.length === 0) {
    res.status(400).json({ error: "Ninguno de los estudios elegidos existe en el catálogo" });
    return;
  }
  let klinicosPracticaId: number | undefined =
    practicaIds[0] ?? parsed.data.klinicosPracticaId ?? undefined;
  if (klinicosPracticaId == null) {
    klinicosPracticaId = (await practicaUnicaDeTurnera(parsed.data.turneraId)) ?? undefined;
  }

  // El profesional del turno se toma de la agenda seleccionada, salvo en
  // guardia grupal: el turno queda abierto a todos los médicos de guardia.
  const profesionalId = turnera?.esGuardia ? undefined : turnera?.profesionalId ?? undefined;

  // Guardia anti doble-reserva: si ya hay un turno activo en el mismo slot,
  // rechazamos salvo que sea un sobreturno explícito.
  const fechaTurno = parsed.data.fecha instanceof Date
    ? parsed.data.fecha.toISOString().split("T")[0]
    : parsed.data.fecha;

  // Guardia grupal: por orden de llegada, sin validar slot ni horario pasado.
  const esGuardia = !!turnera?.esGuardia;

  // La bolsa de guardia/demanda espontánea es un circuito interno: solo el
  // personal puede cargar pacientes ahí. La reserva pública queda únicamente
  // para agendas programadas (no guardia).
  if (esGuardia && (!user || !["admin", "recepcionista", "medico"].includes(user.rol))) {
    res.status(403).json({ error: "Solo el personal puede cargar pacientes en la guardia" });
    return;
  }

  // Nunca permitir reservar en el pasado (hora argentina).
  if (!esGuardia && esSlotPasado(fechaTurno, parsed.data.horaInicio)) {
    res.status(400).json({ error: "No se puede reservar un turno en el pasado. Elegí un horario futuro." });
    return;
  }

  // Obras sociales de la agenda: si tiene listado, la cobertura del paciente
  // debe estar en la lista y respetar el cupo diario configurado.
  let coberturaEfectiva = parsed.data.cobertura ?? null;
  if (!coberturaEfectiva) {
    const [pac] = await db.select({ cobertura: pacientesTable.cobertura })
      .from(pacientesTable).where(eq(pacientesTable.id, pacienteId)).limit(1);
    coberturaEfectiva = pac?.cobertura ?? null;
  }
  // El control de cupo va junto al insert (reservarConCupo) en todos los
  // casos; en guardia cada reintento de slot corre su propia transacción.

  if (!parsed.data.sobreturno && !esGuardia) {
    const existentes = await db.select({ id: turnosTable.id, estado: turnosTable.estado })
      .from(turnosTable)
      .where(and(
        eq(turnosTable.turneraId, parsed.data.turneraId),
        eq(turnosTable.fecha, fechaTurno),
        eq(turnosTable.horaInicio, parsed.data.horaInicio),
      ));
    if (existentes.some((t) => !["cancelado", "ausente"].includes(t.estado))) {
      res.status(409).json({ error: "Ese horario ya fue reservado. Elegí otro horario disponible." });
      return;
    }
  }

  let turno: typeof turnosTable.$inferSelect | null = null;
  // En guardia dos pacientes pueden llegar en el mismo minuto: ante colisión
  // de slot corremos la hora un minuto hacia adelante (hasta 30 intentos).
  const maxIntentos = esGuardia ? 30 : 1;
  // Normalizar a HH:MM (el cliente puede mandar HH:MM:SS).
  let horaIntento = parsed.data.horaInicio.substring(0, 5);

  // Especialidad mixta (turnera programada + demanda espontánea): el que entra
  // por demanda se ubica DETRÁS del último recepcionado de los que tenían
  // turno. Buscamos la mayor horaInicio entre los turnos de hoy ya
  // recepcionados de las agendas programadas de la misma especialidad y, si es
  // mayor a la hora de llegada, corremos el ingreso a un minuto después.
  if (esGuardia && turnera?.especialidadId != null) {
    const ESTADOS_RECEPCIONADO = ["arribo", "recepcionado", "en_sala", "llamado"];
    const turnerasEsp = await db
      .select({ id: turnerasTable.id })
      .from(turnerasTable)
      .where(and(eq(turnerasTable.especialidadId, turnera.especialidadId), eq(turnerasTable.esGuardia, false)));
    if (turnerasEsp.length > 0) {
      const recepcionados = await db
        .select({ horaInicio: turnosTable.horaInicio })
        .from(turnosTable)
        .where(and(
          inArray(turnosTable.turneraId, turnerasEsp.map((t) => t.id)),
          eq(turnosTable.fecha, fechaTurno),
          inArray(turnosTable.estado, ESTADOS_RECEPCIONADO),
        ));
      const ultima = recepcionados.map((t) => t.horaInicio.substring(0, 5)).sort().pop();
      if (ultima && ultima >= horaIntento) {
        const [hU, mU] = ultima.split(":").map(Number);
        const sig = Math.min(hU * 60 + mU + 1, 23 * 60 + 59);
        horaIntento = `${Math.floor(sig / 60).toString().padStart(2, "0")}:${(sig % 60).toString().padStart(2, "0")}`;
      }
    }
  }
  for (let intento = 0; intento < maxIntentos && !turno; intento++) {
    try {
      const [hI, mI] = horaIntento.split(":").map(Number);
      // horaFin no puede pasar de 23:59 (sin rollover al día siguiente).
      const finMin = Math.min(hI * 60 + mI + dur, 23 * 60 + 59);
      const horaFinIntento = `${Math.floor(finMin / 60).toString().padStart(2, "0")}:${(finMin % 60).toString().padStart(2, "0")}`;
      // Guardia (demanda espontánea): el paciente está físicamente presente,
      // entra directo a "Esperando" (arribo) sin el paso de Recepcionar.
      // El token se puede validar después con el botón Validar (es opcional).
      const entraDirecto = esGuardia && fechaTurno === hoyArgentina();
      const valores = {
        turneraId: parsed.data.turneraId,
        pacienteId,
        profesionalId: profesionalId ?? undefined,
        fecha: fechaTurno,
        horaInicio: horaIntento,
        horaFin: horaFinIntento,
        estado: entraDirecto ? "arribo" : "pendiente",
        ...(entraDirecto
          ? { admitidoEn: new Date(), admitidoPor: user?.nombre || user?.email || "recepción" }
          : {}),
        modalidad: parsed.data.modalidad ?? "presencial",
        sobreturno: parsed.data.sobreturno ?? false,
        motivoConsulta: parsed.data.motivoConsulta ?? undefined,
        regionAnatomica: regionAnatomica ?? undefined,
        observaciones: parsed.data.observaciones ?? undefined,
        cobertura: parsed.data.cobertura ?? undefined,
        nroAfiliado: parsed.data.nroAfiliado ?? undefined,
        klinicosPracticaId,
      };
      // Verificación de cupo + insert en una transacción serializada por
      // advisory lock (evita superar el cupo en concurrencia). Una violación
      // del índice único de slot dentro de la tx propaga al catch de abajo
      // (retry en guardia / 409 en agendas programadas).
      const r = await reservarConCupo(
        { turneraId: parsed.data.turneraId, fecha: fechaTurno, cobertura: coberturaEfectiva },
        async (tx) => {
          const [creado] = await tx.insert(turnosTable).values(valores).returning();
          return creado;
        },
      );
      if (!r.ok) {
        res.status(r.status).json({ error: r.error });
        return;
      }
      turno = r.valor;
    } catch (err) {
      // Índice único parcial turnos_slot_activo_unique: otro request ganó el slot.
      if (esViolacionUnique(err)) {
        if (esGuardia) {
          const [hI, mI] = horaIntento.split(":").map(Number);
          const sig = hI * 60 + mI + 1;
          // Nunca pasar de las 23:59 (sin rollover al día siguiente).
          if (sig > 23 * 60 + 59) break;
          horaIntento = `${Math.floor(sig / 60).toString().padStart(2, "0")}:${(sig % 60).toString().padStart(2, "0")}`;
          continue;
        }
        res.status(409).json({ error: "Ese horario ya fue reservado. Elegí otro horario disponible." });
        return;
      }
      throw err;
    }
  }
  if (!turno) {
    res.status(409).json({ error: "No se pudo asignar un lugar en la guardia. Intentá de nuevo." });
    return;
  }
  // Conjunto completo de estudios del turno (incluye la principal).
  const idsFinales = practicaIds.length > 0
    ? practicaIds
    : (turno.klinicosPracticaId ? [turno.klinicosPracticaId] : []);
  if (idsFinales.length > 0) {
    try {
      await guardarPracticasDeTurno(turno.id, idsFinales);
    } catch (err) {
      // El turno ya quedó creado con su práctica principal en la columna
      // legada: el Robot cae a ese campo si el conjunto no se pudo guardar.
      req.log.error({ err, turnoId: turno.id }, "No se pudo guardar el conjunto de prácticas del turno");
    }
  }
  await registrarEventoTurnoRobot(turno.id, "alta");
  // Guardia que entró directo a "Esperando": mismos efectos que la recepción
  // manual (Klinicos deduplica por turno, y el aviso PACS es inofensivo).
  if (turno.estado === "arribo") {
    // Regla de facturación (02/08/2026): la consulta se genera recién al
    // Validar Token; acá solo origen "auto" (frenado por el kill-switch).
    // Guardia virtual (videoconsulta): NUNCA se auto-encola — la consulta
    // Klinicos solo puede nacer del Validar Token, sin depender del kill-switch.
    if (turno.modalidad !== "videoconsulta") {
      void encolarTrabajoKlinicos(turno.id, user?.id ?? null, "auto");
    }
    void avisarRecepcionPacs(turno.pacienteId, req.log);
  }
  // Turnos de prácticas: la carga en Klinicos se encola ya al reservar (queda
  // pendiente de la carga del token, que el paciente genera después).
  void encolarTrabajoAlReservar(turno.id, turno.turneraId, user?.id ?? null);
  void sincronizarWorklistTurno(turno.id, req.log);
  res.status(201).json(await enrichTurno(turno));
});

// ── GET /turnos/mis-turnos ───────────────────────────────────────────────
// El paciente logueado ve todos sus turnos (futuros e historial), sin DNI.
router.get("/turnos/mis-turnos", async (req, res): Promise<void> => {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  if (user.rol !== "paciente") {
    res.status(403).json({ error: "Solo disponible para pacientes" });
    return;
  }

  const pacienteId = Number(user.pacienteId);
  if (!user.pacienteId || !Number.isInteger(pacienteId)) {
    res.json([]);
    return;
  }

  const rows = await db
    .select()
    .from(turnosTable)
    .where(eq(turnosTable.pacienteId, pacienteId))
    .orderBy(turnosTable.fecha, turnosTable.horaInicio);

  const data = await Promise.all(rows.map(enrichTurno));
  res.json(data);
});

router.get("/turnos/tablero", soloStaff, async (req, res): Promise<void> => {
  const params = GetTableroQueryParams.safeParse(coerceFechasQuery(req.query));
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { fecha: fechaRaw, sedeId, especialidadId } = params.data;
  const fecha = fechaRaw instanceof Date ? fechaRaw.toISOString().split("T")[0] : String(fechaRaw);
  const conditions: SQL[] = [eq(turnerasTable.activa, true)];
  if (sedeId != null) conditions.push(eq(turnerasTable.sedeId, sedeId));
  if (especialidadId != null) conditions.push(eq(turnerasTable.especialidadId, especialidadId));

  let turneras = await db.select().from(turnerasTable)
    .where(and(...conditions))
    .orderBy(turnerasTable.nombre);

  // La planilla diaria de un médico solo muestra sus propias turneras.
  const userTablero = await getUserFromRequest(req);
  if (userTablero?.rol === "medico") {
    const pid = profesionalIdDe(userTablero);
    const permitidas = new Set(pid != null ? await turneraIdsDelProfesional(pid) : []);
    turneras = turneras.filter((t) => permitidas.has(t.id));
  }

  // fecha es YYYY-MM-DD → new Date() la parsea como medianoche UTC; usar getUTCDay()
  // para que el día de semana no se corra si el server no corre en UTC.
  const fechaDate = new Date(`${fecha}T00:00:00.000Z`);
  const diaSemana = fechaDate.getUTCDay();

  // Helpers para calcular el próximo slot libre mirando hacia adelante.
  const sumarDias = (f: string, n: number): string => {
    const d = new Date(`${f}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().split("T")[0];
  };
  const DIAS_BUSQUEDA = 30;
  const fechaLimite = sumarDias(fecha, DIAS_BUSQUEDA);

  const result = [];
  for (const turnera of turneras) {
    const diasArray = turnera.diasAtencion?.split(",").map(Number) ?? [];
    // Una sola query por turnera: todos los turnos activos desde hoy hasta el límite.
    const turnosRango = await db.select().from(turnosTable)
      .where(and(
        eq(turnosTable.turneraId, turnera.id),
        gte(turnosTable.fecha, fecha),
        lte(turnosTable.fecha, fechaLimite),
      ));
    const turnosDelDia = turnosRango.filter((t) => t.fecha === fecha);
    const ocupadosPorFecha = new Map<string, Set<string>>();
    for (const t of turnosRango) {
      if (["cancelado", "ausente"].includes(t.estado)) continue;
      if (!ocupadosPorFecha.has(t.fecha)) ocupadosPorFecha.set(t.fecha, new Set());
      ocupadosPorFecha.get(t.fecha)!.add(t.horaInicio);
    }

    // Próximo slot libre de la agenda (hoy inclusive, hasta DIAS_BUSQUEDA días).
    let proximoDisponible: { fecha: string; hora: string } | null = null;
    const [hIniP, mIniP] = turnera.horaInicio.split(":").map(Number);
    const [hFinP, mFinP] = turnera.horaFin.split(":").map(Number);
    for (let i = 0; i <= DIAS_BUSQUEDA && !proximoDisponible; i++) {
      const f = sumarDias(fecha, i);
      const dia = new Date(`${f}T00:00:00.000Z`).getUTCDay();
      if (!diasArray.includes(dia)) continue;
      const ocupadosDia = ocupadosPorFecha.get(f);
      let cur = hIniP * 60 + mIniP;
      const fin = hFinP * 60 + mFinP;
      while (cur + turnera.duracionMinutos <= fin) {
        const hora = `${Math.floor(cur / 60).toString().padStart(2, "0")}:${(cur % 60).toString().padStart(2, "0")}`;
        if (!ocupadosDia?.has(hora) && !esSlotPasado(f, hora)) {
          proximoDisponible = { fecha: f, hora };
          break;
        }
        cur += turnera.duracionMinutos;
      }
    }

    // Enrich turnos
    const turnosEnriched = await Promise.all(turnosDelDia.map(enrichTurno));

    // Calculate slots for ocupacion
    let totalSlots = 0;
    let ocupados = 0;
    let primerDisponible: string | null = null;

    if (diasArray.includes(diaSemana)) {
      const [hIni, mIni] = turnera.horaInicio.split(":").map(Number);
      const [hFin, mFin] = turnera.horaFin.split(":").map(Number);
      let current = hIni * 60 + mIni;
      const end = hFin * 60 + mFin;
      while (current + turnera.duracionMinutos <= end) {
        totalSlots++;
        const slotH = Math.floor(current / 60).toString().padStart(2, "0");
        const slotM = (current % 60).toString().padStart(2, "0");
        const horaStr = `${slotH}:${slotM}`;
        const ocupado = turnosDelDia.some(t => t.horaInicio === horaStr && !["cancelado", "ausente"].includes(t.estado));
        if (ocupado) ocupados++;
        else if (!primerDisponible) primerDisponible = horaStr;
        current += turnera.duracionMinutos;
      }
    }

    // Enrich turnera
    let especialidad = null;
    let profesional = null;
    let sede = null;
    if (turnera.especialidadId) {
      const [e] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, turnera.especialidadId)).limit(1);
      especialidad = e ?? null;
    }
    if (turnera.profesionalId) {
      const [p] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, turnera.profesionalId)).limit(1);
      profesional = p ?? null;
    }
    if (turnera.sedeId) {
      const [s] = await db.select().from(sedesTable).where(eq(sedesTable.id, turnera.sedeId)).limit(1);
      sede = s ?? null;
    }
    const turneraEnriched = { ...turnera, diasAtencion: diasArray, especialidad, profesional, sede };

    result.push({
      turnera: turneraEnriched,
      turnos: turnosEnriched,
      primerDisponible,
      ocupacion: totalSlots > 0 ? ocupados / totalSlots : 0,
      demora: null,
      proximoDisponible,
    });
  }
  res.json(result);
});

// ── GET /turnos/demanda-espontanea ────────────────────────────────────────
// Bolsa de demanda espontánea: especialidades con médicos que tienen prendido
// el casillero "acepto demanda espontánea". Recepción carga el paciente en la
// turnera grupal (esGuardia) de la especialidad, sin asignar médico; los
// médicos van agarrando los pacientes desde su consultorio.
router.get("/turnos/demanda-espontanea", soloStaff, async (_req, res): Promise<void> => {
  const hoy = hoyArgentina();
  const ahora = horaArgentina();
  const diaSemana = new Date(`${hoy}T00:00:00.000Z`).getUTCDay();

  const medicos = await db.select().from(profesionalesTable)
    .where(and(eq(profesionalesTable.activo, true), eq(profesionalesTable.aceptaDemandaEspontanea, true)));
  if (medicos.length === 0) { res.json([]); return; }

  const turneras = await db.select().from(turnerasTable).where(eq(turnerasTable.activa, true));

  // Hasta qué hora atiende hoy cada médico: el fin más tardío de sus agendas
  // personales que atienden hoy y todavía no terminaron.
  const hastaHoraDe = (profesionalId: number): string | null => {
    let max: string | null = null;
    for (const t of turneras) {
      if (t.profesionalId !== profesionalId) continue;
      const dias = t.diasAtencion?.split(",").map(Number) ?? [];
      if (!dias.includes(diaSemana)) continue;
      if (t.horaFin <= ahora) continue;
      if (!max || t.horaFin > max) max = t.horaFin;
    }
    return max;
  };

  // Un médico pertenece a una guardia si comparte especialidad con la bolsa
  // o si está anotado como participante de la turnera de guardia (muchos
  // médicos de guardia no tienen especialidad cargada en su ficha).
  const bolsasTodas = turneras.filter((t) => t.esGuardia);
  const participantes = bolsasTodas.length
    ? await db.select().from(turneraParticipantesTable)
        .where(inArray(turneraParticipantesTable.turneraId, bolsasTodas.map((b) => b.id)))
    : [];
  const participaEn = new Map<number, Set<number>>(); // turneraId -> profesionalIds
  for (const p of participantes) {
    if (!participaEn.has(p.turneraId)) participaEn.set(p.turneraId, new Set());
    participaEn.get(p.turneraId)!.add(p.profesionalId);
  }

  // Agrupar las bolsas de guardia por especialidad (una guardia puede tener
  // varias filas de horario) y juntar sus médicos.
  const porEspecialidad = new Map<number, typeof bolsasTodas>();
  for (const b of bolsasTodas) {
    if (!b.especialidadId) continue;
    if (!porEspecialidad.has(b.especialidadId)) porEspecialidad.set(b.especialidadId, []);
    porEspecialidad.get(b.especialidadId)!.push(b);
  }

  const result = [];
  for (const [especialidadId, bolsas] of porEspecialidad) {
    const bolsa = bolsas[0];
    if (!bolsa) continue;
    const meds = medicos.filter(
      (m) =>
        m.especialidadId === especialidadId ||
        bolsas.some((b) => participaEn.get(b.id)?.has(m.id)),
    );
    if (meds.length === 0) continue;

    // Las guardias están abiertas las 24 hs, todos los días: no se filtra
    // por día ni horario de la bolsa. El médico sin agenda personal cubre
    // el día completo.
    const bolsaHasta = "23:59";
    const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, especialidadId)).limit(1);
    let sede = null;
    if (bolsa.sedeId) {
      const [s] = await db.select().from(sedesTable).where(eq(sedesTable.id, bolsa.sedeId)).limit(1);
      sede = s ? { id: s.id, nombre: s.nombre } : null;
    }
    result.push({
      especialidad: esp ? { id: esp.id, nombre: esp.nombre } : null,
      turneraId: bolsa.id,
      turneraNombre: bolsa.nombre,
      sede,
      // Solo médicos con cobertura vigente ahora (agenda de hoy sin vencer):
      // sin "hasta qué hora" no está atendiendo y no debe ofrecerse.
      medicos: meds
        .map((m) => ({
          id: m.id,
          nombre: `${m.apellido ?? ""}${m.apellido ? ", " : ""}${m.nombre}`,
          hastaHora: hastaHoraDe(m.id) ?? bolsaHasta,
        }))
        .filter((m) => m.hastaHora !== null),
    });
  }
  // Si ningún médico de la especialidad está atendiendo ahora, no se ofrece.
  const conMedicos = result.filter((r) => r.medicos.length > 0);
  conMedicos.sort((a, b) => (a.especialidad?.nombre ?? "").localeCompare(b.especialidad?.nombre ?? "", "es"));
  res.json(conMedicos);
});

router.get("/turnos/:id", soloStaff, async (req, res): Promise<void> => {
  const params = GetTurnoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, params.data.id)).limit(1);
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }
  if (await bloquearMedicoFueraDeAlcance(req, res, turno)) return;
  res.json(await enrichTurno(turno));
});

router.patch("/turnos/:id", soloStaff, async (req, res): Promise<void> => {
  const params = UpdateTurnoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateTurnoBody.safeParse(coerceFechasQuery(req.body ?? {}));
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // El Zod generado produce Date para fecha, pero Drizzle (mode:"string") espera YYYY-MM-DD
  const cambios: Record<string, unknown> = { ...parsed.data };
  if (cambios.fecha instanceof Date) cambios.fecha = cambios.fecha.toISOString().split("T")[0];
  // Varias prácticas: se guardan en turno_practicas, no como columna del turno.
  const pidioPracticas = Array.isArray(cambios.klinicosPracticaIds);
  const practicaIdsPatch = pidioPracticas
    ? await filtrarPracticasValidas(cambios.klinicosPracticaIds as number[])
    : null;
  if (pidioPracticas && (cambios.klinicosPracticaIds as unknown[]).length > 0
    && (practicaIdsPatch?.length ?? 0) === 0) {
    res.status(400).json({ error: "Ninguno de los estudios elegidos existe en el catálogo" });
    return;
  }
  delete cambios.klinicosPracticaIds;
  if (practicaIdsPatch) {
    // La primera de la lista pasa a ser la práctica principal (la lista
    // vacía explícita significa quitar todos los estudios del turno).
    cambios.klinicosPracticaId = practicaIdsPatch[0] ?? null;
  }
  if (Object.keys(cambios).length === 0) {
    res.status(400).json({ error: "No hay campos para actualizar" });
    return;
  }
  const [anterior] = await db.select().from(turnosTable).where(eq(turnosTable.id, params.data.id)).limit(1);
  if (!anterior) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }
  if (await bloquearMedicoFueraDeAlcance(req, res, anterior)) return;
  // Mover de agenda: la turnera destino tiene que existir
  if (cambios.turneraId !== undefined && cambios.turneraId !== anterior.turneraId) {
    const [destino] = await db.select({ id: turnerasTable.id }).from(turnerasTable)
      .where(eq(turnerasTable.id, Number(cambios.turneraId))).limit(1);
    if (!destino) {
      res.status(400).json({ error: "La agenda destino no existe" });
      return;
    }
  }
  // En prácticas la región anatómica es obligatoria: se puede corregir pero
  // no vaciar (el PACS la recibe como body_part).
  if ("regionAnatomica" in cambios) {
    const nueva = String(cambios.regionAnatomica ?? "").trim();
    cambios.regionAnatomica = nueva || null;
    if (!nueva) {
      const [tra] = await db.select({ tipo: turnerasTable.tipo }).from(turnerasTable)
        .where(eq(turnerasTable.id, anterior.turneraId)).limit(1);
      if (tra?.tipo === "practica") {
        res.status(400).json({ error: "La región anatómica no se puede dejar vacía en un turno de práctica" });
        return;
      }
    }
  }
  let turno;
  try {
    [turno] = await db.update(turnosTable).set(cambios).where(eq(turnosTable.id, params.data.id)).returning();
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ error: "Ya hay un turno en ese horario en la agenda destino" });
      return;
    }
    throw err;
  }
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }
  if (practicaIdsPatch) {
    await guardarPracticasDeTurno(turno.id, practicaIdsPatch);
  } else if ("klinicosPracticaId" in cambios) {
    // Cambio por el campo singular legado: sincroniza el conjunto.
    await guardarPracticasDeTurno(turno.id, turno.klinicosPracticaId ? [turno.klinicosPracticaId] : []);
  }
  // Evento para el Robot Klinicos según qué cambió
  const seCancelo =
    turno.estado !== anterior.estado && ["cancelado", "anulado", "a_reprogramar"].includes(turno.estado);
  const seMovio = turno.fecha !== anterior.fecha || turno.horaInicio !== anterior.horaInicio;
  const tokenNuevo = !!turno.klinicosToken && turno.klinicosToken !== anterior.klinicosToken;
  await registrarEventoTurnoRobot(
    turno.id,
    seCancelo ? "cancelacion" : seMovio ? "reprogramacion" : "actualizacion",
  );
  if (tokenNuevo) await registrarEventoTurnoRobot(turno.id, "token_disponible");
  if (seCancelo) {
    void cancelarTrabajosDeTurno(turno.id);
    // Guardia virtual: avisar la cancelación al portal (fire-and-forget).
    void notificarEventoVideollamadaPorTurno(turno.id, "cancelada", "El turno fue cancelado");
    void avanzarFilaGuardia(turno.id);
    // App del paciente: avisar que la clínica canceló el turno.
    void encolarAvisoTurno(turno.id, "cancelado");
  } else if (seMovio) {
    // App del paciente: avisar que la clínica movió el turno.
    void encolarAvisoTurno(turno.id, "reprogramado", {
      fechaAnterior: anterior.fecha,
      horaAnterior: anterior.horaInicio,
    });
  }
  if (tokenNuevo && turno.klinicosToken) void actualizarTokenTrabajosDeTurno(turno.id, turno.klinicosToken);
  // Si cambió la región anatómica hay que reenviar al PACS aunque el estado
  // del turno no haya cambiado (body_part actualizado).
  const cambioRegion = (turno.regionAnatomica ?? null) !== (anterior.regionAnatomica ?? null);
  void sincronizarWorklistTurno(turno.id, req.log, { forzarReenvio: cambioRegion });
  res.json(await enrichTurno(turno));
});

// Encolado manual en Klinicos para casos puntuales (trabajo cancelado por
// error, turno de una agenda que no se corrigió, etc.). encolarTrabajoKlinicos
// ya deduplica trabajos activos, así que acá solo distinguimos los casos para
// dar feedback claro a recepción.
router.post("/turnos/:id/encolar-klinicos", soloStaff, async (req, res): Promise<void> => {
  const params = GetTurnoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const turnoId = params.data.id;
  const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, turnoId)).limit(1);
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }
  if (await bloquearMedicoFueraDeAlcance(req, res, turno)) return;

  const activo = () =>
    db
      .select({ id: klinicosTrabajos.id })
      .from(klinicosTrabajos)
      .where(and(eq(klinicosTrabajos.turnoId, turnoId), notInArray(klinicosTrabajos.estado, ["cancelado", "error"])))
      .limit(1);

  const [existente] = await activo();
  if (existente) {
    res.json({ encolado: false, yaExistia: true, trabajoId: existente.id });
    return;
  }

  const user = await getUserFromRequest(req);
  await encolarTrabajoKlinicos(turnoId, user?.id ?? null, "manual");

  // encolarTrabajoKlinicos es best-effort (no lanza): verificamos que el
  // trabajo haya quedado creado para poder avisar si algo lo impidió.
  const [creado] = await activo();
  if (!creado) {
    res.status(422).json({ error: "No se pudo encolar el trabajo (verificá que el paciente tenga DNI y una obra social que valide en Klinicos, como IOMA)" });
    return;
  }
  res.json({ encolado: true, yaExistia: false, trabajoId: creado.id });
});

router.delete("/turnos/:id", soloStaff, async (req, res): Promise<void> => {
  const params = DeleteTurnoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [existente] = await db.select().from(turnosTable).where(eq(turnosTable.id, params.data.id)).limit(1);
  if (!existente) {
    res.sendStatus(204);
    return;
  }
  if (await bloquearMedicoFueraDeAlcance(req, res, existente)) return;
  // El evento se registra ANTES del delete (necesita el snapshot del turno)
  await registrarEventoTurnoRobot(params.data.id, "cancelacion");
  // App del paciente: borrar un turno vigente equivale a cancelarlo para el
  // paciente. Se encola ANTES del delete (el payload se congela al encolar).
  if (["pendiente", "reservado", "confirmado", "publicado", "arribo", "en_sala", "llamado"].includes(existente.estado)) {
    await encolarAvisoTurno(params.data.id, "cancelado");
  }
  await cancelarTrabajosDeTurno(params.data.id);
  await db.delete(turnosTable).where(eq(turnosTable.id, params.data.id));
  void sincronizarWorklistTurno(params.data.id, req.log);
  res.sendStatus(204);
});

export default router;
