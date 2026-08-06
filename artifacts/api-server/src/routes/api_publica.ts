import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { eq, and, or, like, isNull, notInArray, inArray, lt, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  db,
  sedesTable,
  especialidadesTable,
  profesionalesTable,
  turnerasTable,
  turnosTable,
  pacientesTable,
  valoracionesAtencionTable,
  configSistemaTable,
} from "@workspace/db";
import {
  PublicoListProfesionalesQueryParams,
  PublicoListTurnerasQueryParams,
  PublicoGetDisponibilidadParams,
  PublicoGetTurnosPorDniQueryParams,
  PublicoCreateTurnoBody,
} from "@workspace/api-zod";
import { esSlotPasado, hoyArgentina, horaArgentina } from "../lib/tiempo";
import { calcularSlotsDisponibles } from "../lib/slots";
import { esViolacionUnique } from "../lib/pg";
import { registrarEventoTurnoRobot } from "../lib/robot-turnos-eventos";
import { verificarCupoObraSocial, reservarConCupo } from "../lib/cupos-obra-social";
import { cancelarTrabajosDeTurno } from "../integraciones/klinicos-cola";
import { notificarEventoVideollamadaPorTurno, avanzarFilaGuardia } from "../integraciones/app-paciente-videollamadas";
import { sincronizarWorklistTurno } from "../integraciones/pacs-worklist";
import { ejecutarValidacionTokenTurno } from "./sala_espera";
import { crearEstimadorEspera } from "../lib/espera";

// Estados que dejan el slot libre: un turno en cualquiera de estos NO cuenta
// como "activo" (mismo criterio que el índice único parcial de turnos).
const ESTADOS_INACTIVOS = ["cancelado", "anulado", "a_reprogramar", "ausente"];

// Estado simplificado para la app del paciente: confirmado | cancelado |
// atendido | ausente. El estado interno crudo se sigue devolviendo aparte.
function estadoSimple(estado: string): "confirmado" | "cancelado" | "atendido" | "ausente" {
  if (["cancelado", "anulado", "a_reprogramar"].includes(estado)) return "cancelado";
  if (estado === "ausente") return "ausente";
  if (["atendido", "finalizado", "visto", "pendiente_informe", "informando", "informado", "publicado", "visto_usuario"].includes(estado)) return "atendido";
  return "confirmado";
}
// Estados desde los cuales el paciente todavía puede mover (reprogramar) el turno.
const ESTADOS_MODIFICABLES = ["pendiente", "confirmado"];
// La cancelación es más amplia (regla de Federico 05/08/2026): también se puede
// cancelar ya recepcionado/esperando en sala. NUNCA en consulta (llamado /
// en_atencion) ni atendido. Si la consulta ya se cargó en Klinicos, la
// cancelación encola la anulación automática (ver cancelarTrabajosDeTurno).
const ESTADOS_CANCELABLES = [...ESTADOS_MODIFICABLES, "reservado", "arribo", "en_sala"];

// ── Idempotencia de reservas (header Idempotency-Key) ─────────────────────
// La clave del cliente se guarda hasheada en config_sistema con TTL perezoso:
// dos toques seguidos con la misma clave devuelven el mismo turno.
const PREFIJO_IDEM = "idem_publico_";
const TTL_IDEM_MS = 48 * 60 * 60 * 1000;

function claveIdem(key: string): string {
  return PREFIJO_IDEM + createHash("sha256").update(key).digest("hex");
}

// Huella del pedido: la misma clave solo vale para el MISMO pedido
// (agenda+fecha+hora+dni). Reusar la clave con otro contenido es un error.
function huellaReserva(o: { turneraId: number; fecha: string; horaInicio: string; dni: string }): string {
  return createHash("sha256").update(`${o.turneraId}|${o.fecha}|${o.horaInicio}|${o.dni}`).digest("hex");
}

type RegistroIdem = { fp: string; turnoId: number | null };

// Reclama la clave de forma atómica (INSERT ... ON CONFLICT DO NOTHING).
// Devuelve { propia: true } si este request es el dueño de la clave, o el
// registro existente si otro request la reclamó antes.
async function reclamarIdemKey(key: string, fp: string): Promise<{ propia: boolean; registro: RegistroIdem | null }> {
  const insertadas = await db.insert(configSistemaTable)
    .values({ clave: claveIdem(key), valor: JSON.stringify({ fp, turnoId: null }) })
    .onConflictDoNothing()
    .returning({ clave: configSistemaTable.clave });
  if (insertadas.length > 0) return { propia: true, registro: null };
  const [row] = await db.select().from(configSistemaTable)
    .where(eq(configSistemaTable.clave, claveIdem(key))).limit(1);
  if (!row) return { propia: false, registro: null };
  try {
    const v = JSON.parse(row.valor) as Partial<RegistroIdem>;
    return { propia: false, registro: { fp: v.fp ?? "", turnoId: typeof v.turnoId === "number" ? v.turnoId : null } };
  } catch {
    return { propia: false, registro: null };
  }
}

async function confirmarIdemKey(key: string, fp: string, turnoId: number): Promise<void> {
  await db.update(configSistemaTable)
    .set({ valor: JSON.stringify({ fp, turnoId }) })
    .where(eq(configSistemaTable.clave, claveIdem(key)));
  // Limpieza perezosa de claves viejas.
  const limite = new Date(Date.now() - TTL_IDEM_MS);
  await db.delete(configSistemaTable)
    .where(and(like(configSistemaTable.clave, `${PREFIJO_IDEM}%`), lt(configSistemaTable.actualizadoEn, limite)))
    .catch(() => undefined);
}

async function liberarIdemKey(key: string): Promise<void> {
  await db.delete(configSistemaTable).where(eq(configSistemaTable.clave, claveIdem(key))).catch(() => undefined);
}

const router: IRouter = Router();

// ── Autenticación por API key (header x-api-key) ─────────────────────────
// La clave vive en el secret API_PUBLICA_KEY. Comparación en tiempo constante.
function claveValida(provista: string | undefined): boolean {
  const esperada = process.env.API_PUBLICA_KEY;
  if (!esperada || !provista) return false;
  const a = Buffer.from(provista);
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!process.env.API_PUBLICA_KEY) {
    res.status(503).json({ error: "API pública no configurada" });
    return;
  }
  const provista = req.header("x-api-key");
  if (!claveValida(provista)) {
    res.status(401).json({ error: "Clave de API inválida o faltante" });
    return;
  }
  next();
}

// Scopear el middleware SOLO a /publico para no filtrarlo a otros routers.
router.use("/publico", requireApiKey);

// ── Catálogo ──────────────────────────────────────────────────────────────
router.get("/publico/sedes", async (_req, res): Promise<void> => {
  const rows = await db.select().from(sedesTable).where(eq(sedesTable.activa, true)).orderBy(sedesTable.nombre);
  res.json(rows);
});

