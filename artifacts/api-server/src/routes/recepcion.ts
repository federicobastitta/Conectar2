import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import {
  db,
  studyOrdersTable,
  turnosTable,
  pacientesTable,
  turnerasTable,
  sedesTable,
  especialidadesTable,
  profesionalesTable,
  usersTable,
  auditLogTable,
  documentacionRecepcionTable,
  consultasTokenTable,
  bloqueosTable,
  indicacionesPacientesTable,
  TIPOS_DOCUMENTACION,
  type DocumentacionRecepcion,
} from "@workspace/db";
import { UpsertDocumentacionRecepcionBody, SetRecepcionAvisoBody, ConfirmarAvisoMedicoBody, AsignarTurnoOrdenEstudioBody } from "@workspace/api-zod";
import { getUserFromRequest } from "./auth";
import { cargarFuente } from "../pdf/fuente_documento";
import { generarPdfDocumento } from "../pdf/documento_pdf";
import { prepararDatosPdf } from "../pdf/escaneado";
import { hoyArgentina } from "../lib/tiempo";
import { configSistemaTable } from "@workspace/db";
import { generarSecretoTotp, otpauthUrl } from "../lib/totp";
import { resolverSectorServicio, esSectorConsultorio } from "../integraciones/klinicos-cola";
import { turneraIdsDelProfesional, turneraIdsGuardia, profesionalIdDe, ocultarTurnoAjeno } from "../lib/alcance-medico";
import { practicasDeTurno } from "../lib/turno-practicas";
import { klinicosPracticas as klinicosPracticasTable } from "@workspace/db";

const router: IRouter = Router();

type RecepcionUser = typeof usersTable.$inferSelect;

const ROLES_RECEPCION = ["admin", "recepcionista"];

// Tipos críticos: sin ellos el semáforo es rojo
const TIPOS_CRITICOS = ["orden_medica"];

// El semáforo documental considera solo la orden médica (jul 2026):
// DNI, credencial y autorización ya no se piden en recepción.
const TIPOS_SEMAFORO = ["orden_medica"] as const;

// Tipos que se pueden subir por recepción: los del semáforo + informe
// (el informe no participa del semáforo documental)
const TIPOS_SUBIBLES = [...TIPOS_DOCUMENTACION, "informe"] as const;

const MAX_ARCHIVO_BASE64 = 7 * 1024 * 1024; // ~5MB de archivo real

const hoy = hoyArgentina;

function calcularEdad(fechaNacimiento: string | null): number | null {
  if (!fechaNacimiento) return null;
  const nac = new Date(`${fechaNacimiento}T00:00:00.000Z`);
  if (Number.isNaN(nac.getTime())) return null;
  const ahora = new Date();
  let edad = ahora.getUTCFullYear() - nac.getUTCFullYear();
  const m = ahora.getUTCMonth() - nac.getUTCMonth();
  if (m < 0 || (m === 0 && ahora.getUTCDate() < nac.getUTCDate())) edad--;
  return edad >= 0 && edad < 130 ? edad : null;
}

type Semaforo = { color: "verde" | "amarillo" | "rojo"; faltantes: string[] };

function calcularSemaforo(docs: DocumentacionRecepcion[]): Semaforo {
  const porTipo = new Map(docs.map((d) => [d.tipo, d]));
  const faltantes: string[] = [];
  let rojo = false;
  let amarillo = false;
  for (const tipo of TIPOS_SEMAFORO) {
    const doc = porTipo.get(tipo);
    const estado = doc?.estado ?? "pendiente";
    // Los tipos críticos (orden_medica) SOLO se satisfacen con "validada";
    // "no_aplica" no alcanza para salir del rojo.
    const completo = TIPOS_CRITICOS.includes(tipo)
      ? estado === "validada"
      : estado === "validada" || estado === "no_aplica";
    if (completo) continue;
    faltantes.push(tipo);
    if (TIPOS_CRITICOS.includes(tipo)) rojo = true;
    else amarillo = true;
  }
  return { color: rojo ? "rojo" : amarillo ? "amarillo" : "verde", faltantes };
}

function docPublico(d: DocumentacionRecepcion) {
  return {
    id: d.id,
    pacienteId: d.pacienteId,
    turnoId: d.turnoId,
    tipo: d.tipo,
    estado: d.estado,
    tieneArchivo: Boolean(d.archivoData),
    archivoNombre: d.archivoNombre,
    archivoMime: d.archivoMime,
    observaciones: d.observaciones,
    validadoPor: d.validadoPor,
    updatedAt: d.updatedAt ? d.updatedAt.toISOString() : null,
  };
}

async function getStaff(req: Request, res: Response): Promise<RecepcionUser | null> {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  if (!ROLES_RECEPCION.includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos de recepción" });
    return null;
  }
  return user;
}

// Los médicos también publican avisos al staff (botón "Avisar a recepción"),
// así que las rutas de avisos propios aceptan staff + médico.
async function getStaffOMedico(req: Request, res: Response): Promise<RecepcionUser | null> {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  if (!ROLES_RECEPCION.includes(user.rol) && user.rol !== "medico") {
    res.status(403).json({ error: "Sin permisos" });
    return null;
  }
  return user;
}

// ── Avisos del puesto ─────────────────────────────────────────────────────
// Botón de avisos de recepción: descanso, asistencia, mucha gente, reemplazo
// temporal o un mensaje de texto libre. Cada inicio/fin queda registrado en la
// auditoría (audit_log) y el estado actual se deriva del último evento del
// usuario por tipo, así sobrevive a recargas de página y reinicios.
const TIPOS_AVISO = ["descanso", "asistencia", "mucha_gente", "reemplazo", "mensaje", "seguridad"] as const;
type TipoAviso = (typeof TIPOS_AVISO)[number];

const ACCIONES_AVISO = TIPOS_AVISO.flatMap((t) => [`${t}_inicio`, `${t}_fin`]);

// El tipo puede tener guiones bajos (mucha_gente), por eso se saca el sufijo.
function tipoDeAccion(accion: string): TipoAviso {
  return accion.replace(/_(inicio|fin)$/, "") as TipoAviso;
}

type AvisoActivo = {
  usuarioId: number;
  nombre: string;
  desde: string;
  tipo: TipoAviso;
  mensaje: string | null;
  rol: string;
};

