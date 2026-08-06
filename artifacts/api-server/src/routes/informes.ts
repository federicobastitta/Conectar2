import { Router } from "express";
import { eq, and, desc, inArray, isNull } from "drizzle-orm";
import {
  db,
  informesTable,
  imagenesClaveTable,
  turnosTable,
  pacientesTable,
  profesionalesTable,
  turnerasTable,
  informePlantillasTable,
} from "@workspace/db";
import { getUserFromRequest } from "./auth";
import { enviarTurnoAlPacs } from "../integraciones/pacs-flujo";
import { sincronizarWorklistTurno } from "../integraciones/pacs-worklist";

// La firma escaneada del profesional nunca viaja en las respuestas de informes.
function profesionalSinFirma<T extends { firmaImagen?: string | null }>(p: T | null) {
  if (!p) return null;
  const { firmaImagen, ...resto } = p;
  return resto;
}

const router = Router();

type EstadoTurno =
  | "pendiente"
  | "reservado"
  | "arribo"
  | "llamado"
  | "en_atencion"
  | "visto"
  | "pendiente_informe"
  | "informando"
  | "informado"
  | "publicado"
  | "visto_usuario"
  | "cancelado"
  | "ausente";

const TRANSICIONES_VALIDAS: Record<string, EstadoTurno[]> = {
  pendiente: ["arribo", "cancelado", "ausente"],
  reservado: ["arribo", "cancelado", "ausente"],
  confirmado: ["arribo", "cancelado", "ausente"],
  en_sala: ["llamado", "en_atencion", "cancelado", "ausente"],
  arribo: ["llamado", "en_atencion", "cancelado", "ausente"],
  llamado: ["en_atencion", "arribo", "ausente"],
  en_atencion: ["visto", "pendiente_informe"],
  visto: [],
  pendiente_informe: ["informando"],
  informando: ["informado"],
  informado: ["publicado"],
  publicado: ["visto_usuario"],
  cancelado: [],
  ausente: ["arribo"],
  visto_usuario: [],
};

type AuthUser = NonNullable<Awaited<ReturnType<typeof getUserFromRequest>>>;

const ROLES_LECTURA = ["admin", "recepcionista", "medico"];
const ROLES_ESCRITURA = ["admin", "medico"];

async function requireRoles(
  req: import("express").Request,
  res: import("express").Response,
  roles: string[],
): Promise<AuthUser | null> {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  if (!roles.includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos para esta operación" });
    return null;
  }
  return user;
}

// El médico solo puede operar sobre informes/turnos de su propio profesionalId
function medicoPuedeOperar(user: AuthUser, profesionalId: number | null): boolean {
  if (user.rol !== "medico") return true;
  const propio = user.profesionalId ? Number(user.profesionalId) : null;
  return propio !== null && profesionalId === propio;
}

// El paciente solo puede leer sus propios informes ya publicados
function pacientePuedeLeerInforme(
  user: AuthUser,
  informe: typeof informesTable.$inferSelect,
): boolean {
  const propio = user.pacienteId ? Number(user.pacienteId) : null;
  return (
    propio !== null && informe.pacienteId === propio && informe.estado === "publicado"
  );
}

type UsuarioReq = { rol?: string | null; profesionalId?: string | number | null; pacienteId?: string | number | null };

// La imagen de la firma es dato sensible: solo la reciben el admin, el médico
// dueño del informe, o el paciente dueño cuando el informe está publicado.
function puedeVerFirmaImagen(user: UsuarioReq | undefined, informe: typeof informesTable.$inferSelect): boolean {
  if (!user) return false;
  if (informe.estado !== "firmado" && informe.estado !== "publicado") return false;
  if (user.rol === "admin") return true;
  if (user.rol === "medico") {
    return user.profesionalId != null && Number(user.profesionalId) === informe.profesionalId;
  }
  if (user.rol === "paciente") {
    return informe.estado === "publicado" && user.pacienteId != null && Number(user.pacienteId) === informe.pacienteId;
  }
  return false;
}

