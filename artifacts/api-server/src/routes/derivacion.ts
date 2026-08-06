import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  pacientesTable,
  profesionalesTable,
  especialidadesTable,
  sedesTable,
  turnerasTable,
  turnosTable,
  serviciosTable,
  solicitudesTable,
  notificacionesSalientesTable,
  auditLogTable,
  type Solicitud,
} from "@workspace/db";
import {
  ListServiciosQueryParams,
  CreateServicioBody,
  UpdateServicioParams,
  UpdateServicioBody,
  GetDisponibilidadServicioParams,
  ListSolicitudesQueryParams,
  CreateSolicitudBody,
  UpdateSolicitudEstadoParams,
  UpdateSolicitudEstadoBody,
  GetSolicitudHistorialParams,
  ListSolicitudesPacienteParams,
  ListNotificacionesSalientesQueryParams,
  EnviarWhatsappManualBody,
  UpdateWhatsappConfigBody,
} from "@workspace/api-zod";
import {
  enviarWhatsappWhaticket,
  whaticketConfigurado,
  obtenerTemplateIdAprobado,
  guardarTemplateIdAprobado,
  obtenerTemplateIdLink,
  guardarTemplateIdLink,
  CLAVE_WHATICKET_TEMPLATE_ID,
  CLAVE_WHATICKET_TEMPLATE_LINK_ID,
} from "../integraciones/whaticket";
import { getUserIdFromToken } from "./auth";
import { registrarEventoTurnoRobot } from "../lib/robot-turnos-eventos";
import { generarTokenIngreso } from "../lib/autologin-paciente";
import { urlPublicaApp, urlBaseLinkIngreso } from "../lib/url-publica";
import { reservarConCupo } from "../lib/cupos-obra-social";
import { esViolacionUnique } from "../lib/pg";

const router: IRouter = Router();

// ── Auth (mismo modelo que consultorio_docs.ts) ───────────────────────────
type DerivUser = {
  id: number;
  email: string;
  rol: string;
  profesionalId: number | null;
  pacienteId: number | null;
};

async function getUser(req: Request): Promise<DerivUser | null> {
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
    pacienteId: user.pacienteId ? parseInt(user.pacienteId) : null,
  };
}

async function requireUser(req: Request, res: Response): Promise<DerivUser | null> {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  return user;
}

async function registrarAuditoria(
  user: DerivUser,
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

// ── Máquina de estados de solicitudes ─────────────────────────────────────
const TRANSICIONES: Record<string, string[]> = {
  indicada: ["pre_reservada", "pendiente_validacion", "en_sala", "cancelada", "rechazada"],
  pre_reservada: ["pendiente_validacion", "validada", "programada", "cancelada", "rechazada"],
  pendiente_validacion: ["validada", "rechazada", "cancelada"],
  validada: ["programada", "en_sala", "cancelada"],
  programada: ["programada", "en_sala", "realizada", "cancelada"], // programada→programada = reprogramación
  en_sala: ["realizada", "cancelada"],
  realizada: ["informada"],
  informada: [],
  cancelada: [],
  rechazada: [],
};

// Estados que puede aplicar recepción (validación/logística)
const ESTADOS_RECEPCION = ["pendiente_validacion", "validada", "programada", "en_sala", "cancelada", "rechazada"];
// Estados clínicos del médico sobre sus propias solicitudes
const ESTADOS_MEDICO = ["pre_reservada", "pendiente_validacion", "en_sala", "realizada", "informada", "cancelada"];

// ── Notificaciones salientes (WhatsApp auditado) ──────────────────────────
async function enviarNotificacion(opts: {
  user: DerivUser;
  patientId: number;
  solicitudId: number | null;
  evento: string;
  contenido: string;
}): Promise<void> {
  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, opts.patientId)).limit(1);
  const destinatario = paciente?.telefono ?? null;
  // Sin credenciales de proveedor WhatsApp configuradas, la notificación queda
  // registrada como "simulada" (auditada y lista para conectar un proveedor real).
  const tieneProveedor = Boolean(process.env.WHATSAPP_API_TOKEN);
  let estadoEntrega = "simulada";
  let errorDetalle: string | null = null;
  if (tieneProveedor) {
    estadoEntrega = destinatario ? "enviada" : "fallida";
    if (!destinatario) errorDetalle = "El paciente no tiene teléfono registrado";
  } else if (!destinatario) {
    errorDetalle = "El paciente no tiene teléfono registrado";
  }
  await db.insert(notificacionesSalientesTable).values({
    patientId: opts.patientId,
    solicitudId: opts.solicitudId,
    canal: "whatsapp",
    evento: opts.evento,
    destinatario,
    contenido: opts.contenido,
    estadoEntrega,
    errorDetalle,
    usuarioOrigenId: opts.user.id,
  });
}

