import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { eq, and, gte, lte, like, inArray, notInArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  db,
  turnerasTable,
  turneraParticipantesTable,
  turneraObrasSocialesTable,
  turneraPracticasTable,
  obrasSocialesTable,
  bloqueosTable,
  especialidadesTable,
  profesionalesTable,
  sedesTable,
  turnosTable,
  pacientesTable,
  notificacionesSalientesTable,
  usersTable,
  auditLogTable,
  elegirTurneraReutilizable,
  salasLlamadoTable,
  type BloqueNuevo,
} from "@workspace/db";
import {
  CreateTurneraBody,
  UpdateTurneraBody,
  GetTurneraParams,
  UpdateTurneraParams,
  DeleteTurneraParams,
  ListTurnerasQueryParams,
  GetDisponibilidadTurneraParams,
  GetProximosHuecosQueryParams,
  GetDisponibilidadAgregadaQueryParams,
  GetProximoHuecoAgregadoQueryParams,
  CreateBloqueoParams,
  CreateBloqueoBody,
  GetTurnosAfectadosTurneraParams,
  GetTurnosAfectadosTurneraBody,
  CancelarTurneraMasivoParams,
  CancelarTurneraMasivoBody,
} from "@workspace/api-zod";
import { requireRol, hashPassword, getUserIdFromToken } from "./auth";
import { calcularSlotsDisponibles } from "../lib/slots";
import { registrarEventoTurnoRobot } from "../lib/robot-turnos-eventos";
import { sincronizarWorklistTurno } from "../integraciones/pacs-worklist";
import { encolarTurnosFuturosDeTurnera, cancelarTrabajosDeTurno } from "../integraciones/klinicos-cola";
import {
  enviarWhatsappWhaticket,
  PLANTILLA_META_CANCELACION_ID,
  whaticketConfigurado,
  renderPlantilla,
  PLANTILLA_CANCELACION_DEFAULT,
} from "../integraciones/whaticket";

const router: IRouter = Router();

