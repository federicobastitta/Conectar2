import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, and, inArray, gte, lte, sql } from "drizzle-orm";
import {
  db,
  practicasCatalogoTable,
  ordenesPracticasTable,
  ordenesPracticasLogTable,
  pacientesTable,
  profesionalesTable,
  especialidadesTable,
  usersTable,
  turnerasTable,
  turneraPracticasTable,
  turnosTable,
  sedesTable,
  type EstadoOrdenPractica,
  ESTADOS_ORDEN_PRACTICA,
  FECHA_CORTE_PULSO,
} from "@workspace/db";
import { requireRol, getUserIdFromToken } from "./auth";
import {
  pacsWorkspaceHabilitado,
  generarAccessionNumber,
  upsertOrden,
  crearSesionVisor,
  sexoParaPacs,
  fechaNacimientoParaPacs,
} from "../integraciones/pacs-workspace-v1";
import { verificarFirmaWebhook } from "../integraciones/pacs-workspace-v1";
import { generarPdfDocumento } from "../pdf/documento_pdf";
import { prepararDatosPdf } from "../pdf/escaneado";
import { calcularSlotsDisponibles } from "../lib/slots";
import { hoyArgentina, horaArgentina } from "../lib/tiempo";
import { z } from "zod/v4";

// ── Reglas de transición de estado ────────────────────────────────────────────
const TRANSICIONES_VALIDAS: Record<EstadoOrdenPractica, EstadoOrdenPractica[]> = {
  creada: ["pendiente_validacion", "cancelada"],
  pendiente_validacion: ["validada", "rechazada", "cancelada"],
  validada: ["arribado", "rechazada", "cancelada"],
  arribado: ["en_realizacion", "cancelada"],
  en_realizacion: ["pendiente_informe", "cancelada"],
  pendiente_informe: ["informada"],
  informada: ["publicada"],
  publicada: [],
  rechazada: [],
  cancelada: [],
};

function puedeTransicionar(desde: EstadoOrdenPractica, hacia: EstadoOrdenPractica): boolean {
  return TRANSICIONES_VALIDAS[desde]?.includes(hacia) ?? false;
}

// ── Schema de creación ────────────────────────────────────────────────────────
const crearOrdenSchema = z.object({
  practicaId: z.number().int().positive(),
  patientId: z.number().int().positive(),
  professionalId: z.number().int().positive(),
  sedeId: z.number().int().positive().optional().nullable(),
  motivoClinico: z.string().min(5, "El motivo clínico es obligatorio (mín. 5 caracteres)").max(1000).trim(),
  diagnosticoCie10: z.string().max(20).trim().optional().nullable(),
  region: z.string().max(100).trim().optional().nullable(),
  lateralidad: z.string().max(50).trim().optional().nullable(),
  observaciones: z.string().max(1000).trim().optional().nullable(),
  fechaOrden: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (YYYY-MM-DD)"),
  fechaRealizacionEstimada: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  coberturaObra: z.string().max(200).trim().optional().nullable(),
  coberturaPlan: z.string().max(200).trim().optional().nullable(),
  coberturaNumeroAfiliado: z.string().max(100).trim().optional().nullable(),
  prioridad: z.enum(["normal", "urgente", "programada"]).default("normal"),
  // TOKEN Klinicos — solo requerido si la práctica lo exige. NUNCA se persiste en claro.
  token: z.string().min(4).max(40).optional().nullable(),
});

const router: IRouter = Router();

// ── Helper: obtener usuario autenticado ───────────────────────────────────────
async function getUser(req: Request) {
  const raw = req.headers.authorization?.replace("Bearer ", "");
  if (!raw) return null;
  const userId = await getUserIdFromToken(raw);
  if (!userId) return null;
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}

// ── Helper: log de transición ─────────────────────────────────────────────────
async function logTransicion(
  ordenId: number,
  estadoAnterior: string | null,
  estadoNuevo: string,
  autorId: number | null,
  motivo?: string | null,
  metadata?: unknown,
): Promise<void> {
  await db.insert(ordenesPracticasLogTable).values({
    ordenId,
    estadoAnterior: estadoAnterior ?? null,
    estadoNuevo,
    autorId,
    motivo: motivo ?? null,
    metadata: metadata ? (metadata as Record<string, unknown>) : null,
  });
}