const ETIQUETAS_ESTADO: Record<string, string> = {
  indicada: "Indicada",
  pre_reservada: "Pre-reservada",
  pendiente_validacion: "Pendiente de validación",
  validada: "Validada",
  programada: "Programada",
  en_sala: "En sala",
  realizada: "Realizada",
  informada: "Informe disponible",
  cancelada: "Cancelada",
  rechazada: "Rechazada",
};

async function contenidoNotificacion(solicitudId: number): Promise<{ patientId: number; texto: string } | null> {
  const s = await getSolicitudEnriquecida(solicitudId);
  if (!s) return null;
  const partes = [
    `Hola ${s.pacienteNombre ?? ""}!`.trim(),
    `Tu ${s.tipo === "derivacion" ? "derivación" : "estudio"} de ${s.servicioNombre} indicado por ${s.profesionalNombre ?? "tu médico"} está: ${ETIQUETAS_ESTADO[s.estado] ?? s.estado}.`,
  ];
  if (s.turnoFecha && s.turnoHoraInicio) {
    partes.push(`Turno: ${s.turnoFecha} ${s.turnoHoraInicio} hs${s.turnoSedeNombre ? ` en ${s.turnoSedeNombre}` : ""}.`);
  }
  if (s.requiereAutorizacion && !s.tokenValidado) {
    partes.push("Requiere autorización/token de tu cobertura. Acercate a recepción o respondé este mensaje.");
  }
  partes.push("Podés confirmar, reprogramar o contactar recepción respondiendo este WhatsApp.");
  return { patientId: s.patientId, texto: partes.join(" ") };
}

// ── Enriquecimiento de solicitudes (joins) ────────────────────────────────
async function getSolicitudesEnriquecidas(where?: ReturnType<typeof and>): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select({
      s: solicitudesTable,
      pacienteNombre: sql<string | null>`${pacientesTable.apellido} || ', ' || ${pacientesTable.nombre}`,
      pacienteDni: pacientesTable.dni,
      pacienteTelefono: pacientesTable.telefono,
      profesionalNombre: sql<string | null>`${profesionalesTable.apellido} || ', ' || ${profesionalesTable.nombre}`,
      servicioNombre: serviciosTable.nombre,
      requiereAutorizacion: serviciosTable.requiereAutorizacion,
      turnoFecha: turnosTable.fecha,
      turnoHoraInicio: turnosTable.horaInicio,
      turnoSedeNombre: sedesTable.nombre,
    })
    .from(solicitudesTable)
    .leftJoin(pacientesTable, eq(solicitudesTable.patientId, pacientesTable.id))
    .leftJoin(profesionalesTable, eq(solicitudesTable.professionalId, profesionalesTable.id))
    .leftJoin(serviciosTable, eq(solicitudesTable.servicioId, serviciosTable.id))
    .leftJoin(turnosTable, eq(solicitudesTable.turnoId, turnosTable.id))
    .leftJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(sedesTable, eq(turnerasTable.sedeId, sedesTable.id))
    .where(where)
    .orderBy(desc(solicitudesTable.createdAt));
  return rows.map((r) => ({
    ...r.s,
    pacienteNombre: r.pacienteNombre,
    pacienteDni: r.pacienteDni,
    pacienteTelefono: r.pacienteTelefono,
    profesionalNombre: r.profesionalNombre,
    servicioNombre: r.servicioNombre,
    requiereAutorizacion: r.requiereAutorizacion ?? false,
    turnoFecha: r.turnoFecha,
    turnoHoraInicio: r.turnoHoraInicio,
    turnoSedeNombre: r.turnoSedeNombre,
  }));
}

async function getSolicitudEnriquecida(id: number): Promise<Record<string, any> | null> {
  const rows = await getSolicitudesEnriquecidas(and(eq(solicitudesTable.id, id)));
  return rows[0] ?? null;
}

// ── Catálogo de servicios ─────────────────────────────────────────────────
router.get("/servicios", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  const query = ListServiciosQueryParams.safeParse(req.query);
  const incluirInactivos = query.success && query.data.incluirInactivos === true && user.rol === "admin";
  const rows = await db
    .select({
      s: serviciosTable,
      especialidadNombre: especialidadesTable.nombre,
    })
    .from(serviciosTable)
    .leftJoin(especialidadesTable, eq(serviciosTable.especialidadId, especialidadesTable.id))
    .where(incluirInactivos ? undefined : eq(serviciosTable.activo, true))
    .orderBy(serviciosTable.orden, serviciosTable.nombre);
  res.json(rows.map((r) => ({ ...r.s, especialidadNombre: r.especialidadNombre })));
});

router.post("/servicios", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.rol !== "admin") {
    res.status(403).json({ error: "Solo admin puede gestionar el catálogo" });
    return;
  }
  const parsed = CreateServicioBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [servicio] = await db
    .insert(serviciosTable)
    .values({
      nombre: parsed.data.nombre,
      slug: parsed.data.slug,
      especialidadId: parsed.data.especialidadId ?? null,
      requiereAutorizacion: parsed.data.requiereAutorizacion ?? false,
      activo: parsed.data.activo ?? true,
      orden: parsed.data.orden ?? 0,
    })
    .returning();
  await registrarAuditoria(user, "crear", "servicio", servicio.id, null, { nombre: servicio.nombre });
  res.status(201).json({ ...servicio, especialidadNombre: null });
});

