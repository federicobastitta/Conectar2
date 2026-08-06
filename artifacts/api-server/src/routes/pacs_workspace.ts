import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq, desc, and, isNull, sql } from "drizzle-orm";
import {
  db,
  studyOrdersTable,
  pacsEventosTable,
  pacsInformesTable,
  informeVersionesTable,
  informeImagenesClavePacsTable,
  pacientesTable,
  profesionalesTable,
} from "@workspace/db";
import { requireRol } from "./auth";
import {
  pacsWorkspaceHabilitado,
  generarAccessionNumber,
  upsertOrden,
  crearSesionVisor,
  estudiosDeOrden,
  verificarFirmaWebhook,
} from "../integraciones/pacs-workspace-v1";

// ── Workspace PACS v1.0 — TODO detrás de PACS_WORKSPACE_ENABLED ─────────────
// Con el flag apagado, todas las rutas de este router devuelven 404 como si
// no existieran (incluido el webhook). No se contacta al PACS jamás.

const router: IRouter = Router();

function soloConFlag(req: Request, res: Response, next: NextFunction): void {
  if (!pacsWorkspaceHabilitado()) {
    res.status(404).json({ error: "No encontrado" });
    return;
  }
  next();
}

router.use("/pacs-workspace", soloConFlag);
router.use("/pacs/webhook", soloConFlag);