async function enrichInforme(informe: typeof informesTable.$inferSelect, user?: UsuarioReq) {
  const imagenes = await db
    .select()
    .from(imagenesClaveTable)
    .where(eq(imagenesClaveTable.informeId, informe.id))
    .orderBy(imagenesClaveTable.orden);

  let paciente = null;
  let profesional = null;
  if (informe.pacienteId) {
    const [p] = await db
      .select()
      .from(pacientesTable)
      .where(eq(pacientesTable.id, informe.pacienteId))
      .limit(1);
    paciente = p ?? null;
  }
  if (informe.profesionalId) {
    const [p] = await db
      .select()
      .from(profesionalesTable)
      .where(eq(profesionalesTable.id, informe.profesionalId))
      .limit(1);
    profesional = p ?? null;
  }
  // La imagen de la firma solo viaja cuando el informe ya está firmado/publicado
  // (para estamparla como "firma y sello" en el documento).
  const profesionalOut = profesional
    ? { ...profesionalSinFirma(profesional), ...(puedeVerFirmaImagen(user, informe) ? { firmaImagen: profesional.firmaImagen ?? null } : {}) }
    : null;
  return { ...informe, imagenes, paciente, profesional: profesionalOut };
}

// ── PATCH /turnos/:id/estado ─────────────────────────────────────────────

const ROLES_ESTADO = ["admin", "recepcionista", "medico"];
// El médico solo puede realizar transiciones clínicas (nunca las de recepción:
// arribo, llamado, ausente, cancelado) y solo sobre sus propios turnos.
const ESTADOS_MEDICO = ["en_atencion", "visto", "pendiente_informe", "informando", "informado"];

router.patch("/turnos/:id/estado", async (req, res): Promise<void> => {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  if (!ROLES_ESTADO.includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos para cambiar el estado del turno" });
    return;
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const { estado: nuevoEstado, observaciones, atendidoPorProfesionalId } = req.body as {
    estado?: string;
    observaciones?: string;
    atendidoPorProfesionalId?: number;
  };

  if (!nuevoEstado) {
    res.status(400).json({ error: "estado requerido" });
    return;
  }

  const [turno] = await db
    .select()
    .from(turnosTable)
    .where(eq(turnosTable.id, id))
    .limit(1);

  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }

  if (user.rol === "medico") {
    if (!ESTADOS_MEDICO.includes(nuevoEstado)) {
      res.status(403).json({
        error: "El médico no puede realizar transiciones de recepción",
        estadosPermitidos: ESTADOS_MEDICO,
      });
      return;
    }
    const propioProfesionalId = user.profesionalId ? Number(user.profesionalId) : null;
    if (!propioProfesionalId || turno.profesionalId !== propioProfesionalId) {
      res.status(403).json({ error: "Solo puede cambiar el estado de sus propios turnos" });
      return;
    }
  }

  const estadoActual = turno.estado as EstadoTurno;
  const transiciones = TRANSICIONES_VALIDAS[estadoActual] ?? [];
  if (!transiciones.includes(nuevoEstado as EstadoTurno)) {
    res.status(422).json({
      error: `Transición no permitida: ${estadoActual} → ${nuevoEstado}`,
      transicionesValidas: transiciones,
    });
    return;
  }

  const updateData: Partial<typeof turnosTable.$inferInsert> = {
    estado: nuevoEstado,
  };
  if (observaciones !== undefined) updateData.observaciones = observaciones;

  // Atribución manual: cuando recepción/admin cierra un turno sin médico
  // (grupal/guardia sin llamado previo), puede indicar quién lo atendió.
  // Nunca pisa una atribución existente (la del llamado real tiene prioridad).
  let atribuyeAtencion = false;
  if (atendidoPorProfesionalId !== undefined) {
    if (user.rol === "medico") {
      res.status(403).json({ error: "Solo recepción o administración pueden atribuir la atención a otro médico" });
      return;
    }
    if (!["visto", "pendiente_informe"].includes(nuevoEstado)) {
      res.status(422).json({ error: "La atribución de atención solo aplica al cerrar la atención (visto o pendiente de informe)" });
      return;
    }
    if (turno.profesionalId != null || turno.llamadoPorProfesionalId != null) {
      res.status(409).json({ error: "El turno ya tiene un médico atribuido; no se puede reasignar" });
      return;
    }
    if (!Number.isInteger(atendidoPorProfesionalId) || atendidoPorProfesionalId <= 0) {
      res.status(400).json({ error: "atendidoPorProfesionalId inválido" });
      return;
    }
    const [prof] = await db
      .select({ id: profesionalesTable.id })
      .from(profesionalesTable)
      .where(and(eq(profesionalesTable.id, atendidoPorProfesionalId), eq(profesionalesTable.activo, true)))
      .limit(1);
    if (!prof) {
      res.status(422).json({ error: "El profesional indicado no existe o está inactivo" });
      return;
    }
    updateData.llamadoPorProfesionalId = atendidoPorProfesionalId;
    atribuyeAtencion = true;
  }

  // Transición atómica: la condición de estado va en el UPDATE para evitar carreras
  const [updated] = await db
    .update(turnosTable)
    .set(updateData)
    .where(and(
      eq(turnosTable.id, id),
      eq(turnosTable.estado, estadoActual),
      // La atribución manual nunca pisa una existente, ni siquiera en carrera
      ...(atribuyeAtencion ? [isNull(turnosTable.llamadoPorProfesionalId)] : []),
    ))
    .returning();

  if (!updated) {
    res.status(422).json({
      error: `El turno cambió de estado mientras se procesaba la solicitud`,
      transicionesValidas: transiciones,
    });
    return;
  }

  // Circuito DiagnostiPACS: al pasar a pendiente_informe se envía el estudio
  // al PACS (solo actúa si la turnera lleva informe; fire-and-forget).
  if (nuevoEstado === "pendiente_informe") {
    void enviarTurnoAlPacs(id, req.log);
  }

  // Worklist PACS v3: reflejar el nuevo estado del turno en la worklist
  // (solo actúa para especialidades con envia_al_pacs; fire-and-forget).
  void sincronizarWorklistTurno(id, req.log);

  res.json(updated);
});