// Último evento por usuario+tipo; los que terminan en _inicio siguen activos.
async function avisosActivos(usuarioId?: number): Promise<AvisoActivo[]> {
  const filtroUsuario = usuarioId ? sql` AND a.usuario_id = ${usuarioId}` : sql``;
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (a.usuario_id, regexp_replace(a.accion, '_(inicio|fin)$', ''))
      a.usuario_id AS "usuarioId",
      u.nombre AS "nombre",
      u.rol AS "rol",
      a.accion AS "accion",
      a.created_at AS "desde",
      a.detalle->>'mensaje' AS "mensaje"
    FROM audit_log a
    JOIN users u ON u.id = a.usuario_id
    WHERE a.accion IN (${sql.join(ACCIONES_AVISO.map((a) => sql`${a}`), sql`, `)})${filtroUsuario}
    ORDER BY a.usuario_id, regexp_replace(a.accion, '_(inicio|fin)$', ''), a.created_at DESC, a.id DESC
  `);
  // Los carteles duran 1 minuto para todos los perfiles: pasado ese tiempo el
  // aviso deja de mostrarse solo (queda igual registrado en la auditoría).
  const limite = Date.now() - 60_000;
  return (rows.rows as Array<{ usuarioId: number; nombre: string; rol: string; accion: string; desde: Date; mensaje: string | null }>)
    .filter((r) => r.accion.endsWith("_inicio"))
    .filter((r) => new Date(r.desde).getTime() >= limite)
    .map((r) => ({
      usuarioId: r.usuarioId,
      nombre: r.nombre,
      rol: r.rol,
      desde: new Date(r.desde).toISOString(),
      tipo: tipoDeAccion(r.accion),
      mensaje: r.mensaje ?? null,
    }));
}

router.get("/recepcion/avisos-mios", async (req: Request, res: Response): Promise<void> => {
  const user = await getStaffOMedico(req, res);
  if (!user) return;
  res.json(await avisosActivos(user.id));
});

router.post("/recepcion/aviso", async (req: Request, res: Response): Promise<void> => {
  const user = await getStaffOMedico(req, res);
  if (!user) return;
  const parsed = SetRecepcionAvisoBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { tipo, accion } = parsed.data;
  // El médico solo publica los tipos que expone su UI: mensaje y seguridad.
  if (user.rol === "medico" && tipo !== "mensaje" && tipo !== "seguridad") {
    res.status(403).json({ error: "Tipo de aviso no permitido para médicos" });
    return;
  }
  const mensaje = parsed.data.mensaje?.trim() || null;
  const quiereIniciar = accion === "inicio";
  if (tipo === "mensaje" && quiereIniciar && !mensaje) {
    res.status(400).json({ error: "Escribí el texto del aviso" });
    return;
  }

  const activos = await avisosActivos(user.id);
  const yaActivo = activos.some((a) => a.tipo === tipo);
  // El aviso libre se puede volver a mandar con otro texto sin cancelarlo antes.
  if (yaActivo === quiereIniciar && !(tipo === "mensaje" && quiereIniciar)) {
    res.status(409).json({ error: quiereIniciar ? "Ese aviso ya está activo" : "Ese aviso no estaba activo" });
    return;
  }

  await db.insert(auditLogTable).values({
    usuarioId: user.id,
    usuarioEmail: user.email,
    rol: user.rol,
    accion: `${tipo}_${quiereIniciar ? "inicio" : "fin"}`,
    entidad: "usuario",
    entidadId: user.id,
    detalle: { origen: "boton_descanso_recepcion", ...(mensaje ? { mensaje } : {}) },
  });
  req.log.info({ userId: user.id, tipo, accion }, "aviso de puesto registrado");
  const ahora = (await avisosActivos(user.id)).find((a) => a.tipo === tipo);
  res.json({ enDescanso: !!ahora, desde: ahora?.desde ?? null, mensaje: ahora?.mensaje ?? null });
});

// ── POST /recepcion/aviso-confirmar ───────────────────────────────────────
// Recepción/administración da por recibido el aviso de un médico: registra el
// "fin" en nombre del emisor y el aviso sale del banner de todos. Queda en la
// auditoría quién lo confirmó.
router.post("/recepcion/aviso-confirmar", async (req: Request, res: Response): Promise<void> => {
  const user = await getStaff(req, res);
  if (!user) return;
  const parsed = ConfirmarAvisoMedicoBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Datos inválidos" }); return; }
  const { usuarioId, tipo } = parsed.data;

  const activos = await avisosActivos(usuarioId);
  const aviso = activos.find((a) => a.tipo === tipo);
  if (!aviso) {
    res.status(404).json({ error: "Ese aviso no está activo" });
    return;
  }
  // Solo los avisos de médicos se confirman desde recepción; los del propio
  // staff los quita cada uno desde su botón.
  if (aviso.rol !== "medico") {
    res.status(403).json({ error: "Solo se pueden confirmar avisos de médicos" });
    return;
  }
  const [emisor] = await db.select().from(usersTable).where(eq(usersTable.id, usuarioId)).limit(1);
  if (!emisor) { res.status(404).json({ error: "Ese aviso no está activo" }); return; }

  await db.insert(auditLogTable).values({
    usuarioId: emisor.id,
    usuarioEmail: emisor.email,
    rol: emisor.rol,
    accion: `${tipo}_fin`,
    entidad: "usuario",
    entidadId: emisor.id,
    detalle: { origen: "confirmacion_recepcion", confirmadoPorUsuarioId: user.id, confirmadoPorNombre: user.nombre },
  });
  req.log.info({ usuarioId, tipo, confirmadoPor: user.id }, "aviso confirmado por recepción");
  res.json({ ok: true });
});

// ── GET /recepcion/descansos-activos ──────────────────────────────────────
// Avisos activos de todo el staff para el banner en pantalla.
router.get("/recepcion/descansos-activos", async (req: Request, res: Response): Promise<void> => {
  const user = await getStaff(req, res);
  if (!user) return;
  res.json(await avisosActivos());
});

// ── GET /recepcion/qr/:codigo ─────────────────────────────────────────────
// Escaneo del QR del turno en recepción: devuelve el turno y el paciente
// para abrir directo la ficha y cargar el token.
router.get("/recepcion/qr/:codigo", async (req: Request, res: Response): Promise<void> => {
  const user = await getStaff(req, res);
  if (!user) return;

  const codigo = String(req.params["codigo"] ?? "").trim().toUpperCase();
  if (!codigo || codigo.length > 64) {
    res.status(404).json({ error: "Código QR no encontrado" });
    return;
  }

  const [fila] = await db
    .select({ turno: turnosTable, paciente: pacientesTable, turnera: turnerasTable })
    .from(turnosTable)
    .leftJoin(pacientesTable, eq(pacientesTable.id, turnosTable.pacienteId))
    .leftJoin(turnerasTable, eq(turnerasTable.id, turnosTable.turneraId))
    .where(eq(turnosTable.qrCodigo, codigo))
    .limit(1);

  if (!fila) {
    res.status(404).json({ error: "Código QR no encontrado" });
    return;
  }

  res.json({
    turnoId: fila.turno.id,
    fecha: fila.turno.fecha,
    horaInicio: fila.turno.horaInicio,
    estado: fila.turno.estado,
    pacienteId: fila.turno.pacienteId,
    pacienteNombre: fila.paciente?.nombre ?? "",
    pacienteApellido: fila.paciente?.apellido ?? "",
    pacienteDni: fila.paciente?.dni ?? null,
    cobertura: fila.turno.cobertura ?? fila.paciente?.cobertura ?? null,
    turneraNombre: fila.turnera?.nombre ?? null,
    esHoy: fila.turno.fecha === hoy(),
  });
});

// ── GET /recepcion/turnos-dia ─────────────────────────────────────────────
router.get("/recepcion/turnos-dia", async (req: Request, res: Response): Promise<void> => {
  // Staff ve todo; un médico también puede consultar, pero solo sus turnos.
  const user = await getStaffOMedico(req, res);
  if (!user) return;

  const fechaParam = typeof req.query["fecha"] === "string" ? req.query["fecha"] : null;
  if (fechaParam && !/^\d{4}-\d{2}-\d{2}$/.test(fechaParam)) {
    res.status(400).json({ error: "Fecha inválida (formato YYYY-MM-DD)" });
    return;
  }
  const fecha = fechaParam ?? hoy();

  let filas = await db
    .select({
      turno: turnosTable,
      paciente: pacientesTable,
      turnera: turnerasTable,
      especialidad: especialidadesTable,
      profesional: profesionalesTable,
      tokenStatus: consultasTokenTable.tokenStatus,
      robotSyncStatus: consultasTokenTable.robotSyncStatus,
      nroBono: consultasTokenTable.authorizationNumber,
    })
    .from(turnosTable)
    .innerJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .leftJoin(profesionalesTable, eq(turnosTable.profesionalId, profesionalesTable.id))
    .leftJoin(consultasTokenTable, eq(consultasTokenTable.consultationId, turnosTable.id))
    .where(eq(turnosTable.fecha, fecha))
    .orderBy(turnosTable.horaInicio);

  // Un médico ve los turnos de sus propias turneras, de las grupales en las
  // que participa y de la bolsa de guardia (demanda espontánea, sin médico
  // asignado); nunca los de otros profesionales.
  if (user.rol === "medico") {
    const pid = profesionalIdDe(user);
    const [propias, guardias] = await Promise.all([
      pid != null ? turneraIdsDelProfesional(pid) : Promise.resolve([]),
      turneraIdsGuardia(),
    ]);
    const permitidas = new Set([...propias, ...guardias]);
    filas = filas.filter((f) => permitidas.has(f.turnera.id) || (pid != null && f.turno.profesionalId === pid));

    // En turneras grupales/guardia los que esperan son bolsa compartida, pero
    // los EN CONSULTA (llamados por otro médico) y los YA ATENDIDOS por otro
    // se ocultan (atribuidos por quién llamó al paciente o por el profesional
    // asignado al turno). Si no hay atribución (p. ej. recepción lo marcó
    // atendido a mano), se deja visible.
    filas = filas.filter((f) => !ocultarTurnoAjeno(f.turno, pid));
  }

  const pacienteIds = [...new Set(filas.map((f) => f.paciente.id))];
  const docs = pacienteIds.length
    ? await db
        .select()
        .from(documentacionRecepcionTable)
        .where(inArray(documentacionRecepcionTable.pacienteId, pacienteIds))
    : [];
  const docsPorPaciente = new Map<number, DocumentacionRecepcion[]>();
  for (const d of docs) {
    const arr = docsPorPaciente.get(d.pacienteId) ?? [];
    arr.push(d);
    docsPorPaciente.set(d.pacienteId, arr);
  }

  // Últimas indicaciones (plan de atención) por paciente: pastilla visible
  // para todo el staff una vez que el médico las emitió al cerrar la consulta.
  const indicacionesPorPaciente = new Map<
    number,
    { id: number; estudios: string | null; medicamentos: string | null; otrasIndicaciones: string | null; profesionalNombre: string | null; createdAt: Date }
  >();
  if (pacienteIds.length) {
    const inds = await db
      .select({
        id: indicacionesPacientesTable.id,
        patientId: indicacionesPacientesTable.patientId,
        estudios: indicacionesPacientesTable.estudios,
        medicamentos: indicacionesPacientesTable.medicamentos,
        otrasIndicaciones: indicacionesPacientesTable.otrasIndicaciones,
        createdAt: indicacionesPacientesTable.createdAt,
        profApellido: profesionalesTable.apellido,
        profNombre: profesionalesTable.nombre,
      })
      .from(indicacionesPacientesTable)
      .leftJoin(profesionalesTable, eq(indicacionesPacientesTable.professionalId, profesionalesTable.id))
      .where(inArray(indicacionesPacientesTable.patientId, pacienteIds))
      .orderBy(desc(indicacionesPacientesTable.createdAt));
    for (const ind of inds) {
      if (!indicacionesPorPaciente.has(ind.patientId)) {
        indicacionesPorPaciente.set(ind.patientId, {
          id: ind.id,
          estudios: ind.estudios,
          medicamentos: ind.medicamentos,
          otrasIndicaciones: ind.otrasIndicaciones,
          profesionalNombre: ind.profApellido || ind.profNombre ? [ind.profApellido, ind.profNombre].filter(Boolean).join(", ") : null,
          createdAt: ind.createdAt,
        });
      }
    }
  }

  // Sector por turnera: klinicosSector explícito o regla por especialidad
  // (memoizado por especialidad para no repetir consultas)
  const sectorCache = new Map<string, string>();
  const sectorDe = async (f: (typeof filas)[number]): Promise<string> => {
    if (f.turnera.klinicosSector) return f.turnera.klinicosSector;
    const clave = f.especialidad?.nombre ?? f.turnera.nombre;
    const cached = sectorCache.get(clave);
    if (cached) return cached;
    const sector = await resolverSectorServicio(clave);
    sectorCache.set(clave, sector);
    return sector;
  };
  const sectores = await Promise.all(filas.map(sectorDe));

  // Nombre del profesional que llamó al paciente: en guardia el turno no tiene
  // profesional asignado, así que la vista necesita saber QUIÉN lo está
  // atendiendo (pastilla "médicos atendiendo" y detalle de la fila).
  const llamadoPorIds = [...new Set(filas.map((f) => f.turno.llamadoPorProfesionalId).filter((v): v is number => v != null))];
  const llamadoPorNombres = new Map<number, string>();
  if (llamadoPorIds.length) {
    const profs = await db
      .select({ id: profesionalesTable.id, nombre: profesionalesTable.nombre, apellido: profesionalesTable.apellido })
      .from(profesionalesTable)
      .where(inArray(profesionalesTable.id, llamadoPorIds));
    for (const p of profs) llamadoPorNombres.set(p.id, [p.apellido, p.nombre].filter(Boolean).join(", "));
  }

  res.json(
    filas.map((f, i) => ({
      turnoId: f.turno.id,
      horaInicio: f.turno.horaInicio,
      horaFin: f.turno.horaFin,
      estado: f.turno.estado,
      pacienteId: f.paciente.id,
      pacienteNombre: f.paciente.nombre,
      pacienteApellido: f.paciente.apellido,
      pacienteDni: f.paciente.dni,
      pacienteTelefono: f.paciente.telefono,
      numeroHc: f.paciente.numeroHc,
      cobertura: f.turno.cobertura ?? f.paciente.cobertura,
      turneraNombre: f.turnera.nombre,
      especialidad: f.especialidad?.nombre ?? null,
      profesionalNombre: f.profesional
        ? [f.profesional.apellido, f.profesional.nombre].filter(Boolean).join(", ")
        : null,
      modalidad: f.turno.modalidad,
      sobreturno: f.turno.sobreturno,
      marcaColor: f.turno.marcaColor ?? null,
      admitidoPor: f.turno.admitidoPor ?? null,
      observaciones: f.turno.observaciones ?? null,
      llamadoPorProfesionalId: f.turno.llamadoPorProfesionalId ?? null,
      llamadoPorNombre:
        f.turno.llamadoPorProfesionalId != null
          ? llamadoPorNombres.get(f.turno.llamadoPorProfesionalId) ?? null
          : null,
      semaforo: calcularSemaforo(docsPorPaciente.get(f.paciente.id) ?? []),
      tokenStatus: f.tokenStatus ?? null,
      robotSyncStatus: f.robotSyncStatus ?? null,
      nroBono: f.nroBono ?? null,
      esConsulta: esSectorConsultorio(sectores[i]),
      token: f.turno.klinicosToken ?? null,
      ordenMedicaEstado:
        (docsPorPaciente.get(f.paciente.id) ?? []).find((d) => d.tipo === "orden_medica")?.estado ?? null,
      ordenMedicaArchivo: Boolean(
        (docsPorPaciente.get(f.paciente.id) ?? []).find((d) => d.tipo === "orden_medica")?.archivoData,
      ),
      informeEstado:
        (docsPorPaciente.get(f.paciente.id) ?? []).find(
          (d) => d.tipo === "informe" && d.turnoId === f.turno.id,
        )?.estado ?? null,
      informeArchivo: Boolean(
        (docsPorPaciente.get(f.paciente.id) ?? []).find(
          (d) => d.tipo === "informe" && d.turnoId === f.turno.id,
        )?.archivoData,
      ),
      indicaciones: indicacionesPorPaciente.get(f.paciente.id) ?? null,
      // Check in previo desde la app (guardia presencial, aún sin llegar):
      // la UI lo muestra con la pastilla "Check in".
      checkInPrevio:
        f.turno.estado === "confirmado" && f.turnera.esGuardia && f.turno.modalidad === "presencial",
    })),
  );
});

// ── GET /recepcion/turnos/:id/ficha ───────────────────────────────────────
router.get("/recepcion/turnos/:id/ficha", async (req: Request, res: Response): Promise<void> => {
  const user = await getStaff(req, res);
  if (!user) return;

  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const [fila] = await db
    .select({
      turno: turnosTable,
      paciente: pacientesTable,
      turnera: turnerasTable,
      especialidad: especialidadesTable,
      profesional: profesionalesTable,
      sede: sedesTable,
      nroBono: consultasTokenTable.authorizationNumber,
    })
    .from(turnosTable)
    .innerJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .leftJoin(profesionalesTable, eq(turnosTable.profesionalId, profesionalesTable.id))
    .leftJoin(sedesTable, eq(turnerasTable.sedeId, sedesTable.id))
    .leftJoin(consultasTokenTable, eq(consultasTokenTable.consultationId, turnosTable.id))
    .where(eq(turnosTable.id, id));

  if (!fila) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }

  const docs = await db
    .select()
    .from(documentacionRecepcionTable)
    .where(eq(documentacionRecepcionTable.pacienteId, fila.paciente.id));

  // Todos los estudios del turno (turno_practicas); si el turno es viejo y
  // solo tiene la práctica singular legada, se devuelve esa como conjunto.
  let practicasTurno = await practicasDeTurno(id);
  if (practicasTurno.length === 0 && fila.turno.klinicosPracticaId != null) {
    const [p] = await db
      .select({
        id: klinicosPracticasTable.id,
        nombre: klinicosPracticasTable.nombre,
        codigos: klinicosPracticasTable.codigos,
      })
      .from(klinicosPracticasTable)
      .where(eq(klinicosPracticasTable.id, fila.turno.klinicosPracticaId));
    if (p) practicasTurno = [{ id: p.id, nombre: p.nombre, codigos: p.codigos ?? [] }];
  }

  res.json({
    turno: { ...fila.turno, practicas: practicasTurno },
    paciente: fila.paciente,
    edad: calcularEdad(fila.paciente.fechaNacimiento),
    turneraNombre: fila.turnera.nombre,
    especialidad: fila.especialidad?.nombre ?? null,
    profesionalNombre: fila.profesional
      ? [fila.profesional.apellido, fila.profesional.nombre].filter(Boolean).join(", ")
      : null,
    sedeNombre: fila.sede?.nombre ?? null,
    nroBono: fila.nroBono ?? null,
    documentacion: docs.map(docPublico),
    semaforo: calcularSemaforo(docs),
    // Check in previo desde la app (guardia presencial, aún sin llegar).
    checkInPrevio:
      fila.turno.estado === "confirmado" &&
      fila.turnera.esGuardia &&
      fila.turno.modalidad === "presencial",
  });
});

// ── GET /recepcion/pacientes/:id/documentacion ────────────────────────────
router.get("/recepcion/pacientes/:id/documentacion", async (req: Request, res: Response): Promise<void> => {
  const user = await getStaff(req, res);
  if (!user) return;

  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const docs = await db
    .select()
    .from(documentacionRecepcionTable)
    .where(eq(documentacionRecepcionTable.pacienteId, id));

  res.json(docs.map(docPublico));
});

// ── PUT /recepcion/pacientes/:id/documentacion/:tipo ──────────────────────
router.put(
  "/recepcion/pacientes/:id/documentacion/:tipo",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getStaff(req, res);
    if (!user) return;

    const pacienteId = Number(req.params["id"]);
    const tipo = String(req.params["tipo"]);
    if (!Number.isInteger(pacienteId) || pacienteId <= 0) {
      res.status(400).json({ error: "ID inválido" });
      return;
    }
    if (!(TIPOS_SUBIBLES as readonly string[]).includes(tipo)) {
      res.status(400).json({ error: "Tipo de documentación inválido" });
      return;
    }

    const parsed = UpsertDocumentacionRecepcionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const body = parsed.data;

    // El informe es por turno: exige turnoId (los demás tipos son del paciente)
    if (tipo === "informe" && body.turnoId == null) {
      res.status(400).json({ error: "El informe requiere turnoId (es un adjunto del turno)" });
      return;
    }

    if (body.estado === "no_aplica" && TIPOS_CRITICOS.includes(tipo)) {
      res.status(400).json({
        error: "La documentación crítica (DNI, orden médica) no puede marcarse como 'no aplica'",
      });
      return;
    }

    if (body.archivoData) {
      if (body.archivoData.length > MAX_ARCHIVO_BASE64) {
        res.status(400).json({ error: "El archivo supera el tamaño máximo (5MB)" });
        return;
      }
      if (body.archivoData.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.archivoData)) {
        res.status(400).json({ error: "El archivo debe estar codificado en base64 válido" });
        return;
      }
    }

    const [paciente] = await db
      .select({ id: pacientesTable.id })
      .from(pacientesTable)
      .where(eq(pacientesTable.id, pacienteId));
    if (!paciente) {
      res.status(404).json({ error: "Paciente no encontrado" });
      return;
    }

    const valores = {
      estado: body.estado,
      turnoId: body.turnoId ?? null,
      observaciones: body.observaciones ?? null,
      validadoPor: user.email,
      updatedAt: new Date(),
      ...(body.archivoData
        ? {
            archivoNombre: body.archivoNombre ?? "archivo",
            archivoMime: body.archivoMime ?? "application/octet-stream",
            archivoData: body.archivoData,
          }
        : {}),
    };

    // Upsert + auditoría en una transacción: sin registro de auditoría no hay cambio.
    const doc = await db.transaction(async (tx) => {
      let d: DocumentacionRecepcion;
      if (tipo === "informe") {
        // Informe: un registro por paciente+turno (no se pisa entre turnos)
        const [existente] = await tx
          .select({ id: documentacionRecepcionTable.id })
          .from(documentacionRecepcionTable)
          .where(
            and(
              eq(documentacionRecepcionTable.pacienteId, pacienteId),
              eq(documentacionRecepcionTable.tipo, "informe"),
              eq(documentacionRecepcionTable.turnoId, body.turnoId as number),
            ),
          )
          .limit(1);
        if (existente) {
          [d] = await tx
            .update(documentacionRecepcionTable)
            .set(valores)
            .where(eq(documentacionRecepcionTable.id, existente.id))
            .returning();
        } else {
          [d] = await tx
            .insert(documentacionRecepcionTable)
            .values({ pacienteId, tipo, ...valores })
            .returning();
        }
      } else {
        [d] = await tx
          .insert(documentacionRecepcionTable)
          .values({ pacienteId, tipo, ...valores })
          .onConflictDoUpdate({
            target: [documentacionRecepcionTable.pacienteId, documentacionRecepcionTable.tipo],
            targetWhere: sql`tipo <> 'informe'`,
            set: valores,
          })
          .returning();
      }

      await tx.insert(auditLogTable).values({
        usuarioId: user.id,
        usuarioEmail: user.email,
        rol: user.rol,
        accion: "documentacion_recepcion",
        entidad: "documentacion_recepcion",
        entidadId: d.id,
        pacienteId,
        detalle: {
          tipo,
          estado: body.estado,
          turnoId: body.turnoId ?? null,
          conArchivo: Boolean(body.archivoData),
          observaciones: body.observaciones ?? null,
        },
      });

      return d;
    });

    req.log.info(
      { pacienteId, tipo, estado: body.estado, conArchivo: Boolean(body.archivoData), usuario: user.email },
      "recepcion: documentación actualizada",
    );

    res.json(docPublico(doc));
  },
);

// ── GET /recepcion/documentacion/:docId/archivo ───────────────────────────
router.get("/recepcion/documentacion/:docId/archivo", async (req: Request, res: Response): Promise<void> => {
  const user = await getStaff(req, res);
  if (!user) return;

  const docId = Number(req.params["docId"]);
  if (!Number.isInteger(docId) || docId <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const [doc] = await db
    .select()
    .from(documentacionRecepcionTable)
    .where(eq(documentacionRecepcionTable.id, docId));

  if (!doc || !doc.archivoData) {
    res.status(404).json({ error: "Archivo no encontrado" });
    return;
  }

  const buffer = Buffer.from(doc.archivoData, "base64");
  res.setHeader("Content-Type", doc.archivoMime ?? "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${(doc.archivoNombre ?? "archivo").replace(/[^\w.\-]/g, "_")}"`,
  );
  res.send(buffer);
});

