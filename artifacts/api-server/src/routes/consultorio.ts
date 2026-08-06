import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, gte, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { hoyArgentina } from "../lib/tiempo";
import { urlVideollamadaTurno } from "../lib/videollamada-turno";
import {
  db,
  usersTable,
  pacientesTable,
  profesionalesTable,
  turnosTable,
  turnerasTable,
  encountersTable,
  clinicalRecordsTable,
  practicasTable,
  studyOrdersTable,
  referralsTable,
  auditLogTable,
  turneraParticipantesTable,
  nomencladorPracticasTable,
  obrasSocialesTable,
  valoracionesAtencionTable,
  consultasTokenTable,
} from "@workspace/db";
import { ilike } from "drizzle-orm";
import {
  GetConsultorioAgendaQueryParams,
  GetConsultorioProduccionQueryParams,
  CreatePracticaBody,
  UpdatePracticaParams,
  UpdatePracticaBody,
  SetDemandaEspontaneaBody,
} from "@workspace/api-zod";
import { getUserIdFromToken } from "./auth";
import { turneraIdsDelProfesional, ocultarTurnoAjeno } from "../lib/alcance-medico";

const router: IRouter = Router();

// ── Auth ──────────────────────────────────────────────────────────────────
// admin: puede consultar cualquier profesional pasando ?profesionalId
// medico: siempre opera sobre su propio profesionalId

type ConsultorioUser = {
  id: number;
  email: string;
  rol: string;
  profesionalId: number | null;
};

async function getConsultorioUser(req: Request): Promise<ConsultorioUser | null> {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const userId = await getUserIdFromToken(token);
  if (!userId) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    rol: user.rol,
    profesionalId: user.profesionalId ? parseInt(user.profesionalId) : null,
  };
}

function resolverProfesionalId(user: ConsultorioUser, queryProfesionalId?: number): number | null {
  if (user.rol === "medico") return user.profesionalId;
  if (user.rol === "admin") return queryProfesionalId ?? user.profesionalId ?? null;
  return null;
}

async function registrarAuditoria(
  user: ConsultorioUser,
  accion: string,
  entidad: string,
  entidadId: number | null,
  pacienteId: number | null,
  detalle: unknown,
): Promise<void> {
  await db.insert(auditLogTable).values({
    usuarioId: user.id,
    usuarioEmail: user.email,
    rol: user.rol,
    accion,
    entidad,
    entidadId,
    pacienteId,
    detalle,
  });
}

function hoyISO(): string {
  return new Date().toISOString().split("T")[0];
}

// ── PUT /consultorio/demanda-espontanea ───────────────────────────────────
// El médico prende/apaga su casillero "acepto demanda espontánea". Los turnos
// de demanda espontánea van a una bolsa grupal; este casillero solo indica
// que el médico está atendiendo y va agarrando pacientes de la bolsa.
router.put("/consultorio/demanda-espontanea", async (req: Request, res: Response) => {
  const user = await getConsultorioUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const parsed = SetDemandaEspontaneaBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const profesionalId = user.rol === "admin" && parsed.data.profesionalId != null
    ? parsed.data.profesionalId
    : resolverProfesionalId(user);
  if (!profesionalId) {
    res.status(403).json({ error: "El usuario no tiene un profesional asociado" });
    return;
  }
  const [actualizado] = await db.update(profesionalesTable)
    .set({ aceptaDemandaEspontanea: parsed.data.aceptar })
    .where(eq(profesionalesTable.id, profesionalId))
    .returning();
  if (!actualizado) { res.status(404).json({ error: "Profesional no encontrado" }); return; }
  await registrarAuditoria(user, parsed.data.aceptar ? "demanda_espontanea_on" : "demanda_espontanea_off", "profesional", profesionalId, null, null);
  res.json({ aceptaDemandaEspontanea: actualizado.aceptaDemandaEspontanea });
});