// ── GET /informes/bandeja ─────────────────────────────────────────────────

router.get("/informes/bandeja", async (req, res): Promise<void> => {
  const user = await requireRoles(req, res, ROLES_LECTURA);
  if (!user) return;

  const { profesionalId, sedeId, fecha } = req.query as {
    profesionalId?: string;
    sedeId?: string;
    fecha?: string;
  };

  const estadosPendientes = [
    "pendiente_informe",
    "informando",
    "informado",
    "publicado",
  ];

  const conditions = [inArray(turnosTable.estado, estadosPendientes)];

  if (fecha) conditions.push(eq(turnosTable.fecha, fecha));
  if (profesionalId)
    conditions.push(eq(turnosTable.profesionalId, Number(profesionalId)));

  // El médico ve su propia bandeja (asignados) o, con vista=modalidad,
  // todos los estudios de su misma modalidad/especialidad.
  const { vista } = req.query as { vista?: string };
  if (user.rol === "medico") {
    const propio = user.profesionalId ? Number(user.profesionalId) : null;
    if (!propio) {
      res.status(403).json({ error: "Usuario médico sin profesional vinculado" });
      return;
    }
    if (vista === "modalidad") {
      const [prof] = await db
        .select({ especialidadId: profesionalesTable.especialidadId })
        .from(profesionalesTable)
        .where(eq(profesionalesTable.id, propio))
        .limit(1);
      if (!prof?.especialidadId) {
        res.status(422).json({ error: "El profesional no tiene modalidad/especialidad asignada" });
        return;
      }
      const turnerasModalidad = await db
        .select({ id: turnerasTable.id })
        .from(turnerasTable)
        .where(eq(turnerasTable.especialidadId, prof.especialidadId));
      const ids = turnerasModalidad.map((t) => t.id);
      if (ids.length === 0) {
        res.json([]);
        return;
      }
      conditions.push(inArray(turnosTable.turneraId, ids));
    } else {
      conditions.push(eq(turnosTable.profesionalId, propio));
    }
  }

  const turnos = await db
    .select()
    .from(turnosTable)
    .where(and(...conditions))
    .orderBy(turnosTable.fecha, turnosTable.horaInicio);

  const result = await Promise.all(
    turnos.map(async (t) => {
      let paciente = null;
      let profesional = null;
      if (t.pacienteId) {
        const [p] = await db
          .select()
          .from(pacientesTable)
          .where(eq(pacientesTable.id, t.pacienteId))
          .limit(1);
        paciente = p ?? null;
      }
      if (t.profesionalId) {
        const [p] = await db
          .select()
          .from(profesionalesTable)
          .where(eq(profesionalesTable.id, t.profesionalId))
          .limit(1);
        profesional = p ?? null;
      }
      const [informe] = await db
        .select()
        .from(informesTable)
        .where(eq(informesTable.turnoId, t.id))
        .orderBy(desc(informesTable.createdAt))
        .limit(1);
      return { ...t, paciente, profesional: profesionalSinFirma(profesional), informe: informe ?? null };
    })
  );

  res.json(result);
});