// ── Órdenes de estudio: búsqueda por DNI y asignación de turno ────────────

// Estados en los que una orden está "pendiente" desde recepción
const ESTADOS_ORDEN_PENDIENTES = ["solicitado", "pendiente_programacion", "programado"];

function serializarOrdenRecepcion(
  o: typeof studyOrdersTable.$inferSelect,
  derivante: string | null,
  turno: { fecha: string; horaInicio: string } | null,
) {
  return {
    id: o.id,
    studyName: o.studyName,
    studyType: o.studyType,
    status: o.status,
    priority: o.priority,
    contraste: o.contraste,
    billingCodes: o.billingCodes,
    clinicalJustification: o.clinicalJustification,
    preparationRequired: o.preparationRequired,
    derivante,
    turnoId: o.turnoId,
    turnoFecha: turno?.fecha ?? null,
    turnoHora: turno?.horaInicio ?? null,
    createdAt: o.createdAt.toISOString(),
  };
}

async function nombreDerivante(professionalId: number): Promise<string | null> {
  const [p] = await db
    .select({ nombre: profesionalesTable.nombre, apellido: profesionalesTable.apellido, matricula: profesionalesTable.matricula })
    .from(profesionalesTable)
    .where(eq(profesionalesTable.id, professionalId))
    .limit(1);
  return p ? `${p.apellido}, ${p.nombre}${p.matricula ? ` · MP ${p.matricula}` : ""}` : null;
}