// ── GET /consultorio/agenda ───────────────────────────────────────────────
router.get("/consultorio/agenda", async (req: Request, res: Response) => {
  const user = await getConsultorioUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }

  const parsed = GetConsultorioAgendaQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Modo "bolsa de médicos" (transitorio): médicos y admins ven todos los
  // turnos del día, con el nombre del médico de cada uno.
  // Más adelante se vuelve a separar por usuario/profesional.
  if (user.rol !== "medico" && user.rol !== "admin") {
    res.status(403).json({ error: "No autorizado" });
    return;
  }
  const profesionalId = resolverProfesionalId(user, parsed.data.profesionalId);

  const fecha = parsed.data.fecha ?? hoyISO();

  const ESTADOS_OCULTOS = ["cancelado", "ausente"];
  const turnos = (
    await db
      .select()
      .from(turnosTable)
      .where(eq(turnosTable.fecha, fecha))
      .orderBy(turnosTable.horaInicio)
  ).filter((t) => !ESTADOS_OCULTOS.includes(t.estado));

  const turneraIds = [...new Set(turnos.map((t) => t.turneraId))];
  const turneras = turneraIds.length
    ? await db.select().from(turnerasTable).where(inArray(turnerasTable.id, turneraIds))
    : [];
  const guardiaTurneraIds = new Set(turneras.filter((tg) => tg.esGuardia).map((tg) => tg.id));

  // Un médico solo ve su propia agenda: turnos de sus turneras (propias o
  // grupales donde participa), asignados a él, o de guardia (bolsa compartida
  // de la que los médicos toman pacientes).
  if (user.rol === "medico") {
    if (profesionalId == null) { res.status(403).json({ error: "Sin profesional asociado" }); return; }
    const permitidas = new Set(await turneraIdsDelProfesional(profesionalId));
    for (let i = turnos.length - 1; i >= 0; i--) {
      const t = turnos[i]!;
      const ok = permitidas.has(t.turneraId) || t.profesionalId === profesionalId || guardiaTurneraIds.has(t.turneraId);
      if (!ok) { turnos.splice(i, 1); continue; }
      // En turneras grupales/guardia los que esperan son bolsa compartida,
      // pero los EN CONSULTA (llamados por otro médico) y los YA ATENDIDOS
      // por otro se ocultan (misma regla que /recepcion/turnos-dia).
      if (ocultarTurnoAjeno(t, profesionalId)) turnos.splice(i, 1);
    }
  }
  const turnerasMap = new Map(turneras.map((tg) => [tg.id, tg]));

  const profesionalIds = [
    ...new Set(
      turnos.flatMap((t) => {
        const ids: number[] = [];
        if (t.profesionalId != null) ids.push(t.profesionalId);
        const tg = turnerasMap.get(t.turneraId);
        if (tg?.profesionalId != null) ids.push(tg.profesionalId);
        return ids;
      }),
    ),
  ];
  const profesionales = profesionalIds.length
    ? await db.select().from(profesionalesTable).where(inArray(profesionalesTable.id, profesionalIds))
    : [];
  const profesionalesMap = new Map(profesionales.map((p) => [p.id, p]));

  const pacienteIds = [...new Set(turnos.map((t) => t.pacienteId))];
  const pacientes = pacienteIds.length
    ? await db.select().from(pacientesTable).where(inArray(pacientesTable.id, pacienteIds))
    : [];
  const pacientesMap = new Map(pacientes.map((p) => [p.id, p]));

  // N° de Bono (autorización IOMA) por turno, si el token ya fue autorizado.
  const turnoIds = turnos.map((t) => t.id);
  const bonos = turnoIds.length
    ? await db
        .select({
          turnoId: consultasTokenTable.consultationId,
          nroBono: consultasTokenTable.authorizationNumber,
        })
        .from(consultasTokenTable)
        .where(inArray(consultasTokenTable.consultationId, turnoIds))
    : [];
  const bonosMap = new Map(bonos.map((b) => [b.turnoId, b.nroBono]));

  res.json({
    fecha,
    profesionalId,
    turnos: turnos.map((t) => {
      const profId = t.profesionalId ?? turnerasMap.get(t.turneraId)?.profesionalId ?? null;
      const prof = profId != null ? profesionalesMap.get(profId) : undefined;
      return {
        ...t,
        esGuardia: guardiaTurneraIds.has(t.turneraId),
        paciente: pacientesMap.get(t.pacienteId) ?? undefined,
        profesionalNombre: prof ? `${prof.apellido}, ${prof.nombre}`.trim() : null,
        videollamadaUrl: urlVideollamadaTurno(t),
        nroBono: bonosMap.get(t.id) ?? null,
      };
    }),
  });
});