// ── Piloto: restricción por email mientras el módulo no esté abierto a todos ─
// Setear PACS_PILOT_EMAILS=email1@dominio.ar,email2@dominio.ar para limitar el
// acceso. Si la variable está vacía o ausente, cualquier usuario con el rol
// correcto puede acceder (comportamiento de producción general).
function soloEnPiloto(res: Response, next: NextFunction): void {
  const emails = (process.env.PACS_PILOT_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (emails.length === 0) { next(); return; }
  const user = res.locals.user as { email: string } | undefined;
  if (!user || !emails.includes(user.email)) {
    res.status(403).json({ error: "Módulo PACS en piloto cerrado — su usuario no tiene acceso aún." });
    return;
  }
  next();
}

function requirePacs(...roles: string[]) {
  const checkRol = requireRol(...(roles as [string, ...string[]]));
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let rolPassed = false;
    await checkRol(req, res, () => { rolPassed = true; });
    if (!rolPassed) return;
    soloEnPiloto(res, next);
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapEstadoOperativo(status: string): string {
  switch (status) {
    case "programado":
    case "pendiente_programacion":
    case "solicitado":
      return "AGENDADO";
    case "en_realizacion":
      return "RECEPCIONADO";
    case "realizado":
      return "PENDIENTE_DE_INFORME";
    case "informado":
    case "entregado":
      return "INFORMADO";
    case "anulada":
      return "AUSENTE";
    default:
      return "AGENDADO";
  }
}

async function getOrdenConPaciente(ordenId: number) {
  const rows = await db
    .select({
      orden: studyOrdersTable,
      paciente: {
        id: pacientesTable.id,
        nombre: pacientesTable.nombre,
        apellido: pacientesTable.apellido,
        dni: pacientesTable.dni,
        cobertura: pacientesTable.cobertura,
        nroAfiliado: pacientesTable.nroAfiliado,
        fechaNacimiento: pacientesTable.fechaNacimiento,
        sexo: pacientesTable.sexo,
      },
      profesional: {
        id: profesionalesTable.id,
        nombre: profesionalesTable.nombre,
        apellido: profesionalesTable.apellido,
        matricula: profesionalesTable.matricula,
      },
    })
    .from(studyOrdersTable)
    .leftJoin(pacientesTable, eq(studyOrdersTable.patientId, pacientesTable.id))
    .leftJoin(profesionalesTable, eq(studyOrdersTable.professionalId, profesionalesTable.id))
    .where(eq(studyOrdersTable.id, ordenId))
    .limit(1);
  return rows[0] ?? null;
}

async function getInformeCompleto(informeId: number) {
  const [imagenes, versiones] = await Promise.all([
    db
      .select()
      .from(informeImagenesClavePacsTable)
      .where(and(
        eq(informeImagenesClavePacsTable.informeId, informeId),
        isNull(informeImagenesClavePacsTable.informeVersionId),
      ))
      .orderBy(informeImagenesClavePacsTable.orden),
    db
      .select()
      .from(informeVersionesTable)
      .where(eq(informeVersionesTable.informeId, informeId))
      .orderBy(informeVersionesTable.version),
  ]);
  return { imagenesClaveBorrador: imagenes, versiones };
}

// ── GET /pacs-workspace/ordenes — Lista de órdenes para el workspace ─────────
router.get(
  "/pacs-workspace/ordenes",
  requirePacs("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const rows = await db
      .select({
        orden: studyOrdersTable,
        paciente: {
          id: pacientesTable.id,
          nombre: pacientesTable.nombre,
          apellido: pacientesTable.apellido,
          dni: pacientesTable.dni,
          cobertura: pacientesTable.cobertura,
          nroAfiliado: pacientesTable.nroAfiliado,
          fechaNacimiento: pacientesTable.fechaNacimiento,
          sexo: pacientesTable.sexo,
        },
        profesional: {
          id: profesionalesTable.id,
          nombre: profesionalesTable.nombre,
          apellido: profesionalesTable.apellido,
        },
        informe: {
          id: pacsInformesTable.id,
          estadoOperativo: pacsInformesTable.estadoOperativo,
          informeEstado: pacsInformesTable.informeEstado,
        },
      })
      .from(studyOrdersTable)
      .leftJoin(pacientesTable, eq(studyOrdersTable.patientId, pacientesTable.id))
      .leftJoin(profesionalesTable, eq(studyOrdersTable.professionalId, profesionalesTable.id))
      .leftJoin(pacsInformesTable, eq(pacsInformesTable.studyOrderId, studyOrdersTable.id))
      .orderBy(desc(studyOrdersTable.createdAt));

    const ordenes = rows.map((r) => ({
      id: r.orden.id,
      accessionNumber: r.orden.accessionNumber,
      modality: r.orden.modality,
      studyName: r.orden.studyName,
      studyType: r.orden.studyType,
      motivoEstudio: r.orden.clinicalJustification,
      observacionesTecnico: r.orden.observacionesTecnico,
      scheduledAt: r.orden.scheduledAt?.toISOString() ?? null,
      status: r.orden.status,
      estadoOperativo: r.informe?.estadoOperativo ?? mapEstadoOperativo(r.orden.status),
      informeEstado: r.informe?.informeEstado ?? null,
      informeId: r.informe?.id ?? null,
      createdAt: r.orden.createdAt.toISOString(),
      paciente: r.paciente ?? null,
      profesional: r.profesional ?? null,
    }));
    res.json({ ordenes });
  },
);

// ── GET /pacs-workspace/ordenes/:id — Detalle de una orden ──────────────────
router.get(
  "/pacs-workspace/ordenes/:id",
  requirePacs("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const ordenId = parseInt(String(req.params.id ?? ""));
    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "ID de orden inválido" });
      return;
    }
    const row = await getOrdenConPaciente(ordenId);
    if (!row) {
      res.status(404).json({ error: "Orden no encontrada" });
      return;
    }
    const [pInforme] = await db
      .select()
      .from(pacsInformesTable)
      .where(eq(pacsInformesTable.studyOrderId, ordenId))
      .limit(1);

    res.json({
      id: row.orden.id,
      accessionNumber: row.orden.accessionNumber,
      modality: row.orden.modality,
      studyName: row.orden.studyName,
      studyType: row.orden.studyType,
      motivoEstudio: row.orden.clinicalJustification,
      observacionesTecnico: row.orden.observacionesTecnico,
      scheduledAt: row.orden.scheduledAt?.toISOString() ?? null,
      status: row.orden.status,
      estadoOperativo: pInforme?.estadoOperativo ?? mapEstadoOperativo(row.orden.status),
      informeEstado: pInforme?.informeEstado ?? null,
      informeId: pInforme?.id ?? null,
      createdAt: row.orden.createdAt.toISOString(),
      paciente: row.paciente,
      profesional: row.profesional,
    });
  },
);