// ── GET /recepcion/ocupacion-mes ──────────────────────────────────────────
// Ocupación diaria de un mes para pintar el calendario de "Agenda por médico":
// capacidad = slots teóricos por día según los parámetros de cada turnera,
// ocupados = turnos no cancelados/ausentes de esas turneras en cada fecha.
router.get("/recepcion/ocupacion-mes", async (req: Request, res: Response): Promise<void> => {
  const user = await getStaffOMedico(req, res);
  if (!user) return;

  const mes = typeof req.query["mes"] === "string" ? req.query["mes"] : null;
  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
    res.status(400).json({ error: "Mes inválido (formato YYYY-MM)" });
    return;
  }
  const idsParam = typeof req.query["turneraIds"] === "string" ? req.query["turneraIds"] : null;
  const ids = idsParam
    ? [...new Set(idsParam.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))]
    : null;
  if (idsParam && (!ids || ids.length === 0)) {
    res.status(400).json({ error: "turneraIds inválido" });
    return;
  }

  // Un médico solo puede consultar la ocupación de sus propias turneras.
  const esMedico = user.rol === "medico";
  if (esMedico && user.profesionalId == null) {
    res.status(403).json({ error: "Sin profesional asociado" });
    return;
  }
  const condiciones = [];
  if (ids) condiciones.push(inArray(turnerasTable.id, ids));
  else if (!esMedico) condiciones.push(eq(turnerasTable.activa, true));
  if (esMedico) {
    // Turneras propias + grupales en las que participa + guardias (bolsa compartida).
    const [propias, guardias] = await Promise.all([
      turneraIdsDelProfesional(Number(user.profesionalId)),
      turneraIdsGuardia(),
    ]);
    const permitidas = [...new Set([...propias, ...guardias])];
    if (permitidas.length === 0) {
      res.json([]);
      return;
    }
    condiciones.push(inArray(turnerasTable.id, permitidas));
  }

  const turneras = await db
    .select()
    .from(turnerasTable)
    .where(and(...condiciones));
  if (esMedico && ids && turneras.length !== ids.length) {
    res.status(403).json({ error: "Turneras fuera de su alcance" });
    return;
  }
  if (turneras.length === 0) {
    res.json([]);
    return;
  }

  // Capacidad de slots por día de semana de cada turnera (sin ir a la DB).
  const slotsPorDia = (t: (typeof turneras)[number], diaSemana: number): number => {
    const dias = t.diasAtencion ? t.diasAtencion.split(",").map(Number) : [];
    if (!dias.includes(diaSemana)) return 0;
    const h = t.horariosDia?.find((x) => x.dia === diaSemana);
    const [hIni, mIni] = (h?.horaInicio ?? t.horaInicio).split(":").map(Number);
    const [hFin, mFin] = (h?.horaFin ?? t.horaFin).split(":").map(Number);
    const rango = hFin * 60 + mFin - (hIni * 60 + mIni);
    return t.duracionMinutos > 0 ? Math.max(0, Math.floor(rango / t.duracionMinutos)) : 0;
  };

  const [anio, mesNum] = mes.split("-").map(Number);
  const diasDelMes = new Date(Date.UTC(anio, mesNum, 0)).getUTCDate();
  const desde = `${mes}-01`;
  const hasta = `${mes}-${String(diasDelMes).padStart(2, "0")}`;

  const turneraIds = turneras.map((t) => t.id);

  // Bloqueos (agenda cancelada) que tocan el mes: un día queda "cancelado"
  // si todas las turneras del filtro que atendían ese día están bloqueadas.
  const bloqueos = await db
    .select()
    .from(bloqueosTable)
    .where(and(
      inArray(bloqueosTable.turneraId, turneraIds),
      sql`${bloqueosTable.fechaDesde} <= ${`${hasta}T23:59:59.999Z`}`,
      sql`${bloqueosTable.fechaHasta} >= ${`${desde}T00:00:00.000Z`}`,
    ));
  const estaBloqueada = (turneraId: number, fecha: string): boolean => {
    const dia = new Date(`${fecha}T12:00:00.000Z`);
    return bloqueos.some((b) => b.turneraId === turneraId && b.fechaDesde <= dia && b.fechaHasta >= dia);
  };

  const ocupadosFilas = await db
    .select({
      fecha: turnosTable.fecha,
      cantidad: sql<number>`count(*)::int`,
    })
    .from(turnosTable)
    .where(and(
      inArray(turnosTable.turneraId, turneraIds),
      sql`${turnosTable.fecha} between ${desde} and ${hasta}`,
      sql`${turnosTable.estado} not in ('cancelado', 'ausente')`,
    ))
    .groupBy(turnosTable.fecha);
  const ocupadosPorFecha = new Map(ocupadosFilas.map((f) => [f.fecha, f.cantidad]));

  const resultado = [];
  for (let d = 1; d <= diasDelMes; d++) {
    const fecha = `${mes}-${String(d).padStart(2, "0")}`;
    const diaSemana = new Date(`${fecha}T00:00:00.000Z`).getUTCDay();
    let capacidad = 0;
    let conAtencion = 0;
    let bloqueadas = 0;
    for (const t of turneras) {
      const slots = slotsPorDia(t, diaSemana);
      if (slots <= 0) continue;
      conAtencion++;
      if (estaBloqueada(t.id, fecha)) { bloqueadas++; continue; }
      capacidad += slots;
    }
    const cancelado = conAtencion > 0 && bloqueadas === conAtencion;
    resultado.push({ fecha, capacidad, ocupados: ocupadosPorFecha.get(fecha) ?? 0, cancelado });
  }
  res.json(resultado);
});