// ── POST /consultorio/turnos/:id/tomar ────────────────────────────────────
// Bolsa de guardia: el médico toma un paciente sin asignar. Atómico: el
// UPDATE exige profesional_id IS NULL, así el primero que lo toma gana.
router.post("/consultorio/turnos/:id/tomar", async (req: Request, res: Response) => {
  const user = await getConsultorioUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }

  const profesionalId = resolverProfesionalId(user);
  if (profesionalId == null) {
    res.status(403).json({ error: "El usuario no tiene un profesional asociado" });
    return;
  }

  const turnoId = parseInt(String(req.params.id ?? ""));
  if (!Number.isFinite(turnoId)) { res.status(400).json({ error: "Id inválido" }); return; }

  const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, turnoId)).limit(1);
  if (!turno) { res.status(404).json({ error: "Turno no encontrado" }); return; }

  const [turnera] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, turno.turneraId)).limit(1);
  if (!turnera?.esGuardia) {
    res.status(400).json({ error: "Este turno no es de una agenda grupal" });
    return;
  }

  const [prof] = await db
    .select()
    .from(profesionalesTable)
    .where(eq(profesionalesTable.id, profesionalId))
    .limit(1);
  if (user.rol !== "admin") {
    // Habilitado si atiende guardia con la misma especialidad, o si está
    // anotado como participante de la turnera de guardia (muchos médicos de
    // guardia no tienen especialidad cargada en su ficha). Mismo criterio que
    // el listado de demanda espontánea de recepción.
    let habilitado =
      prof?.atiendeGuardia === true && prof.especialidadId === turnera.especialidadId;
    if (!habilitado) {
      const [participa] = await db
        .select({ id: turneraParticipantesTable.id })
        .from(turneraParticipantesTable)
        .where(and(
          eq(turneraParticipantesTable.turneraId, turnera.id),
          eq(turneraParticipantesTable.profesionalId, profesionalId),
        ))
        .limit(1);
      habilitado = !!participa;
    }
    if (!habilitado) {
      res.status(403).json({ error: "No estás habilitado para tomar pacientes de esta agenda grupal" });
      return;
    }
  }
  if (["cancelado", "ausente", "atendido"].includes(turno.estado)) {
    res.status(400).json({ error: "El turno ya no está disponible" });
    return;
  }

  const [actualizado] = await db
    .update(turnosTable)
    .set({ profesionalId })
    .where(and(eq(turnosTable.id, turnoId), isNull(turnosTable.profesionalId)))
    .returning();

  if (!actualizado) {
    res.status(409).json({ error: "Otro médico ya tomó este paciente" });
    return;
  }

  await registrarAuditoria(user, "tomar_guardia", "turno", turnoId, turno.pacienteId, {
    profesionalId,
  });
  req.log.info({ turnoId, profesionalId }, "guardia: paciente tomado de la bolsa");
  res.json(actualizado);
});