// Nombre normalizado para dedup (sin acentos, minúsculas, espacios colapsados)
function normalizarNombre(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Escrituras solo staff; las lecturas quedan publicas (las usa la reserva online sin cuenta).
const soloStaff = requireRol("admin", "recepcionista", "medico");

async function guardarParticipantes(turneraId: number, participantesIds: number[] | undefined) {
  if (participantesIds === undefined) return;
  await db.delete(turneraParticipantesTable).where(eq(turneraParticipantesTable.turneraId, turneraId));
  const ids = [...new Set(participantesIds)].filter((n) => Number.isFinite(n));
  if (ids.length > 0) {
    await db.insert(turneraParticipantesTable).values(ids.map((profesionalId) => ({ turneraId, profesionalId })));
  }
}

async function guardarObrasSociales(
  turneraId: number,
  obrasSociales: { obraSocialId: number; cupoDiario?: number | null }[] | undefined,
) {
  if (obrasSociales === undefined) return;
  await db.delete(turneraObrasSocialesTable).where(eq(turneraObrasSocialesTable.turneraId, turneraId));
  const vistos = new Set<number>();
  const filas = obrasSociales
    .filter((o) => Number.isFinite(o.obraSocialId) && !vistos.has(o.obraSocialId) && (vistos.add(o.obraSocialId), true))
    .map((o) => ({
      turneraId,
      obraSocialId: o.obraSocialId,
      cupoDiario: o.cupoDiario != null && o.cupoDiario > 0 ? Math.floor(o.cupoDiario) : null,
    }));
  if (filas.length > 0) {
    await db.insert(turneraObrasSocialesTable).values(filas);
  }
}

// Prácticas del nomenclador que realiza la agenda (ej: mamografía 340602).
async function guardarPracticas(
  turneraId: number,
  practicas: { codigo: string; descripcion?: string }[] | undefined,
) {
  if (practicas === undefined) return;
  await db.delete(turneraPracticasTable).where(eq(turneraPracticasTable.turneraId, turneraId));
  const vistos = new Set<string>();
  const filas = practicas
    .map((p) => ({ codigo: p.codigo.trim(), descripcion: p.descripcion?.trim() ?? "" }))
    .filter((p) => p.codigo.length > 0 && !vistos.has(p.codigo) && (vistos.add(p.codigo), true))
    .map((p) => ({ turneraId, codigo: p.codigo, descripcion: p.descripcion }));
  if (filas.length > 0) {
    await db.insert(turneraPracticasTable).values(filas);
  }
}

// ── Buscador rápido de recepción ──────────────────────────────────────────
// Busca por texto (ej: "ecografia de abdomen") y devuelve las prácticas y
// especialidades que coinciden, cada una con las agendas activas que las
// realizan (las prácticas se toman de lo tildado en turnera_practicas).
router.get("/buscador-agendas", soloStaff, async (req, res): Promise<void> => {
  const q = normalizarNombre(String(req.query.q ?? ""));
  if (q.length < 3) {
    res.status(400).json({ error: "Escribí al menos 3 letras para buscar" });
    return;
  }
  const palabras = q.split(" ").filter(Boolean);
  const coincide = (texto: string | null | undefined): boolean => {
    const t = normalizarNombre(texto ?? "");
    return palabras.every((p) => t.includes(p));
  };

  const [turneras, practicasFilas, especialidades, profesionales, sedes] = await Promise.all([
    db.select().from(turnerasTable).where(eq(turnerasTable.activa, true)),
    db.select().from(turneraPracticasTable),
    db.select().from(especialidadesTable),
    db.select().from(profesionalesTable),
    db.select().from(sedesTable),
  ]);
  const turnerasPorId = new Map(turneras.map((t) => [t.id, t]));
  const espPorId = new Map(especialidades.map((e) => [e.id, e]));
  const profPorId = new Map(profesionales.map((p) => [p.id, p]));
  const sedePorId = new Map(sedes.map((s) => [s.id, s]));

  const armarAgenda = (t: typeof turnerasTable.$inferSelect) => {
    const prof = t.profesionalId != null ? profPorId.get(t.profesionalId) : undefined;
    return {
      turneraId: t.id,
      turneraNombre: t.nombre,
      profesionalNombre: prof ? `${prof.apellido}, ${prof.nombre}` : null,
      especialidadId: t.especialidadId ?? null,
      especialidadNombre: (t.especialidadId != null ? espPorId.get(t.especialidadId)?.nombre : null) ?? null,
      sedeId: t.sedeId ?? null,
      sedeNombre: (t.sedeId != null ? sedePorId.get(t.sedeId)?.nombre : null) ?? null,
      esGuardia: !!t.esGuardia,
      tipo: t.tipo,
    };
  };

  // Prácticas: agrupar por código las filas tildadas cuya descripción o código
  // coincide, y colgar las agendas activas que las tienen.
  const porCodigo = new Map<string, { codigo: string; descripcion: string; agendas: ReturnType<typeof armarAgenda>[] }>();
  for (const fila of practicasFilas) {
    const turnera = turnerasPorId.get(fila.turneraId);
    if (!turnera) continue;
    if (!(coincide(fila.descripcion) || normalizarNombre(fila.codigo).includes(q))) continue;
    let grupo = porCodigo.get(fila.codigo);
    if (!grupo) {
      grupo = { codigo: fila.codigo, descripcion: fila.descripcion || fila.codigo, agendas: [] };
      porCodigo.set(fila.codigo, grupo);
    }
    if (fila.descripcion && fila.descripcion.length > grupo.descripcion.length) grupo.descripcion = fila.descripcion;
    grupo.agendas.push(armarAgenda(turnera));
  }

  // Especialidades (consultas y demás): coincidencia por nombre/código.
  const especialidadesResultado = especialidades
    .filter((e) => coincide(e.nombre) || coincide(e.descripcion))
    .map((e) => ({
      id: e.id,
      nombre: e.nombre,
      agendas: turneras.filter((t) => t.especialidadId === e.id).map(armarAgenda),
    }))
    .filter((e) => e.agendas.length > 0)
    .slice(0, 8);

  res.json({
    practicas: [...porCodigo.values()].sort((a, b) => a.descripcion.localeCompare(b.descripcion)).slice(0, 12),
    especialidades: especialidadesResultado,
  });
});

type HorarioDia = { dia: number; horaInicio: string; horaFin: string };

// Valida y normaliza horarios por día. Devuelve error o los valores derivados:
// horariosDia deduplicado + rango global (min inicio / max fin) para compatibilidad.
function normalizarHorariosDia(horarios: HorarioDia[]):
  | { error: string }
  | { horariosDia: HorarioDia[]; horaInicio: string; horaFin: string; dias: number[] } {
  const porDia = new Map<number, HorarioDia>();
  for (const h of horarios) {
    const inicio = h.horaInicio.substring(0, 5);
    const fin = h.horaFin.substring(0, 5);
    if (!Number.isInteger(h.dia) || h.dia < 0 || h.dia > 6) {
      return { error: "Día inválido en horarios por día" };
    }
    if (fin <= inicio) {
      return { error: `El horario del día ${h.dia} tiene hora de fin (${fin}) que no es posterior a la de inicio (${inicio})` };
    }
    porDia.set(h.dia, { dia: h.dia, horaInicio: inicio, horaFin: fin });
  }
  const lista = [...porDia.values()].sort((a, b) => a.dia - b.dia);
  if (lista.length === 0) return { error: "Horarios por día vacíos" };
  const horaInicio = lista.map((h) => h.horaInicio).sort()[0];
  const horaFin = lista.map((h) => h.horaFin).sort().at(-1)!;
  return { horariosDia: lista, horaInicio, horaFin, dias: lista.map((h) => h.dia) };
}

async function enrichTurnera(t: typeof turnerasTable.$inferSelect) {
  const diasAtencion = t.diasAtencion ? t.diasAtencion.split(",").map(Number) : [];
  let especialidad = null;
  let profesional = null;
  let sede = null;
  if (t.especialidadId) {
    const [e] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, t.especialidadId)).limit(1);
    especialidad = e ?? null;
  }
  if (t.profesionalId) {
    const [p] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, t.profesionalId)).limit(1);
    profesional = p ?? null;
  }
  if (t.sedeId) {
    const [s] = await db.select().from(sedesTable).where(eq(sedesTable.id, t.sedeId)).limit(1);
    sede = s ?? null;
  }
  const participantes = await db
    .select()
    .from(turneraParticipantesTable)
    .where(eq(turneraParticipantesTable.turneraId, t.id));
  const participantesIds = participantes.map((p) => p.profesionalId);
  const obrasSociales = await db
    .select({
      obraSocialId: turneraObrasSocialesTable.obraSocialId,
      cupoDiario: turneraObrasSocialesTable.cupoDiario,
      nombre: obrasSocialesTable.nombre,
    })
    .from(turneraObrasSocialesTable)
    .innerJoin(obrasSocialesTable, eq(turneraObrasSocialesTable.obraSocialId, obrasSocialesTable.id))
    .where(eq(turneraObrasSocialesTable.turneraId, t.id))
    .orderBy(obrasSocialesTable.nombre);
  const practicas = await db
    .select({ codigo: turneraPracticasTable.codigo, descripcion: turneraPracticasTable.descripcion })
    .from(turneraPracticasTable)
    .where(eq(turneraPracticasTable.turneraId, t.id))
    .orderBy(turneraPracticasTable.codigo);
  return { ...t, diasAtencion, especialidad, profesional, sede, participantesIds, obrasSociales, practicas };
}