router.patch("/servicios/:id", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.rol !== "admin") {
    res.status(403).json({ error: "Solo admin puede gestionar el catálogo" });
    return;
  }
  const params = UpdateServicioParams.safeParse(req.params);
  const parsed = UpdateServicioBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  const [servicio] = await db
    .update(serviciosTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(serviciosTable.id, params.data.id))
    .returning();
  if (!servicio) {
    res.status(404).json({ error: "Servicio no encontrado" });
    return;
  }
  await registrarAuditoria(user, "actualizar", "servicio", servicio.id, null, parsed.data);
  res.json({ ...servicio, especialidadNombre: null });
});

// ── Disponibilidad real del servicio (priorizada por menor espera) ────────
type SlotServicio = {
  turneraId: number;
  turneraNombre: string;
  sedeId: number | null;
  sedeNombre: string | null;
  profesionalId: number | null;
  profesionalNombre: string | null;
  fecha: string;
  horaInicio: string;
  horaFin: string;
  esperaDias: number;
  modalidad: string;
};

async function calcularSlotsServicio(servicioId: number, maxPorTurnera = 3, dias = 21): Promise<SlotServicio[] | null> {
  const [servicio] = await db.select().from(serviciosTable).where(eq(serviciosTable.id, servicioId)).limit(1);
  if (!servicio || !servicio.activo) return null;
  if (!servicio.especialidadId) return [];

  const turneras = await db
    .select({
      t: turnerasTable,
      sedeNombre: sedesTable.nombre,
      profesionalNombre: sql<string | null>`${profesionalesTable.apellido} || ', ' || ${profesionalesTable.nombre}`,
    })
    .from(turnerasTable)
    .leftJoin(sedesTable, eq(turnerasTable.sedeId, sedesTable.id))
    .leftJoin(profesionalesTable, eq(turnerasTable.profesionalId, profesionalesTable.id))
    .where(and(eq(turnerasTable.especialidadId, servicio.especialidadId), eq(turnerasTable.activa, true)));

  const hoy = new Date();
  const slots: SlotServicio[] = [];

  for (const { t: turnera, sedeNombre, profesionalNombre } of turneras) {
    const diasArray = turnera.diasAtencion ? turnera.diasAtencion.split(",").map(Number) : [];
    let encontrados = 0;
    for (let d = 0; d < dias && encontrados < maxPorTurnera; d++) {
      const fechaDate = new Date(hoy);
      fechaDate.setDate(hoy.getDate() + d);
      if (!diasArray.includes(fechaDate.getDay())) continue;
      // Formatear con componentes locales para que la fecha coincida con el
      // getDay() local de arriba (toISOString() usaría UTC y podría correr un día).
      const fecha = `${fechaDate.getFullYear()}-${String(fechaDate.getMonth() + 1).padStart(2, "0")}-${String(fechaDate.getDate()).padStart(2, "0")}`;

      const turnosDelDia = await db
        .select({ horaInicio: turnosTable.horaInicio, estado: turnosTable.estado })
        .from(turnosTable)
        .where(and(eq(turnosTable.turneraId, turnera.id), eq(turnosTable.fecha, fecha)));
      const ocupados = new Set(
        turnosDelDia.filter((x) => !["cancelado", "ausente"].includes(x.estado)).map((x) => x.horaInicio),
      );

      const [hIni, mIni] = turnera.horaInicio.split(":").map(Number);
      const [hFin, mFin] = turnera.horaFin.split(":").map(Number);
      const duracion = turnera.duracionMinutos;
      const ahoraMin = d === 0 ? hoy.getHours() * 60 + hoy.getMinutes() : -1;
      let current = hIni * 60 + mIni;
      const end = hFin * 60 + mFin;
      while (current + duracion <= end && encontrados < maxPorTurnera) {
        const hi = `${Math.floor(current / 60).toString().padStart(2, "0")}:${(current % 60).toString().padStart(2, "0")}`;
        const hf = `${Math.floor((current + duracion) / 60).toString().padStart(2, "0")}:${((current + duracion) % 60).toString().padStart(2, "0")}`;
        if (current > ahoraMin && !ocupados.has(hi)) {
          slots.push({
            turneraId: turnera.id,
            turneraNombre: turnera.nombre,
            sedeId: turnera.sedeId,
            sedeNombre,
            profesionalId: turnera.profesionalId,
            profesionalNombre,
            fecha,
            horaInicio: hi,
            horaFin: hf,
            esperaDias: d,
            modalidad: turnera.modalidad,
          });
          encontrados++;
        }
        current += duracion;
      }
    }
  }
  // Priorización: menor espera primero, luego hora más temprana
  slots.sort((a, b) => a.esperaDias - b.esperaDias || a.fecha.localeCompare(b.fecha) || a.horaInicio.localeCompare(b.horaInicio));
  return slots.slice(0, 12);
}