router.get("/publico/especialidades", async (_req, res): Promise<void> => {
  const rows = await db.select().from(especialidadesTable).orderBy(especialidadesTable.nombre);
  res.json(rows);
});

router.get("/publico/profesionales", async (req, res): Promise<void> => {
  const parsed = PublicoListProfesionalesQueryParams.safeParse({
    sedeId: req.query.sedeId != null ? Number(req.query.sedeId) : undefined,
    especialidadId: req.query.especialidadId != null ? Number(req.query.especialidadId) : undefined,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Parámetros inválidos" });
    return;
  }
  const conditions: SQL[] = [eq(profesionalesTable.activo, true)];
  if (parsed.data.especialidadId != null) conditions.push(eq(profesionalesTable.especialidadId, parsed.data.especialidadId));
  if (parsed.data.sedeId != null) conditions.push(eq(profesionalesTable.sedeId, parsed.data.sedeId));
  const rows = await db.select().from(profesionalesTable).where(and(...conditions)).orderBy(profesionalesTable.apellido);
  res.json(rows);
});

// Única guardia que NO se ofrece en la app: la de Odontología (decisión
// Federico ago 2026). Se detecta por nombre de la turnera o su especialidad.
async function esGuardiaExcluidaDeApp(turnera: { esGuardia: boolean | null; nombre: string | null; especialidadId: number | null }): Promise<boolean> {
  if (!turnera.esGuardia) return false;
  if (/odont/i.test(turnera.nombre ?? "")) return true;
  if (turnera.especialidadId == null) return false;
  const [esp] = await db
    .select({ nombre: especialidadesTable.nombre })
    .from(especialidadesTable)
    .where(eq(especialidadesTable.id, turnera.especialidadId))
    .limit(1);
  return /odont/i.test(esp?.nombre ?? "");
}

router.get("/publico/turneras", async (req, res): Promise<void> => {
  const parsed = PublicoListTurnerasQueryParams.safeParse({
    sedeId: req.query.sedeId != null ? Number(req.query.sedeId) : undefined,
    especialidadId: req.query.especialidadId != null ? Number(req.query.especialidadId) : undefined,
    profesionalId: req.query.profesionalId != null ? Number(req.query.profesionalId) : undefined,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Parámetros inválidos" });
    return;
  }
  // Todas las agendas activas (decisión Federico ago 2026: la app del
  // paciente ve y reserva TODAS las agendas, sin exigir visibilidad online).
  const conditions: SQL[] = [
    eq(turnerasTable.activa, true),
    // Las bolsas de guardia son un circuito interno: nunca se ofrecen online
    eq(turnerasTable.esGuardia, false),
  ];
  if (parsed.data.sedeId != null) conditions.push(eq(turnerasTable.sedeId, parsed.data.sedeId));
  if (parsed.data.especialidadId != null) conditions.push(eq(turnerasTable.especialidadId, parsed.data.especialidadId));
  if (parsed.data.profesionalId != null) conditions.push(eq(turnerasTable.profesionalId, parsed.data.profesionalId));
  const rows = await db.select().from(turnerasTable).where(and(...conditions)).orderBy(turnerasTable.nombre);
  res.json(rows.map((t) => ({ ...t, diasAtencion: t.diasAtencion ? t.diasAtencion.split(",").map(Number) : [] })));
});

// ── Guardias (demanda espontánea) ─────────────────────────────────────────
// Listado público de las agendas de guardia con horario y estado en vivo,
// para que la app del paciente muestre "Atención sin turno" (abierta/cerrada)
// leyendo directo de Conectar en vez de duplicar los horarios a mano.
router.get("/publico/guardias", async (_req, res): Promise<void> => {
  // Además de las agendas de guardia, se pueden publicar servicios por orden
  // de llegada que NO son bolsas de guardia (Radiografías, Mamografía, etc.):
  // sus IDs de turnera van en config_sistema "guardias_publicas_extra_ids"
  // (separados por coma), sin tocar su comportamiento interno.
  const [cfg] = await db
    .select({ valor: configSistemaTable.valor })
    .from(configSistemaTable)
    .where(eq(configSistemaTable.clave, "guardias_publicas_extra_ids"))
    .limit(1);
  const extraIds = (cfg?.valor ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  const rows = await db
    .select({
      id: turnerasTable.id,
      nombre: turnerasTable.nombre,
      especialidadId: turnerasTable.especialidadId,
      especialidadNombre: especialidadesTable.nombre,
      sedeId: turnerasTable.sedeId,
      sedeNombre: sedesTable.nombre,
      diasAtencion: turnerasTable.diasAtencion,
      horaInicio: turnerasTable.horaInicio,
      horaFin: turnerasTable.horaFin,
      horariosDia: turnerasTable.horariosDia,
    })
    .from(turnerasTable)
    .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .leftJoin(sedesTable, eq(turnerasTable.sedeId, sedesTable.id))
    .where(
      and(
        eq(turnerasTable.activa, true),
        extraIds.length > 0
          ? or(eq(turnerasTable.esGuardia, true), inArray(turnerasTable.id, extraIds))
          : eq(turnerasTable.esGuardia, true),
      ),
    )
    .orderBy(turnerasTable.nombre);

  // Estado en vivo con hora argentina: abierta si hoy es día de atención y la
  // hora actual cae dentro del horario (por día si está definido, si no el global).
  const ahora = horaArgentina().substring(0, 5);
  const hoy = hoyArgentina();
  const diaHoy = new Date(`${hoy}T00:00:00.000Z`).getUTCDay(); // 0=domingo

  // Pacientes en espera hoy por agenda (mismos estados "activos" que usa la
  // guardia virtual para estimar la fila).
  const esperaPorTurnera = new Map<number, number>();
  if (rows.length > 0) {
    const counts = await db
      .select({ turneraId: turnosTable.turneraId, cantidad: sql<number>`count(*)::int` })
      .from(turnosTable)
      .where(
        and(
          inArray(turnosTable.turneraId, rows.map((t) => t.id)),
          eq(turnosTable.fecha, hoy),
          inArray(turnosTable.estado, ["confirmado", "arribo", "recepcionado", "en_sala", "llamado"]),
        ),
      )
      .groupBy(turnosTable.turneraId);
    for (const c of counts) if (c.turneraId != null) esperaPorTurnera.set(c.turneraId, c.cantidad);
  }

  res.json(
    rows.map((t) => {
      const dias = t.diasAtencion ? t.diasAtencion.split(",").map(Number) : [];
      const horarioHoy = t.horariosDia?.find((h) => h.dia === diaHoy);
      const hi = horarioHoy?.horaInicio ?? t.horaInicio;
      const hf = horarioHoy?.horaFin ?? t.horaFin;
      const abiertaAhora = dias.includes(diaHoy) && ahora >= hi && ahora < hf;
      return {
        id: t.id,
        nombre: t.nombre,
        especialidadId: t.especialidadId,
        especialidadNombre: t.especialidadNombre,
        sedeId: t.sedeId,
        sedeNombre: t.sedeNombre,
        diasAtencion: dias,
        horaInicio: t.horaInicio,
        horaFin: t.horaFin,
        horariosDia: t.horariosDia ?? null,
        abiertaAhora,
        pacientesEnEspera: esperaPorTurnera.get(t.id) ?? 0,
      };
    }),
  );
});

// ── Check in: validación de token IOMA desde la app del paciente ─────────
// Mismo circuito que usa recepción (bono real, reglas inviolables de
// facturación): acá solo se agregan las guardas propias del canal público y
// después se delega TODO en el handler compartido de sala_espera.ts.
router.post("/publico/turnos/:id/validar-token", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID de turno inválido" });
    return;
  }
  const body = req.body as { dni?: unknown; token?: unknown };
  const dni = typeof body.dni === "string" ? body.dni.trim() : "";
  if (!/^\d{7,10}$/.test(dni)) {
    res.status(400).json({ error: "DNI inválido" });
    return;
  }
  if (typeof body.token !== "string" || body.token.trim() === "") {
    res.status(400).json({ error: "Token requerido" });
    return;
  }

  const [fila] = await db
    .select({
      pacienteDni: pacientesTable.dni,
      esGuardia: turnerasTable.esGuardia,
      tipo: turnerasTable.tipo,
      enviaWorklist: turnerasTable.enviaWorklist,
      enviaAlPacs: especialidadesTable.enviaAlPacs,
      estado: turnosTable.estado,
    })
    .from(turnosTable)
    .innerJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .where(eq(turnosTable.id, id))
    .limit(1);
  if (!fila || fila.pacienteDni !== dni) {
    // No revelar existencia de turnos ajenos: mismo 404 para ambos casos.
    res.status(404).json({ error: "Turno no encontrado para ese DNI" });
    return;
  }
  // Los turnos de guardia validan token por su propio circuito (regla de
  // facturación): este check in es solo para consultas programadas.
  if (fila.esGuardia) {
    res.status(409).json({ error: "Los turnos de guardia validan token por el circuito de guardia." });
    return;
  }
  // Check in solo para consultas: las prácticas (y todo lo que va al PACS/
  // Pixel) llevan otro token y siguen validándose en recepción.
  const vaAlPixel = fila.enviaWorklist ?? fila.enviaAlPacs ?? false;
  if (fila.tipo === "practica" || vaAlPixel) {
    res.status(409).json({ error: "Este turno es de un estudio: el token se valida en recepción." });
    return;
  }
  if (["cancelado", "anulado", "ausente", "finalizado"].includes(fila.estado)) {
    res.status(409).json({ error: "El turno no está vigente para validar token." });
    return;
  }

  // El handler compartido espera body { token } y params.id ya presentes.
  req.body = { token: body.token };
  return ejecutarValidacionTokenTurno(req, res, {
    id: null,
    email: "app-paciente",
    rol: "app_paciente",
    nombre: "App del paciente",
  });
});

// ── Disponibilidad ────────────────────────────────────────────────────────
router.get("/publico/turneras/:id/disponibilidad/:fecha", async (req, res): Promise<void> => {
  const parsed = PublicoGetDisponibilidadParams.safeParse({
    id: Number(req.params.id),
    fecha: req.params.fecha,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Parámetros inválidos (fecha YYYY-MM-DD)" });
    return;
  }
  const [turnera] = await db.select().from(turnerasTable)
    .where(eq(turnerasTable.id, parsed.data.id)).limit(1);
  if (!turnera || !turnera.activa || turnera.esGuardia) {
    res.status(404).json({ error: "Agenda no encontrada" });
    return;
  }
  res.json(await calcularSlotsDisponibles(turnera, parsed.data.fecha));
});

// GET /publico/turneras/:id/disponibilidad — rango de fechas (hasta 31 días),
// agrupado por fecha. Solo aparecen fechas con al menos un slot; turnoId no
// se expone (dato interno).
router.get("/publico/turneras/:id/disponibilidad", async (req, res): Promise<void> => {
  const turneraId = Number(req.params.id);
  if (!Number.isInteger(turneraId) || turneraId <= 0) {
    res.status(400).json({ error: "Id de agenda inválido" });
    return;
  }

  const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
  const fechaDesde = String(req.query.fechaDesde ?? "");
  const fechaHasta = String(req.query.fechaHasta ?? "");
  if (!FECHA_RE.test(fechaDesde) || !FECHA_RE.test(fechaHasta)) {
    res.status(400).json({ error: "Parámetros obligatorios: fechaDesde y fechaHasta (YYYY-MM-DD)" });
    return;
  }

  if (fechaHasta < fechaDesde) {
    res.status(400).json({ error: "fechaHasta debe ser mayor o igual a fechaDesde" });
    return;
  }

  // Límite de rango: 31 días
  const msDesde = new Date(`${fechaDesde}T00:00:00.000Z`).getTime();
  const msHasta = new Date(`${fechaHasta}T00:00:00.000Z`).getTime();
  const diasRango = Math.round((msHasta - msDesde) / (24 * 60 * 60 * 1000)) + 1;
  if (diasRango > 31) {
    res.status(400).json({ error: "El rango máximo es de 31 días" });
    return;
  }

  const [turnera] = await db.select().from(turnerasTable)
    .where(eq(turnerasTable.id, turneraId)).limit(1);
  if (!turnera || !turnera.activa || turnera.esGuardia) {
    res.status(404).json({ error: "Agenda no encontrada" });
    return;
  }

  // Precarga todos los turnos del rango en una sola query.
  const turnosRango = await db.select().from(turnosTable)
    .where(and(eq(turnosTable.turneraId, turneraId), gte(turnosTable.fecha, fechaDesde), lte(turnosTable.fecha, fechaHasta)));

  // Agrupar por fecha para pasarlos como turnosPrecargados.
  const turnosPorFecha = new Map<string, (typeof turnosTable.$inferSelect)[]>();
  for (const t of turnosRango) {
    const arr = turnosPorFecha.get(t.fecha) ?? [];
    arr.push(t);
    turnosPorFecha.set(t.fecha, arr);
  }

  // Iterar cada fecha del rango y calcular slots.
  const dias: Record<string, { horaInicio: string; horaFin: string; disponible: boolean }[]> = {};
  const cursor = new Date(`${fechaDesde}T00:00:00.000Z`);
  const fin = new Date(`${fechaHasta}T00:00:00.000Z`);
  while (cursor <= fin) {
    const fecha = cursor.toISOString().split("T")[0]!;
    const slots = await calcularSlotsDisponibles(turnera, fecha, turnosPorFecha.get(fecha) ?? []);
    if (slots.length > 0) {
      dias[fecha] = slots.map((s) => ({ horaInicio: s.horaInicio, horaFin: s.horaFin, disponible: s.disponible }));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  res.json({ fechaDesde, fechaHasta, dias });
});

// ── Turnos ────────────────────────────────────────────────────────────────
router.get("/publico/turnos", async (req, res): Promise<void> => {
  const parsed = PublicoGetTurnosPorDniQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "DNI inválido" });
    return;
  }
  const dni = parsed.data.dni.trim();
  if (!/^\d{7,10}$/.test(dni)) {
    res.status(400).json({ error: "DNI inválido" });
    return;
  }

  const [paciente] = await db.select({ id: pacientesTable.id })
    .from(pacientesTable).where(eq(pacientesTable.dni, dni)).limit(1);
  if (!paciente) {
    // Misma respuesta que "sin turnos" para no revelar si el DNI existe.
    res.json({ turnos: [] });
    return;
  }

  const rows = await db
    .select({
      id: turnosTable.id,
      turneraId: turnosTable.turneraId,
      fecha: turnosTable.fecha,
      horaInicio: turnosTable.horaInicio,
      estado: turnosTable.estado,
      modalidad: turnosTable.modalidad,
      profesionalNombre: profesionalesTable.nombre,
      profesionalApellido: profesionalesTable.apellido,
      especialidadNombre: especialidadesTable.nombre,
      sedeNombre: sedesTable.nombre,
    })
    .from(turnosTable)
    .leftJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(profesionalesTable, eq(turnosTable.profesionalId, profesionalesTable.id))
    .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .leftJoin(sedesTable, eq(turnerasTable.sedeId, sedesTable.id))
    .where(eq(turnosTable.pacienteId, paciente.id))
    .orderBy(turnosTable.fecha, turnosTable.horaInicio);

  res.json({ turnos: rows.map((t) => ({ ...t, estadoSimple: estadoSimple(t.estado) })) });
});

// Respuesta estándar de un turno para la app del paciente (reserva y reprogramación).
async function armarRespuestaTurno(turno: typeof turnosTable.$inferSelect) {
  const [turnera] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, turno.turneraId)).limit(1);
  const [prof] = turnera?.profesionalId
    ? await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, turnera.profesionalId)).limit(1)
    : [undefined];
  const [esp] = turnera?.especialidadId
    ? await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, turnera.especialidadId)).limit(1)
    : [undefined];
  const [sede] = turnera?.sedeId
    ? await db.select().from(sedesTable).where(eq(sedesTable.id, turnera.sedeId)).limit(1)
    : [undefined];
  return {
    id: turno.id,
    turneraId: turno.turneraId,
    fecha: turno.fecha,
    horaInicio: turno.horaInicio,
    horaFin: turno.horaFin,
    estado: turno.estado,
    profesional: prof ? `${prof.nombre} ${prof.apellido}` : null,
    especialidad: esp?.nombre ?? null,
    sede: sede?.nombre ?? null,
  };
}