// ── GET /pacs-workspace/ordenes/:id/informe — Obtener o crear informe ────────
router.get(
  "/pacs-workspace/ordenes/:id/informe",
  requirePacs("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const ordenId = parseInt(String(req.params.id ?? ""));
    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "ID de orden inválido" });
      return;
    }
    const [orden] = await db
      .select({ id: studyOrdersTable.id, patientId: studyOrdersTable.patientId })
      .from(studyOrdersTable)
      .where(eq(studyOrdersTable.id, ordenId))
      .limit(1);
    if (!orden) {
      res.status(404).json({ error: "Orden no encontrada" });
      return;
    }
    const user = res.locals.user as { id: number; rol: string; nombre: string };
    // Upsert: crear si no existe
    const [pInforme] = await db
      .insert(pacsInformesTable)
      .values({
        studyOrderId: ordenId,
        estadoOperativo: "AGENDADO",
        informeEstado: "borrador",
        borradorActual: "",
        createdBy: user.id,
      })
      .onConflictDoNothing({ target: pacsInformesTable.studyOrderId })
      .returning();

    const informe = pInforme
      ?? (await db.select().from(pacsInformesTable).where(eq(pacsInformesTable.studyOrderId, ordenId)).limit(1))[0];

    if (!informe) {
      res.status(500).json({ error: "No se pudo obtener el informe" });
      return;
    }
    const { imagenesClaveBorrador, versiones } = await getInformeCompleto(informe.id);
    res.json({
      id: informe.id,
      studyOrderId: informe.studyOrderId,
      estadoOperativo: informe.estadoOperativo,
      informeEstado: informe.informeEstado,
      borradorActual: informe.borradorActual,
      imagenesClaveBorrador: imagenesClaveBorrador.map((k) => ({
        keyImageId: k.keyImageId,
        studyInstanceUid: k.studyInstanceUid,
        seriesInstanceUid: k.seriesInstanceUid,
        sopInstanceUid: k.sopInstanceUid,
        titulo: k.titulo ?? "",
        comentarioMedico: k.comentarioMedico ?? "",
        orden: k.orden,
      })),
      versiones: versiones.map((v) => ({
        id: v.id,
        version: v.version,
        texto: v.texto,
        firmadoPor: v.firmadoPor,
        firmadoPorNombre: v.firmadoPorNombre ?? null,
        firmadoEn: v.firmadoEn?.toISOString() ?? null,
        publicadoEn: v.publicadoEn?.toISOString() ?? null,
      })),
    });
  },
);

// ── PUT /pacs-workspace/ordenes/:id/informe/borrador — Guardar borrador ──────
router.put(
  "/pacs-workspace/ordenes/:id/informe/borrador",
  requirePacs("admin", "medico"),
  async (req, res): Promise<void> => {
    const ordenId = parseInt(String(req.params.id ?? ""));
    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "ID de orden inválido" });
      return;
    }
    const texto = String(req.body?.texto ?? "");
    const [informe] = await db
      .update(pacsInformesTable)
      .set({ borradorActual: texto, informeEstado: "borrador", updatedAt: new Date() })
      .where(eq(pacsInformesTable.studyOrderId, ordenId))
      .returning({ id: pacsInformesTable.id });
    if (!informe) {
      res.status(404).json({ error: "Informe no encontrado. Abrí el workspace primero." });
      return;
    }
    res.json({ ok: true });
  },
);

// ── POST /pacs-workspace/ordenes/:id/informe/firmar ──────────────────────────
// Crea una versión inmutable + congela las imágenes clave del borrador.
router.post(
  "/pacs-workspace/ordenes/:id/informe/firmar",
  requirePacs("admin", "medico"),
  async (req, res): Promise<void> => {
    const ordenId = parseInt(String(req.params.id ?? ""));
    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "ID de orden inválido" });
      return;
    }
    const [informe] = await db
      .select()
      .from(pacsInformesTable)
      .where(eq(pacsInformesTable.studyOrderId, ordenId))
      .limit(1);
    if (!informe) {
      res.status(404).json({ error: "Informe no encontrado" });
      return;
    }
    if (!informe.borradorActual.trim()) {
      res.status(422).json({ error: "El borrador está vacío, no se puede firmar" });
      return;
    }
    const user = res.locals.user as { id: number; rol: string; nombre: string };
    // Contar versiones actuales para asignar número
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(informeVersionesTable)
      .where(eq(informeVersionesTable.informeId, informe.id));
    const nuevaVersion = Number(count) + 1;
    const ahora = new Date();

    // Insertar la versión
    const [version] = await db
      .insert(informeVersionesTable)
      .values({
        informeId: informe.id,
        version: nuevaVersion,
        texto: informe.borradorActual,
        firmadoPor: user.id,
        firmadoPorNombre: user.nombre,
        firmadoEn: ahora,
      })
      .returning();

    if (!version) {
      res.status(500).json({ error: "No se pudo crear la versión" });
      return;
    }

    // Congelar imágenes clave del borrador
    await db
      .update(informeImagenesClavePacsTable)
      .set({ informeVersionId: version.id, congeladaEn: ahora })
      .where(and(
        eq(informeImagenesClavePacsTable.informeId, informe.id),
        isNull(informeImagenesClavePacsTable.informeVersionId),
      ));

    // Actualizar estado del informe y de la orden
    const nuevoEstadoOp = informe.estadoOperativo === "PENDIENTE_DE_INFORME" ? "INFORMADO" : informe.estadoOperativo;
    await db
      .update(pacsInformesTable)
      .set({ informeEstado: "firmado", estadoOperativo: nuevoEstadoOp, updatedAt: ahora })
      .where(eq(pacsInformesTable.id, informe.id));

    req.log.info({ ordenId, version: nuevaVersion, userId: user.id }, "pacs: informe firmado");
    res.json({ ok: true, version: nuevaVersion });
  },
);