router.get("/derivacion/servicios/:servicioId/disponibilidad", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!["admin", "medico", "recepcionista"].includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }
  const params = GetDisponibilidadServicioParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const slots = await calcularSlotsServicio(params.data.servicioId);
  if (slots === null) {
    res.status(404).json({ error: "Servicio no encontrado o inactivo" });
    return;
  }
  res.json(slots);
});

// ── Crear solicitud (indicación del médico) ───────────────────────────────
async function crearTurnoPreReserva(opts: {
  turneraId: number;
  fecha: string;
  horaInicio: string;
  patientId: number;
  cobertura?: string;
  motivo: string;
  regionAnatomica?: string | null;
}): Promise<{ ok: true; turnoId: number } | { ok: false; status?: number; error: string }> {
  const [turnera] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, opts.turneraId)).limit(1);
  if (!turnera) return { ok: false, error: "Turnera no encontrada" };
  // Verificar que el slot siga libre
  const existentes = await db
    .select({ id: turnosTable.id, estado: turnosTable.estado })
    .from(turnosTable)
    .where(and(eq(turnosTable.turneraId, opts.turneraId), eq(turnosTable.fecha, opts.fecha), eq(turnosTable.horaInicio, opts.horaInicio)));
  if (existentes.some((t) => !["cancelado", "ausente"].includes(t.estado))) {
    return { ok: false, error: "El turno seleccionado ya no está disponible" };
  }
  // Cobertura efectiva: la indicada o la de la ficha del paciente.
  let coberturaEfectiva: string | null = opts.cobertura ?? null;
  if (!coberturaEfectiva) {
    const [pac] = await db.select({ cobertura: pacientesTable.cobertura })
      .from(pacientesTable).where(eq(pacientesTable.id, opts.patientId)).limit(1);
    coberturaEfectiva = pac?.cobertura ?? null;
  }
  const [h, m] = opts.horaInicio.split(":").map(Number);
  const endMin = h * 60 + m + turnera.duracionMinutos;
  const horaFin = `${Math.floor(endMin / 60).toString().padStart(2, "0")}:${(endMin % 60).toString().padStart(2, "0")}`;
  // Verificación de obra social/cupo + insert atómicos.
  let r: Awaited<ReturnType<typeof reservarConCupo<typeof turnosTable.$inferSelect>>>;
  try {
    r = await reservarConCupo(
      { turneraId: opts.turneraId, fecha: opts.fecha, cobertura: coberturaEfectiva },
      async (tx) => {
        const [turno] = await tx
          .insert(turnosTable)
          .values({
            turneraId: opts.turneraId,
            pacienteId: opts.patientId,
            profesionalId: turnera.profesionalId ?? undefined,
            fecha: opts.fecha,
            horaInicio: opts.horaInicio,
            horaFin,
            estado: "pendiente",
            modalidad: turnera.modalidad,
            motivoConsulta: opts.motivo,
            regionAnatomica: opts.regionAnatomica ?? undefined,
            cobertura: opts.cobertura,
          })
          .returning();
        return turno;
      },
    );
  } catch (err) {
    // Índice único parcial de slot: otro request ganó el slot entre el
    // pre-check y el insert.
    if (esViolacionUnique(err)) {
      return { ok: false, status: 409, error: "El turno seleccionado ya no está disponible" };
    }
    throw err;
  }
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  await registrarEventoTurnoRobot(r.valor.id, "alta");
  return { ok: true, turnoId: r.valor.id };
}