// GET /recepcion/ordenes-estudio?dni=...
router.get("/recepcion/ordenes-estudio", async (req: Request, res: Response) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!ROLES_RECEPCION.includes(user.rol)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const dni = String(req.query.dni ?? "").trim();
  if (dni.length < 6) { res.status(400).json({ error: "DNI inválido" }); return; }

  const [paciente] = await db
    .select()
    .from(pacientesTable)
    .where(and(eq(pacientesTable.dni, dni), eq(pacientesTable.activo, true)))
    .limit(1);
  if (!paciente) { res.status(404).json({ error: "Paciente no encontrado" }); return; }

  const ordenes = await db
    .select()
    .from(studyOrdersTable)
    .where(and(eq(studyOrdersTable.patientId, paciente.id), inArray(studyOrdersTable.status, ESTADOS_ORDEN_PENDIENTES)))
    .orderBy(desc(studyOrdersTable.createdAt));

  const profIds = [...new Set(ordenes.map((o) => o.professionalId))];
  const profesionales = profIds.length
    ? await db.select().from(profesionalesTable).where(inArray(profesionalesTable.id, profIds))
    : [];
  const profMap = new Map(
    profesionales.map((p) => [
      p.id,
      `${p.apellido}, ${p.nombre}${p.matricula ? ` · MP ${p.matricula}` : ""}`,
    ]),
  );

  const turnoIds = [...new Set(ordenes.map((o) => o.turnoId).filter((t): t is number => t != null))];
  const turnos = turnoIds.length
    ? await db
        .select({ id: turnosTable.id, fecha: turnosTable.fecha, horaInicio: turnosTable.horaInicio })
        .from(turnosTable)
        .where(inArray(turnosTable.id, turnoIds))
    : [];
  const turnoMap = new Map(turnos.map((t) => [t.id, t]));

  res.json({
    paciente: { id: paciente.id, nombre: paciente.nombre, apellido: paciente.apellido, dni: paciente.dni ?? dni },
    ordenes: ordenes.map((o) =>
      serializarOrdenRecepcion(o, profMap.get(o.professionalId) ?? null, o.turnoId != null ? (turnoMap.get(o.turnoId) ?? null) : null),
    ),
  });
});