router.post("/publico/turnos", async (req, res): Promise<void> => {
  const parsed = PublicoCreateTurnoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, codigo: "body_invalido" });
    return;
  }

  // Idempotencia: reclamo atómico de la clave. Si otro request con la misma
  // clave ya creó el turno, devolvemos ese; si la clave se reusó con otro
  // pedido, es un error explícito.
  const idemKey = req.header("idempotency-key")?.trim() || null;
  const fp = huellaReserva({
    turneraId: parsed.data.turneraId,
    fecha: parsed.data.fecha,
    horaInicio: parsed.data.horaInicio,
    dni: parsed.data.pacienteDni.trim(),
  });
  let idemReclamada = false;
  if (idemKey) {
    const claim = await reclamarIdemKey(idemKey, fp);
    if (claim.propia) {
      idemReclamada = true;
    } else if (claim.registro && claim.registro.fp !== fp) {
      res.status(422).json({
        error: "La clave de idempotencia ya se usó para otra reserva distinta. Usá una clave nueva por cada intento de reserva.",
        codigo: "clave_idempotencia_reusada",
      });
      return;
    } else if (claim.registro?.turnoId != null) {
      const [previo] = await db.select().from(turnosTable).where(eq(turnosTable.id, claim.registro.turnoId)).limit(1);
      if (previo) {
        res.status(200).json({ ...(await armarRespuestaTurno(previo)), repetido: true });
        return;
      }
      res.status(409).json({ error: "La reserva anterior con esta clave ya no existe. Usá una clave nueva.", codigo: "clave_idempotencia_reusada" });
      return;
    } else {
      // Otro request con la misma clave está creando el turno en este momento.
      res.status(409).json({ error: "Hay otra reserva en curso con la misma clave. Reintentá en unos segundos.", codigo: "reserva_en_curso" });
      return;
    }
  }
  // Si este request reclamó la clave pero la reserva falla (validación, cupo,
  // error interno), se libera la clave para que el reintento no quede trabado.
  if (idemReclamada && idemKey) {
    res.on("finish", () => {
      if (res.statusCode >= 400) void liberarIdemKey(idemKey);
    });
  }
  const { turneraId, fecha, horaInicio, pacienteDni, pacienteNombre, pacienteApellido, telefono, email, sexo, cobertura, nroAfiliado, motivoConsulta, regionAnatomica, origen } = parsed.data;

  const dni = pacienteDni.trim();
  if (!/^\d{7,10}$/.test(dni)) {
    res.status(400).json({ error: "DNI inválido" });
    return;
  }

  // Solo agendas activas (la guardia es circuito interno).
  const [turnera] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, turneraId)).limit(1);
  if (!turnera || !turnera.activa || turnera.esGuardia) {
    res.status(404).json({ error: "Agenda no encontrada" });
    return;
  }

  // En turneras de práctica la región anatómica es obligatoria (va al PACS
  // como body_part). Misma regla que POST /turnos.
  const regionLimpia = regionAnatomica?.trim() || null;
  if (turnera.tipo === "practica" && !regionLimpia) {
    res.status(400).json({ error: "La región anatómica es obligatoria para turnos de práctica (ej. \"Rodilla derecha\")" });
    return;
  }

  // Nunca permitir reservar en el pasado (hora argentina).
  if (esSlotPasado(fecha, horaInicio)) {
    res.status(400).json({ error: "No se puede reservar un turno en el pasado" });
    return;
  }

  // Validar que el slot exista dentro de la grilla de la agenda.
  const slots = await calcularSlotsDisponibles(turnera, fecha);
  const slot = slots.find((s) => s.horaInicio === horaInicio);
  if (!slot) {
    res.status(400).json({ error: "El horario no corresponde a la grilla de la agenda para esa fecha" });
    return;
  }
  if (!slot.disponible) {
    // Doble toque: si el que ocupa el slot es este mismo paciente, devolver
    // su turno en vez de un error.
    const [pacPrevio] = await db.select({ id: pacientesTable.id }).from(pacientesTable)
      .where(eq(pacientesTable.dni, dni)).limit(1);
    if (pacPrevio) {
      const [propio] = await db.select().from(turnosTable).where(and(
        eq(turnosTable.pacienteId, pacPrevio.id),
        eq(turnosTable.turneraId, turneraId),
        eq(turnosTable.fecha, fecha),
        eq(turnosTable.horaInicio, horaInicio),
        notInArray(turnosTable.estado, ESTADOS_INACTIVOS),
      )).limit(1);
      if (propio) {
        if (idemKey) await confirmarIdemKey(idemKey, fp, propio.id);
        res.status(200).json({ ...(await armarRespuestaTurno(propio)), repetido: true });
        return;
      }
    }
    res.status(409).json({ error: "Ese horario ya fue reservado. Elegí otro horario disponible.", codigo: "cupo_tomado" });
    return;
  }

  // Obras sociales de la agenda: si tiene listado, la cobertura debe estar en
  // la lista y respetar el cupo diario configurado. El control definitivo va
  // junto al insert (reservarConCupo); esta verificación previa devuelve un
  // error temprano antes de crear/actualizar la ficha del paciente.
  // El padrón propio manda: si la ficha del paciente ya tiene obra social,
  // esa es la que vale (lo que manda la app solo se usa si acá no hay dato).
  const [fichaPrevia] = await db.select({ cobertura: pacientesTable.cobertura })
    .from(pacientesTable).where(eq(pacientesTable.dni, dni)).limit(1);
  const coberturaEfectiva = fichaPrevia?.cobertura?.trim() || cobertura || null;
  {
    const cupo = await verificarCupoObraSocial({ turneraId, fecha, cobertura: coberturaEfectiva });
    if (!cupo.ok) {
      res.status(cupo.status).json({ error: cupo.error });
      return;
    }
  }

  // Resolver paciente por DNI; si no existe, se crea (con manejo de carrera
  // sobre el índice único de DNI: si otro request lo creó primero, se relee).
  let pacienteId: number;
  const [existente] = await db.select().from(pacientesTable).where(eq(pacientesTable.dni, dni)).limit(1);
  if (existente) {
    pacienteId = existente.id;
    // Completar datos faltantes de la ficha (requeridos por Klinicos) sin pisar los existentes.
    const faltantes: Partial<typeof pacientesTable.$inferInsert> = {};
    if (telefono && !existente.telefono) faltantes.telefono = telefono;
    if (email && !existente.email) faltantes.email = email;
    if (sexo && !existente.sexo) faltantes.sexo = sexo;
    if (cobertura && !existente.cobertura) faltantes.cobertura = cobertura;
    if (nroAfiliado && !existente.nroAfiliado) faltantes.nroAfiliado = nroAfiliado;
    if (Object.keys(faltantes).length > 0) {
      await db.update(pacientesTable).set(faltantes).where(eq(pacientesTable.id, existente.id));
    }
  } else {
    try {
      const [nuevo] = await db.insert(pacientesTable).values({
        nombre: pacienteNombre.trim(),
        apellido: pacienteApellido.trim(),
        dni,
        numeroHc: (dni ?? "").trim() || undefined, // HC = DNI
        telefono: telefono ?? undefined,
        email: email ?? undefined,
        sexo: sexo ?? undefined,
        cobertura: cobertura ?? undefined,
        nroAfiliado: nroAfiliado ?? undefined,
      }).returning();
      pacienteId = nuevo.id;
    } catch (err) {
      if (esViolacionUnique(err)) {
        const [reintentado] = await db.select().from(pacientesTable).where(eq(pacientesTable.dni, dni)).limit(1);
        if (!reintentado) throw err;
        pacienteId = reintentado.id;
      } else {
        throw err;
      }
    }
  }

  // Doble toque sin clave de idempotencia: si el mismo paciente ya tiene un
  // turno activo en ese mismo horario y agenda, devolvemos el existente en
  // vez de fallar con "horario ocupado".
  {
    const [duplicado] = await db.select().from(turnosTable).where(and(
      eq(turnosTable.pacienteId, pacienteId),
      eq(turnosTable.turneraId, turneraId),
      eq(turnosTable.fecha, fecha),
      eq(turnosTable.horaInicio, horaInicio),
      notInArray(turnosTable.estado, ESTADOS_INACTIVOS),
    )).limit(1);
    if (duplicado) {
      if (idemKey) await confirmarIdemKey(idemKey, fp, duplicado.id);
      res.status(200).json({ ...(await armarRespuestaTurno(duplicado)), repetido: true });
      return;
    }
  }

  const contacto = [telefono ? `Tel: ${telefono}` : null, email ? `Email: ${email}` : null]
    .filter(Boolean).join(" | ");
  const observaciones = [contacto || null, origen ? `Origen: ${origen}` : "Origen: api-publica"]
    .filter(Boolean).join(" | ");

  let turno: typeof turnosTable.$inferSelect;
  try {
    // Verificación de cupo + insert atómicos (advisory lock por agenda+fecha).
    const r = await reservarConCupo({ turneraId, fecha, cobertura: coberturaEfectiva }, async (tx) => {
      const [creado] = await tx.insert(turnosTable).values({
        turneraId,
        pacienteId,
        profesionalId: turnera.profesionalId ?? undefined,
        fecha,
        horaInicio,
        horaFin: slot.horaFin,
        estado: "pendiente",
        modalidad: "presencial",
        motivoConsulta: motivoConsulta ?? undefined,
        regionAnatomica: regionLimpia ?? undefined,
        observaciones,
      }).returning();
      return creado;
    });
    if (!r.ok) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    turno = r.valor;
  } catch (err) {
    // Índice único parcial turnos_slot_activo_unique: otro request ganó el slot.
    if (esViolacionUnique(err)) {
      // Si el que ganó la carrera fue este mismo paciente (doble toque
      // simultáneo), devolver su turno en vez de 409.
      const [propio] = await db.select().from(turnosTable).where(and(
        eq(turnosTable.pacienteId, pacienteId),
        eq(turnosTable.turneraId, turneraId),
        eq(turnosTable.fecha, fecha),
        eq(turnosTable.horaInicio, horaInicio),
        notInArray(turnosTable.estado, ESTADOS_INACTIVOS),
      )).limit(1);
      if (propio) {
        if (idemKey) await confirmarIdemKey(idemKey, fp, propio.id);
        res.status(200).json({ ...(await armarRespuestaTurno(propio)), repetido: true });
        return;
      }
      res.status(409).json({ error: "Ese horario ya fue reservado. Elegí otro horario disponible.", codigo: "cupo_tomado" });
      return;
    }
    throw err;
  }

  if (idemKey) await confirmarIdemKey(idemKey, fp, turno.id);

  await registrarEventoTurnoRobot(turno.id, "alta");
  req.log.info({ turnoId: turno.id, turneraId, origen: origen ?? "api-publica" }, "turno creado vía API pública");

  // Respuesta mínima con nombres legibles.
  const [prof] = turnera.profesionalId
    ? await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, turnera.profesionalId)).limit(1)
    : [undefined];
  const [esp] = turnera.especialidadId
    ? await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, turnera.especialidadId)).limit(1)
    : [undefined];
  const [sede] = turnera.sedeId
    ? await db.select().from(sedesTable).where(eq(sedesTable.id, turnera.sedeId)).limit(1)
    : [undefined];

  res.status(201).json({
    id: turno.id,
    turneraId: turno.turneraId,
    fecha: turno.fecha,
    horaInicio: turno.horaInicio,
    horaFin: turno.horaFin,
    estado: turno.estado,
    profesional: prof ? `${prof.nombre} ${prof.apellido}` : null,
    especialidad: esp?.nombre ?? null,
    sede: sede?.nombre ?? null,
  });
});