router.post("/derivacion/solicitudes", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!["admin", "medico"].includes(user.rol)) {
    res.status(403).json({ error: "Solo médicos o admin pueden indicar estudios" });
    return;
  }
  const parsed = CreateSolicitudBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data;

  const profesionalId = user.rol === "medico" ? user.profesionalId : (body.profesionalId ?? user.profesionalId ?? null);
  if (!profesionalId) {
    res.status(400).json({ error: "Debe indicarse el profesional solicitante" });
    return;
  }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, body.patientId)).limit(1);
  if (!paciente) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }
  const [servicio] = await db.select().from(serviciosTable).where(and(eq(serviciosTable.id, body.servicioId), eq(serviciosTable.activo, true))).limit(1);
  if (!servicio) {
    res.status(404).json({ error: "Servicio no encontrado o inactivo" });
    return;
  }

  const accion = body.accion ?? "indicar";
  let turnoId: number | null = null;
  let estado = "indicada";

  if (accion === "pre_reservar") {
    if (!body.turno) {
      res.status(400).json({ error: "Para pre-reservar debe indicarse el turno (turneraId, fecha, horaInicio)" });
      return;
    }
    const r = await crearTurnoPreReserva({
      turneraId: body.turno.turneraId,
      fecha: body.turno.fecha,
      horaInicio: body.turno.horaInicio,
      patientId: body.patientId,
      cobertura: body.cobertura,
      motivo: `${servicio.nombre} — indicación médica`,
    });
    if (!r.ok) {
      res.status(r.status ?? 409).json({ error: r.error });
      return;
    }
    turnoId = r.turnoId;
    estado = servicio.requiereAutorizacion ? "pendiente_validacion" : "pre_reservada";
  } else if (accion === "derivar_recepcion") {
    estado = "pendiente_validacion";
  }

  const [solicitud] = await db
    .insert(solicitudesTable)
    .values({
      patientId: body.patientId,
      professionalId: profesionalId,
      servicioId: body.servicioId,
      tipo: body.tipo ?? "estudio",
      encounterId: body.encounterId ?? null,
      studyOrderId: body.studyOrderId ?? null,
      referralId: body.referralId ?? null,
      turnoId,
      estado,
      detalle: body.detalle ?? null,
      prioridad: body.prioridad ?? "normal",
      cobertura: body.cobertura ?? null,
      observaciones: body.observaciones ?? null,
      createdBy: user.id,
    })
    .returning();

  await registrarAuditoria(user, "crear", "solicitud", solicitud.id, body.patientId, {
    servicio: servicio.nombre,
    accion,
    estado,
    turnoId,
    prioridad: solicitud.prioridad,
    cobertura: solicitud.cobertura,
  });

  const notif = await contenidoNotificacion(solicitud.id);
  if (notif) {
    await enviarNotificacion({
      user,
      patientId: notif.patientId,
      solicitudId: solicitud.id,
      evento: "solicitud_indicada",
      contenido: notif.texto,
    });
  }

  const enriquecida = await getSolicitudEnriquecida(solicitud.id);
  res.status(201).json(enriquecida);
});

// ── Bandeja / listados ────────────────────────────────────────────────────
router.get("/derivacion/solicitudes", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!["admin", "recepcionista", "medico"].includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }
  const query = ListSolicitudesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const condiciones = [];
  if (query.data.estado) condiciones.push(eq(solicitudesTable.estado, query.data.estado));
  if (query.data.patientId) condiciones.push(eq(solicitudesTable.patientId, query.data.patientId));
  if (query.data.servicioId) condiciones.push(eq(solicitudesTable.servicioId, query.data.servicioId));
  // medico solo ve sus propias solicitudes
  if (user.rol === "medico") {
    if (!user.profesionalId) {
      res.status(403).json({ error: "Usuario médico sin profesional asociado" });
      return;
    }
    condiciones.push(eq(solicitudesTable.professionalId, user.profesionalId));
  }
  const rows = await getSolicitudesEnriquecidas(condiciones.length ? and(...condiciones) : undefined);
  res.json(rows);
});

router.get("/derivacion/pacientes/:patientId/solicitudes", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  const params = ListSolicitudesPacienteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const patientId = params.data.patientId;
  const esStaff = ["admin", "medico", "recepcionista"].includes(user.rol);
  if (!esStaff && !(user.rol === "paciente" && user.pacienteId === patientId)) {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }
  const rows = await getSolicitudesEnriquecidas(and(eq(solicitudesTable.patientId, patientId)));
  res.json(rows);
});