// ── POST /pacs-workspace/ordenes/:id/informe/publicar ────────────────────────
router.post(
  "/pacs-workspace/ordenes/:id/informe/publicar",
  requirePacs("admin", "medico"),
  async (req, res): Promise<void> => {
    const ordenId = parseInt(String(req.params.id ?? ""));
    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "ID de orden inválido" });
      return;
    }
    const [informe] = await db
      .select()
      .from(pacsInformesTable)
      .where(eq(pacsInformesTable.studyOrderId, ordenId))
      .limit(1);
    if (!informe) {
      res.status(404).json({ error: "Informe no encontrado" });
      return;
    }
    if (informe.informeEstado !== "firmado") {
      res.status(422).json({ error: "Solo se puede publicar un informe firmado" });
      return;
    }
    // Marcar la última versión como publicada
    const [ultimaVersion] = await db
      .select()
      .from(informeVersionesTable)
      .where(eq(informeVersionesTable.informeId, informe.id))
      .orderBy(desc(informeVersionesTable.version))
      .limit(1);
    if (ultimaVersion && !ultimaVersion.publicadoEn) {
      await db
        .update(informeVersionesTable)
        .set({ publicadoEn: new Date() })
        .where(eq(informeVersionesTable.id, ultimaVersion.id));
    }
    await db
      .update(pacsInformesTable)
      .set({ informeEstado: "publicado", updatedAt: new Date() })
      .where(eq(pacsInformesTable.id, informe.id));

    req.log.info({ ordenId }, "pacs: informe publicado");
    res.json({ ok: true });
  },
);

// ── POST /pacs-workspace/ordenes/:id/informe/corregir ────────────────────────
router.post(
  "/pacs-workspace/ordenes/:id/informe/corregir",
  requirePacs("admin", "medico"),
  async (req, res): Promise<void> => {
    const ordenId = parseInt(String(req.params.id ?? ""));
    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "ID de orden inválido" });
      return;
    }
    const [informe] = await db
      .select()
      .from(pacsInformesTable)
      .where(eq(pacsInformesTable.studyOrderId, ordenId))
      .limit(1);
    if (!informe) {
      res.status(404).json({ error: "Informe no encontrado" });
      return;
    }
    await db
      .update(pacsInformesTable)
      .set({ informeEstado: "borrador", updatedAt: new Date() })
      .where(eq(pacsInformesTable.id, informe.id));
    res.json({ ok: true });
  },
);

// ── PUT /pacs-workspace/ordenes/:id/informe/imagenes-clave ───────────────────
// Reemplaza las imágenes clave del borrador (draft, sin versión asignada).
router.put(
  "/pacs-workspace/ordenes/:id/informe/imagenes-clave",
  requirePacs("admin", "medico"),
  async (req, res): Promise<void> => {
    const ordenId = parseInt(String(req.params.id ?? ""));
    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "ID de orden inválido" });
      return;
    }
    const [informe] = await db
      .select()
      .from(pacsInformesTable)
      .where(eq(pacsInformesTable.studyOrderId, ordenId))
      .limit(1);
    if (!informe) {
      res.status(404).json({ error: "Informe no encontrado" });
      return;
    }
    if (informe.informeEstado !== "borrador") {
      res.status(422).json({ error: "Solo se pueden editar imágenes clave en borrador" });
      return;
    }
    type ImagenBody = {
      keyImageId: string;
      studyInstanceUid: string;
      seriesInstanceUid: string;
      sopInstanceUid: string;
      titulo?: string;
      comentarioMedico?: string;
      orden?: number;
    };
    const imagenes: ImagenBody[] = Array.isArray(req.body?.imagenes) ? (req.body.imagenes as ImagenBody[]) : [];

    // Borrar las draft actuales (sin versión) e insertar las nuevas
    await db
      .delete(informeImagenesClavePacsTable)
      .where(and(
        eq(informeImagenesClavePacsTable.informeId, informe.id),
        isNull(informeImagenesClavePacsTable.informeVersionId),
      ));

    if (imagenes.length > 0) {
      await db.insert(informeImagenesClavePacsTable).values(
        imagenes.map((img, idx) => ({
          informeId: informe.id,
          keyImageId: img.keyImageId,
          studyInstanceUid: img.studyInstanceUid,
          seriesInstanceUid: img.seriesInstanceUid,
          sopInstanceUid: img.sopInstanceUid,
          titulo: img.titulo ?? null,
          comentarioMedico: img.comentarioMedico ?? null,
          orden: img.orden ?? idx + 1,
        })),
      );
    }
    res.json({ ok: true, total: imagenes.length });
  },
);