// GET /recepcion/ordenes-estudio/pendientes — listado global de órdenes
// pendientes generadas por los médicos, para que recepción las vea sin
// necesidad de conocer el DNI del paciente.
router.get("/recepcion/ordenes-estudio/pendientes", async (req: Request, res: Response) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!ROLES_RECEPCION.includes(user.rol)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const ordenes = await db
    .select()
    .from(studyOrdersTable)
    .where(inArray(studyOrdersTable.status, ESTADOS_ORDEN_PENDIENTES))
    .orderBy(desc(studyOrdersTable.createdAt))
    .limit(300);

  const pacIds = [...new Set(ordenes.map((o) => o.patientId))];
  const pacientes = pacIds.length
    ? await db
        .select({ id: pacientesTable.id, nombre: pacientesTable.nombre, apellido: pacientesTable.apellido, dni: pacientesTable.dni })
        .from(pacientesTable)
        .where(inArray(pacientesTable.id, pacIds))
    : [];
  const pacMap = new Map(pacientes.map((p) => [p.id, p]));

  const profIds = [...new Set(ordenes.map((o) => o.professionalId))];
  const profesionales = profIds.length
    ? await db.select().from(profesionalesTable).where(inArray(profesionalesTable.id, profIds))
    : [];
  const profMap = new Map(
    profesionales.map((p) => [p.id, `${p.apellido}, ${p.nombre}${p.matricula ? ` · MP ${p.matricula}` : ""}`]),
  );

  const turnoIds = [...new Set(ordenes.map((o) => o.turnoId).filter((t): t is number => t != null))];
  const turnos = turnoIds.length
    ? await db
        .select({ id: turnosTable.id, fecha: turnosTable.fecha, horaInicio: turnosTable.horaInicio })
        .from(turnosTable)
        .where(inArray(turnosTable.id, turnoIds))
    : [];
  const turnoMap = new Map(turnos.map((t) => [t.id, t]));

  res.json(
    ordenes
      .filter((o) => pacMap.has(o.patientId))
      .map((o) => ({
        ...serializarOrdenRecepcion(o, profMap.get(o.professionalId) ?? null, o.turnoId != null ? (turnoMap.get(o.turnoId) ?? null) : null),
        paciente: pacMap.get(o.patientId)!,
      })),
  );
});