// ── Transición de estado (atómica + auditada + notificada) ────────────────
router.patch("/derivacion/solicitudes/:id/estado", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  const params = UpdateSolicitudEstadoParams.safeParse(req.params);
  const parsed = UpdateSolicitudEstadoBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  const { id } = params.data;
  const nuevoEstado = parsed.data.estado;

  const [actual] = await db.select().from(solicitudesTable).where(eq(solicitudesTable.id, id)).limit(1);
  if (!actual) {
    res.status(404).json({ error: "Solicitud no encontrada" });
    return;
  }

  // Permisos por rol
  if (user.rol === "admin") {
    // todo permitido
  } else if (user.rol === "recepcionista") {
    if (!ESTADOS_RECEPCION.includes(nuevoEstado)) {
      res.status(403).json({ error: "Recepción solo gestiona estados de validación y logística" });
      return;
    }
  } else if (user.rol === "medico") {
    if (actual.professionalId !== user.profesionalId) {
      res.status(403).json({ error: "Solo puede gestionar sus propias solicitudes" });
      return;
    }
    if (!ESTADOS_MEDICO.includes(nuevoEstado)) {
      res.status(403).json({ error: "Estado no habilitado para el médico" });
      return;
    }
  } else {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }

  const validas = TRANSICIONES[actual.estado] ?? [];
  if (!validas.includes(nuevoEstado)) {
    res.status(422).json({
      error: `Transición inválida: ${actual.estado} → ${nuevoEstado}`,
      transicionesValidas: validas,
    });
    return;
  }

  // Reprogramación / programación con turno nuevo
  let turnoId = actual.turnoId;
  if (parsed.data.turno) {
    const [servicio] = await db.select().from(serviciosTable).where(eq(serviciosTable.id, actual.servicioId)).limit(1);
    // Conservar la región anatómica del turno anterior (obligatoria en
    // prácticas; el PACS la recibe como body_part).
    let regionAnterior: string | null = null;
    if (actual.turnoId) {
      const [previo] = await db.select({ regionAnatomica: turnosTable.regionAnatomica })
        .from(turnosTable).where(eq(turnosTable.id, actual.turnoId)).limit(1);
      regionAnterior = previo?.regionAnatomica ?? null;
    }
    const r = await crearTurnoPreReserva({
      turneraId: parsed.data.turno.turneraId,
      fecha: parsed.data.turno.fecha,
      horaInicio: parsed.data.turno.horaInicio,
      patientId: actual.patientId,
      cobertura: parsed.data.cobertura ?? actual.cobertura ?? undefined,
      motivo: `${servicio?.nombre ?? "Práctica"} — reprogramación`,
      regionAnatomica: regionAnterior,
    });
    if (!r.ok) {
      res.status(r.status ?? 409).json({ error: r.error });
      return;
    }
    // cancelar turno anterior
    if (actual.turnoId) {
      await db.update(turnosTable).set({ estado: "cancelado" }).where(eq(turnosTable.id, actual.turnoId));
      await registrarEventoTurnoRobot(actual.turnoId, "cancelacion");
    }
    turnoId = r.turnoId;
  }

  const setExtra: Partial<typeof solicitudesTable.$inferInsert> = {};
  if (parsed.data.token !== undefined) {
    setExtra.token = parsed.data.token;
    setExtra.tokenValidado = true;
    setExtra.validadoPor = user.id;
  }
  if (parsed.data.cobertura !== undefined) {
    setExtra.cobertura = parsed.data.cobertura;
    setExtra.coberturaValidada = true;
    setExtra.validadoPor = user.id;
  }
  if (nuevoEstado === "validada") {
    setExtra.validadoPor = user.id;
  }
  if (nuevoEstado === "cancelada" && actual.turnoId) {
    await db.update(turnosTable).set({ estado: "cancelado" }).where(eq(turnosTable.id, actual.turnoId));
    await registrarEventoTurnoRobot(actual.turnoId, "cancelacion");
  }

  // UPDATE atómico con condición de estado (evita carreras)
  const [actualizada] = await db
    .update(solicitudesTable)
    .set({
      estado: nuevoEstado,
      estadoUpdatedAt: new Date(),
      updatedAt: new Date(),
      turnoId,
      ...setExtra,
    })
    .where(and(eq(solicitudesTable.id, id), eq(solicitudesTable.estado, actual.estado)))
    .returning();
  if (!actualizada) {
    res.status(422).json({ error: "La solicitud cambió de estado; recargá e intentá de nuevo" });
    return;
  }

  await registrarAuditoria(user, "cambio_estado", "solicitud", id, actual.patientId, {
    de: actual.estado,
    a: nuevoEstado,
    motivo: parsed.data.motivo ?? null,
    token: parsed.data.token ?? null,
    cobertura: parsed.data.cobertura ?? null,
    turnoAnterior: actual.turnoId,
    turnoNuevo: turnoId,
  });

  const notif = await contenidoNotificacion(id);
  if (notif) {
    await enviarNotificacion({
      user,
      patientId: notif.patientId,
      solicitudId: id,
      evento: `solicitud_${nuevoEstado}`,
      contenido: notif.texto,
    });
  }

  const enriquecida = await getSolicitudEnriquecida(id);
  res.json(enriquecida);
});

// ── Historial (auditoría) ─────────────────────────────────────────────────
router.get("/derivacion/solicitudes/:id/historial", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!["admin", "recepcionista", "medico"].includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }
  const params = GetSolicitudHistorialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [solicitud] = await db
    .select({ professionalId: solicitudesTable.professionalId })
    .from(solicitudesTable)
    .where(eq(solicitudesTable.id, params.data.id))
    .limit(1);
  if (!solicitud) {
    res.status(404).json({ error: "Solicitud no encontrada" });
    return;
  }
  if (user.rol === "medico" && solicitud.professionalId !== user.profesionalId) {
    res.status(403).json({ error: "Solo puede ver el historial de sus propias solicitudes" });
    return;
  }
  const rows = await db
    .select()
    .from(auditLogTable)
    .where(and(eq(auditLogTable.entidad, "solicitud"), eq(auditLogTable.entidadId, params.data.id)))
    .orderBy(desc(auditLogTable.createdAt));
  res.json(
    rows.map((r) => ({
      id: r.id,
      action: r.accion,
      detail: r.detalle ? JSON.stringify(r.detalle) : null,
      userId: r.usuarioId,
      userEmail: r.usuarioEmail,
      createdAt: r.createdAt,
    })),
  );
});