// Versión batch de enrichTurnera: con la DB remota, 6 consultas POR turnera
// (N+1) hacen inusable el listado; acá son 6 consultas EN TOTAL.
async function enrichTurnerasBatch(turneras: (typeof turnerasTable.$inferSelect)[]) {
  if (turneras.length === 0) return [];
  const ids = turneras.map((t) => t.id);
  const espIds = [...new Set(turneras.map((t) => t.especialidadId).filter((x): x is number => x != null))];
  const profIds = [...new Set(turneras.map((t) => t.profesionalId).filter((x): x is number => x != null))];
  const sedeIds = [...new Set(turneras.map((t) => t.sedeId).filter((x): x is number => x != null))];

  const [esps, profs, sedes, participantes, obrasSociales, practicas] = await Promise.all([
    espIds.length ? db.select().from(especialidadesTable).where(inArray(especialidadesTable.id, espIds)) : [],
    profIds.length ? db.select().from(profesionalesTable).where(inArray(profesionalesTable.id, profIds)) : [],
    sedeIds.length ? db.select().from(sedesTable).where(inArray(sedesTable.id, sedeIds)) : [],
    db.select().from(turneraParticipantesTable).where(inArray(turneraParticipantesTable.turneraId, ids)),
    db
      .select({
        turneraId: turneraObrasSocialesTable.turneraId,
        obraSocialId: turneraObrasSocialesTable.obraSocialId,
        cupoDiario: turneraObrasSocialesTable.cupoDiario,
        nombre: obrasSocialesTable.nombre,
      })
      .from(turneraObrasSocialesTable)
      .innerJoin(obrasSocialesTable, eq(turneraObrasSocialesTable.obraSocialId, obrasSocialesTable.id))
      .where(inArray(turneraObrasSocialesTable.turneraId, ids))
      .orderBy(obrasSocialesTable.nombre),
    db
      .select({
        turneraId: turneraPracticasTable.turneraId,
        codigo: turneraPracticasTable.codigo,
        descripcion: turneraPracticasTable.descripcion,
      })
      .from(turneraPracticasTable)
      .where(inArray(turneraPracticasTable.turneraId, ids))
      .orderBy(turneraPracticasTable.codigo),
  ]);

  const espById = new Map(esps.map((e) => [e.id, e]));
  const profById = new Map(profs.map((p) => [p.id, p]));
  const sedeById = new Map(sedes.map((s) => [s.id, s]));
  const partsBy = new Map<number, number[]>();
  for (const p of participantes) {
    (partsBy.get(p.turneraId) ?? partsBy.set(p.turneraId, []).get(p.turneraId)!).push(p.profesionalId);
  }
  const osBy = new Map<number, { obraSocialId: number; cupoDiario: number | null; nombre: string }[]>();
  for (const o of obrasSociales) {
    const { turneraId, ...resto } = o;
    (osBy.get(turneraId) ?? osBy.set(turneraId, []).get(turneraId)!).push(resto);
  }
  const pracBy = new Map<number, { codigo: string; descripcion: string | null }[]>();
  for (const p of practicas) {
    const { turneraId, ...resto } = p;
    (pracBy.get(turneraId) ?? pracBy.set(turneraId, []).get(turneraId)!).push(resto);
  }

  return turneras.map((t) => ({
    ...t,
    diasAtencion: t.diasAtencion ? t.diasAtencion.split(",").map(Number) : [],
    especialidad: (t.especialidadId != null ? espById.get(t.especialidadId) : null) ?? null,
    profesional: (t.profesionalId != null ? profById.get(t.profesionalId) : null) ?? null,
    sede: (t.sedeId != null ? sedeById.get(t.sedeId) : null) ?? null,
    participantesIds: partsBy.get(t.id) ?? [],
    obrasSociales: osBy.get(t.id) ?? [],
    practicas: pracBy.get(t.id) ?? [],
  }));
}