// ── PATCH /pacs-workspace/ordenes/:id/estado — Cambiar estado operativo ──────
router.patch(
  "/pacs-workspace/ordenes/:id/estado",
  requirePacs("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const ordenId = parseInt(String(req.params.id ?? ""));
    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "ID de orden inválido" });
      return;
    }
    const ESTADOS_VALIDOS = ["AGENDADO", "RECEPCIONADO", "PENDIENTE_DE_INFORME", "INFORMADO", "AUSENTE"];
    const estadoOperativo = String(req.body?.estadoOperativo ?? "");
    if (!ESTADOS_VALIDOS.includes(estadoOperativo)) {
      res.status(422).json({ error: `estadoOperativo inválido. Opciones: ${ESTADOS_VALIDOS.join(", ")}` });
      return;
    }
    const user = res.locals.user as { id: number; rol: string; nombre: string };

    // Upsert: si no existe informe, crearlo con el nuevo estado
    await db
      .insert(pacsInformesTable)
      .values({
        studyOrderId: ordenId,
        estadoOperativo,
        informeEstado: "borrador",
        borradorActual: "",
        createdBy: user.id,
      })
      .onConflictDoUpdate({
        target: pacsInformesTable.studyOrderId,
        set: { estadoOperativo, updatedAt: new Date() },
      });

    req.log.info({ ordenId, estadoOperativo, userId: user.id }, "pacs: estado operativo cambiado");
    res.json({ ok: true, estadoOperativo });
  },
);

// ── Webhook de eventos del PACS (firmado HMAC, idempotente por event_id) ────
// Necesita el body CRUDO para verificar la firma: app.ts lo captura en
// req.rawBody (verify hook de express.json) solo para /api/pacs/webhook/*.
router.post(
  "/pacs/webhook/eventos",
  async (req, res): Promise<void> => {
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? "";
    if (!rawBody) {
      res.status(400).json({ error: "Body JSON inválido" });
      return;
    }
    let evento: {
      event_id?: string;
      event_type?: string;
      signature_ts?: number;
      occurred_at?: string;
      order_id?: string;
      study_instance_uid?: string;
    };
    try {
      evento = JSON.parse(rawBody) as typeof evento;
    } catch {
      res.status(400).json({ error: "Body JSON inválido" });
      return;
    }
    const firma = req.headers["x-conectar-signature"];
    const verificacion = verificarFirmaWebhook(
      rawBody,
      typeof firma === "string" ? firma : undefined,
      Number(evento.signature_ts),
    );
    if (!verificacion.ok) {
      req.log.warn({ motivo: verificacion.motivo }, "pacs webhook: firma rechazada");
      res.status(401).json({ error: "Firma inválida" });
      return;
    }
    if (!evento.event_id || !evento.event_type) {
      res.status(422).json({ error: "Faltan event_id o event_type" });
      return;
    }
    // Idempotencia por event_id: el duplicado responde 200 sin reprocesar.
    const insertado = await db
      .insert(pacsEventosTable)
      .values({
        eventId: evento.event_id,
        eventType: evento.event_type,
        orderId: evento.order_id ?? null,
        studyInstanceUid: evento.study_instance_uid ?? null,
        ocurridoEn: evento.occurred_at ? new Date(evento.occurred_at) : null,
        payload: JSON.parse(rawBody) as Record<string, unknown>,
        procesadoEn: new Date(),
      })
      .onConflictDoNothing({ target: pacsEventosTable.eventId })
      .returning({ id: pacsEventosTable.id });
    if (insertado.length === 0) {
      req.log.info({ eventId: evento.event_id }, "pacs webhook: evento duplicado, ignorado");
      res.json({ ok: true, duplicado: true });
      return;
    }
    req.log.info({ eventId: evento.event_id, tipo: evento.event_type }, "pacs webhook: evento registrado");
    res.json({ ok: true });
  },
);