// ── Alta de pacientes nuevos (registro desde la app del paciente) ─────────
// Crea la ficha (HC = DNI). Si el DNI ya existe activo → 409 (la app lo toma
// como "ya existe"); si existe inactivo se reactiva (nunca se inserta doble).
// El padrón propio manda: nunca se pisan datos ya cargados, solo se completan
// los que falten.
const PublicoAltaPacienteBody = z.object({
  // Tolerante: algunas versiones de la app del paciente mandan el dni como número.
  dni: z.union([z.string(), z.number()]).transform((v) => String(v)),
  nombre: z.string().transform((v) => v.trim()).pipe(z.string().min(1)),
  apellido: z.string().transform((v) => v.trim()).pipe(z.string().min(1)),
  fechaNacimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sexo: z.string().max(20).optional(),
  telefono: z.string().max(50).optional(),
  email: z.string().max(200).optional(),
  obraSocial: z.string().max(100).optional(),
  numeroAfiliado: z.string().max(50).optional(),
  origen: z.string().max(100).optional(),
});

router.post("/publico/pacientes", async (req, res): Promise<void> => {
  const parsed = PublicoAltaPacienteBody.safeParse(req.body);
  const dni = parsed.success ? parsed.data.dni.replace(/\D/g, "") : "";
  if (!parsed.success || !/^\d{7,10}$/.test(dni)) {
    // Solo nombres de campos, sin valores (no filtrar datos del paciente al log).
    const camposInvalidos = parsed.success
      ? ["dni"]
      : Object.keys(parsed.error.flatten().fieldErrors);
    req.log.warn({ camposInvalidos }, "alta pública de paciente rechazada por body inválido");
    res.status(400).json({ error: "Datos inválidos: dni (7-10 dígitos), nombre y apellido son obligatorios", codigo: "body_invalido", campos: camposInvalidos });
    return;
  }
  const d = parsed.data;
  const datosNuevos = {
    telefono: d.telefono?.trim() || undefined,
    email: d.email?.trim() || undefined,
    sexo: d.sexo?.trim() || undefined,
    fechaNacimiento: d.fechaNacimiento || undefined,
    cobertura: d.obraSocial?.trim() || undefined,
    nroAfiliado: d.numeroAfiliado?.trim() || undefined,
  };

  const [existente] = await db.select().from(pacientesTable).where(eq(pacientesTable.dni, dni)).limit(1);
  if (existente) {
    // Completar solo lo que falte en la ficha, sin pisar lo existente.
    const faltantes: Partial<typeof pacientesTable.$inferInsert> = {};
    if (datosNuevos.telefono && !existente.telefono) faltantes.telefono = datosNuevos.telefono;
    if (datosNuevos.email && !existente.email) faltantes.email = datosNuevos.email;
    if (datosNuevos.sexo && !existente.sexo) faltantes.sexo = datosNuevos.sexo;
    if (datosNuevos.fechaNacimiento && !existente.fechaNacimiento) faltantes.fechaNacimiento = datosNuevos.fechaNacimiento;
    if (datosNuevos.cobertura && !existente.cobertura) faltantes.cobertura = datosNuevos.cobertura;
    if (datosNuevos.nroAfiliado && !existente.nroAfiliado) faltantes.nroAfiliado = datosNuevos.nroAfiliado;
    if (!existente.numeroHc?.trim()) faltantes.numeroHc = dni; // HC = DNI
    if (!existente.activo) faltantes.activo = true; // reactivar, nunca duplicar
    if (Object.keys(faltantes).length > 0) {
      await db.update(pacientesTable).set(faltantes).where(eq(pacientesTable.id, existente.id));
    }
    if (existente.activo) {
      // Idempotente: para la app del paciente "ya existe" no es un error.
      // Antes se devolvía 409 y el portal lo mostraba como fallo de registro.
      res.status(200).json({ id: existente.id, dni, numeroHc: existente.numeroHc?.trim() || dni, yaExistia: true });
      return;
    }
    req.log.info({ pacienteId: existente.id }, "paciente reactivado vía alta pública");
    res.status(200).json({ id: existente.id, dni, numeroHc: existente.numeroHc?.trim() || dni, reactivado: true });
    return;
  }

  try {
    const [nuevo] = await db.insert(pacientesTable).values({
      nombre: d.nombre.trim(),
      apellido: d.apellido.trim(),
      dni,
      numeroHc: dni, // HC = DNI
      ...datosNuevos,
    }).returning();
    req.log.info({ pacienteId: nuevo.id, origen: d.origen ?? "app-paciente" }, "paciente creado vía alta pública");
    res.status(201).json({ id: nuevo.id, dni, numeroHc: dni });
  } catch (err) {
    // Carrera sobre el índice único de DNI: otro request lo creó primero.
    if (esViolacionUnique(err)) {
      const [ganador] = await db.select().from(pacientesTable).where(eq(pacientesTable.dni, dni)).limit(1);
      res.status(200).json({ id: ganador?.id, dni, numeroHc: dni, yaExistia: true });
      return;
    }
    throw err;
  }
});