router.get("/turneras", async (req, res): Promise<void> => {
  const params = ListTurnerasQueryParams.safeParse(req.query);
  const conditions: SQL[] = [];
  if (params.success) {
    if (params.data.sedeId != null) conditions.push(eq(turnerasTable.sedeId, params.data.sedeId));
    if (params.data.especialidadId != null) conditions.push(eq(turnerasTable.especialidadId, params.data.especialidadId));
    if (params.data.profesionalId != null) conditions.push(eq(turnerasTable.profesionalId, params.data.profesionalId));
    if (params.data.activa != null) conditions.push(eq(turnerasTable.activa, params.data.activa));
    // visibilidad es multi-canal ("online,recepcion"): el filtro matchea contención
    if (params.data.visibilidad != null) conditions.push(like(turnerasTable.visibilidad, `%${params.data.visibilidad}%`));
  }
  const turneras = await db.select().from(turnerasTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(turnerasTable.nombre);
  res.json(await enrichTurnerasBatch(turneras));
});

// La sala asociada a una agenda debe existir (filtro de pantallas TV).
async function salaLlamadoExiste(id: number): Promise<boolean> {
  const [row] = await db
    .select({ id: salasLlamadoTable.id })
    .from(salasLlamadoTable)
    .where(eq(salasLlamadoTable.id, id))
    .limit(1);
  return row != null;
}

router.post("/turneras", soloStaff, async (req, res): Promise<void> => {
  const parsed = CreateTurneraBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { diasAtencion, participantesIds, obrasSociales, practicas, horariosDia, confirmarDuplicado, ...rest } = parsed.data;
  if (rest.horaFin <= rest.horaInicio) {
    res.status(400).json({ error: "La hora de fin debe ser posterior a la hora de inicio" });
    return;
  }
  if (rest.salaLlamadoId != null && !(await salaLlamadoExiste(rest.salaLlamadoId))) {
    res.status(400).json({ error: "La sala de espera indicada no existe" });
    return;
  }
  let diasStr = Array.isArray(diasAtencion) ? diasAtencion.join(",") : "1,2,3,4,5";
  let extras: Partial<typeof turnerasTable.$inferInsert> = { horariosDia: null };
  if (horariosDia !== undefined && horariosDia.length > 0) {
    const norm = normalizarHorariosDia(horariosDia);
    if ("error" in norm) {
      res.status(400).json({ error: norm.error });
      return;
    }
    diasStr = norm.dias.join(",");
    extras = { horariosDia: norm.horariosDia, horaInicio: norm.horaInicio, horaFin: norm.horaFin };
  }
  // Anti-duplicados de guardias: si ya existe una turnera con el mismo
  // nombre+sede+esGuardia se REUTILIZA (se actualiza y reactiva) en vez de
  // crear otra. Evita que re-creaciones/reimportaciones ensucien el dropdown
  // "Pantalla por guardia" con turneras de guardia repetidas.
  if (rest.esGuardia) {
    const guardias = await db
      .select()
      .from(turnerasTable)
      .where(eq(turnerasTable.esGuardia, true))
      .orderBy(turnerasTable.id);
    const nombreNorm = normalizarNombre(rest.nombre);
    const candidatas = guardias.filter(
      (g) => normalizarNombre(g.nombre) === nombreNorm && (g.sedeId ?? null) === (rest.sedeId ?? null),
    );
    const existente = candidatas.find((g) => g.activa) ?? candidatas[0];
    if (existente) {
      const [t] = await db
        .update(turnerasTable)
        .set({ ...rest, ...extras, diasAtencion: diasStr, activa: true })
        .where(eq(turnerasTable.id, existente.id))
        .returning();
      await guardarParticipantes(t.id, participantesIds);
      await guardarObrasSociales(t.id, obrasSociales);
      await guardarPracticas(t.id, practicas);
      res.status(200).json(await enrichTurnera(t));
      return;
    }
  }
  // Aviso anti-duplicados (no guardias): si el mismo profesional ya tiene una
  // agenda ACTIVA en la misma sede+especialidad con horario superpuesto, se
  // responde 409 para que la UI pida confirmación antes de duplicar el
  // mosaico de Nuevo Turno. Con confirmarDuplicado=true se crea igual.
  if (!rest.esGuardia && rest.profesionalId != null && !confirmarDuplicado) {
    const candidatas = await db
      .select()
      .from(turnerasTable)
      .where(and(
        eq(turnerasTable.profesionalId, rest.profesionalId),
        eq(turnerasTable.activa, true),
        eq(turnerasTable.esGuardia, false),
        rest.sedeId != null ? eq(turnerasTable.sedeId, rest.sedeId) : isNull(turnerasTable.sedeId),
        rest.especialidadId != null ? eq(turnerasTable.especialidadId, rest.especialidadId) : isNull(turnerasTable.especialidadId),
      ))
      .orderBy(turnerasTable.id);
    // Bloques nuevos: uno por día si usa horarios por día, o el rango global.
    const bloques: BloqueNuevo[] =
      extras.horariosDia && Array.isArray(extras.horariosDia) && extras.horariosDia.length > 0
        ? (extras.horariosDia as HorarioDia[]).map((h) => ({ dias: [h.dia], horaInicio: h.horaInicio, horaFin: h.horaFin }))
        : [{ dias: diasStr.split(",").map(Number), horaInicio: rest.horaInicio, horaFin: rest.horaFin }];
    const candidatasReuso = candidatas.map((c) => ({
      id: c.id,
      activa: c.activa,
      diasAtencion: c.diasAtencion ?? "",
      horaInicio: c.horaInicio,
      horaFin: c.horaFin,
    }));
    let elegida: ReturnType<typeof elegirTurneraReutilizable> = null;
    for (const b of bloques) {
      // Solo cuenta si además comparten al menos un día de atención
      const conDia = candidatasReuso.filter((c) =>
        c.diasAtencion.split(",").map(Number).some((d) => b.dias.includes(d)),
      );
      elegida = elegirTurneraReutilizable(conDia, b);
      if (elegida) break;
    }
    if (elegida) {
      const existente = candidatas.find((c) => c.id === elegida!.turneraId)!;
      res.status(409).json({
        error: `El profesional ya tiene la agenda activa "${existente.nombre}" en esa sede con horario superpuesto`,
        codigo: "turnera_duplicada",
        turneraExistente: {
          id: existente.id,
          nombre: existente.nombre,
          horaInicio: existente.horaInicio,
          horaFin: existente.horaFin,
          diasAtencion: existente.diasAtencion ? existente.diasAtencion.split(",").map(Number) : [],
        },
      });
      return;
    }
  }
  const [t] = await db.insert(turnerasTable).values({ ...rest, ...extras, diasAtencion: diasStr }).returning();
  await guardarParticipantes(t.id, participantesIds);
  await guardarObrasSociales(t.id, obrasSociales);
  await guardarPracticas(t.id, practicas);
  res.status(201).json(await enrichTurnera(t));
});

// GET /turneras/proximos-huecos — próximos horarios libres de una o varias
// turneras, calculados en el servidor de una sola vez (para el asistente de
// turnos). OJO: debe registrarse ANTES de /turneras/:id para que "proximos-
// huecos" no se interprete como un id.
router.get("/turneras/proximos-huecos", async (req, res): Promise<void> => {
  // Solo usuarios logueados: es un cálculo pesado y de uso interno (staff).
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? await getUserIdFromToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const query = GetProximosHuecosQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const ids = query.data.turneraIds
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0 || ids.length > 20) {
    res.status(400).json({ error: "turneraIds debe tener entre 1 y 20 ids" });
    return;
  }
  const limit = Math.min(Math.max(query.data.limit ?? 8, 1), 30);

  const turneras = await db.select().from(turnerasTable)
    .where(and(inArray(turnerasTable.id, ids), eq(turnerasTable.activa, true)));
  if (turneras.length === 0) {
    res.json([]);
    return;
  }

  // Fechas del rango a recorrer (hoy + 29 días).
  const base = new Date();
  const fechas: string[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    fechas.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }

  // Una sola consulta trae todos los turnos del rango; se agrupan por
  // turnera+fecha para no golpear la base una vez por turnera por día.
  const idsActivos = turneras.map((t) => t.id);
  const turnosRango = await db.select().from(turnosTable).where(and(
    inArray(turnosTable.turneraId, idsActivos),
    gte(turnosTable.fecha, fechas[0]),
    lte(turnosTable.fecha, fechas[fechas.length - 1]),
  ));
  const turnosPorClave = new Map<string, typeof turnosRango>();
  for (const t of turnosRango) {
    const clave = `${t.turneraId}|${t.fecha}`;
    const lista = turnosPorClave.get(clave);
    if (lista) lista.push(t);
    else turnosPorClave.set(clave, [t]);
  }

  // Recorre los días juntando huecos libres de todas las turneras pedidas,
  // en orden cronológico, hasta llenar el límite.
  const huecos: { turneraId: number; fecha: string; hora: string }[] = [];
  for (const fecha of fechas) {
    if (huecos.length >= limit) break;
    const slotsDia = (
      await Promise.all(
        turneras.map((t) =>
          calcularSlotsDisponibles(t, fecha, turnosPorClave.get(`${t.id}|${fecha}`) ?? []),
        ),
      )
    ).flat();
    const libres = slotsDia
      .filter((s) => s.disponible)
      .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));
    // Variedad: como mucho 3 huecos por día, para mostrar opciones de
    // distintos días en vez de llenar la lista con la primera mañana libre.
    let delDia = 0;
    for (const s of libres) {
      if (huecos.length >= limit || delDia >= 3) break;
      huecos.push({ turneraId: s.turneraId, fecha: s.fecha, hora: s.horaInicio });
      delDia++;
    }
  }
  res.json(huecos);
});