// ── GET /turnos/:id/informe ───────────────────────────────────────────────

router.get("/turnos/:id/informe", async (req, res): Promise<void> => {
  const user = await requireRoles(req, res, [...ROLES_LECTURA, "paciente"]);
  if (!user) return;

  const turnoId = Number(req.params.id);
  if (!Number.isInteger(turnoId)) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const [informe] = await db
    .select()
    .from(informesTable)
    .where(eq(informesTable.turnoId, turnoId))
    .orderBy(desc(informesTable.createdAt))
    .limit(1);

  if (!informe) {
    res.status(404).json({ error: "Informe no encontrado" });
    return;
  }

  if (user.rol === "paciente" && !pacientePuedeLeerInforme(user, informe)) {
    res.status(403).json({ error: "Solo puede ver sus propios informes publicados" });
    return;
  }

  res.json(await enrichInforme(informe, user));
});

// ── POST /turnos/:id/informe ──────────────────────────────────────────────

router.post("/turnos/:id/informe", async (req, res): Promise<void> => {
  const user = await requireRoles(req, res, ROLES_ESCRITURA);
  if (!user) return;

  const turnoId = Number(req.params.id);
  if (!Number.isInteger(turnoId)) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const [turno] = await db
    .select()
    .from(turnosTable)
    .where(eq(turnosTable.id, turnoId))
    .limit(1);

  if (!turno) {
    res.status(404).json({ error: "Turno no encontrado" });
    return;
  }

  if (!medicoPuedeOperar(user, turno.profesionalId)) {
    res.status(403).json({ error: "Solo puede crear informes de sus propios turnos" });
    return;
  }

  const { texto, profesionalId, pacsStudyId, pacsViewerUrl, observaciones } =
    req.body as {
      texto?: string;
      profesionalId?: number;
      pacsStudyId?: string;
      pacsViewerUrl?: string;
      observaciones?: string;
    };

  const [existing] = await db
    .select()
    .from(informesTable)
    .where(eq(informesTable.turnoId, turnoId))
    .limit(1);

  if (existing) {
    res.json(await enrichInforme(existing, user));
    return;
  }

  const [informe] = await db
    .insert(informesTable)
    .values({
      turnoId,
      pacienteId: turno.pacienteId,
      profesionalId:
        profesionalId ?? turno.profesionalId ?? undefined,
      texto: texto ?? "",
      estado: "borrador",
      pacsStudyId: pacsStudyId ?? undefined,
      pacsViewerUrl: pacsViewerUrl ?? undefined,
      observaciones: observaciones ?? undefined,
    })
    .returning();

  if (
    turno.estado === "en_atencion" ||
    turno.estado === "pendiente_informe" ||
    turno.estado === "pendiente" ||
    turno.estado === "reservado"
  ) {
    await db
      .update(turnosTable)
      .set({ estado: "pendiente_informe" })
      .where(eq(turnosTable.id, turnoId));
  }

  res.status(201).json(await enrichInforme(informe, user));
});

// ── PATCH /informes/:id ───────────────────────────────────────────────────