// ── Cobertura por DNI (padrón propio) ─────────────────────────────────────
// La app del paciente consulta la obra social contra nuestra propia base
// (los pacientes ya cargados con su cobertura). Si no tenemos el DNI o la
// ficha no tiene cobertura útil, se responde 404 con codigo "sin_datos":
// la app manda lo que tenga y NO debe pisar datos con "particular" inventado.
router.get("/publico/pacientes/cobertura", async (req, res): Promise<void> => {
  const dni = String(req.query.dni ?? "").replace(/\D/g, "");
  if (!/^\d{7,10}$/.test(dni)) {
    res.status(400).json({ error: "DNI inválido (7-10 dígitos)", codigo: "dni_invalido" });
    return;
  }
  const [p] = await db.select({
    cobertura: pacientesTable.cobertura,
    planCobertura: pacientesTable.planCobertura,
    nroAfiliado: pacientesTable.nroAfiliado,
    // Nota: se responde también para fichas inactivas a propósito — la
    // cobertura sigue siendo dato válido del padrón aunque la ficha esté baja.
  }).from(pacientesTable).where(eq(pacientesTable.dni, dni)).limit(1);

  const cobertura = (p?.cobertura ?? "").trim();
  // "Particular" o vacío no es un dato del padrón: es la ausencia de cobertura.
  if (!p || !cobertura || /^particular$/i.test(cobertura)) {
    res.status(404).json({ error: "Sin datos de cobertura para ese DNI", codigo: "sin_datos" });
    return;
  }
  res.json({
    dni,
    cobertura,
    plan: p.planCobertura?.trim() || null,
    nroAfiliado: p.nroAfiliado?.trim() || null,
  });
});