// GET /turneras/disponibilidad-agregada — slots libres de TODAS las turneras
// activas que coinciden con sede/especialidad para una fecha, cada uno
// identificado con su turnera y profesional. Alimenta la vista "Todos los
// profesionales" de la agenda por médico. Excluye guardias (esGuardia): la
// demanda espontánea no tiene horarios. OJO: debe registrarse ANTES de
// /turneras/:id para que "disponibilidad-agregada" no se interprete como id.
router.get("/turneras/disponibilidad-agregada", async (req, res): Promise<void> => {
  // Solo usuarios logueados: cálculo pesado, de uso interno (staff).
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? await getUserIdFromToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const query = GetDisponibilidadAgregadaQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { fecha, sedeId, especialidadId } = query.data;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    res.status(400).json({ error: "Fecha inválida (formato YYYY-MM-DD)" });
    return;
  }

  const conds: SQL[] = [eq(turnerasTable.activa, true), eq(turnerasTable.esGuardia, false)];
  if (sedeId != null) conds.push(eq(turnerasTable.sedeId, sedeId));
  if (especialidadId != null) conds.push(eq(turnerasTable.especialidadId, especialidadId));
  const turneras = await db.select().from(turnerasTable).where(and(...conds));
  if (turneras.length === 0) {
    res.json([]);
    return;
  }

  // Una sola consulta trae todos los turnos del día de esas turneras.
  const ids = turneras.map((t) => t.id);
  const turnosDia = await db.select().from(turnosTable)
    .where(and(inArray(turnosTable.turneraId, ids), eq(turnosTable.fecha, fecha)));
  const turnosPorTurnera = new Map<number, typeof turnosDia>();
  for (const t of turnosDia) {
    const lista = turnosPorTurnera.get(t.turneraId);
    if (lista) lista.push(t);
    else turnosPorTurnera.set(t.turneraId, [t]);
  }

  // Nombres de profesionales en lote (para etiquetar cada slot).
  const profIds = [...new Set(turneras.map((t) => t.profesionalId).filter((x): x is number => x != null))];
  const profs = profIds.length
    ? await db.select().from(profesionalesTable).where(inArray(profesionalesTable.id, profIds))
    : [];
  const profById = new Map(profs.map((p) => [p.id, [p.apellido, p.nombre].filter(Boolean).join(", ")]));

  const slots = (
    await Promise.all(
      turneras.map((t) =>
        calcularSlotsDisponibles(t, fecha, turnosPorTurnera.get(t.id) ?? []),
      ),
    )
  ).flat();
  const turneraById = new Map(turneras.map((t) => [t.id, t]));
  const libres = slots
    .filter((s) => s.disponible)
    .map((s) => {
      const t = turneraById.get(s.turneraId)!;
      return {
        turneraId: s.turneraId,
        turneraNombre: t.nombre,
        profesionalNombre: (t.profesionalId != null ? profById.get(t.profesionalId) : null) ?? null,
        fecha: s.fecha,
        horaInicio: s.horaInicio,
        horaFin: s.horaFin,
      };
    })
    .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio) || a.turneraNombre.localeCompare(b.turneraNombre, "es"));
  res.json(libres);
});