// ── Enviar/actualizar una orden en el PACS ───────────────────────────────────
router.post(
  "/pacs-workspace/ordenes/:id/enviar",
  requirePacs("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const ordenId = parseInt(String(req.params.id ?? ""));
    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "ID de orden inválido" });
      return;
    }
    const [orden] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, ordenId)).limit(1);
    if (!orden) {
      res.status(404).json({ error: "Orden no encontrada" });
      return;
    }
    const modality = (req.body?.modality as string | undefined) ?? orden.modality;
    if (!modality) {
      res.status(422).json({ error: "Falta modality para enviar la orden al PACS" });
      return;
    }
    // CM-1: accession único e inmutable — se genera una sola vez.
    let accession = orden.accessionNumber;
    if (!accession) {
      accession = await generarAccessionNumber();
      await db
        .update(studyOrdersTable)
        .set({ accessionNumber: accession, modality, updatedAt: new Date() })
        .where(eq(studyOrdersTable.id, ordenId));
    }
    const [pacienteOrden] = await db
      .select()
      .from(pacientesTable)
      .where(eq(pacientesTable.id, orden.patientId))
      .limit(1);
    const resultado = await upsertOrden(
      {
        order_id: String(orden.id),
        accession_number: accession,
        conectar_patient_id: String(orden.patientId),
        external_patient_id: (pacienteOrden?.dni ?? "").replace(/\D/g, ""),
        patient_phone: pacienteOrden?.telefono ?? pacienteOrden?.telefonoAlternativo ?? null,
        practice_id: String(orden.studyType ?? "estudio"),
        practice_description: orden.studyName ?? undefined,
        modality,
        reason_for_study: orden.clinicalJustification ?? orden.studyName ?? "Estudio solicitado",
        technician_notes: orden.observacionesTecnico ?? null,
        scheduled_at: orden.scheduledAt?.toISOString(),
      },
      `orden-${orden.id}-${accession}`,
    );
    if (!resultado.ok) {
      req.log.error({ ordenId, code: resultado.code, message: resultado.message }, "pacs: fallo upsert de orden");
      res.status(502).json({ error: resultado.message });
      return;
    }
    res.json({ ok: true, accessionNumber: accession });
  },
);

// ── Sesión de visor (redeem_code un solo uso) ────────────────────────────────
router.post(
  "/pacs-workspace/ordenes/:id/sesion-visor",
  requirePacs("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const ordenId = parseInt(String(req.params.id ?? ""));
    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "ID de orden inválido" });
      return;
    }
    const [orden] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, ordenId)).limit(1);
    if (!orden || !orden.accessionNumber) {
      res.status(404).json({ error: "Orden no encontrada o aún no enviada al PACS" });
      return;
    }
    const user = res.locals.user as { id: number; rol: string; nombre: string };
    const rolPacs = user.rol === "medico" ? "medico" : user.rol === "admin" ? "admin" : "recepcion";
    const resultado = await crearSesionVisor(
      {
        order_id: String(orden.id),
        user: { external_id: String(user.id), role: rolPacs as "medico" | "admin" | "recepcion", display_name: user.nombre },
        purpose: "visualizacion_clinica",
      },
      `visor-${orden.id}-${user.id}-${crypto.randomUUID()}`,
    );
    if (!resultado.ok) {
      req.log.error({ ordenId, code: resultado.code, message: resultado.message }, "pacs: fallo sesión de visor");
      res.status(502).json({ error: resultado.message });
      return;
    }
    res.json(resultado.data);
  },
);

// ── Estudios de una orden (estado espejo desde el PACS) ─────────────────────
router.get(
  "/pacs-workspace/ordenes/:id/estudios",
  requirePacs("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const ordenId = parseInt(String(req.params.id ?? ""));
    if (!Number.isInteger(ordenId)) {
      res.status(400).json({ error: "ID de orden inválido" });
      return;
    }
    const resultado = await estudiosDeOrden(String(ordenId));
    if (!resultado.ok) {
      req.log.error({ ordenId, code: resultado.code, message: resultado.message }, "pacs: fallo listado de estudios");
      res.status(502).json({ error: resultado.message });
      return;
    }
    res.json(resultado.data);
  },
);

export default router;