// ── Cancelación real por id de turno ──────────────────────────────────────
// El DNI del body tiene que coincidir con el paciente del turno (la API key
// identifica a la app, no al paciente). Idempotente: cancelar un turno ya
// cancelado devuelve 200 con repetido:true, sin duplicar side-effects.
const PublicoCancelarTurnoBody = z.object({
  dni: z.string().min(1),
  motivo: z.string().max(500).optional(),
});

async function turnoDelPaciente(id: number, dni: string): Promise<typeof turnosTable.$inferSelect | null> {
  const [turno] = await db.select().from(turnosTable).where(eq(turnosTable.id, id)).limit(1);
  if (!turno || turno.pacienteId == null) return null;
  const [pac] = await db.select({ dni: pacientesTable.dni }).from(pacientesTable)
    .where(eq(pacientesTable.id, turno.pacienteId)).limit(1);
  // Mismo 404 si el turno no existe o no es de ese DNI: no revelar turnos ajenos.
  if (!pac?.dni || pac.dni.trim() !== dni) return null;
  return turno;
}

router.post("/publico/turnos/:id/cancelar", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Id de turno inválido", codigo: "id_invalido" });
    return;
  }
  const parsed = PublicoCancelarTurnoBody.safeParse(req.body);
  const dni = parsed.success ? parsed.data.dni.trim() : "";
  if (!parsed.success || !/^\d{7,10}$/.test(dni)) {
    res.status(400).json({ error: "DNI inválido", codigo: "dni_invalido" });
    return;
  }

  const turno = await turnoDelPaciente(id, dni);
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado", codigo: "turno_no_encontrado" });
    return;
  }
  if (ESTADOS_INACTIVOS.includes(turno.estado)) {
    res.status(200).json({ ok: true, id: turno.id, estado: turno.estado, repetido: true });
    return;
  }
  if (!ESTADOS_CANCELABLES.includes(turno.estado)) {
    res.status(422).json({
      error: `El turno ya está en curso o atendido y no se puede cancelar desde la app (estado: ${turno.estado})`,
      codigo: "estado_no_cancelable",
      estado: turno.estado,
    });
    return;
  }

  const motivo = parsed.data.motivo?.trim() || null;
  const nota = `Cancelado por el paciente vía app${motivo ? ` | Motivo: ${motivo}` : ""}`;
  const observaciones = [turno.observaciones?.trim() || null, nota].filter(Boolean).join(" | ");
  // Guard atómico sobre el estado: si otro proceso lo cambió en el medio
  // (recepción lo recepcionó, etc.), no se pisa.
  const [actualizado] = await db.update(turnosTable)
    .set({ estado: "cancelado", observaciones })
    .where(and(eq(turnosTable.id, turno.id), eq(turnosTable.estado, turno.estado)))
    .returning();
  if (!actualizado) {
    res.status(409).json({ error: "El turno cambió de estado, volvé a consultarlo", codigo: "estado_cambio" });
    return;
  }

  // Mismos side-effects que la cancelación interna de recepción.
  await registrarEventoTurnoRobot(turno.id, "cancelacion");
  void cancelarTrabajosDeTurno(turno.id);
  void notificarEventoVideollamadaPorTurno(turno.id, "cancelada", "El paciente canceló el turno");
  void avanzarFilaGuardia(turno.id);
  void sincronizarWorklistTurno(turno.id, req.log);
  req.log.info({ turnoId: turno.id }, "turno cancelado vía API pública");

  res.json({ ok: true, id: turno.id, estado: "cancelado" });
});