// GET /turneras/proximo-hueco-agregado — primer slot libre DESPUÉS de una
// fecha entre todas las turneras activas que coinciden con sede/especialidad
// (excluye guardias). Alimenta el aviso "próximo turno libre" cuando el día
// elegido en la vista combinada está completo. Devuelve una lista con 0 o 1
// slot. OJO: debe registrarse ANTES de /turneras/:id.
router.get("/turneras/proximo-hueco-agregado", async (req, res): Promise<void> => {
  // Solo usuarios logueados: cálculo pesado, de uso interno (staff).
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? await getUserIdFromToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const query = GetProximoHuecoAgregadoQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { desde, sedeId, especialidadId } = query.data;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
    res.status(400).json({ error: "Fecha inválida (formato YYYY-MM-DD)" });
    return;
  }

  const conds: SQL[] = [eq(turnerasTable.activa, true), eq(turnerasTable.esGuardia, false)];
  if (sedeId != null) conds.push(eq(turnerasTable.sedeId, sedeId));
  if (especialidadId != null) conds.push(eq(turnerasTable.especialidadId, especialidadId));
  const turneras = await db.select().from(turnerasTable).where(and(...conds));
  if (turneras.length === 0) {
    res.json([]);
    return;
  }

  // Fechas a recorrer: desde el día SIGUIENTE al pedido, 30 días.
  const [y, m, d] = desde.split("-").map(Number);
  const fechas: string[] = [];
  for (let i = 1; i <= 30; i++) {
    const dd = new Date(y, m - 1, d + i);
    fechas.push(`${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, "0")}-${String(dd.getDate()).padStart(2, "0")}`);
  }

  // Una sola consulta trae todos los turnos del rango, agrupados por
  // turnera+fecha para no golpear la base una vez por turnera por día.
  const ids = turneras.map((t) => t.id);
  const turnosRango = await db.select().from(turnosTable).where(and(
    inArray(turnosTable.turneraId, ids),
    gte(turnosTable.fecha, fechas[0]),
    lte(turnosTable.fecha, fechas[fechas.length - 1]),
  ));
  const turnosPorClave = new Map<string, typeof turnosRango>();
  for (const t of turnosRango) {
    const clave = `${t.turneraId}|${t.fecha}`;
    const lista = turnosPorClave.get(clave);
    if (lista) lista.push(t);
    else turnosPorClave.set(clave, [t]);
  }

  const turneraById = new Map(turneras.map((t) => [t.id, t]));
  for (const fecha of fechas) {
    const slots = (
      await Promise.all(
        turneras.map((t) =>
          calcularSlotsDisponibles(t, fecha, turnosPorClave.get(`${t.id}|${fecha}`) ?? []),
        ),
      )
    ).flat();
    const libres = slots
      .filter((s) => s.disponible)
      .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));
    if (libres.length === 0) continue;
    const s = libres[0];
    const t = turneraById.get(s.turneraId)!;
    let profesionalNombre: string | null = null;
    if (t.profesionalId != null) {
      const [p] = await db.select().from(profesionalesTable)
        .where(eq(profesionalesTable.id, t.profesionalId)).limit(1);
      if (p) profesionalNombre = [p.apellido, p.nombre].filter(Boolean).join(", ");
    }
    res.json([{
      turneraId: s.turneraId,
      turneraNombre: t.nombre,
      profesionalNombre,
      fecha: s.fecha,
      horaInicio: s.horaInicio,
      horaFin: s.horaFin,
    }]);
    return;
  }
  res.json([]);
});

router.get("/turneras/:id", async (req, res): Promise<void> => {
  const params = GetTurneraParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [t] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, params.data.id)).limit(1);
  if (!t) {
    res.status(404).json({ error: "Turnera no encontrada" });
    return;
  }
  res.json(await enrichTurnera(t));
});

router.patch("/turneras/:id", soloStaff, async (req, res): Promise<void> => {
  const params = UpdateTurneraParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateTurneraBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { diasAtencion, participantesIds, obrasSociales, practicas, horariosDia, ...rest } = parsed.data;
  if (rest.salaLlamadoId != null && !(await salaLlamadoExiste(rest.salaLlamadoId))) {
    res.status(400).json({ error: "La sala de espera indicada no existe" });
    return;
  }
  if (rest.horaInicio !== undefined || rest.horaFin !== undefined) {
    const [actual] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, params.data.id)).limit(1);
    if (!actual) {
      res.status(404).json({ error: "Turnera no encontrada" });
      return;
    }
    const inicio = (rest.horaInicio ?? actual.horaInicio ?? "").substring(0, 5);
    const fin = (rest.horaFin ?? actual.horaFin ?? "").substring(0, 5);
    if (fin <= inicio) {
      res.status(400).json({ error: "La hora de fin debe ser posterior a la hora de inicio" });
      return;
    }
  }
  const updateData: Record<string, unknown> = { ...rest };
  if (diasAtencion !== undefined) {
    updateData.diasAtencion = Array.isArray(diasAtencion) ? diasAtencion.join(",") : diasAtencion;
  }
  if (horariosDia !== undefined) {
    if (horariosDia.length === 0) {
      updateData.horariosDia = null;
    } else {
      const norm = normalizarHorariosDia(horariosDia);
      if ("error" in norm) {
        res.status(400).json({ error: norm.error });
        return;
      }
      updateData.horariosDia = norm.horariosDia;
      updateData.horaInicio = norm.horaInicio;
      updateData.horaFin = norm.horaFin;
      updateData.diasAtencion = norm.dias.join(",");
    }
  }
  const [t] = Object.keys(updateData).length > 0
    ? await db.update(turnerasTable).set(updateData).where(eq(turnerasTable.id, params.data.id)).returning()
    : await db.select().from(turnerasTable).where(eq(turnerasTable.id, params.data.id)).limit(1);
  if (!t) {
    res.status(404).json({ error: "Turnera no encontrada" });
    return;
  }
  await guardarParticipantes(t.id, participantesIds);
  await guardarObrasSociales(t.id, obrasSociales);
  await guardarPracticas(t.id, practicas);
  // Caso Holter (01/08/2026): si la corrección pudo convertir la agenda en
  // "de prácticas" (se tildaron prácticas, cambió el sector/especialidad
  // Klinicos o la especialidad), encolar retroactivamente los turnos futuros
  // ya reservados que quedaron sin trabajo. Corre en background y nunca
  // rompe el guardado; el dedup por turno vive en la cola.
  if (
    practicas !== undefined ||
    rest.klinicosSector !== undefined ||
    rest.klinicosEspecialidad !== undefined ||
    rest.especialidadId !== undefined ||
    rest.tipo !== undefined
  ) {
    const token = req.headers.authorization?.replace("Bearer ", "");
    const userId = token ? await getUserIdFromToken(token) : null;
    void encolarTurnosFuturosDeTurnera(t.id, userId);
  }
  res.json(await enrichTurnera(t));
});