// GET /recepcion/ordenes-estudio/:id/pdf — la orden médica tal como la firmó
// el profesional, para que recepción la vea y cargue el turno a mano por el
// circuito normal de agendas (el flujo de asignar turno desde la orden se
// dio de baja a pedido del usuario).
router.get("/recepcion/ordenes-estudio/:id/pdf", async (req: Request, res: Response): Promise<void> => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!ROLES_RECEPCION.includes(user.rol)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: "Orden no encontrada" }); return; }

  const fuente = await cargarFuente("orden_estudio", id);
  if (!fuente) { res.status(404).json({ error: "Orden no encontrada" }); return; }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, fuente.patientId)).limit(1);
  const [profesional] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, fuente.professionalId)).limit(1);
  if (!paciente || !profesional) { res.status(404).json({ error: "Datos de la orden incompletos" }); return; }

  let especialidad: string | null = null;
  if (profesional.especialidadId != null) {
    const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, profesional.especialidadId)).limit(1);
    especialidad = esp?.nombre ?? null;
  }

  await db.insert(auditLogTable).values({
    usuarioId: user.id,
    usuarioEmail: user.email,
    rol: user.rol,
    accion: "ver_pdf_orden",
    entidad: "orden_estudio",
    entidadId: id,
    detalle: { pacienteId: fuente.patientId },
  });

  const doc = generarPdfDocumento(await prepararDatosPdf({
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
      especialidad,
      telefonoMovil: profesional.telefonoMovil,
      telefono: profesional.telefono,
      firmaImagen: profesional.firmaImagen,
      caligrafia: profesional.caligrafia,
    },
  }));

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="orden_${id}_${paciente.apellido.toLowerCase().replace(/[^\w]/g, "_")}.pdf"`);
  doc.pipe(res);
  doc.end();
});

// PATCH /recepcion/ordenes-estudio/:id/turno — asignar o desvincular turno
router.patch("/recepcion/ordenes-estudio/:id/turno", async (req: Request, res: Response) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!ROLES_RECEPCION.includes(user.rol)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "Orden no encontrada" }); return; }

  const parsed = AsignarTurnoOrdenEstudioBody.safeParse(req.body);
  if (!parsed.success) { res.status(422).json({ error: "Cuerpo inválido" }); return; }
  const turnoId = parsed.data.turnoId ?? null;

  const [orden] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, id)).limit(1);
  if (!orden) { res.status(404).json({ error: "Orden no encontrada" }); return; }
  if (!ESTADOS_ORDEN_PENDIENTES.includes(orden.status)) {
    res.status(422).json({ error: `La orden en estado "${orden.status}" no admite cambios de turno` });
    return;
  }

  let turnoAsignado: { fecha: string; horaInicio: string } | null = null;
  let nuevoEstado: string;
  if (turnoId != null) {
    const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, turnoId)).limit(1);
    if (!turno) { res.status(404).json({ error: "Turno no encontrado" }); return; }
    if (turno.pacienteId !== orden.patientId) {
      res.status(422).json({ error: "El turno pertenece a otro paciente" });
      return;
    }
    if (["cancelado", "ausente", "atendido"].includes(turno.estado)) {
      res.status(422).json({
        error:
          turno.estado === "atendido"
            ? "El turno ya fue atendido, no puede asignarse a una orden"
            : "El turno está cancelado",
      });
      return;
    }
    turnoAsignado = { fecha: turno.fecha, horaInicio: turno.horaInicio };
    nuevoEstado = "programado";
  } else {
    nuevoEstado = "pendiente_programacion";
  }

  const [actualizada] = await db
    .update(studyOrdersTable)
    .set({ turnoId, status: nuevoEstado, statusUpdatedAt: new Date(), updatedAt: new Date() })
    .where(eq(studyOrdersTable.id, id))
    .returning();

  await db.insert(auditLogTable).values({
    usuarioId: user.id,
    usuarioEmail: user.email,
    rol: user.rol,
    accion: turnoId != null ? "asignar_turno" : "desvincular_turno",
    entidad: "orden_estudio",
    entidadId: id,
    detalle: { turnoId, estadoAnterior: orden.status, estadoNuevo: nuevoEstado, pacienteId: orden.patientId },
  });
  req.log.info({ ordenId: id, turnoId, estadoNuevo: nuevoEstado }, "orden de estudio: turno asignado desde recepción");

  res.json(serializarOrdenRecepcion(actualizada, await nombreDerivante(actualizada.professionalId), turnoAsignado));
});

// ── Código de supervisor (TOTP / app authenticator) ─────────────────────
// Autoriza recepcionar un turno de consulta SIN token validado: recepción
// tiene que pedirle el código de 6 dígitos al supervisor. El secreto solo lo
// ve el admin al generarlo (se carga en la app authenticator y no se vuelve
// a mostrar).
export const CLAVE_SUPERVISOR_TOTP = "supervisor_totp_secret";

export async function obtenerSecretoSupervisor(): Promise<string | null> {
  const [row] = await db
    .select({ valor: configSistemaTable.valor })
    .from(configSistemaTable)
    .where(eq(configSistemaTable.clave, CLAVE_SUPERVISOR_TOTP))
    .limit(1);
  return row?.valor ?? null;
}

router.get("/recepcion/supervisor-totp", async (req: Request, res: Response): Promise<void> => {
  const user = await getStaff(req, res);
  if (!user) return;
  res.json({ configurado: (await obtenerSecretoSupervisor()) !== null });
});

router.post("/recepcion/supervisor-totp/generar", async (req: Request, res: Response): Promise<void> => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (user.rol !== "admin") {
    res.status(403).json({ error: "Solo un administrador puede generar el código de supervisor" });
    return;
  }
  const secret = generarSecretoTotp();
  await db
    .insert(configSistemaTable)
    .values({ clave: CLAVE_SUPERVISOR_TOTP, valor: secret, actualizadoEn: new Date() })
    .onConflictDoUpdate({
      target: configSistemaTable.clave,
      set: { valor: secret, actualizadoEn: new Date() },
    });
  // Nunca guardar el secreto en la auditoría: solo el hecho de que se regeneró
  await db.insert(auditLogTable).values({
    usuarioId: user.id,
    usuarioEmail: user.email,
    rol: user.rol,
    accion: "supervisor_totp_generar",
    entidad: "config_sistema",
    entidadId: null,
    detalle: { clave: CLAVE_SUPERVISOR_TOTP },
  });
  req.log.info({ usuario: user.email }, "secreto TOTP de supervisor regenerado");
  res.json({ secret, otpauthUrl: otpauthUrl(secret, "Supervisor Recepción", "Conectar") });
});

export default router;