// ── Fila de espera: cuántos pacientes tiene adelante ──────────────────────
// Premio por hacer el check-in: SOLO un turno ya recepcionado (arribo/en_sala,
// o confirmado en guardia) ve su posición en la fila y la espera estimada.
// Sin check-in devuelve el motivo para que la app invite a hacerlo.
const ESTADOS_FILA = ["arribo", "en_sala"];

router.get("/publico/turnos/:id/fila", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Id de turno inválido", codigo: "id_invalido" });
    return;
  }
  const dni = String(req.query.dni ?? "").trim();
  if (!/^\d{7,10}$/.test(dni)) {
    res.status(400).json({ error: "DNI inválido", codigo: "dni_invalido" });
    return;
  }
  const turno = await turnoDelPaciente(id, dni);
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado", codigo: "turno_no_encontrado" });
    return;
  }
  const hoy = hoyArgentina();
  if (turno.fecha !== hoy) {
    res.status(422).json({ error: "La fila solo se ve el día del turno", codigo: "fuera_de_fecha" });
    return;
  }
  const [turnera] = await db.select().from(turnerasTable)
    .where(eq(turnerasTable.id, turno.turneraId)).limit(1);
  if (!turnera) {
    res.status(404).json({ error: "Turno no encontrado", codigo: "turno_no_encontrado" });
    return;
  }
  if (turno.estado === "llamado" || turno.estado === "en_atencion") {
    res.json({ enFila: false, codigo: "en_consulta", mensaje: "Ya te llamaron: acercate al consultorio." });
    return;
  }
  const enFila = ESTADOS_FILA.includes(turno.estado) ||
    (turno.estado === "confirmado" && turnera.esGuardia);
  if (!enFila) {
    res.json({
      enFila: false,
      codigo: "checkin_pendiente",
      mensaje: "Hacé el check-in al llegar para ver cuántos pacientes tenés adelante.",
      estado: turno.estado,
    });
    return;
  }

  // Misma cola y orden que ve el staff y la TV de sala: por hora de turno.
  // En guardia, los "confirmado" (agendados sin llegar) también ocupan lugar.
  const [colaRows, estimador] = await Promise.all([
    db.select({ id: turnosTable.id })
      .from(turnosTable)
      .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
      .where(and(
        eq(turnosTable.fecha, hoy),
        eq(turnosTable.turneraId, turno.turneraId),
        or(
          inArray(turnosTable.estado, ESTADOS_FILA),
          and(eq(turnosTable.estado, "confirmado"), eq(turnerasTable.esGuardia, true)),
        )!,
      ))
      .orderBy(turnosTable.horaInicio),
    crearEstimadorEspera(hoy, [turno.turneraId], new Map([[turno.turneraId, turnera.duracionMinutos ?? (turnera.esGuardia ? 15 : null)]])),
  ]);
  const idx = colaRows.findIndex((c) => c.id === turno.id);
  const posicion = idx >= 0 ? idx + 1 : null;
  res.json({
    enFila: true,
    posicion,
    pacientesAdelante: idx >= 0 ? idx : null,
    enEsperaTotal: colaRows.length,
    esperaEstimadaMinutos: posicion != null ? estimador.estimar(turno.turneraId, posicion) : null,
    agenda: turnera.nombre,
  });
});