router.delete("/turneras/:id", soloStaff, async (req, res): Promise<void> => {
  const params = DeleteTurneraParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db.delete(turneraParticipantesTable).where(eq(turneraParticipantesTable.turneraId, params.data.id));
  await db.delete(turneraObrasSocialesTable).where(eq(turneraObrasSocialesTable.turneraId, params.data.id));
  await db.delete(turneraPracticasTable).where(eq(turneraPracticasTable.turneraId, params.data.id));
  await db.delete(bloqueosTable).where(eq(bloqueosTable.turneraId, params.data.id));
  await db.delete(turnerasTable).where(eq(turnerasTable.id, params.data.id));
  res.sendStatus(204);
});

// GET /turneras/:id/disponibilidad/:fecha
router.get("/turneras/:id/disponibilidad/:fecha", async (req, res): Promise<void> => {
  const params = GetDisponibilidadTurneraParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { id, fecha } = params.data;
  const [turnera] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, id)).limit(1);
  if (!turnera) {
    res.status(404).json({ error: "Turnera no encontrada" });
    return;
  }

  res.json(await calcularSlotsDisponibles(turnera, fecha));
});

// POST /turneras/:id/bloqueos
router.post("/turneras/:id/bloqueos", soloStaff, async (req, res): Promise<void> => {
  const params = CreateBloqueoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateBloqueoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [bloqueo] = await db.insert(bloqueosTable).values({
    turneraId: params.data.id,
    fechaDesde: new Date(parsed.data.fechaDesde),
    fechaHasta: new Date(parsed.data.fechaHasta),
    motivo: parsed.data.motivo,
  }).returning();
  res.status(201).json(bloqueo);
});

// ── Cancelación masiva de turnera + aviso WhatsApp (Whaticket) ─────────────
// Estados terminales que no se tocan en una cancelación masiva.
const ESTADOS_NO_CANCELABLES = ["cancelado", "anulado", "ausente", "atendido", "finalizado"];

const soloAdminRecepcion = requireRol("admin", "recepcionista");

function fechaISO(d: Date): string {
  return d.toISOString().split("T")[0];
}

const sqlNombrePaciente = sql<string | null>`${pacientesTable.apellido} || ', ' || ${pacientesTable.nombre}`;

async function buscarTurnosAfectados(turneraId: number, fechaDesde: string, fechaHasta: string) {
  return db
    .select({
      turnoId: turnosTable.id,
      fecha: turnosTable.fecha,
      horaInicio: turnosTable.horaInicio,
      estado: turnosTable.estado,
      pacienteId: turnosTable.pacienteId,
      pacienteNombre: sqlNombrePaciente,
      pacienteDni: pacientesTable.dni,
      telefono: pacientesTable.telefono,
      telefonoAlternativo: pacientesTable.telefonoAlternativo,
    })
    .from(turnosTable)
    .leftJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .where(
      and(
        eq(turnosTable.turneraId, turneraId),
        gte(turnosTable.fecha, fechaDesde),
        lte(turnosTable.fecha, fechaHasta),
        notInArray(turnosTable.estado, ESTADOS_NO_CANCELABLES),
      ),
    )
    .orderBy(turnosTable.fecha, turnosTable.horaInicio);
}

// POST /turneras/:id/turnos-afectados — vista previa (no modifica nada)
router.post("/turneras/:id/turnos-afectados", soloAdminRecepcion, async (req, res): Promise<void> => {
  const params = GetTurnosAfectadosTurneraParams.safeParse(req.params);
  const body = GetTurnosAfectadosTurneraBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  const [turnera] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, params.data.id)).limit(1);
  if (!turnera) {
    res.status(404).json({ error: "Turnera no encontrada" });
    return;
  }
  const fechaDesde = fechaISO(body.data.fechaDesde);
  const fechaHasta = fechaISO(body.data.fechaHasta);
  const turnos = await buscarTurnosAfectados(turnera.id, fechaDesde, fechaHasta);
  const enriched = await enrichTurnera(turnera);
  const items = turnos.map((t) => ({
    turnoId: t.turnoId,
    fecha: t.fecha,
    horaInicio: t.horaInicio,
    estado: t.estado,
    pacienteId: t.pacienteId ?? 0,
    pacienteNombre: t.pacienteNombre,
    pacienteDni: t.pacienteDni,
    telefono: t.telefono ?? t.telefonoAlternativo ?? null,
    tieneTelefono: Boolean(t.telefono ?? t.telefonoAlternativo),
  }));
  res.json({
    turneraId: turnera.id,
    turneraNombre: turnera.nombre,
    profesionalNombre: enriched.profesional ? `${enriched.profesional.apellido}, ${enriched.profesional.nombre}` : null,
    sedeNombre: enriched.sede?.nombre ?? null,
    totalTurnos: items.length,
    conTelefono: items.filter((t) => t.tieneTelefono).length,
    sinTelefono: items.filter((t) => !t.tieneTelefono).length,
    whaticketConfigurado: whaticketConfigurado(),
    plantillaDefault: PLANTILLA_CANCELACION_DEFAULT,
    turnos: items,
  });
});