// ── Envío manual de WhatsApp (Whaticket) ──────────────────────────────────
router.post("/notificaciones/whatsapp", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!["admin", "recepcionista", "medico"].includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }
  const body = EnviarWhatsappManualBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  let mensaje = body.data.mensaje.trim();
  if (!mensaje) {
    res.status(400).json({ error: "El mensaje no puede estar vacío" });
    return;
  }
  const [paciente] = await db
    .select()
    .from(pacientesTable)
    .where(eq(pacientesTable.id, body.data.pacienteId))
    .limit(1);
  if (!paciente) {
    res.status(404).json({ error: "Paciente no encontrado" });
    return;
  }
  const telefonoDestino = body.data.telefono?.trim() || paciente.telefono;
  if (!telefonoDestino) {
    res.status(422).json({ error: "El paciente no tiene teléfono cargado" });
    return;
  }

  // WABA: para iniciar una conversación hace falta la plantilla aprobada.
  // Con conLinkIngreso se usa la SEGUNDA plantilla aprobada (con variable
  // {{1}}) y se genera el link de ingreso mágico del paciente en el momento.
  let templateId: string | undefined;
  let variables: string[] | undefined;
  let evento = "mensaje_manual";
  if (body.data.conLinkIngreso) {
    const plantillaLink = await obtenerTemplateIdLink();
    if (!plantillaLink) {
      res.status(422).json({
        error:
          "No hay una plantilla con link de ingreso configurada. Cargá el ID de la plantilla aprobada por Meta (con variable {{1}}) antes de enviar.",
      });
      return;
    }
    const base = urlBaseLinkIngreso();
    if (!base) {
      res.status(422).json({ error: "No hay una URL pública configurada para armar el link de ingreso." });
      return;
    }
    // Las cuentas de los pacientes viven en la app Mi Diagnosticar (proyecto
    // aparte) y se identifican por DNI: alcanza con la ficha de Conectar.
    if (!paciente.dni?.trim()) {
      res.status(422).json({
        error: "El paciente no tiene DNI cargado en su ficha, así que no se puede generar el link de ingreso.",
      });
      return;
    }
    templateId = plantillaLink;
    // Link opaco (token de un solo uso): nunca DNI ni teléfono en la URL.
    const { tokenPlano } = await generarTokenIngreso({
      usuarioId: null,
      pacienteId: paciente.id,
      generadoPorId: user.id,
      generadoPorEmail: user.email,
    });
    variables = [`${base}/ingreso/${tokenPlano}`];
    evento = "mensaje_link_ingreso";
    await registrarAuditoria(user, "link_ingreso_generado", "paciente", paciente.id, paciente.id, {
      viaPlantilla: true,
    });
  } else if (body.data.usarPlantilla) {
    const aprobada = await obtenerTemplateIdAprobado();
    if (!aprobada) {
      res.status(422).json({
        error:
          "No hay una plantilla aprobada configurada. Cargá el ID de la plantilla aprobada por Meta antes de enviar.",
      });
      return;
    }
    templateId = aprobada;
  }

  // ── Link mágico de ingreso a la app (texto libre dentro de la ventana de
  // 24 h, o como variable {{1}} de la plantilla aprobada "con link") ──
  let mensajeAuditoria = mensaje;
  if (body.data.incluirLinkIngreso) {
    if (body.data.usarPlantilla || body.data.conLinkIngreso) {
      res.status(422).json({
        error:
          "Para mandar el link en el primer mensaje usá la plantilla con link de ingreso; incluirLinkIngreso es solo para texto libre (ventana de 24 h).",
      });
      return;
    }
    const base = urlBaseLinkIngreso();
    if (!base) {
      res.status(422).json({ error: "No hay una URL pública configurada para armar el link de ingreso." });
      return;
    }
    // Las cuentas de los pacientes viven en la app Mi Diagnosticar (proyecto
    // aparte) y se identifican por DNI: alcanza con la ficha de Conectar.
    if (!paciente.dni?.trim()) {
      res.status(422).json({
        error: "El paciente no tiene DNI cargado en su ficha, así que no se puede generar el link de ingreso.",
      });
      return;
    }
    const { tokenPlano } = await generarTokenIngreso({
      usuarioId: null,
      pacienteId: paciente.id,
      generadoPorId: user.id,
      generadoPorEmail: user.email,
    });
    const link = `${base}/ingreso/${tokenPlano}`;
    const anexo = `\n\nIngresá a la app Mi Diagnosticar sin clave con tu link personal (guardalo, es tuyo y podés usarlo siempre): ${link}`;
    mensaje = `${mensaje}${anexo}`;
    // El token plano nunca queda en la DB: en la auditoría se enmascara.
    mensajeAuditoria = `${mensajeAuditoria}${anexo.replace(tokenPlano, `****${tokenPlano.slice(-4)}`)}`;
    await registrarAuditoria(user, "link_ingreso_generado", "paciente", paciente.id, paciente.id, {
    });
  }

  const r = await enviarWhatsappWhaticket(telefonoDestino, mensaje, req.log, { templateId, variables });
  await db.insert(notificacionesSalientesTable).values({
    patientId: paciente.id,
    canal: "whatsapp",
    evento,
    destinatario: telefonoDestino,
    // El link es de un solo uso: NO se guarda completo en la auditoría para
    // que nadie del staff pueda usarlo; se deja constancia enmascarada.
    contenido: variables?.length
      ? `${mensajeAuditoria} [se incluyó link de ingreso único: ****${variables[0].slice(-4)}]`
      : mensajeAuditoria,
    estadoEntrega: r.estado,
    errorDetalle: r.estado === "fallida" ? r.error : null,
    template: templateId ?? null,
    usuarioOrigenId: user.id,
  });

  res.json({
    estado: r.estado,
    ...(r.estado === "fallida" ? { error: r.error } : {}),
    destinatario: telefonoDestino,
  });
});