router.patch("/informes/:id", async (req, res): Promise<void> => {
  const user = await requireRoles(req, res, ROLES_ESCRITURA);
  if (!user) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const { texto, pacsStudyId, pacsViewerUrl, observaciones } = req.body as {
    texto?: string;
    pacsStudyId?: string;
    pacsViewerUrl?: string;
    observaciones?: string;
  };

  const [informe] = await db
    .select()
    .from(informesTable)
    .where(eq(informesTable.id, id))
    .limit(1);

  if (!informe) {
    res.status(404).json({ error: "Informe no encontrado" });
    return;
  }

  if (!medicoPuedeOperar(user, informe.profesionalId)) {
    res.status(403).json({ error: "Solo puede editar sus propios informes" });
    return;
  }

  if (informe.estado === "firmado" || informe.estado === "publicado") {
    res.status(422).json({ error: "No se puede editar un informe firmado" });
    return;
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (texto !== undefined) updateData.texto = texto;
  if (pacsStudyId !== undefined) updateData.pacsStudyId = pacsStudyId;
  if (pacsViewerUrl !== undefined) updateData.pacsViewerUrl = pacsViewerUrl;
  if (observaciones !== undefined) updateData.observaciones = observaciones;

  const [updated] = await db
    .update(informesTable)
    .set(updateData)
    .where(eq(informesTable.id, id))
    .returning();

  res.json(await enrichInforme(updated, user));
});

// ── POST /informes/:id/firmar ────────────────────────────────────────────

router.post("/informes/:id/firmar", async (req, res): Promise<void> => {
  const user = await requireRoles(req, res, ROLES_ESCRITURA);
  if (!user) return;

  const id = Number(req.params.id);

  const [informe] = await db
    .select()
    .from(informesTable)
    .where(eq(informesTable.id, id))
    .limit(1);

  if (!informe) {
    res.status(404).json({ error: "Informe no encontrado" });
    return;
  }

  if (!medicoPuedeOperar(user, informe.profesionalId)) {
    res.status(403).json({ error: "Solo puede firmar sus propios informes" });
    return;
  }

  if (!informe.texto?.trim()) {
    res.status(422).json({ error: "El informe debe tener texto antes de firmar" });
    return;
  }

  const { firma } = req.body as { firma?: string };

  const [signed] = await db
    .update(informesTable)
    .set({
      estado: "firmado",
      firma: firma ?? informe.firma ?? "Profesional",
      firmadoEn: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(informesTable.id, id))
    .returning();

  await db
    .update(turnosTable)
    .set({ estado: "informado" })
    .where(eq(turnosTable.id, informe.turnoId));

  res.json(await enrichInforme(signed, user));
});

// ── POST /informes/:id/publicar ──────────────────────────────────────────

router.post("/informes/:id/publicar", async (req, res): Promise<void> => {
  const user = await requireRoles(req, res, ROLES_ESCRITURA);
  if (!user) return;

  const id = Number(req.params.id);

  const [informe] = await db
    .select()
    .from(informesTable)
    .where(eq(informesTable.id, id))
    .limit(1);

  if (!informe) {
    res.status(404).json({ error: "Informe no encontrado" });
    return;
  }

  if (!medicoPuedeOperar(user, informe.profesionalId)) {
    res.status(403).json({ error: "Solo puede publicar sus propios informes" });
    return;
  }

  if (informe.estado !== "firmado") {
    res.status(422).json({ error: "El informe debe estar firmado antes de publicar" });
    return;
  }

  const [published] = await db
    .update(informesTable)
    .set({ estado: "publicado", updatedAt: new Date() })
    .where(eq(informesTable.id, id))
    .returning();

  await db
    .update(turnosTable)
    .set({ estado: "publicado" })
    .where(eq(turnosTable.id, informe.turnoId));

  res.json(await enrichInforme(published, user));
});

// ── POST /informes/:id/imagenes ─────────────────────────────────────────

router.post("/informes/:id/imagenes", async (req, res): Promise<void> => {
  const user = await requireRoles(req, res, ROLES_ESCRITURA);
  if (!user) return;

  const id = Number(req.params.id);

  const [informe] = await db
    .select()
    .from(informesTable)
    .where(eq(informesTable.id, id))
    .limit(1);

  if (!informe) {
    res.status(404).json({ error: "Informe no encontrado" });
    return;
  }

  if (!medicoPuedeOperar(user, informe.profesionalId)) {
    res.status(403).json({ error: "Solo puede modificar sus propios informes" });
    return;
  }

  const existentes = await db
    .select()
    .from(imagenesClaveTable)
    .where(eq(imagenesClaveTable.informeId, id));

  if (existentes.length >= 4) {
    res.status(422).json({ error: "Máximo 4 imágenes clave por informe" });
    return;
  }

  const { url, descripcion } = req.body as { url: string; descripcion?: string };

  if (!url?.trim()) {
    res.status(400).json({ error: "URL requerida" });
    return;
  }

  const orden =
    existentes.length > 0
      ? Math.max(...existentes.map((i) => i.orden)) + 1
      : 1;

  const [imagen] = await db
    .insert(imagenesClaveTable)
    .values({ informeId: id, url: url.trim(), descripcion, orden })
    .returning();

  res.status(201).json(imagen);
});

// ── DELETE /informes/:id/imagenes/:imgId ─────────────────────────────────

router.delete(
  "/informes/:id/imagenes/:imgId",
  async (req, res): Promise<void> => {
    const user = await requireRoles(req, res, ROLES_ESCRITURA);
    if (!user) return;

    const id = Number(req.params.id);
    const imgId = Number(req.params.imgId);

    const [informe] = await db
      .select()
      .from(informesTable)
      .where(eq(informesTable.id, id))
      .limit(1);

    if (!informe) {
      res.status(404).json({ error: "Informe no encontrado" });
      return;
    }

    if (!medicoPuedeOperar(user, informe.profesionalId)) {
      res.status(403).json({ error: "Solo puede modificar sus propios informes" });
      return;
    }

    await db
      .delete(imagenesClaveTable)
      .where(
        and(
          eq(imagenesClaveTable.id, imgId),
          eq(imagenesClaveTable.informeId, id)
        )
      );

    res.sendStatus(204);
  }
);

// ── GET /informes/:id ────────────────────────────────────────────────────

router.get("/informes/:id", async (req, res): Promise<void> => {
  const user = await requireRoles(req, res, [...ROLES_LECTURA, "paciente"]);
  if (!user) return;

  const id = Number(req.params.id);

  const [informe] = await db
    .select()
    .from(informesTable)
    .where(eq(informesTable.id, id))
    .limit(1);

  if (!informe) {
    res.status(404).json({ error: "Informe no encontrado" });
    return;
  }

  if (user.rol === "paciente" && !pacientePuedeLeerInforme(user, informe)) {
    res.status(403).json({ error: "Solo puede ver sus propios informes publicados" });
    return;
  }

  res.json(await enrichInforme(informe, user));
});

// ── Plantillas de informe personales del médico (no compartidas) ─────────

async function requireMedicoConProfesional(
  req: import("express").Request,
  res: import("express").Response,
): Promise<{ user: AuthUser; profesionalId: number } | null> {
  const user = await requireRoles(req, res, ["medico"]);
  if (!user) return null;
  const profesionalId = user.profesionalId ? Number(user.profesionalId) : null;
  if (!profesionalId) {
    res.status(403).json({ error: "Usuario médico sin profesional vinculado" });
    return null;
  }
  return { user, profesionalId };
}

router.get("/informe-plantillas", async (req, res): Promise<void> => {
  const ctx = await requireMedicoConProfesional(req, res);
  if (!ctx) return;
  const plantillas = await db
    .select()
    .from(informePlantillasTable)
    .where(eq(informePlantillasTable.profesionalId, ctx.profesionalId))
    .orderBy(informePlantillasTable.nombre);
  res.json(plantillas);
});

router.post("/informe-plantillas", async (req, res): Promise<void> => {
  const ctx = await requireMedicoConProfesional(req, res);
  if (!ctx) return;
  const { nombre, texto } = req.body as { nombre?: string; texto?: string };
  if (!nombre?.trim() || !texto?.trim()) {
    res.status(400).json({ error: "nombre y texto son obligatorios" });
    return;
  }
  if (nombre.trim().length > 120 || texto.length > 50_000) {
    res.status(400).json({ error: "nombre o texto demasiado largos" });
    return;
  }
  const [plantilla] = await db
    .insert(informePlantillasTable)
    .values({ profesionalId: ctx.profesionalId, nombre: nombre.trim(), texto })
    .returning();
  res.status(201).json(plantilla);
});

router.delete("/informe-plantillas/:id", async (req, res): Promise<void> => {
  const ctx = await requireMedicoConProfesional(req, res);
  if (!ctx) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const [borrada] = await db
    .delete(informePlantillasTable)
    .where(and(eq(informePlantillasTable.id, id), eq(informePlantillasTable.profesionalId, ctx.profesionalId)))
    .returning({ id: informePlantillasTable.id });
  if (!borrada) {
    res.status(404).json({ error: "Plantilla no encontrada" });
    return;
  }
  res.sendStatus(204);
});

export default router;