// POST /turneras/:id/cancelar — cancela turnos del rango y notifica por WhatsApp
router.post("/turneras/:id/cancelar", soloAdminRecepcion, async (req, res): Promise<void> => {
  const params = CancelarTurneraMasivoParams.safeParse(req.params);
  const body = CancelarTurneraMasivoBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Datos inválidos" });
    return;
  }
  // Se valida la contraseña del usuario REAL de la sesión (no el simulado por
  // "vista rol"), para que la auditoría refleje quién hizo la cancelación.
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  const operadorId = token ? await getUserIdFromToken(token) : null;
  const [operador] = operadorId
    ? await db.select().from(usersTable).where(eq(usersTable.id, operadorId)).limit(1)
    : [];
  if (!operador || operador.passwordHash !== hashPassword(body.data.password)) {
    res.status(403).json({ error: "Contraseña incorrecta" });
    return;
  }
  const [turnera] = await db.select().from(turnerasTable).where(eq(turnerasTable.id, params.data.id)).limit(1);
  if (!turnera) {
    res.status(404).json({ error: "Turnera no encontrada" });
    return;
  }
  const fechaDesde = fechaISO(body.data.fechaDesde);
  const fechaHasta = fechaISO(body.data.fechaHasta);
  if (fechaDesde > fechaHasta) {
    res.status(400).json({ error: "El rango de fechas es inválido" });
    return;
  }
  const enriched = await enrichTurnera(turnera);
  let turnos = await buscarTurnosAfectados(turnera.id, fechaDesde, fechaHasta);
  // Si vienen turnoIds, se cancelan solo esos (validados contra la turnera y el rango)
  if (body.data.turnoIds && body.data.turnoIds.length > 0) {
    const seleccionados = new Set(body.data.turnoIds);
    turnos = turnos.filter((t) => seleccionados.has(t.turnoId));
    if (turnos.length === 0) {
      res.status(400).json({ error: "Ninguno de los turnos seleccionados es cancelable en ese rango" });
      return;
    }
  }
  const loteId = randomUUID();
  const plantilla = body.data.plantilla?.trim() || PLANTILLA_CANCELACION_DEFAULT;
  const motivoTexto = body.data.motivo?.trim() ? ` (motivo: ${body.data.motivo.trim()})` : "";

  let turnosCancelados = 0;
  let enviadas = 0;
  let simuladas = 0;
  let fallidas = 0;
  let sinTelefono = 0;

  for (const t of turnos) {
    const [actualizado] = await db
      .update(turnosTable)
      .set({ estado: "cancelado" })
      .where(and(eq(turnosTable.id, t.turnoId), notInArray(turnosTable.estado, ESTADOS_NO_CANCELABLES)))
      .returning({ id: turnosTable.id });
    if (!actualizado) continue;
    turnosCancelados++;
    await registrarEventoTurnoRobot(t.turnoId, "cancelacion");
    // Cancelación MASIVA: cancela trabajos Klinicos pendientes, pero NUNCA
    // anula prestaciones ya cargadas (queda warning para anular a mano).
    void cancelarTrabajosDeTurno(t.turnoId, { anularSiCargado: false });
    void sincronizarWorklistTurno(t.turnoId, req.log);

    if (!body.data.notificar || !t.pacienteId) continue;

    const telefono = t.telefono ?? t.telefonoAlternativo ?? null;
    const contenido = renderPlantilla(plantilla, {
      nombre: (t.pacienteNombre ?? "").split(",").pop()?.trim() || "paciente",
      clinica: "Diagnosticar",
      turnera: turnera.nombre,
      profesional: enriched.profesional ? `${enriched.profesional.apellido}, ${enriched.profesional.nombre}` : "el profesional",
      sede: enriched.sede?.nombre ?? "la sede",
      fecha: t.fecha,
      hora: t.horaInicio,
      motivo: motivoTexto,
    });

    let estadoEntrega = "simulada";
    let errorDetalle: string | null = null;
    if (!telefono) {
      estadoEntrega = "fallida";
      errorDetalle = "El paciente no tiene teléfono registrado";
      sinTelefono++;
    } else {
      const r = await enviarWhatsappWhaticket(telefono, contenido, req.log, {
        templateId: PLANTILLA_META_CANCELACION_ID,
      });
      estadoEntrega = r.estado;
      if (r.estado === "fallida") errorDetalle = r.error;
    }
    if (estadoEntrega === "enviada") enviadas++;
    else if (estadoEntrega === "simulada") simuladas++;
    else fallidas++;

    await db.insert(notificacionesSalientesTable).values({
      patientId: t.pacienteId,
      turnoId: t.turnoId,
      loteId,
      canal: "whatsapp",
      evento: "turnera_cancelada",
      destinatario: telefono,
      contenido,
      estadoEntrega,
      errorDetalle,
      template: "cancelacion_turnera",
      usuarioOrigenId: operador.id,
    });
  }

  if (body.data.bloquearAgenda) {
    await db.insert(bloqueosTable).values({
      turneraId: turnera.id,
      fechaDesde: new Date(`${fechaDesde}T00:00:00.000Z`),
      fechaHasta: new Date(`${fechaHasta}T23:59:59.000Z`),
      motivo: body.data.motivo?.trim() || "Cancelación masiva de agenda",
    });
  }

  await db.insert(auditLogTable).values({
    usuarioId: operador.id,
    usuarioEmail: operador.email,
    rol: operador.rol,
    accion: "cancelacion_masiva",
    entidad: "turnera",
    entidadId: turnera.id,
    detalle: {
      loteId,
      turneraNombre: turnera.nombre,
      fechaDesde,
      fechaHasta,
      motivo: body.data.motivo?.trim() || null,
      turnosCancelados,
      notificacionesEnviadas: enviadas,
      notificacionesSimuladas: simuladas,
      notificacionesFallidas: fallidas,
    },
  });

  req.log.info(
    { turneraId: turnera.id, loteId, fechaDesde, fechaHasta, turnosCancelados, enviadas, simuladas, fallidas },
    "cancelación masiva de turnera",
  );

  res.json({
    loteId,
    turnosCancelados,
    notificacionesEnviadas: enviadas,
    notificacionesSimuladas: simuladas,
    notificacionesFallidas: fallidas,
    sinTelefono,
  });
});

export default router;