// ── Configuración de Whaticket (plantilla aprobada por Meta) ──────────────
router.get("/notificaciones/whatsapp/config", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!["admin", "recepcionista", "medico"].includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }
  const [templateId, templateLinkId] = await Promise.all([obtenerTemplateIdAprobado(), obtenerTemplateIdLink()]);
  res.json({
    configurado: whaticketConfigurado(),
    plantillaConfigurada: templateId !== null,
    plantillaLinkConfigurada: templateLinkId !== null,
    ...(templateId ? { templateId } : {}),
    ...(templateLinkId ? { templateLinkId } : {}),
  });
});

router.put("/notificaciones/whatsapp/config", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.rol !== "admin") {
    res.status(403).json({ error: "Solo un administrador puede configurar la plantilla de WhatsApp" });
    return;
  }
  const body = UpdateWhatsappConfigBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const templateId = body.data.templateId?.trim();
  const templateLinkId = body.data.templateLinkId?.trim();
  if (!templateId && !templateLinkId) {
    res.status(400).json({ error: "Indicá al menos un ID de plantilla (templateId o templateLinkId)" });
    return;
  }
  const detalle: Record<string, string> = {};
  if (templateId) {
    await guardarTemplateIdAprobado(templateId);
    detalle[CLAVE_WHATICKET_TEMPLATE_ID] = templateId;
  }
  if (templateLinkId) {
    await guardarTemplateIdLink(templateLinkId);
    detalle[CLAVE_WHATICKET_TEMPLATE_LINK_ID] = templateLinkId;
  }
  await db.insert(auditLogTable).values({
    usuarioId: user.id,
    usuarioEmail: user.email,
    rol: user.rol,
    accion: "whaticket_template_actualizar",
    entidad: "config_sistema",
    entidadId: null,
    detalle,
  });
  req.log.info({ usuario: user.email }, "plantillas aprobadas de Whaticket actualizadas");
  const [actualId, actualLinkId] = await Promise.all([obtenerTemplateIdAprobado(), obtenerTemplateIdLink()]);
  res.json({
    configurado: whaticketConfigurado(),
    plantillaConfigurada: actualId !== null,
    plantillaLinkConfigurada: actualLinkId !== null,
    ...(actualId ? { templateId: actualId } : {}),
    ...(actualLinkId ? { templateLinkId: actualLinkId } : {}),
  });
});

// ── Notificaciones salientes (auditoría) ──────────────────────────────────
router.get("/notificaciones/salientes", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!["admin", "recepcionista", "medico"].includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }
  const query = ListNotificacionesSalientesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const condiciones = [];
  if (query.data.patientId) condiciones.push(eq(notificacionesSalientesTable.patientId, query.data.patientId));
  if (query.data.solicitudId) condiciones.push(eq(notificacionesSalientesTable.solicitudId, query.data.solicitudId));
  if (query.data.loteId) condiciones.push(eq(notificacionesSalientesTable.loteId, query.data.loteId));
  if (query.data.evento) condiciones.push(eq(notificacionesSalientesTable.evento, query.data.evento));
  // El médico solo ve notificaciones vinculadas a sus propias solicitudes
  if (user.rol === "medico") {
    if (!user.profesionalId) {
      res.status(403).json({ error: "Usuario médico sin profesional asociado" });
      return;
    }
    condiciones.push(eq(solicitudesTable.professionalId, user.profesionalId));
  }
  const rows = await db
    .select({
      n: notificacionesSalientesTable,
      pacienteNombre: sql<string | null>`${pacientesTable.apellido} || ', ' || ${pacientesTable.nombre}`,
    })
    .from(notificacionesSalientesTable)
    .leftJoin(pacientesTable, eq(notificacionesSalientesTable.patientId, pacientesTable.id))
    .leftJoin(solicitudesTable, eq(notificacionesSalientesTable.solicitudId, solicitudesTable.id))
    .where(condiciones.length ? and(...condiciones) : undefined)
    .orderBy(desc(notificacionesSalientesTable.createdAt))
    .limit(200);
  res.json(rows.map((r) => ({ ...r.n, pacienteNombre: r.pacienteNombre })));
});

export default router;