// ── Reprogramación: mover un turno existente a otro horario ───────────────
// Mueve el MISMO turno (conserva id, estudios y trazabilidad). Si el nuevo
// horario está tomado responde 409 y el turno original queda intacto.
const PublicoReprogramarTurnoBody = z.object({
  dni: z.string().min(1),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  horaInicio: z.string().regex(/^\d{2}:\d{2}$/),
  turneraId: z.number().int().positive().optional(),
});

router.post("/publico/turnos/:id/reprogramar", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Id de turno inválido", codigo: "id_invalido" });
    return;
  }
  const parsed = PublicoReprogramarTurnoBody.safeParse(req.body);
  const dni = parsed.success ? parsed.data.dni.trim() : "";
  if (!parsed.success || !/^\d{7,10}$/.test(dni)) {
    res.status(400).json({ error: "Datos inválidos (dni, fecha YYYY-MM-DD, horaInicio HH:MM)", codigo: "body_invalido" });
    return;
  }

  const turno = await turnoDelPaciente(id, dni);
  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado", codigo: "turno_no_encontrado" });
    return;
  }
  if (!ESTADOS_MODIFICABLES.includes(turno.estado)) {
    res.status(422).json({
      error: `El turno no se puede reprogramar desde la app (estado: ${turno.estado})`,
      codigo: "estado_no_reprogramable",
      estado: turno.estado,
    });
    return;
  }

  const { fecha, horaInicio } = parsed.data;
  const turneraDestinoId = parsed.data.turneraId ?? turno.turneraId;
  const [destino] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, turneraDestinoId)).limit(1);
  if (!destino || !destino.activa || destino.esGuardia) {
    res.status(404).json({ error: "Agenda no encontrada", codigo: "agenda_no_encontrada" });
    return;
  }
  if (esSlotPasado(fecha, horaInicio)) {
    res.status(400).json({ error: "No se puede reprogramar a un horario pasado", codigo: "horario_pasado" });
    return;
  }
  const slots = await calcularSlotsDisponibles(destino, fecha);
  const slot = slots.find((s) => s.horaInicio === horaInicio);
  if (!slot) {
    res.status(400).json({ error: "El horario no corresponde a la grilla de la agenda para esa fecha", codigo: "horario_fuera_de_grilla" });
    return;
  }
  // Mismo horario que ya tiene: idempotente.
  if (turno.turneraId === turneraDestinoId && turno.fecha === fecha && turno.horaInicio === horaInicio) {
    res.status(200).json({ ...(await armarRespuestaTurno(turno)), repetido: true });
    return;
  }
  if (!slot.disponible) {
    res.status(409).json({ error: "Ese horario ya fue reservado. Elegí otro horario disponible.", codigo: "cupo_tomado" });
    return;
  }

  let movido: typeof turnosTable.$inferSelect | undefined;
  try {
    [movido] = await db.update(turnosTable)
      .set({
        turneraId: turneraDestinoId,
        profesionalId: destino.profesionalId ?? turno.profesionalId,
        fecha,
        horaInicio,
        horaFin: slot.horaFin,
      })
      .where(and(eq(turnosTable.id, turno.id), eq(turnosTable.estado, turno.estado)))
      .returning();
  } catch (err) {
    if (esViolacionUnique(err)) {
      res.status(409).json({ error: "Ese horario ya fue reservado. Elegí otro horario disponible.", codigo: "cupo_tomado" });
      return;
    }
    throw err;
  }
  if (!movido) {
    res.status(409).json({ error: "El turno cambió de estado, volvé a consultarlo", codigo: "estado_cambio" });
    return;
  }

  await registrarEventoTurnoRobot(movido.id, "reprogramacion");
  void sincronizarWorklistTurno(movido.id, req.log, { forzarReenvio: true });
  req.log.info({ turnoId: movido.id, fecha, horaInicio }, "turno reprogramado vía API pública");

  res.json(await armarRespuestaTurno(movido));
});

// ── Valoración de la atención (la app del paciente responde acá) ─────────
router.get("/publico/valoraciones/:token", async (req, res): Promise<void> => {
  const [v] = await db
    .select()
    .from(valoracionesAtencionTable)
    .where(eq(valoracionesAtencionTable.token, req.params.token))
    .limit(1);
  if (!v) { res.status(404).json({ error: "Valoración no encontrada" }); return; }
  const [prof] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, v.profesionalId)).limit(1);
  res.json({
    profesional: prof ? `${prof.apellido ? prof.apellido + ", " : ""}${prof.nombre}` : null,
    fechaConsulta: v.creadoEn.toISOString(),
    calificada: v.puntaje != null,
  });
});

// Estado de la invitación (la app verifica antes de mostrar el formulario).
router.get("/publico/valoraciones/:token/estado", async (req, res): Promise<void> => {
  const [v] = await db
    .select({ puntaje: valoracionesAtencionTable.puntaje })
    .from(valoracionesAtencionTable)
    .where(eq(valoracionesAtencionTable.token, req.params.token))
    .limit(1);
  if (!v) { res.status(404).json({ error: "Valoración no encontrada" }); return; }
  const calificada = v.puntaje != null;
  res.json({ estado: calificada ? "calificada" : "disponible", disponible: !calificada, calificada });
});

router.post("/publico/valoraciones/:token", async (req, res): Promise<void> => {
  const puntaje = Number((req.body as Record<string, unknown>)?.puntaje);
  const comentarioRaw = (req.body as Record<string, unknown>)?.comentario;
  if (!Number.isInteger(puntaje) || puntaje < 1 || puntaje > 5) {
    res.status(400).json({ error: "puntaje debe ser un entero entre 1 y 5" });
    return;
  }
  const comentario = typeof comentarioRaw === "string" && comentarioRaw.trim() ? comentarioRaw.trim().slice(0, 1000) : null;

  // Update condicional y atómico: solo si todavía no fue calificada.
  const actualizadas = await db
    .update(valoracionesAtencionTable)
    .set({ puntaje, comentario, calificadoEn: new Date(), actualizadoEn: new Date() })
    .where(and(eq(valoracionesAtencionTable.token, req.params.token), isNull(valoracionesAtencionTable.puntaje)))
    .returning({ id: valoracionesAtencionTable.id });
  if (actualizadas.length > 0) { res.status(201).json({ ok: true }); return; }

  const [v] = await db
    .select({ id: valoracionesAtencionTable.id })
    .from(valoracionesAtencionTable)
    .where(eq(valoracionesAtencionTable.token, req.params.token))
    .limit(1);
  if (!v) { res.status(404).json({ error: "Valoración no encontrada" }); return; }
  res.status(409).json({ error: "Esta consulta ya fue calificada" });
});

export default router;