// ── GET /consultorio/produccion ───────────────────────────────────────────
router.get("/consultorio/produccion", async (req: Request, res: Response) => {
  const user = await getConsultorioUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }

  const parsed = GetConsultorioProduccionQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const profesionalId = resolverProfesionalId(user, parsed.data.profesionalId);
  if (profesionalId == null) {
    res.status(403).json({ error: "El usuario no tiene un profesional asociado" });
    return;
  }

  // Cortes de día/semana/mes en hora argentina: el servidor corre en UTC y a
  // la noche "hoy" ya sería mañana si se usara la hora del servidor.
  const hoyStr = hoyArgentina();
  const [aaaa, mm, dd] = hoyStr.split("-").map(Number);
  const hoyMediodia = new Date(Date.UTC(aaaa, mm - 1, dd, 12)); // mediodía UTC: aritmética de calendario segura
  const lunes = new Date(hoyMediodia);
  lunes.setUTCDate(lunes.getUTCDate() - ((lunes.getUTCDay() + 6) % 7));
  const aStrUTC = (d: Date) => d.toISOString().slice(0, 10);
  const inicioSemanaStr = aStrUTC(lunes);
  const inicioMesStr = `${hoyStr.slice(0, 8)}01`;
  // Para la lista de consultas (encounters con timestamp) alcanza el corte de
  // mes en hora argentina.
  const inicioMes = new Date(`${inicioMesStr}T00:00:00-03:00`);
  const hoy = new Date(`${hoyStr}T00:00:00-03:00`);

  const encuentrosMes = await db
    .select()
    .from(encountersTable)
    .where(and(eq(encountersTable.professionalId, profesionalId), gte(encountersTable.encounterDate, inicioMes)))
    .orderBy(desc(encountersTable.encounterDate));

  // Las atenciones se computan desde la recepción (turnos atendidos), NO
  // desde la historia clínica: corregir/duplicar una evolución no suma
  // atenciones. encuentrosMes se sigue usando solo para listar consultas.
  const turnosCerradosDesdeInicioMes = await db
    .select({ id: turnosTable.id, fecha: turnosTable.fecha })
    .from(turnosTable)
    .where(and(
      eq(turnosTable.profesionalId, profesionalId),
      gte(turnosTable.fecha, inicioMesStr),
      inArray(turnosTable.estado, ["atendido", "visto", "pendiente_informe", "en_atencion"]),
    ));

  const atendidosHoy = turnosCerradosDesdeInicioMes.filter((t) => t.fecha >= hoyStr).length;
  const atendidosSemana = turnosCerradosDesdeInicioMes.filter((t) => t.fecha >= inicioSemanaStr).length;
  const atendidosMes = turnosCerradosDesdeInicioMes.length;

  // Pacientes de los encuentros (via clinical_records)
  const recordIds = [...new Set(encuentrosMes.map((e) => e.clinicalRecordId))];
  const records = recordIds.length
    ? await db.select().from(clinicalRecordsTable).where(inArray(clinicalRecordsTable.id, recordIds))
    : [];
  const recordToPaciente = new Map(records.map((r) => [r.id, r.patientId]));

  const practicas = await db
    .select()
    .from(practicasTable)
    .where(eq(practicasTable.profesionalId, profesionalId))
    .orderBy(desc(practicasTable.fecha));

  const pacienteIds = [
    ...new Set([
      ...practicas.map((p) => p.pacienteId),
      ...[...recordToPaciente.values()],
    ]),
  ];
  const pacientes = pacienteIds.length
    ? await db.select().from(pacientesTable).where(inArray(pacientesTable.id, pacienteIds))
    : [];
  const pacientesMap = new Map(pacientes.map((p) => [p.id, p]));
  const nombreDe = (id: number) => {
    const p = pacientesMap.get(id);
    return p ? `${p.apellido}, ${p.nombre}` : `Paciente #${id}`;
  };

  const PENDIENTES = ["indicada", "autorizada", "pendiente"];
  const porNombre = new Map<string, typeof practicas>();
  for (const p of practicas) {
    const lista = porNombre.get(p.nombre) ?? [];
    lista.push(p);
    porNombre.set(p.nombre, lista);
  }

  const practicasAgrupadas = [...porNombre.entries()].map(([nombre, lista]) => ({
    nombre,
    indicadas: lista.length,
    realizadas: lista.filter((p) => p.estado === "realizada").length,
    pendientes: lista.filter((p) => PENDIENTES.includes(p.estado)).length,
    pacientes: lista.map((p) => ({
      practicaId: p.id,
      pacienteId: p.pacienteId,
      nombrePaciente: nombreDe(p.pacienteId),
      dni: pacientesMap.get(p.pacienteId)?.dni ?? null,
      estado: p.estado,
      fecha: p.fecha,
      notas: p.notas ?? null,
    })),
  }));

  // Se envían todas las consultas del mes (acotado a 500 por seguridad):
  // el tablero del médico calcula sus gráficos y métricas a partir de esta lista.
  const ultimosAtendidosBase = encuentrosMes.slice(0, 500).map((e) => {
    const pacienteId = recordToPaciente.get(e.clinicalRecordId) ?? 0;
    return {
      encounterId: e.id,
      pacienteId,
      nombrePaciente: nombreDe(pacienteId),
      dni: pacientesMap.get(pacienteId)?.dni ?? null,
      fecha: e.encounterDate.toISOString(),
      diagnostico: e.diagnosis ?? null,
    };
  });

  // Pacientes atendidos en el mes: por obra social y por rango de edad
  const pacientesUnicosMes = [...new Set(encuentrosMes.map((e) => recordToPaciente.get(e.clinicalRecordId) ?? 0))].filter(Boolean);
  const conteoOS = new Map<string, number>();
  const rangosEdad = ["0-17", "18-30", "31-45", "46-60", "61-75", "76+"] as const;
  const conteoEdad = new Map<string, number>(rangosEdad.map((r) => [r, 0]));
  let edadSinDato = 0;
  const fechaRef = new Date();
  for (const pid of pacientesUnicosMes) {
    const p = pacientesMap.get(pid);
    const os = p?.cobertura?.trim() || "Sin cobertura";
    conteoOS.set(os, (conteoOS.get(os) ?? 0) + 1);
    const fn = p?.fechaNacimiento ? new Date(p.fechaNacimiento) : null;
    if (!fn || isNaN(fn.getTime())) {
      edadSinDato += 1;
    } else {
      let edad = fechaRef.getFullYear() - fn.getFullYear();
      const m = fechaRef.getMonth() - fn.getMonth();
      if (m < 0 || (m === 0 && fechaRef.getDate() < fn.getDate())) edad -= 1;
      const rango =
        edad <= 17 ? "0-17" : edad <= 30 ? "18-30" : edad <= 45 ? "31-45" : edad <= 60 ? "46-60" : edad <= 75 ? "61-75" : "76+";
      conteoEdad.set(rango, (conteoEdad.get(rango) ?? 0) + 1);
    }
  }
  const porObraSocial = [...conteoOS.entries()]
    .map(([nombre, cantidad]) => ({ nombre, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad);
  const porEdad = rangosEdad.map((rango) => ({ rango, cantidad: conteoEdad.get(rango) ?? 0 }));
  if (edadSinDato > 0) porEdad.push({ rango: "Sin dato" as (typeof rangosEdad)[number], cantidad: edadSinDato });

  // Órdenes de estudio derivadas por este profesional
  const ESTADOS_ORDEN_REALIZADA = ["realizado", "informado", "entregado"];
  const ESTADOS_ORDEN_PENDIENTE = ["solicitado", "pendiente_programacion", "programado", "en_realizacion"];
  const ordenesDerivante = await db
    .select({
      status: studyOrdersTable.status,
      statusUpdatedAt: studyOrdersTable.statusUpdatedAt,
      studyName: studyOrdersTable.studyName,
      patientId: studyOrdersTable.patientId,
      createdAt: studyOrdersTable.createdAt,
    })
    .from(studyOrdersTable)
    .where(eq(studyOrdersTable.professionalId, profesionalId));

  // Estudios solicitados agrupados por nombre (Ecografías, Resonancia, OCT, etc.)
  const porEstudio = new Map<string, { solicitados: number; realizados: number; pendientes: number }>();
  for (const o of ordenesDerivante) {
    const nombre = o.studyName?.trim() || "Sin nombre";
    const acc = porEstudio.get(nombre) ?? { solicitados: 0, realizados: 0, pendientes: 0 };
    acc.solicitados += 1;
    if (["realizado", "informado", "entregado"].includes(o.status)) acc.realizados += 1;
    if (["solicitado", "pendiente_programacion", "programado", "en_realizacion"].includes(o.status)) acc.pendientes += 1;
    porEstudio.set(nombre, acc);
  }
  const estudiosSolicitados = [...porEstudio.entries()]
    .map(([nombre, v]) => ({ nombre, ...v }))
    .sort((a, b) => b.solicitados - a.solicitados);

  // Qué se le pidió a cada paciente atendido (órdenes de estudio del mismo día)
  const mismaFecha = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const ultimosAtendidos = ultimosAtendidosBase.map((u) => {
    const fechaConsulta = new Date(u.fecha);
    const pedidos = ordenesDerivante
      .filter((o) => o.patientId === u.pacienteId && o.createdAt && mismaFecha(o.createdAt, fechaConsulta))
      .map((o) => o.studyName);
    return { ...u, pedidos };
  });
  const ordenesDerivadas = {
    realizadasMes: ordenesDerivante.filter(
      (o) =>
        ESTADOS_ORDEN_REALIZADA.includes(o.status) &&
        o.statusUpdatedAt != null &&
        o.statusUpdatedAt >= inicioMes,
    ).length,
    pendientes: ordenesDerivante.filter((o) => ESTADOS_ORDEN_PENDIENTE.includes(o.status)).length,
  };

  // Derivaciones internas pedidas por este profesional, con su trazabilidad
  const derivacionesFilas = await db
    .select({ derivacion: referralsTable, paciente: pacientesTable })
    .from(referralsTable)
    .innerJoin(pacientesTable, eq(referralsTable.patientId, pacientesTable.id))
    .where(eq(referralsTable.professionalId, profesionalId))
    .orderBy(desc(referralsTable.createdAt))
    .limit(100);
  const [derivMes] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(referralsTable)
    .where(and(eq(referralsTable.professionalId, profesionalId), gte(referralsTable.createdAt, inicioMes)));
  const derivacionesMes = derivMes?.total ?? 0;
  const derivaciones = derivacionesFilas.map(({ derivacion: d, paciente: p }) => ({
    id: d.id,
    pacienteId: d.patientId,
    nombrePaciente: `${p.apellido}, ${p.nombre}`,
    dni: p.dni ?? null,
    targetSpecialty: d.targetSpecialty,
    reason: d.reason ?? null,
    priority: d.priority ?? null,
    estado: d.status,
    createdAt: d.createdAt,
  }));

  // Duración promedio de consulta del mes: desde que el médico aprieta "Atender"
  // (turnos.atendidoEn) hasta que finaliza la consulta (encounters.createdAt).
  const turnosAtendidosMes = await db
    .select({
      pacienteId: turnosTable.pacienteId,
      atendidoEn: turnosTable.atendidoEn,
    })
    .from(turnosTable)
    .where(
      and(
        eq(turnosTable.profesionalId, profesionalId),
        isNotNull(turnosTable.atendidoEn),
        gte(turnosTable.atendidoEn, inicioMes),
      ),
    );
  const duraciones: number[] = [];
  for (const e of encuentrosMes) {
    const pacienteId = recordToPaciente.get(e.clinicalRecordId);
    const fin = e.createdAt;
    if (pacienteId == null || !fin) continue;
    // turno del mismo paciente cuyo inicio es anterior al cierre, el más cercano
    let mejor: number | null = null;
    for (const t of turnosAtendidosMes) {
      if (t.pacienteId !== pacienteId || !t.atendidoEn) continue;
      const delta = (fin.getTime() - t.atendidoEn.getTime()) / 60000; // minutos
      if (delta >= 1 && delta <= 240 && (mejor == null || delta < mejor)) mejor = delta;
    }
    if (mejor != null) duraciones.push(mejor);
  }
  const duracionPromedioMin = duraciones.length
    ? Math.round((duraciones.reduce((a, b) => a + b, 0) / duraciones.length) * 10) / 10
    : null;

  // Promedio de satisfacción (valoraciones respondidas por los pacientes)
  const [satis] = await db
    .select({
      promedio: sql<number | null>`avg(${valoracionesAtencionTable.puntaje})::float`,
      respuestas: sql<number>`count(${valoracionesAtencionTable.puntaje})::int`,
      invitaciones: sql<number>`count(*)::int`,
    })
    .from(valoracionesAtencionTable)
    .where(eq(valoracionesAtencionTable.profesionalId, profesionalId));
  const comentariosRecientes = await db
    .select({
      puntaje: valoracionesAtencionTable.puntaje,
      comentario: valoracionesAtencionTable.comentario,
      calificadoEn: valoracionesAtencionTable.calificadoEn,
    })
    .from(valoracionesAtencionTable)
    .where(
      and(
        eq(valoracionesAtencionTable.profesionalId, profesionalId),
        isNotNull(valoracionesAtencionTable.comentario),
        isNotNull(valoracionesAtencionTable.puntaje),
      ),
    )
    .orderBy(desc(valoracionesAtencionTable.calificadoEn))
    .limit(5);
  const satisfaccion = {
    promedio: satis?.promedio ?? null,
    respuestas: satis?.respuestas ?? 0,
    invitaciones: satis?.invitaciones ?? 0,
    ultimosComentarios: comentariosRecientes.map((c) => ({
      puntaje: c.puntaje ?? 0,
      comentario: c.comentario ?? "",
      fecha: c.calificadoEn?.toISOString() ?? null,
    })),
  };

  // Top 20 de estudios más caros según el nomenclador de IOMA
  const [ioma] = await db
    .select({ id: obrasSocialesTable.id })
    .from(obrasSocialesTable)
    .where(ilike(obrasSocialesTable.nombre, "%ioma%"))
    .limit(1);
  const nomencladorIomaTop = ioma
    ? (
        await db
          .select({
            codigo: nomencladorPracticasTable.codigo,
            descripcion: nomencladorPracticasTable.descripcion,
            valorTotal: nomencladorPracticasTable.valorTotal,
          })
          .from(nomencladorPracticasTable)
          .where(and(eq(nomencladorPracticasTable.obraSocialId, ioma.id), isNotNull(nomencladorPracticasTable.valorTotal)))
          .orderBy(desc(nomencladorPracticasTable.valorTotal))
          .limit(20)
      )
    : [];

  res.json({
    profesionalId,
    ordenesDerivadas,
    estudiosSolicitados,
    nomencladorIomaTop,
    porObraSocial,
    porEdad,
    satisfaccion,
    atendidosHoy,
    atendidosSemana,
    atendidosMes,
    practicas: practicasAgrupadas,
    ultimosAtendidos,
    derivaciones,
    derivacionesMes,
    duracionPromedioMin,
    consultasConDuracion: duraciones.length,
  });
});

// ── POST /consultorio/practicas ───────────────────────────────────────────
router.post("/consultorio/practicas", async (req: Request, res: Response) => {
  const user = await getConsultorioUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!["admin", "medico"].includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos para indicar prácticas" });
    return;
  }

  const parsed = CreatePracticaBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // medico: siempre su propio profesional; admin: puede indicar el profesional en el body
  const profesionalId =
    user.rol === "admin" && parsed.data.profesionalId != null
      ? parsed.data.profesionalId
      : resolverProfesionalId(user, undefined);
  if (profesionalId == null) {
    res.status(400).json({
      error: user.rol === "admin"
        ? "Indicá el profesionalId de la práctica"
        : "El usuario no tiene un profesional asociado",
    });
    return;
  }

  const [profesional] = await db
    .select()
    .from(profesionalesTable)
    .where(eq(profesionalesTable.id, profesionalId))
    .limit(1);
  if (!profesional) { res.status(404).json({ error: "Profesional no encontrado" }); return; }

  const [paciente] = await db
    .select()
    .from(pacientesTable)
    .where(eq(pacientesTable.id, parsed.data.pacienteId))
    .limit(1);
  if (!paciente) { res.status(404).json({ error: "Paciente no encontrado" }); return; }

  const [practica] = await db
    .insert(practicasTable)
    .values({
      pacienteId: parsed.data.pacienteId,
      profesionalId,
      encounterId: parsed.data.encounterId ?? null,
      turnoId: parsed.data.turnoId ?? null,
      nombre: parsed.data.nombre,
      estado: parsed.data.estado ?? "indicada",
      fecha: parsed.data.fecha ?? hoyISO(),
      notas: parsed.data.notas ?? null,
    })
    .returning();

  await registrarAuditoria(user, "crear", "practica", practica.id, practica.pacienteId, parsed.data);
  res.status(201).json(practica);
});

// ── PATCH /consultorio/practicas/:practicaId ──────────────────────────────
router.patch("/consultorio/practicas/:practicaId", async (req: Request, res: Response) => {
  const user = await getConsultorioUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!["admin", "medico"].includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos para modificar prácticas" });
    return;
  }

  const params = UpdatePracticaParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdatePracticaBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [existente] = await db
    .select()
    .from(practicasTable)
    .where(eq(practicasTable.id, params.data.practicaId))
    .limit(1);
  if (!existente) { res.status(404).json({ error: "Práctica no encontrada" }); return; }

  if (user.rol === "medico" && user.profesionalId !== existente.profesionalId) {
    res.status(403).json({ error: "No podés modificar prácticas de otro profesional" });
    return;
  }

  const [actualizada] = await db
    .update(practicasTable)
    .set({
      estado: parsed.data.estado,
      ...(parsed.data.notas !== undefined && { notas: parsed.data.notas }),
    })
    .where(eq(practicasTable.id, params.data.practicaId))
    .returning();

  await registrarAuditoria(user, "actualizar", "practica", actualizada.id, actualizada.pacienteId, parsed.data);
  res.json(actualizada);
});

export default router;