// ── GET /api/ordenes-practicas ────────────────────────────────────────────────
router.get(
  "/ordenes-practicas",
  requireRol("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const { estado, patientId, practicaId, fecha, dni, limit: rawLimit, offset: rawOffset } = req.query;
    const limitNum = Math.min(parseInt(String(rawLimit ?? "50")), 200);
    const offsetNum = parseInt(String(rawOffset ?? "0")) || 0;

    const conditions = [];
    if (estado && ESTADOS_ORDEN_PRACTICA.includes(estado as EstadoOrdenPractica)) {
      conditions.push(eq(ordenesPracticasTable.estado, estado as EstadoOrdenPractica));
    }
    if (patientId) conditions.push(eq(ordenesPracticasTable.patientId, parseInt(String(patientId))));
    if (practicaId) conditions.push(eq(ordenesPracticasTable.practicaId, parseInt(String(practicaId))));
    if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
      conditions.push(eq(ordenesPracticasTable.fechaOrden, String(fecha)));
    }
    // Filtro por DNI del paciente: compara solo dígitos para tolerar puntos
    // tanto en lo cargado como en lo guardado (p. ej. "12.345.678").
    const dniDigits = String(dni ?? "").replace(/\D/g, "");
    if (dniDigits) {
      conditions.push(
        sql`regexp_replace(coalesce(${pacientesTable.dni}, ''), '\\D', '', 'g') LIKE ${`%${dniDigits}%`}`,
      );
    }

    const rows = await db
      .select({
        orden: ordenesPracticasTable,
        practica: {
          nombre: practicasCatalogoTable.nombre,
          especialidad: practicasCatalogoTable.especialidad,
          modalidadDicom: practicasCatalogoTable.modalidadDicom,
          generaDicom: practicasCatalogoTable.generaDicom,
        },
        paciente: {
          nombre: pacientesTable.nombre,
          apellido: pacientesTable.apellido,
          dni: pacientesTable.dni,
        },
        turno: {
          fecha: turnosTable.fecha,
          horaInicio: turnosTable.horaInicio,
          estado: turnosTable.estado,
        },
      })
      .from(ordenesPracticasTable)
      .leftJoin(practicasCatalogoTable, eq(ordenesPracticasTable.practicaId, practicasCatalogoTable.id))
      .leftJoin(pacientesTable, eq(ordenesPracticasTable.patientId, pacientesTable.id))
      .leftJoin(turnosTable, eq(ordenesPracticasTable.turnoId, turnosTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(ordenesPracticasTable.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    res.json({ ordenes: rows, fechaCorte: FECHA_CORTE_PULSO });
  },
);

// ── GET /api/ordenes-practicas/:id ────────────────────────────────────────────
router.get(
  "/ordenes-practicas/:id",
  requireRol("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) { res.status(400).json({ error: "ID inválido" }); return; }

    const [row] = await db
      .select({
        orden: ordenesPracticasTable,
        practica: practicasCatalogoTable,
        paciente: pacientesTable,
        profesional: profesionalesTable,
      })
      .from(ordenesPracticasTable)
      .leftJoin(practicasCatalogoTable, eq(ordenesPracticasTable.practicaId, practicasCatalogoTable.id))
      .leftJoin(pacientesTable, eq(ordenesPracticasTable.patientId, pacientesTable.id))
      .leftJoin(profesionalesTable, eq(ordenesPracticasTable.professionalId, profesionalesTable.id))
      .where(eq(ordenesPracticasTable.id, id))
      .limit(1);

    if (!row) { res.status(404).json({ error: "Orden no encontrada" }); return; }

    const log = await db
      .select()
      .from(ordenesPracticasLogTable)
      .where(eq(ordenesPracticasLogTable.ordenId, id))
      .orderBy(desc(ordenesPracticasLogTable.createdAt));

    res.json({ ...row, log });
  },
);

// ── POST /api/ordenes-practicas/limpiar-test ─────────────────────────────────
// Borra de un clic las órdenes de prueba cargadas durante la validación:
// las identificadas por motivo clínico que empieza con "TEST - Orden de prueba".
// Elimina también sus logs y los turnos que hayan generado. Solo admin.
const PREFIJO_MOTIVO_TEST = "TEST - Orden de prueba";

router.post(
  "/ordenes-practicas/limpiar-test",
  requireRol("admin"),
  async (req, res): Promise<void> => {
    const ordenesTest = await db
      .select({
        id: ordenesPracticasTable.id,
        numeroOrden: ordenesPracticasTable.numeroOrden,
        turnoId: ordenesPracticasTable.turnoId,
      })
      .from(ordenesPracticasTable)
      .where(sql`${ordenesPracticasTable.motivoClinico} LIKE ${`${PREFIJO_MOTIVO_TEST}%`}`);

    if (ordenesTest.length === 0) {
      res.json({ ordenesEliminadas: 0, turnosEliminados: 0, numeros: [] });
      return;
    }

    const ordenIds = ordenesTest.map((o) => o.id);
    const turnoIds = ordenesTest.map((o) => o.turnoId).filter((t): t is number => t != null);

    await db.transaction(async (tx) => {
      await tx.delete(ordenesPracticasLogTable).where(inArray(ordenesPracticasLogTable.ordenId, ordenIds));
      await tx.delete(ordenesPracticasTable).where(inArray(ordenesPracticasTable.id, ordenIds));
      if (turnoIds.length > 0) {
        await tx.delete(turnosTable).where(inArray(turnosTable.id, turnoIds));
      }
    });

    const user = await getUser(req);
    req.log.info(
      { ordenes: ordenesTest.map((o) => o.numeroOrden), turnos: turnoIds, autorId: user?.id ?? null },
      "ordenes-practicas: limpieza de órdenes TEST",
    );

    res.json({
      ordenesEliminadas: ordenIds.length,
      turnosEliminados: turnoIds.length,
      numeros: ordenesTest.map((o) => o.numeroOrden),
    });
  },
);

// ── POST /api/ordenes-practicas/preview-pdf ───────────────────────────────────
// Vista previa del PDF de la orden ANTES de emitirla: recibe el mismo body que
// la creación, arma el documento en memoria y lo devuelve sin persistir nada.
// No valida TOKEN Klinicos ni envía nada al PACS.
router.post(
  "/ordenes-practicas/preview-pdf",
  requireRol("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const parsed = crearOrdenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const body = parsed.data;

    const [practica] = await db
      .select()
      .from(practicasCatalogoTable)
      .where(and(eq(practicasCatalogoTable.id, body.practicaId), eq(practicasCatalogoTable.activo, true)))
      .limit(1);
    if (!practica) { res.status(422).json({ error: "Práctica no encontrada o inactiva" }); return; }

    const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, body.patientId)).limit(1);
    if (!paciente) { res.status(422).json({ error: "Paciente no encontrado" }); return; }

    const [profesional] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, body.professionalId)).limit(1);
    if (!profesional) { res.status(422).json({ error: "Profesional no encontrado" }); return; }

    // Mismas reglas de negocio que la emisión real (sin llamar al robot Klinicos)
    if (!profesional.matricula) {
      res.status(422).json({ error: "El profesional solicitante no tiene matrícula registrada" });
      return;
    }
    if (practica.requiereRegion && !body.region) {
      res.status(422).json({ error: `La práctica '${practica.nombre}' requiere especificar región` });
      return;
    }
    if (practica.requiereLateralidad && !body.lateralidad) {
      res.status(422).json({ error: `La práctica '${practica.nombre}' requiere especificar lateralidad` });
      return;
    }
    if (practica.requiereTokenKlinicos && !(body.token?.trim() && body.token.trim().length >= 4)) {
      res.status(422).json({ error: "Se requiere TOKEN Klinicos para esta práctica" });
      return;
    }

    let especialidad: string | null = null;
    if (profesional.especialidadId != null) {
      const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, profesional.especialidadId)).limit(1);
      especialidad = esp?.nombre ?? null;
    }

    const campos: Array<{ etiqueta: string; valor: string }> = [
      { etiqueta: "Práctica", valor: practica.nombre },
      ...(body.region ? [{ etiqueta: "Región", valor: body.region }] : []),
      ...(body.lateralidad ? [{ etiqueta: "Lateralidad", valor: body.lateralidad }] : []),
      ...(body.diagnosticoCie10 ? [{ etiqueta: "Diagnóstico (CIE-10)", valor: body.diagnosticoCie10 }] : []),
      { etiqueta: "Prioridad", valor: body.prioridad === "urgente" ? "Urgente" : body.prioridad === "programada" ? "Programada" : "Normal" },
      { etiqueta: "Fecha de la orden", valor: body.fechaOrden },
      ...(body.fechaRealizacionEstimada ? [{ etiqueta: "Fecha estimada de realización", valor: body.fechaRealizacionEstimada }] : []),
    ];

    const doc = generarPdfDocumento(await prepararDatosPdf({
      titulo: "Orden de práctica (VISTA PREVIA)",
      tipoDocumento: "orden_estudio",
      paciente: {
        nombre: paciente.nombre,
        apellido: paciente.apellido,
        dni: paciente.dni,
        cobertura: body.coberturaObra ?? paciente.cobertura,
        nroAfiliado: body.coberturaNumeroAfiliado ?? paciente.nroAfiliado,
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
      fechaEmision: new Date(),
      campos,
      cuerpo: body.motivoClinico,
      observaciones: body.observaciones ?? null,
    }));

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="vista_previa_orden_${paciente.apellido.toLowerCase()}.pdf"`);
    doc.pipe(res);
    doc.end();
  },
);

// ── POST /api/ordenes-practicas ───────────────────────────────────────────────
// Flujo:
//   1. Validar todos los campos + entidades referenciadas
//   2. Si la práctica requiere TOKEN Klinicos → validar antes de emitir
//      TOKEN_ACCEPTED habilita; TOKEN_DENIED es rechazo real;
//      TECHNICAL_ERROR ≠ denegación → 503
//   3. Generar order_id (UUID) + accession_number (C{AA}-{12 dígitos})
//   4. Insertar orden (estado=validada) + actualizar numero_orden
//   5. Si genera_dicom=true → enviar a DiagnosticPACS vía contrato v1.0
//   6. Log de creación
router.post(
  "/ordenes-practicas",
  requireRol("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const user = await getUser(req);
    if (!user) { res.status(401).json({ error: "No autenticado" }); return; }

    const parsed = crearOrdenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }
    const body = parsed.data;

    // ── 1. Verificar entidades referenciadas ─────────────────────────────
    const [practica] = await db
      .select()
      .from(practicasCatalogoTable)
      .where(and(eq(practicasCatalogoTable.id, body.practicaId), eq(practicasCatalogoTable.activo, true)))
      .limit(1);
    if (!practica) { res.status(422).json({ error: "Práctica no encontrada o inactiva" }); return; }

    const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, body.patientId)).limit(1);
    if (!paciente) { res.status(422).json({ error: "Paciente no encontrado" }); return; }

    const [profesional] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, body.professionalId)).limit(1);
    if (!profesional) { res.status(422).json({ error: "Profesional no encontrado" }); return; }

    if (!profesional.matricula) {
      res.status(422).json({ error: "El profesional solicitante no tiene matrícula registrada" });
      return;
    }

    // ── 2. Región y lateralidad si la práctica lo requiere ───────────────
    if (practica.requiereRegion && !body.region) {
      res.status(422).json({ error: `La práctica '${practica.nombre}' requiere especificar región` });
      return;
    }
    if (practica.requiereLateralidad && !body.lateralidad) {
      res.status(422).json({ error: `La práctica '${practica.nombre}' requiere especificar lateralidad` });
      return;
    }

    // ── 3. Validación Klinicos TOKEN (si la práctica lo requiere) ─────────
    let klinicosEstado: string | null = null;
    let klinicosAuthNumber: string | null = null;
    let klinicosTokenMasked: string | null = null;
    let klinicosRequestId: string | null = null;

    if (practica.requiereTokenKlinicos) {
      const token = body.token?.trim();
      if (!token || token.length < 4) {
        res.status(422).json({ error: "Se requiere TOKEN Klinicos para esta práctica" });
        return;
      }

      // Enmascarar: últimos 4 caracteres
      klinicosTokenMasked = token.slice(-4).padStart(token.length, "*");
      klinicosRequestId = crypto.randomUUID();

      const robotUrl = process.env.ROBOT_API_URL?.trim();
      if (!robotUrl) {
        res.status(503).json({ error: "Servicio de validación Klinicos no configurado (error técnico)" });
        return;
      }

      const reglas = practica.reglasKlinicos as { practiceId?: string; practiceCode?: string; catalog?: string; description?: string } | null;

      const payload = {
        request_id: klinicosRequestId,
        consultation_id: klinicosRequestId,
        patient: {
          document_type: "DNI",
          document_number: (paciente.dni ?? "").replace(/\./g, ""),
          first_name: paciente.nombre,
          last_name: paciente.apellido,
          birth_date: paciente.fechaNacimiento ?? null,
          affiliate_number: body.coberturaNumeroAfiliado ?? "",
          affiliate_type: null,
        },
        coverage: {
          insurer: body.coberturaObra ?? paciente.cobertura ?? "",
          plan: body.coberturaPlan ?? paciente.planCobertura ?? null,
        },
        practice: {
          id: reglas?.practiceId ?? practica.codigo,
          code: reglas?.practiceCode ?? practica.codigo,
          // Klinicos solo acepta el código de prestación: nunca enviar letras.
          description: null,
          catalog: reglas?.catalog ?? null,
          quantity: 1,
        },
        site: body.sedeId ? { id: String(body.sedeId) } : null,
        scheduled_at: `${body.fechaOrden}T08:00:00-03:00`,
        diagnosis: {
          code: body.diagnosticoCie10 ?? "Z00",
          description: body.motivoClinico,
        },
        token,
      };

      let robotResult: { status: string; authorization_number?: string | null } | null = null;
      try {
        const r = await fetch(`${robotUrl}/api/v1/klinicos/consultations/process`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(process.env.ROBOT_API_KEY ? { "x-api-key": process.env.ROBOT_API_KEY } : {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });
        if (r.ok) {
          robotResult = (await r.json()) as { status: string; authorization_number?: string | null };
        } else {
          req.log.warn({ status: r.status }, "ordenes-practicas: robot respondió error");
          res.status(503).json({ error: "Error técnico al validar TOKEN Klinicos — reintente" });
          return;
        }
      } catch (err) {
        req.log.warn({ err: String(err) }, "ordenes-practicas: timeout/error red al validar TOKEN");
        res.status(503).json({ error: "Error técnico al validar TOKEN Klinicos — reintente" });
        return;
      }

      klinicosEstado = robotResult?.status ?? "TECHNICAL_ERROR";
      klinicosAuthNumber = robotResult?.authorization_number ?? null;

      if (klinicosEstado === "TOKEN_DENIED") {
        res.status(402).json({ error: "Token rechazado por Klinicos", klinicosEstado });
        return;
      }
      if (klinicosEstado !== "TOKEN_ACCEPTED") {
        // TECHNICAL_ERROR, PROCESSING, DATA_REQUIRED, etc. ≠ rechazo real
        res.status(503).json({
          error: "Error técnico al validar TOKEN — reintente",
          klinicosEstado,
          esRechazo: false,
        });
        return;
      }
    }

    // ── 4. Generar IDs ────────────────────────────────────────────────────
    const ordenUuid = crypto.randomUUID();
    let accessionNumber: string | null = null;
    if (practica.generaDicom && pacsWorkspaceHabilitado()) {
      accessionNumber = await generarAccessionNumber();
    }

    // ── 5. Insertar orden en transacción ──────────────────────────────────
    const estadoInicial: EstadoOrdenPractica =
      practica.requiereTokenKlinicos && klinicosEstado === "TOKEN_ACCEPTED"
        ? "validada"
        : practica.requiereTokenKlinicos
          ? "pendiente_validacion"
          : "validada";

    const [inserted] = await db
      .insert(ordenesPracticasTable)
      .values({
        ordenUuid,
        // Placeholder único por inserción: numero_orden tiene índice único y
        // dos creaciones concurrentes con el mismo placeholder chocan (23505).
        numeroOrden: `OP-${body.fechaOrden.slice(0, 4)}-tmp-${ordenUuid.slice(0, 8)}`,
        accessionNumber,
        patientId: body.patientId,
        professionalId: body.professionalId,
        practicaId: body.practicaId,
        sedeId: body.sedeId ?? null,
        estado: estadoInicial,
        prioridad: body.prioridad,
        motivoClinico: body.motivoClinico,
        diagnosticoCie10: body.diagnosticoCie10 ?? null,
        region: body.region ?? null,
        lateralidad: body.lateralidad ?? null,
        observaciones: body.observaciones ?? null,
        fechaOrden: body.fechaOrden,
        fechaRealizacionEstimada: body.fechaRealizacionEstimada ?? null,
        coberturaObra: body.coberturaObra ?? paciente.cobertura ?? null,
        coberturaPlan: body.coberturaPlan ?? paciente.planCobertura ?? null,
        coberturaNumeroAfiliado: body.coberturaNumeroAfiliado ?? paciente.nroAfiliado ?? null,
        klinicosRequestId,
        klinicosEstado,
        klinicosAuthorizationNumber: klinicosAuthNumber,
        klinicosTokenMasked,
        createdBy: user.id,
      })
      .returning();

    // ── 6. Actualizar numero_orden con el id real ─────────────────────────
    const numeroOrden = `OP-${body.fechaOrden.slice(0, 4)}-${String(inserted.id).padStart(6, "0")}`;
    await db
      .update(ordenesPracticasTable)
      .set({ numeroOrden })
      .where(eq(ordenesPracticasTable.id, inserted.id));

    inserted.numeroOrden = numeroOrden;

    // ── 7. Enviar a DiagnosticPACS si es práctica DICOM ──────────────────
    if (practica.generaDicom && pacsWorkspaceHabilitado() && accessionNumber) {
      const pacsResult = await upsertOrden(
        {
          order_id: ordenUuid,
          accession_number: accessionNumber,
          conectar_patient_id: String(body.patientId),
          external_patient_id: (paciente.dni ?? "").replace(/\D/g, ""),
          patient_first_name: paciente.nombre ?? null,
          patient_last_name: paciente.apellido ?? null,
          patient_birth_date: fechaNacimientoParaPacs(paciente.fechaNacimiento),
          patient_sex: sexoParaPacs(paciente.sexo),
          patient_phone: paciente.telefono ?? paciente.telefonoAlternativo ?? null,
          practice_id: practica.codigo,
          practice_description: practica.nombre,
          modality: practica.modalidadDicom ?? "OT",
          reason_for_study: body.motivoClinico,
          diagnosis: body.diagnosticoCie10 ?? null,
          technician_notes: body.observaciones ?? null,
          scheduled_at: body.fechaRealizacionEstimada
            ? `${body.fechaRealizacionEstimada}T08:00:00-03:00`
            : `${body.fechaOrden}T08:00:00-03:00`,
        },
        ordenUuid,
      );

      if (pacsResult.ok) {
        await db
          .update(ordenesPracticasTable)
          .set({ pacsOrdenEnviada: true })
          .where(eq(ordenesPracticasTable.id, inserted.id));
        inserted.pacsOrdenEnviada = true;
        req.log.info({ ordenId: inserted.id, ordenUuid, accessionNumber }, "ordenes-practicas: enviada al PACS");
      } else {
        req.log.warn({ ordenId: inserted.id, pacsResult }, "ordenes-practicas: error al enviar al PACS");
        // No fallar la creación — la orden queda creada, el operador puede reintentar
      }
    }

    // ── 8. Log de creación ────────────────────────────────────────────────
    await logTransicion(inserted.id, null, estadoInicial, user.id, "Orden creada", {
      practica: practica.nombre,
      generaDicom: practica.generaDicom,
      klinicosEstado,
    });

    req.log.info(
      { ordenId: inserted.id, numeroOrden, uuid: ordenUuid, practica: practica.codigo },
      "ordenes-practicas: orden creada",
    );

    res.status(201).json({ orden: inserted });
  },
);

// ── PATCH /api/ordenes-practicas/:id/estado ───────────────────────────────────
router.patch(
  "/ordenes-practicas/:id/estado",
  requireRol("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) { res.status(400).json({ error: "ID inválido" }); return; }

    const { estado, motivo } = req.body as { estado?: string; motivo?: string };
    if (!estado || !ESTADOS_ORDEN_PRACTICA.includes(estado as EstadoOrdenPractica)) {
      res.status(422).json({ error: "Estado inválido", validos: ESTADOS_ORDEN_PRACTICA });
      return;
    }

    const estadoNuevo = estado as EstadoOrdenPractica;
    if ((estadoNuevo === "cancelada" || estadoNuevo === "rechazada") && !motivo?.trim()) {
      res.status(422).json({ error: "El motivo es obligatorio al cancelar o rechazar una orden" });
      return;
    }

    const user = await getUser(req);

    const [orden] = await db
      .select()
      .from(ordenesPracticasTable)
      .where(eq(ordenesPracticasTable.id, id))
      .limit(1);

    if (!orden) { res.status(404).json({ error: "Orden no encontrada" }); return; }

    if (!puedeTransicionar(orden.estado, estadoNuevo)) {
      res.status(409).json({
        error: `Transición inválida: ${orden.estado} → ${estadoNuevo}`,
        estadoActual: orden.estado,
        transicionesValidas: TRANSICIONES_VALIDAS[orden.estado],
      });
      return;
    }

    const updates: Partial<typeof ordenesPracticasTable.$inferInsert> = {
      estado: estadoNuevo,
      updatedAt: new Date(),
    };
    if (estadoNuevo === "cancelada") updates.canceladoMotivo = motivo ?? null;
    if (estadoNuevo === "rechazada") updates.rechazadoMotivo = motivo ?? null;

    const [updated] = await db
      .update(ordenesPracticasTable)
      .set(updates)
      .where(eq(ordenesPracticasTable.id, id))
      .returning();

    await logTransicion(id, orden.estado, estadoNuevo, user?.id ?? null, motivo ?? null);

    req.log.info({ ordenId: id, desde: orden.estado, hacia: estadoNuevo }, "ordenes-practicas: estado actualizado");
    res.json({ orden: updated });
  },
);

// ── POST /api/ordenes-practicas/:id/sesion-visor ──────────────────────────────
// Abre el workspace de informe en DiagnosticPACS mediante sesión segura (CM-3).
// DiagnosticPACS es dueño del editor clínico, IA, firma y correcciones.
// Conectar solo abre la sesión y recibe el informe firmado por webhook.
router.post(
  "/ordenes-practicas/:id/sesion-visor",
  requireRol("admin", "medico"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) { res.status(400).json({ error: "ID inválido" }); return; }

    if (!pacsWorkspaceHabilitado()) {
      res.status(503).json({ error: "Módulo PACS desactivado — contactá soporte técnico" });
      return;
    }

    const [orden] = await db
      .select({ o: ordenesPracticasTable, p: practicasCatalogoTable })
      .from(ordenesPracticasTable)
      .leftJoin(practicasCatalogoTable, eq(ordenesPracticasTable.practicaId, practicasCatalogoTable.id))
      .where(eq(ordenesPracticasTable.id, id))
      .limit(1);

    if (!orden) { res.status(404).json({ error: "Orden no encontrada" }); return; }
    if (!orden.p?.generaDicom) {
      res.status(422).json({ error: "Esta práctica no usa workspace DICOM del PACS" });
      return;
    }
    if (!orden.o.pacsOrdenEnviada) {
      res.status(409).json({ error: "La orden aún no fue enviada al PACS — verificá el estado" });
      return;
    }

    const user = await getUser(req);
    const idempotencyKey = `visor-${id}-${Date.now()}`;

    const result = await crearSesionVisor(
      {
        order_id: orden.o.ordenUuid,
        user: {
          external_id: String(user?.id ?? "0"),
          role: user?.rol === "medico" ? "medico_firmante" : "admin",
          display_name: user?.nombre ?? undefined,
        },
        purpose: "informe",
      },
      idempotencyKey,
    );

    if (!result.ok) {
      req.log.warn({ ordenId: id, result }, "ordenes-practicas: error al crear sesión visor PACS");
      res.status(502).json({ error: "No se pudo crear la sesión en DiagnosticPACS", detalle: result.message });
      return;
    }

    req.log.info({ ordenId: id, sessionId: result.data.session_id }, "ordenes-practicas: sesión visor creada");
    res.json({
      sessionId: result.data.session_id,
      redeemUrl: result.data.redeem_url,
      viewerUrl: result.data.viewer_url,
      expiresAt: result.data.expires_at,
    });
  },
);

// ── POST /api/pacs/webhook/informe-firmado ────────────────────────────────────
// DiagnosticPACS envía el informe firmado a Conectar al firmar o corregir.
// Payload esperado:
//   event_id, event_type="INFORME_FIRMADO", signature_ts (HMAC anti-replay),
//   order_id (= ordenUuid), payload: {
//     informe_ejecutivo_url, informe_ejecutivo_texto, informe_anexos_url,
//     informe_version, informe_checksum, informe_conclusion,
//     informe_paginas_ejecutivo,   ← DEBE ser 1 para el informe ejecutivo
//     firmante_nombre, firmante_matricula, firmante_especialidad, firmado_at
//   }
//
// Separación informe / evidencia (regla invariable):
//   - informe_ejecutivo_url  → PDF firmado, 1 hoja A4, conclusión + firma
//   - informe_anexos_url     → trazados, tablas, mediciones, multipágina (sin límite)
// Solo se valida que el INFORME EJECUTIVO tenga 1 hoja y conclusión ≥ 20 chars.
// Los ANEXOS pueden tener N páginas — nunca se rechaza un estudio por eso.
router.post(
  "/pacs/webhook/informe-firmado",
  async (req: Request & { rawBody?: string }, res: Response): Promise<void> => {
    const rawBody = req.rawBody;
    if (!rawBody) {
      res.status(400).json({ error: "Body requerido" });
      return;
    }

    let payload: {
      event_id?: string;
      event_type?: string;
      signature_ts?: number;
      order_id?: string;
      payload?: {
        informe_ejecutivo_url?: string;
        informe_ejecutivo_texto?: Record<string, unknown>;
        informe_anexos_url?: string;
        informe_version?: number;
        informe_checksum?: string;
        informe_conclusion?: string;
        informe_paginas_ejecutivo?: number;
        firmante_nombre?: string;
        firmante_matricula?: string;
        firmante_especialidad?: string;
        firmado_at?: string;
      };
    };

    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      res.status(400).json({ error: "JSON inválido" });
      return;
    }

    // ── HMAC anti-replay ─────────────────────────────────────────────────
    const firma = req.headers["x-conectar-signature"];
    const verificacion = verificarFirmaWebhook(
      rawBody,
      typeof firma === "string" ? firma : undefined,
      Number(payload.signature_ts),
    );
    if (!verificacion.ok) {
      req.log.warn({ motivo: verificacion.motivo }, "webhook/informe-firmado: firma rechazada");
      res.status(401).json({ error: "Firma inválida" });
      return;
    }

    if (payload.event_type !== "INFORME_FIRMADO") {
      res.status(422).json({ error: `event_type inesperado: ${payload.event_type}` });
      return;
    }
    if (!payload.event_id || !payload.order_id) {
      res.status(422).json({ error: "Faltan event_id u order_id" });
      return;
    }

    const inf = payload.payload ?? {};

    // ── Validar informe ejecutivo (no los anexos) ─────────────────────────
    // Los anexos (trazados, tablas, DICOM) pueden tener N páginas — OK.
    // Solo el informe ejecutivo firmado debe tener exactamente 1 hoja.
    if (typeof inf.informe_paginas_ejecutivo === "number" && inf.informe_paginas_ejecutivo !== 1) {
      req.log.warn({ paginas: inf.informe_paginas_ejecutivo, orderId: payload.order_id }, "webhook/informe-firmado: informe ejecutivo supera 1 página");
      res.status(422).json({
        error: "El informe médico ejecutivo debe ocupar exactamente 1 hoja A4 (los anexos pueden ser multipágina)",
        informe_paginas_ejecutivo: inf.informe_paginas_ejecutivo,
      });
      return;
    }

    const conclusion = inf.informe_conclusion?.trim() ?? "";
    if (conclusion.length < 20) {
      res.status(422).json({
        error: "La conclusión es obligatoria y debe tener al menos 20 caracteres",
        longitudActual: conclusion.length,
      });
      return;
    }

    const firmaOk =
      inf.firmante_nombre?.trim() &&
      inf.firmante_matricula?.trim() &&
      inf.firmante_especialidad?.trim() &&
      inf.firmado_at &&
      inf.informe_checksum?.trim();

    if (!firmaOk) {
      res.status(422).json({
        error: "Datos de firma incompletos (nombre, matrícula, especialidad, fecha y checksum son obligatorios)",
      });
      return;
    }

    // ── Localizar la orden por UUID ───────────────────────────────────────
    const [orden] = await db
      .select()
      .from(ordenesPracticasTable)
      .where(eq(ordenesPracticasTable.ordenUuid, payload.order_id))
      .limit(1);

    if (!orden) {
      req.log.warn({ orderId: payload.order_id }, "webhook/informe-firmado: orden no encontrada");
      res.status(404).json({ error: "Orden no encontrada para este order_id" });
      return;
    }

    const version = inf.informe_version ?? (orden.informeVersion ?? 0) + 1;
    const estadoNuevo: EstadoOrdenPractica = "informada";

    await db.update(ordenesPracticasTable)
      .set({
        estado: estadoNuevo,
        informeEjecutivoUrl: inf.informe_ejecutivo_url ?? null,
        informeEjecutivoTexto: inf.informe_ejecutivo_texto
          ? (inf.informe_ejecutivo_texto as Record<string, unknown>)
          : null,
        informeAnexosUrl: inf.informe_anexos_url ?? null,
        informeVersion: version,
        informeChecksum: inf.informe_checksum ?? null,
        informeConclusion: conclusion,
        informePaginasEjecutivo: inf.informe_paginas_ejecutivo ?? 1,
        informeFirmanteNombre: inf.firmante_nombre ?? null,
        informeFirmanteMatricula: inf.firmante_matricula ?? null,
        informeFirmanteEspecialidad: inf.firmante_especialidad ?? null,
        informeFirmadoAt: inf.firmado_at ? new Date(inf.firmado_at) : null,
        updatedAt: new Date(),
      })
      .where(eq(ordenesPracticasTable.id, orden.id));

    await logTransicion(
      orden.id,
      orden.estado,
      estadoNuevo,
      null,
      `Informe firmado recibido desde DiagnosticPACS (v${version})`,
      { eventId: payload.event_id, firmante: inf.firmante_nombre, version },
    );

    req.log.info(
      { ordenId: orden.id, version, firmante: inf.firmante_nombre },
      "webhook/informe-firmado: informe recibido y vinculado",
    );

    res.json({ ok: true, ordenId: orden.id, version });
  },
);

// ── GET /api/ordenes-practicas/pulso-backlog ──────────────────────────────────
// Vista de solo lectura de los estudios históricos de Pulso
// (anteriores a FECHA_CORTE_PULSO). Sin creación ni edición.
router.get(
  "/ordenes-practicas/pulso-backlog",
  requireRol("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const { limit: rawLimit, offset: rawOffset, patientId } = req.query;
    const limitNum = Math.min(parseInt(String(rawLimit ?? "50")), 200);
    const offsetNum = parseInt(String(rawOffset ?? "0")) || 0;

    // Importar tabla de Pulso directamente
    const { pulsoEstudiosTable } = await import("@workspace/db");
    const conditions = patientId
      ? [eq(pulsoEstudiosTable.patientId, parseInt(String(patientId)))]
      : [];

    const rows = await db
      .select()
      .from(pulsoEstudiosTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(pulsoEstudiosTable.fechaEstudio))
      .limit(limitNum)
      .offset(offsetNum);

    res.json({
      estudios: rows,
      soloLectura: true,
      fechaCorte: FECHA_CORTE_PULSO,
      mensaje: `Historial Pulso (solo lectura). Órdenes nuevas se generan en Conectar desde ${FECHA_CORTE_PULSO}.`,
    });
  },
);

// ── Asignación de turno directo desde la orden ───────────────────────────────

// Normaliza texto para comparar descripciones (minúsculas, sin acentos).
function normalizarTexto(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// Código numérico del nomenclador derivado del código del catálogo (ej.
// "ECO-180106" → "180106"). Misma regla que en practicas_catalogo.ts.
function codigoNumerico(codigo: string): string | null {
  const partes = codigo.match(/\d{4,}/g);
  return partes ? partes.sort((a, b) => b.length - a.length)[0] : null;
}

// Turneras activas compatibles con una práctica del catálogo: matchean por
// código de nomenclador (turnera_practicas.codigo) o por descripción igual al
// nombre de la práctica (estudios multi-código comparten descripción).
async function turnerasCompatibles(practica: typeof practicasCatalogoTable.$inferSelect) {
  const codigos = new Set<string>((practica.codigos ?? []).map(String));
  const num = codigoNumerico(practica.codigo);
  if (num) codigos.add(num);
  const nombreNorm = normalizarTexto(practica.nombre);

  const filas = await db
    .select({ turneraId: turneraPracticasTable.turneraId, codigo: turneraPracticasTable.codigo, descripcion: turneraPracticasTable.descripcion })
    .from(turneraPracticasTable);
  const ids = new Set<number>();
  for (const f of filas) {
    if (codigos.has(f.codigo) || (f.descripcion && normalizarTexto(f.descripcion) === nombreNorm)) {
      ids.add(f.turneraId);
    }
  }
  if (ids.size === 0) return { turneras: [], codigoNomenclador: num };
  const turneras = await db
    .select()
    .from(turnerasTable)
    .where(and(inArray(turnerasTable.id, [...ids]), eq(turnerasTable.activa, true)));
  return { turneras, codigoNomenclador: num };
}

async function nombresTurnera(t: typeof turnerasTable.$inferSelect) {
  let profesional: string | null = null;
  if (t.profesionalId) {
    const [p] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, t.profesionalId)).limit(1);
    if (p) profesional = `${p.apellido}, ${p.nombre}`;
  }
  let sede: string | null = null;
  if (t.sedeId) {
    const [s] = await db.select().from(sedesTable).where(eq(sedesTable.id, t.sedeId)).limit(1);
    sede = s?.nombre ?? null;
  }
  return { profesional, sede };
}

// ── GET /api/ordenes-practicas/:id/sugerencias-turno ─────────────────────────
// Hasta 4 opciones concretas de turno (agenda/sede/fecha/hora) compatibles con
// la práctica de la orden. Si solo hay turneras de guardia (demanda
// espontánea), lo informa en lugar de ofrecer horarios.
router.get(
  "/ordenes-practicas/:id/sugerencias-turno",
  requireRol("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) { res.status(400).json({ error: "ID inválido" }); return; }

    const [orden] = await db.select().from(ordenesPracticasTable).where(eq(ordenesPracticasTable.id, id)).limit(1);
    if (!orden) { res.status(404).json({ error: "Orden no encontrada" }); return; }

    const [practica] = await db.select().from(practicasCatalogoTable).where(eq(practicasCatalogoTable.id, orden.practicaId)).limit(1);
    if (!practica) { res.status(422).json({ error: "La orden no tiene una práctica válida" }); return; }

    const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, orden.patientId)).limit(1);
    const pacienteResumen = paciente
      ? {
          id: paciente.id,
          dni: paciente.dni,
          nombre: paciente.nombre,
          apellido: paciente.apellido,
          telefono: paciente.telefono,
          cobertura: paciente.cobertura,
          nroAfiliado: paciente.nroAfiliado,
        }
      : null;

    const { turneras, codigoNomenclador } = await turnerasCompatibles(practica);
    const programadas = turneras.filter((t) => !t.esGuardia);
    const guardias = turneras.filter((t) => t.esGuardia);

    // Modalidad de atención derivada de las agendas activas compatibles:
    // "turno" (solo agenda programada), "demanda" (solo guardia/orden de
    // llegada) o "mixta" (ambas: el recepcionista informa y el paciente elige).
    const modalidad =
      programadas.length > 0 && guardias.length > 0
        ? "mixta"
        : guardias.length > 0
          ? "demanda"
          : "turno";

    let guardiaInfo: { turneraId: number; nombre: string; sede: string | null } | undefined;
    if (guardias.length > 0) {
      const g = guardias[0];
      const { sede } = await nombresTurnera(g);
      guardiaInfo = { turneraId: g.id, nombre: g.nombre, sede };
    }

    const base = {
      ordenId: orden.id,
      turnoId: orden.turnoId ?? null,
      practica: { id: practica.id, nombre: practica.nombre, codigoNomenclador },
      paciente: pacienteResumen,
      modalidad,
      ...(guardiaInfo ? { guardia: guardiaInfo } : {}),
    };

    if (programadas.length === 0 && guardias.length === 0) {
      res.json({ ...base, tipo: "sin_agenda", opciones: [] });
      return;
    }

    if (programadas.length === 0) {
      // Solo turneras de guardia → la práctica se atiende por demanda espontánea.
      res.json({ ...base, tipo: "demanda_espontanea", opciones: [] });
      return;
    }

    // Slots reales de los próximos 30 días; máx. 2 por día para variedad.
    const hoy = hoyArgentina();
    const fechas: string[] = [];
    {
      const d0 = new Date(`${hoy}T00:00:00.000Z`);
      for (let i = 0; i < 30; i++) {
        const d = new Date(d0);
        d.setUTCDate(d.getUTCDate() + i);
        fechas.push(d.toISOString().split("T")[0]);
      }
    }
    const idsProg = programadas.map((t) => t.id);
    const turnosRango = await db.select().from(turnosTable).where(and(
      inArray(turnosTable.turneraId, idsProg),
      gte(turnosTable.fecha, fechas[0]),
      lte(turnosTable.fecha, fechas[fechas.length - 1]),
    ));
    const turnosPorClave = new Map<string, typeof turnosRango>();
    for (const t of turnosRango) {
      const clave = `${t.turneraId}|${t.fecha}`;
      (turnosPorClave.get(clave) ?? turnosPorClave.set(clave, []).get(clave)!).push(t);
    }

    const nombresCache = new Map<number, { profesional: string | null; sede: string | null }>();
    const opciones: Array<{
      turneraId: number; turneraNombre: string; profesional: string | null; sede: string | null;
      fecha: string; horaInicio: string; horaFin: string;
    }> = [];
    const LIMITE = 4;
    for (const fecha of fechas) {
      if (opciones.length >= LIMITE) break;
      const slotsDia = (
        await Promise.all(
          programadas.map((t) => calcularSlotsDisponibles(t, fecha, turnosPorClave.get(`${t.id}|${fecha}`) ?? [])),
        )
      ).flat();
      const libres = slotsDia.filter((s) => s.disponible).sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));
      let delDia = 0;
      for (const s of libres) {
        if (opciones.length >= LIMITE || delDia >= 2) break;
        const turnera = programadas.find((t) => t.id === s.turneraId)!;
        if (!nombresCache.has(turnera.id)) nombresCache.set(turnera.id, await nombresTurnera(turnera));
        const n = nombresCache.get(turnera.id)!;
        opciones.push({
          turneraId: s.turneraId,
          turneraNombre: turnera.nombre,
          profesional: n.profesional,
          sede: n.sede,
          fecha: s.fecha,
          horaInicio: s.horaInicio,
          horaFin: s.horaFin,
        });
        delDia++;
      }
    }

    res.json({ ...base, tipo: opciones.length > 0 ? "opciones" : "sin_disponibilidad", opciones });
  },
);

// ── POST /api/ordenes-practicas/:id/asignar-turno ─────────────────────────────
// Crea el turno por el flujo existente (POST /turnos interno, con el token del
// usuario — nunca reimplementa la lógica de reserva) y vincula la orden.
const asignarTurnoSchema = z.object({
  turneraId: z.number().int().positive(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  horaInicio: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

router.post(
  "/ordenes-practicas/:id/asignar-turno",
  requireRol("admin", "recepcionista", "medico"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) { res.status(400).json({ error: "ID inválido" }); return; }
    const parsed = asignarTurnoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "Datos inválidos", detalles: parsed.error.issues });
      return;
    }

    const [orden] = await db.select().from(ordenesPracticasTable).where(eq(ordenesPracticasTable.id, id)).limit(1);
    if (!orden) { res.status(404).json({ error: "Orden no encontrada" }); return; }
    if (orden.turnoId) {
      res.status(409).json({ error: "La orden ya tiene un turno asignado" });
      return;
    }
    if (!["creada", "pendiente_validacion", "validada"].includes(orden.estado)) {
      res.status(422).json({ error: `No se puede asignar turno a una orden en estado '${orden.estado}'` });
      return;
    }

    const [practica] = await db.select().from(practicasCatalogoTable).where(eq(practicasCatalogoTable.id, orden.practicaId)).limit(1);
    if (!practica) { res.status(422).json({ error: "La orden no tiene una práctica válida" }); return; }

    const [turnera] = await db.select().from(turnerasTable)
      .where(and(eq(turnerasTable.id, parsed.data.turneraId), eq(turnerasTable.activa, true)))
      .limit(1);
    if (!turnera) { res.status(422).json({ error: "Agenda no encontrada o inactiva" }); return; }

    // Guardia (demanda espontánea): entra ahora, sin slot programado.
    const fecha = parsed.data.fecha ?? (turnera.esGuardia ? hoyArgentina() : null);
    const horaInicio = parsed.data.horaInicio ?? (turnera.esGuardia ? horaArgentina().substring(0, 5) : null);
    if (!fecha || !horaInicio) {
      res.status(422).json({ error: "Fecha y hora son obligatorias para agendas programadas" });
      return;
    }

    // Crear el turno por el flujo existente, con el token del usuario.
    const puerto = process.env.PORT ?? "8080";
    let turnoCreado: { id: number; fecha: string; horaInicio: string } | null = null;
    try {
      const resp = await fetch(`http://localhost:${puerto}/api/turnos`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
        body: JSON.stringify({
          turneraId: turnera.id,
          pacienteId: orden.patientId,
          fecha,
          horaInicio,
          modalidad: "presencial",
          motivoConsulta: `Orden ${orden.numeroOrden} — ${practica.nombre}`,
          regionAnatomica: orden.region ?? practica.nombre,
          cobertura: orden.coberturaObra ?? undefined,
          nroAfiliado: orden.coberturaNumeroAfiliado ?? undefined,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await resp.json().catch(() => ({}))) as { id?: number; fecha?: string; horaInicio?: string; error?: string };
      if (!resp.ok || !body.id) {
        res.status(resp.status === 201 ? 502 : resp.status).json({ error: body.error ?? "No se pudo crear el turno" });
        return;
      }
      turnoCreado = { id: body.id, fecha: body.fecha ?? fecha, horaInicio: body.horaInicio ?? horaInicio };
    } catch (err) {
      req.log.warn({ err: String(err) }, "asignar-turno: error al crear turno interno");
      res.status(503).json({ error: "Error técnico al crear el turno — reintente" });
      return;
    }

    await db.update(ordenesPracticasTable)
      .set({ turnoId: turnoCreado.id, updatedAt: new Date() })
      .where(eq(ordenesPracticasTable.id, orden.id));

    const user = await getUser(req);
    await logTransicion(
      orden.id,
      orden.estado,
      orden.estado,
      user?.id ?? null,
      turnera.esGuardia
        ? `Paciente sumado a demanda espontánea (${turnera.nombre})`
        : `Turno asignado desde la orden: ${turnoCreado.fecha} ${turnoCreado.horaInicio} (${turnera.nombre})`,
      { turnoId: turnoCreado.id, turneraId: turnera.id, esGuardia: turnera.esGuardia },
    );

    res.status(201).json({
      ok: true,
      turno: { id: turnoCreado.id, fecha: turnoCreado.fecha, horaInicio: turnoCreado.horaInicio, esGuardia: turnera.esGuardia },
    });
  },
);

export default router;
