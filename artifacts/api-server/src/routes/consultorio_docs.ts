import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { hoyArgentina } from "../lib/tiempo";
import {
  db,
  usersTable,
  pacientesTable,
  profesionalesTable,
  especialidadesTable,
  turnosTable,
  encountersTable,
  clinicalRecordsTable,
  practicasTable,
  prescriptionsTable,
  referralsTable,
  certificatesTable,
  certificadoVerificacionesTable,
  indicacionesPacientesTable,
  studyOrdersTable,
  studyOrdersFirmaLogTable,
  pdfDocumentsTable,
  auditLogTable,
  vitalSignsTable,
  encounterAttachmentsTable,
  turnerasTable,
  estudiosExternosTable,
  notificacionesSalientesTable,
  practicasCatalogoTable,
  sedesTable,
} from "@workspace/db";
import { enviarTurnoAlPacs } from "../integraciones/pacs-flujo";
import { enviarOrdenEstudioAlPacs } from "../integraciones/pacs-worklist";
import { encolarEnvioCertificadoApp } from "../integraciones/app-paciente-certificados";
import { encolarEnvioIndicacionApp } from "../integraciones/app-paciente-indicaciones";
import { notificarEventoVideollamadaPorTurno, avanzarFilaGuardia } from "../integraciones/app-paciente-videollamadas";
import {
  enviarWhatsappWhaticket,
  renderPlantilla,
  PLANTILLA_DOCUMENTO_APP_DEFAULT,
  PLANTILLA_META_DOCUMENTO_APP_ID,
} from "../integraciones/whaticket";
import {
  CreateConsultorioPrescriptionBody,
  CreateReferralBody,
  UpdateReferralEstadoBody,
  CreateCertificateBody,
  CreateIndicacionBody,
  CreateStudyOrderBody,
  UpdateStudyOrderStatusBody,
  RechazarFirmaStudyOrderBody,
  CrearNuevaVersionStudyOrderBody,
  FinalizarConsultaBody,
  EditarConsultaBody,
  GetDoctorDashboardQueryParams,
  GetClinicalAiSuggestionsBody,
  GeneratePdfBody,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { medicoPuedeVerPaciente } from "../lib/alcance-medico";
import {
  agregarLineaIndicacionDelDia,
  lineaReceta,
  lineaOrdenEstudio,
  lineaInterconsulta,
  upsertIndicacionManualDelDia,
} from "../lib/indicaciones-auto";
import { getUserIdFromToken } from "./auth";
import QRCode from "qrcode";
import { generarPdfDocumento } from "../pdf/documento_pdf";
import { prepararDatosPdf } from "../pdf/escaneado";
import { urlPublicaApp } from "../lib/url-publica";
import { cargarFuente, armarFuenteOrdenEstudio, armarDatosIndicaciones, numeroOrdenEstudio, numeroReceta } from "../pdf/fuente_documento";

const router: IRouter = Router();

// ── Auth (mismo modelo que consultorio.ts) ────────────────────────────────
type DocsUser = {
  id: number;
  email: string;
  rol: string;
  profesionalId: number | null;
  pacienteId: number | null;
};

async function getUser(req: Request): Promise<DocsUser | null> {
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

function puedeEscribir(user: DocsUser): boolean {
  return ["admin", "medico"].includes(user.rol);
}

// Solo roles profesionales (dashboard médico, IA clínica)
function esProfesional(user: DocsUser): boolean {
  return ["admin", "medico"].includes(user.rol);
}

// Lectura de documentos de un paciente: admin/medico siempre (precedente HCE),
// paciente solo si es su propia historia
async function puedeLeerPaciente(user: DocsUser, patientId: number): Promise<boolean> {
  if (user.rol === "admin") return true;
  // Un médico solo accede a documentos de pacientes dentro de su alcance
  // (turnos suyos o de turneras grupales en las que participa).
  if (user.rol === "medico") {
    if (user.profesionalId == null) return false;
    return medicoPuedeVerPaciente(user.profesionalId, patientId);
  }
  if (user.rol === "paciente") return user.pacienteId === patientId;
  return false;
}

// Staff administrativo (recepción/gestión): puede LISTAR e IMPRIMIR la
// documentación emitida de un paciente (certificados y recetas) desde la
// ficha, para entregarla impresa en mostrador. Solo lectura: la emisión
// sigue restringida a admin/medico (puedeEscribir).
function esStaffAdministrativo(user: DocsUser): boolean {
  return ["admin", "gerente", "desarrollador", "recepcionista"].includes(user.rol);
}

// medico: siempre su propio profesionalId; admin: puede indicar profesionalId en el body
function resolverProfesionalEmisor(user: DocsUser, bodyProfesionalId?: number): number | null {
  if (user.rol === "medico") return user.profesionalId;
  if (user.rol === "admin") return bodyProfesionalId ?? user.profesionalId ?? null;
  return null;
}

async function registrarAuditoria(
  user: DocsUser,
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

async function validarPacienteYProfesional(
  pacienteId: number,
  profesionalId: number,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, pacienteId)).limit(1);
  if (!paciente) return { ok: false, status: 404, error: "Paciente no encontrado" };
  const [profesional] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, profesionalId)).limit(1);
  if (!profesional) return { ok: false, status: 404, error: "Profesional no encontrado" };
  return { ok: true };
}

async function validarConsulta(consultationId: number | undefined | null): Promise<boolean> {
  if (consultationId == null) return true;
  const [enc] = await db.select().from(encountersTable).where(eq(encountersTable.id, consultationId)).limit(1);
  return Boolean(enc);
}

// ── Notificación por WhatsApp: documento nuevo en la app Mi Diagnosticar ──
// Al emitir una receta o certificado, se le avisa al paciente por WhatsApp
// (plantilla validada por Meta) que el documento está disponible en la app,
// invitándolo a descargarla si todavía no la tiene. Fire-and-forget: nunca
// bloquea ni hace fallar la emisión del documento.
async function notificarDocumentoEnApp(opts: {
  patientId: number;
  profesionalId: number;
  documento: "receta" | "certificado" | "indicaciones";
  usuarioOrigenId: number;
  log: Request["log"];
}): Promise<void> {
  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, opts.patientId)).limit(1);
  if (!paciente) return;
  const [profesional] = await db
    .select()
    .from(profesionalesTable)
    .where(eq(profesionalesTable.id, opts.profesionalId))
    .limit(1);

  const linkApp = process.env.APP_PACIENTE_URL ?? "https://turno-facil.replit.app/";
  const contenido = renderPlantilla(PLANTILLA_DOCUMENTO_APP_DEFAULT, {
    nombre: paciente.nombre?.split(" ")[0] || "paciente",
    clinica: "Diagnosticar",
    profesional: profesional ? `${profesional.apellido}, ${profesional.nombre}` : "Tu médico",
    documento: opts.documento === "receta" ? "una receta" : opts.documento === "indicaciones" ? "indicaciones médicas" : "un certificado",
    link: linkApp,
  });

  const telefono = paciente.telefono?.trim() || null;
  let estadoEntrega = "simulada";
  let errorDetalle: string | null = null;
  if (!telefono) {
    estadoEntrega = "fallida";
    errorDetalle = "El paciente no tiene teléfono registrado";
  } else {
    const r = await enviarWhatsappWhaticket(telefono, contenido, opts.log, {
      templateId: PLANTILLA_META_DOCUMENTO_APP_ID,
    });
    estadoEntrega = r.estado;
    if (r.estado === "fallida") errorDetalle = r.error;
  }

  await db.insert(notificacionesSalientesTable).values({
    patientId: opts.patientId,
    canal: "whatsapp",
    evento: opts.documento === "receta" ? "receta_emitida" : opts.documento === "indicaciones" ? "indicaciones_emitidas" : "certificado_emitido",
    destinatario: telefono,
    contenido,
    estadoEntrega,
    errorDetalle,
    template: "documento_app",
    usuarioOrigenId: opts.usuarioOrigenId,
  });
}

function notificarDocumentoEnAppAsync(opts: Parameters<typeof notificarDocumentoEnApp>[0]): void {
  void notificarDocumentoEnApp(opts).catch((err) => {
    opts.log.warn({ err: err instanceof Error ? err.message : String(err) }, "No se pudo notificar el documento por WhatsApp");
  });
}

// ── POST /consultorio/prescriptions ───────────────────────────────────────
router.post("/consultorio/prescriptions", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos para emitir recetas" }); return; }

  const parsed = CreateConsultorioPrescriptionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const profesionalId = resolverProfesionalEmisor(user, parsed.data.profesionalId);
  if (profesionalId == null) {
    res.status(400).json({ error: user.rol === "admin" ? "Indicá el profesionalId emisor" : "El usuario no tiene un profesional asociado" });
    return;
  }

  const val = await validarPacienteYProfesional(parsed.data.patientId, profesionalId);
  if (!val.ok) { res.status(val.status).json({ error: val.error }); return; }
  if (!(await validarConsulta(parsed.data.consultationId))) {
    res.status(404).json({ error: "Consulta no encontrada" });
    return;
  }

  const [receta] = await db
    .insert(prescriptionsTable)
    .values({
      encounterId: parsed.data.consultationId ?? null,
      medication: parsed.data.medication,
      dosage: parsed.data.dosage ?? null,
      frequency: parsed.data.frequency ?? null,
      duration: parsed.data.duration ?? null,
      instructions: parsed.data.instructions ?? null,
      patientId: parsed.data.patientId,
      professionalId: profesionalId,
      consultationId: parsed.data.consultationId ?? null,
      type: parsed.data.type ?? "medicamento",
      status: "emitida",
      createdBy: user.id,
    })
    .returning();

  await registrarAuditoria(user, "crear", "receta", receta.id, receta.patientId, parsed.data);
  // Las indicaciones del día se arman solas: cada receta suma su línea
  void agregarLineaIndicacionDelDia({
    patientId: parsed.data.patientId,
    professionalId: profesionalId,
    consultationId: parsed.data.consultationId ?? null,
    createdBy: user.id,
    seccion: "medicamentos",
    linea: lineaReceta(receta),
  });
  notificarDocumentoEnAppAsync({
    patientId: parsed.data.patientId,
    profesionalId,
    documento: "receta",
    usuarioOrigenId: user.id,
    log: req.log,
  });
  res.status(201).json(receta);
});

// ── GET /consultorio/patients/:patientId/prescriptions ────────────────────
router.get("/consultorio/patients/:patientId/prescriptions", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const patientId = parseInt(String(req.params.patientId));
  if (isNaN(patientId)) { res.status(400).json({ error: "patientId inválido" }); return; }
  // Recepción también lista (solo lectura) para imprimir desde la ficha.
  if (!esStaffAdministrativo(user) && !(await puedeLeerPaciente(user, patientId))) { res.status(403).json({ error: "Sin permisos" }); return; }

  const recetas = await db
    .select()
    .from(prescriptionsTable)
    .where(eq(prescriptionsTable.patientId, patientId))
    .orderBy(desc(prescriptionsTable.createdAt));
  res.json(recetas);
});

// ── POST /consultorio/referrals ───────────────────────────────────────────
router.post("/consultorio/referrals", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos para emitir derivaciones" }); return; }

  const parsed = CreateReferralBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const profesionalId = resolverProfesionalEmisor(user, parsed.data.profesionalId);
  if (profesionalId == null) {
    res.status(400).json({ error: user.rol === "admin" ? "Indicá el profesionalId emisor" : "El usuario no tiene un profesional asociado" });
    return;
  }

  const val = await validarPacienteYProfesional(parsed.data.patientId, profesionalId);
  if (!val.ok) { res.status(val.status).json({ error: val.error }); return; }
  if (!(await validarConsulta(parsed.data.consultationId))) {
    res.status(404).json({ error: "Consulta no encontrada" });
    return;
  }

  const [derivacion] = await db
    .insert(referralsTable)
    .values({
      patientId: parsed.data.patientId,
      professionalId: profesionalId,
      consultationId: parsed.data.consultationId ?? null,
      targetSpecialty: parsed.data.targetSpecialty,
      targetProfessionalId: parsed.data.targetProfessionalId ?? null,
      reason: parsed.data.reason,
      priority: parsed.data.priority ?? "normal",
      observations: parsed.data.observations ?? null,
      status: "pedido",
      createdBy: user.id,
    })
    .returning();

  await registrarAuditoria(user, "crear", "derivacion", derivacion.id, derivacion.patientId, parsed.data);
  // Las interconsultas suman su línea a las indicaciones del día
  void agregarLineaIndicacionDelDia({
    patientId: derivacion.patientId,
    professionalId: profesionalId,
    consultationId: derivacion.consultationId,
    createdBy: user.id,
    seccion: "otrasIndicaciones",
    linea: lineaInterconsulta(derivacion),
  });
  res.status(201).json(derivacion);
});

// ── Trazabilidad de derivaciones internas ─────────────────────────────────
// pedido → agendado → realizado → informado. Anulable hasta que se realiza.
const TRANSICIONES_DERIVACION: Record<string, string[]> = {
  pedido: ["agendado", "anulada"],
  agendado: ["realizado", "pedido", "anulada"],
  realizado: ["informado"],
  informado: [],
  anulada: [],
};

// ── PATCH /consultorio/referrals/:id/estado ───────────────────────────────
router.patch("/consultorio/referrals/:id/estado", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!["admin", "recepcionista", "medico"].includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos para gestionar derivaciones" });
    return;
  }

  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const parsed = UpdateReferralEstadoBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const nuevoEstado = parsed.data.estado;

  const [derivacion] = await db.select().from(referralsTable).where(eq(referralsTable.id, id)).limit(1);
  if (!derivacion) { res.status(404).json({ error: "Derivación no encontrada" }); return; }

  // El médico solo gestiona derivaciones que pidió él mismo
  if (user.rol === "medico" && derivacion.professionalId !== user.profesionalId) {
    res.status(403).json({ error: "Solo puede gestionar sus propias derivaciones" });
    return;
  }

  const estadoActual = derivacion.status;
  const permitidas = TRANSICIONES_DERIVACION[estadoActual] ?? [];
  if (!permitidas.includes(nuevoEstado)) {
    res.status(422).json({
      error: `Transición no permitida: ${estadoActual} → ${nuevoEstado}`,
      transicionesValidas: permitidas,
    });
    return;
  }

  // Transición atómica: condición de estado dentro del UPDATE
  const [updated] = await db
    .update(referralsTable)
    .set({ status: nuevoEstado, updatedAt: new Date() })
    .where(and(eq(referralsTable.id, id), eq(referralsTable.status, estadoActual)))
    .returning();
  if (!updated) {
    res.status(409).json({ error: "La derivación cambió de estado; recargá e intentá de nuevo" });
    return;
  }

  await registrarAuditoria(user, "actualizar", "derivacion", updated.id, updated.patientId, {
    estadoAnterior: estadoActual,
    estadoNuevo: nuevoEstado,
    ...(parsed.data.notas ? { notas: parsed.data.notas } : {}),
  });
  res.json(updated);
});

// ── GET /consultorio/patients/:patientId/referrals ────────────────────────
router.get("/consultorio/patients/:patientId/referrals", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const patientId = parseInt(String(req.params.patientId));
  if (isNaN(patientId)) { res.status(400).json({ error: "patientId inválido" }); return; }
  if (!(await puedeLeerPaciente(user, patientId))) { res.status(403).json({ error: "Sin permisos" }); return; }

  const derivaciones = await db
    .select()
    .from(referralsTable)
    .where(eq(referralsTable.patientId, patientId))
    .orderBy(desc(referralsTable.createdAt));
  res.json(derivaciones);
});

// ── Número institucional del certificado ──────────────────────────────────
// Formato visible: CT-AAAAMMDD-XXXXXXXX (fecha de emisión + id con ceros).
// Es derivable del registro (id + createdAt): único, secuencial y estable.
export function numeroCertificado(c: { id: number; createdAt: Date | string }): string {
  const f = new Date(c.createdAt);
  const ymd = `${f.getUTCFullYear()}${String(f.getUTCMonth() + 1).padStart(2, "0")}${String(f.getUTCDate()).padStart(2, "0")}`;
  return `CT-${ymd}-${String(c.id).padStart(8, "0")}`;
}

// Acepta el número CT ingresado a mano y devuelve el id del certificado.
function idDesdeNumeroCertificado(codigo: string): number | null {
  const m = /^CT-?(\d{8})-?(\d{1,10})$/i.exec(codigo.trim());
  if (!m) return null;
  const id = parseInt(m[2], 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// DNI parcialmente oculto para la página pública: ••.•••.456
function dniParcial(dni: string | null | undefined): string | null {
  const limpio = (dni ?? "").replace(/\D/g, "");
  if (!limpio) return null;
  return `••.•••.${limpio.slice(-3)}`;
}

// ── Freno anti-enumeración del verificador público ────────────────────────
// El número CT es derivable (fecha + id secuencial): sin un límite por IP se
// podrían barrer rangos y extraer datos clínicos a escala. Límite en memoria:
// 30 consultas por minuto por IP (de sobra para uso legítimo).
const ventanasVerificacion = new Map<string, { hasta: number; usos: number }>();
function permitirVerificacionPublica(req: Request): boolean {
  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const ahora = Date.now();
  const v = ventanasVerificacion.get(ip);
  if (!v || v.hasta < ahora) {
    // Limpieza oportunista para que el mapa no crezca sin límite.
    if (ventanasVerificacion.size > 5000) {
      for (const [k, w] of ventanasVerificacion) if (w.hasta < ahora) ventanasVerificacion.delete(k);
    }
    ventanasVerificacion.set(ip, { hasta: ahora + 60_000, usos: 1 });
    return true;
  }
  v.usos += 1;
  return v.usos <= 30;
}

// Arma el DatosDocumentoPdf completo de un certificado (para el PDF original).
async function armarDatosPdfCertificado(certId: number) {
  const fuente = await cargarFuente("certificado", certId);
  if (!fuente) return null;
  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, fuente.patientId)).limit(1);
  const [profesional] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, fuente.professionalId)).limit(1);
  if (!paciente || !profesional) return null;
  let especialidad: string | null = null;
  if (profesional.especialidadId != null) {
    const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, profesional.especialidadId)).limit(1);
    especialidad = esp?.nombre ?? null;
  }
  return {
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
  };
}

// Genera el PDF de un certificado como Buffer (para el snapshot inmutable).
async function generarPdfCertificadoBuffer(certId: number): Promise<Buffer | null> {
  const datos = await armarDatosPdfCertificado(certId);
  if (!datos) return null;
  const doc = generarPdfDocumento(datos);
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (ch: Buffer) => chunks.push(ch));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

// Genera y guarda el PDF original inmutable del certificado recién emitido.
async function guardarPdfOriginalCertificado(certId: number): Promise<void> {
  try {
    const buf = await generarPdfCertificadoBuffer(certId);
    if (buf) {
      await db.update(certificatesTable)
        .set({ pdfOriginal: buf.toString("base64") })
        .where(eq(certificatesTable.id, certId));
    }
  } catch {
    // Sin snapshot, la descarga pública cae al PDF regenerado (fallback).
  }
}

// ── POST /consultorio/certificates ────────────────────────────────────────
router.post("/consultorio/certificates", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos para emitir certificados" }); return; }

  const parsed = CreateCertificateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const profesionalId = resolverProfesionalEmisor(user, parsed.data.profesionalId);
  if (profesionalId == null) {
    res.status(400).json({ error: user.rol === "admin" ? "Indicá el profesionalId emisor" : "El usuario no tiene un profesional asociado" });
    return;
  }

  const val = await validarPacienteYProfesional(parsed.data.patientId, profesionalId);
  if (!val.ok) { res.status(val.status).json({ error: val.error }); return; }
  if (!(await validarConsulta(parsed.data.consultationId))) {
    res.status(404).json({ error: "Consulta no encontrada" });
    return;
  }

  // Reemplazo: el certificado nuevo corrige uno anterior del MISMO paciente.
  let certAnterior: typeof certificatesTable.$inferSelect | null = null;
  if (parsed.data.reemplazaAId != null) {
    const [ant] = await db.select().from(certificatesTable).where(eq(certificatesTable.id, parsed.data.reemplazaAId)).limit(1);
    if (!ant || ant.patientId !== parsed.data.patientId) {
      res.status(404).json({ error: "El certificado a reemplazar no existe o es de otro paciente" });
      return;
    }
    if (ant.estado === "reemplazado") {
      res.status(409).json({ error: "Ese certificado ya fue reemplazado por otro" });
      return;
    }
    certAnterior = ant;
  }

  // Emisión + reemplazo en UNA transacción: el anterior solo pasa a
  // "reemplazado" si sigue "valido" (evita doble reemplazo concurrente o
  // pisar un revocado). Si la transición falla, no se emite nada.
  let certificado: typeof certificatesTable.$inferSelect;
  try {
    certificado = await db.transaction(async (tx) => {
      if (certAnterior) {
        const [ant] = await tx.update(certificatesTable)
          .set({ estado: "reemplazado", updatedAt: new Date() })
          .where(and(eq(certificatesTable.id, certAnterior.id), eq(certificatesTable.estado, "valido")))
          .returning();
        if (!ant) throw new Error("REEMPLAZO_CONFLICTO");
      }
      const [nuevo] = await tx
        .insert(certificatesTable)
        .values({
          reemplazaAId: certAnterior?.id ?? null,
          patientId: parsed.data.patientId,
          professionalId: profesionalId,
          consultationId: parsed.data.consultationId ?? null,
          certificateType: parsed.data.certificateType,
          diagnosis: parsed.data.diagnosis ?? null,
          restDays: parsed.data.restDays ?? null,
          content: parsed.data.content,
          observations: parsed.data.observations ?? null,
          verificationCode: randomBytes(10).toString("hex"),
          createdBy: user.id,
        })
        .returning();
      if (certAnterior) {
        await tx.update(certificatesTable)
          .set({ reemplazadoPorId: nuevo.id })
          .where(eq(certificatesTable.id, certAnterior.id));
      }
      return nuevo;
    });
  } catch (e) {
    if (e instanceof Error && e.message === "REEMPLAZO_CONFLICTO") {
      res.status(409).json({ error: "El certificado a reemplazar ya no está vigente (fue revocado o reemplazado)" });
      return;
    }
    throw e;
  }

  if (certAnterior) {
    await registrarAuditoria(user, "reemplazar", "certificado", certAnterior.id, certAnterior.patientId, { reemplazadoPorId: certificado.id });
  }

  // Snapshot inmutable del PDF original (la descarga pública sirve esto).
  await guardarPdfOriginalCertificado(certificado.id);

  await registrarAuditoria(user, "crear", "certificado", certificado.id, certificado.patientId, parsed.data);
  // Push automático a la app del paciente (cola con reintentos, nunca bloquea)
  void encolarEnvioCertificadoApp(certificado.id);
  notificarDocumentoEnAppAsync({
    patientId: certificado.patientId,
    profesionalId,
    documento: "certificado",
    usuarioOrigenId: user.id,
    log: req.log,
  });
  res.status(201).json({ ...certificado, numero: numeroCertificado(certificado) });
});

// ── POST /consultorio/certificates/:id/revocar ────────────────────────────
// Revoca (anula) un certificado emitido. Lo puede hacer el profesional
// emisor o un rol de gestión. El documento no se borra: queda con estado
// "revocado" y la página pública lo informa.
router.post("/consultorio/certificates/:id/revocar", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "id inválido" }); return; }

  const [c] = await db.select().from(certificatesTable).where(eq(certificatesTable.id, id)).limit(1);
  if (!c) { res.status(404).json({ error: "Certificado no encontrado" }); return; }

  const esGestion = ["admin", "gerente", "desarrollador"].includes(user.rol);
  const esEmisor = puedeEscribir(user) && resolverProfesionalEmisor(user, undefined) === c.professionalId;
  if (!esGestion && !esEmisor) { res.status(403).json({ error: "Solo el profesional emisor o gestión pueden revocar" }); return; }

  if (c.estado === "revocado") { res.status(409).json({ error: "El certificado ya está revocado" }); return; }
  if (c.estado === "reemplazado") { res.status(409).json({ error: "El certificado ya fue reemplazado por otro" }); return; }

  const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim().slice(0, 500) : null;
  const [actualizado] = await db.update(certificatesTable)
    .set({ estado: "revocado", motivoRevocacion: motivo || null, revocadoEn: new Date(), revocadoPorId: user.id, updatedAt: new Date() })
    .where(and(eq(certificatesTable.id, id), eq(certificatesTable.estado, "valido")))
    .returning();
  if (!actualizado) { res.status(409).json({ error: "El certificado cambió de estado; recargá la página" }); return; }

  await registrarAuditoria(user, "revocar", "certificado", id, c.patientId, { motivo });
  res.json({ ...actualizado, numero: numeroCertificado(actualizado) });
});

// ── GET /consultorio/certificates/:id/verificaciones ──────────────────────
// Historial de verificaciones públicas de un certificado (QR/link, código
// manual o descarga del PDF). SOLO roles de gestión: sirve para auditar ante
// una disputa ("el empleador dice que nunca lo verificó"). Nunca es público.
router.get("/consultorio/certificates/:id/verificaciones", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!["admin", "gerente", "desarrollador"].includes(user.rol)) {
    res.status(403).json({ error: "Solo roles de gestión pueden ver las verificaciones" });
    return;
  }
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "id inválido" }); return; }

  const [c] = await db.select().from(certificatesTable).where(eq(certificatesTable.id, id)).limit(1);
  if (!c) { res.status(404).json({ error: "Certificado no encontrado" }); return; }

  const filas = await db
    .select()
    .from(certificadoVerificacionesTable)
    .where(eq(certificadoVerificacionesTable.certificateId, id))
    .orderBy(desc(certificadoVerificacionesTable.fecha));

  res.json(filas.map((v) => ({
    id: v.id,
    fecha: v.fecha,
    via: v.via, // qr_link | codigo_manual | descarga_pdf
    estadoAlMomento: v.estadoAlMomento,
    ip: v.ip,
    dispositivo: resumirDispositivo(v.userAgent),
  })));
});

// Resumen legible del dispositivo a partir del user-agent (aproximado; no se
// expone el user-agent crudo en la UI de gestión).
function resumirDispositivo(ua: string | null): string | null {
  if (!ua) return null;
  const so = /Android/i.test(ua) ? "Android"
    : /iPhone|iPad|iPod/i.test(ua) ? "iPhone/iPad"
    : /Windows/i.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua) ? "Mac"
    : /Linux/i.test(ua) ? "Linux"
    : null;
  const nav = /Edg\//i.test(ua) ? "Edge"
    : /OPR\/|Opera/i.test(ua) ? "Opera"
    : /Firefox\//i.test(ua) ? "Firefox"
    : /Chrome\//i.test(ua) ? "Chrome"
    : /Safari\//i.test(ua) ? "Safari"
    : null;
  if (!so && !nav) return "Otro dispositivo";
  return [nav, so].filter(Boolean).join(" en ");
}

// ── POST /consultorio/certificates/preview-pdf ────────────────────────────
// Vista previa del PDF de un certificado ANTES de emitirlo: recibe el mismo
// body que la creación, arma el documento en memoria y no persiste nada.
router.post("/consultorio/certificates/preview-pdf", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos para emitir certificados" }); return; }

  const parsed = CreateCertificateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const profesionalId = resolverProfesionalEmisor(user, parsed.data.profesionalId);
  if (profesionalId == null) {
    res.status(400).json({ error: user.rol === "admin" ? "Indicá el profesionalId emisor" : "El usuario no tiene un profesional asociado" });
    return;
  }

  const val = await validarPacienteYProfesional(parsed.data.patientId, profesionalId);
  if (!val.ok) { res.status(val.status).json({ error: val.error }); return; }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, parsed.data.patientId)).limit(1);
  const [profesional] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, profesionalId)).limit(1);
  if (!paciente || !profesional) { res.status(404).json({ error: "Datos del documento incompletos" }); return; }

  let especialidad: string | null = null;
  if (profesional.especialidadId != null) {
    const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, profesional.especialidadId)).limit(1);
    especialidad = esp?.nombre ?? null;
  }

  // QR de muestra: en la vista previa el código real todavía no existe (se
  // genera al emitir), pero se estampa uno de ejemplo para ver el layout final.
  let verificacion: { qrPng: Buffer; codigo: string } | null = null;
  const baseVerificacion = urlPublicaApp();
  if (baseVerificacion) {
    try {
      const codigoMuestra = "00000000000000000000";
      const qrPng = await QRCode.toBuffer(`${baseVerificacion}/verificar/${codigoMuestra}`, { margin: 1, width: 220 });
      verificacion = { qrPng, codigo: codigoMuestra };
    } catch {
      verificacion = null;
    }
  }

  const doc = generarPdfDocumento({
    titulo: "Certificado médico (VISTA PREVIA)",
    tipoDocumento: "certificado",
    fechaEmision: new Date(),
    campos: [
      { etiqueta: "Tipo", valor: parsed.data.certificateType },
      { etiqueta: "Diagnóstico", valor: parsed.data.diagnosis ?? "" },
      { etiqueta: "Días de reposo", valor: parsed.data.restDays != null ? String(parsed.data.restDays) : "" },
    ],
    cuerpo: parsed.data.content,
    observaciones: parsed.data.observations ?? null,
    verificacion,
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
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="vista_previa_certificado_${paciente.apellido.toLowerCase()}.pdf"`);
  doc.pipe(res);
  doc.end();
});

// ── GET /consultorio/certificados/verificar/:codigo ───────────────────────
// Endpoint PÚBLICO (sin login): verificación de autenticidad de un
// certificado escaneando el QR impreso. Devuelve solo lo necesario para
// validar la atención; nunca el contenido clínico completo.
// Acepta el token hexadecimal del QR/link o el número institucional CT-...
// ingresado a mano. Cada consulta queda registrada para auditoría interna
// (fecha, IP, navegador) — jamás se le muestra al público.
async function buscarCertificadoPorCodigo(codigo: string) {
  const hex = codigo.trim().toLowerCase();
  if (/^[a-f0-9]{16,64}$/.test(hex)) {
    const [c] = await db.select().from(certificatesTable).where(eq(certificatesTable.verificationCode, hex)).limit(1);
    return { cert: c ?? null, via: "qr_link" as const };
  }
  const id = idDesdeNumeroCertificado(codigo);
  if (id != null) {
    const [c] = await db.select().from(certificatesTable).where(eq(certificatesTable.id, id)).limit(1);
    // El número manual debe coincidir COMPLETO (fecha incluida) para no
    // permitir adivinar certificados probando ids secuenciales. Se normaliza
    // el ingreso (guiones opcionales, ceros a la izquierda del id).
    const m = /^CT-?(\d{8})-?(\d{1,10})$/i.exec(codigo.trim());
    if (c && m && numeroCertificado(c) === `CT-${m[1]}-${m[2].padStart(8, "0")}`) {
      return { cert: c, via: "codigo_manual" as const };
    }
  }
  return { cert: null, via: "codigo_manual" as const };
}

function registrarVerificacion(req: Request, certificateId: number, estado: string, via: string): void {
  const ip = (String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "").slice(0, 64);
  const userAgent = String(req.headers["user-agent"] ?? "").slice(0, 300);
  void db.insert(certificadoVerificacionesTable)
    .values({ certificateId, estadoAlMomento: estado, via, ip: ip || null, userAgent: userAgent || null })
    .catch(() => { /* la trazabilidad nunca debe romper la verificación pública */ });
}

router.get("/consultorio/certificados/verificar/:codigo", async (req: Request, res: Response) => {
  if (!permitirVerificacionPublica(req)) { res.status(429).json({ error: "Demasiadas consultas; esperá un minuto" }); return; }
  const codigo = String(req.params.codigo ?? "").trim();
  if (!codigo || codigo.length > 80) { res.status(404).json({ valido: false, estado: "inexistente" }); return; }

  const { cert: c, via } = await buscarCertificadoPorCodigo(codigo);
  if (!c) { res.status(404).json({ valido: false, estado: "inexistente" }); return; }

  registrarVerificacion(req, c.id, c.estado, via);

  const [pac] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, c.patientId)).limit(1);
  const [prof] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, c.professionalId)).limit(1);
  let especialidad: string | null = null;
  if (prof?.especialidadId != null) {
    const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, prof.especialidadId)).limit(1);
    especialidad = esp?.nombre ?? null;
  }

  // Fechas de reposo: desde la fecha de emisión, N días corridos (inclusive).
  let reposo: { dias: number; desde: string; hasta: string } | null = null;
  if (c.restDays != null && c.restDays > 0) {
    const desde = new Date(c.createdAt);
    const hasta = new Date(desde.getTime() + (c.restDays - 1) * 24 * 60 * 60 * 1000);
    const aFecha = (d: Date) => d.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" });
    reposo = { dias: c.restDays, desde: aFecha(desde), hasta: aFecha(hasta) };
  }

  // Datos de la atención asociada (día, hora y sede) — best-effort:
  // la fecha/hora sale de la consulta médica vinculada (si existe); la sede
  // y la hora del turno salen del turno del paciente con ese profesional ese
  // día. Si no hay nada vinculado, la página muestra solo la emisión.
  const zonaAr = "America/Argentina/Buenos_Aires";
  const aFechaAr = (d: Date) => d.toLocaleDateString("es-AR", { timeZone: zonaAr, day: "2-digit", month: "2-digit", year: "numeric" });
  const aHoraAr = (d: Date) => d.toLocaleTimeString("es-AR", { timeZone: zonaAr, hour: "2-digit", minute: "2-digit", hour12: false });
  let fechaBaseAtencion = new Date(c.createdAt);
  let horaAtencion: string | null = null;
  let huboConsulta = false;
  if (c.consultationId != null) {
    const [enc] = await db.select().from(encountersTable).where(eq(encountersTable.id, c.consultationId)).limit(1);
    if (enc?.encounterDate) {
      fechaBaseAtencion = new Date(enc.encounterDate);
      horaAtencion = aHoraAr(fechaBaseAtencion);
      huboConsulta = true;
    }
  }
  let sedeAtencion: string | null = null;
  try {
    const fechaTurno = fechaBaseAtencion.toLocaleDateString("en-CA", { timeZone: zonaAr });
    const filasTurno = await db
      .select({ hora: turnosTable.horaInicio, sedeNombre: sedesTable.nombre })
      .from(turnosTable)
      .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
      .leftJoin(sedesTable, eq(turnerasTable.sedeId, sedesTable.id))
      .where(and(
        eq(turnosTable.pacienteId, c.patientId),
        eq(turnosTable.fecha, fechaTurno),
        notInArray(turnosTable.estado, ["cancelado", "ausente"]),
        or(eq(turnosTable.profesionalId, c.professionalId), eq(turnerasTable.profesionalId, c.professionalId))!
      ))
      .limit(2);
    // Solo se informa si el turno es inequívoco (uno solo ese día).
    if (filasTurno.length === 1) {
      sedeAtencion = filasTurno[0].sedeNombre ?? null;
      if (!horaAtencion && filasTurno[0].hora) horaAtencion = filasTurno[0].hora;
    }
  } catch { /* la sede es informativa; nunca rompe la verificación */ }
  const atencion = (huboConsulta || sedeAtencion || horaAtencion)
    ? { fecha: aFechaAr(fechaBaseAtencion), hora: horaAtencion, sede: sedeAtencion }
    : null;

  res.json({
    valido: c.estado === "valido",
    estado: c.estado, // valido | revocado | reemplazado
    numero: numeroCertificado(c),
    atencion,
    horaEmision: aHoraAr(new Date(c.createdAt)),
    tipo: c.certificateType,
    fechaEmision: c.createdAt,
    diagnostico: c.diagnosis ?? null,
    diasReposo: c.restDays ?? null,
    reposo,
    paciente: pac ? `${pac.apellido ?? ""}, ${pac.nombre ?? ""}`.replace(/^, /, "") : null,
    dni: dniParcial(pac?.dni),
    profesional: prof ? `${prof.apellido ? prof.apellido + ", " : ""}${prof.nombre ?? ""}` : null,
    matricula: prof?.matricula ?? null,
    especialidad,
    motivoRevocacion: c.estado === "revocado" ? (c.motivoRevocacion ?? null) : null,
    revocadoEn: c.estado === "revocado" ? c.revocadoEn : null,
    // Código del certificado que lo reemplazó (para verlo en la misma página)
    reemplazadoPor: null as string | null,
    ...(c.reemplazadoPorId != null
      ? await (async () => {
          const [nuevo] = await db.select().from(certificatesTable).where(eq(certificatesTable.id, c.reemplazadoPorId!)).limit(1);
          return { reemplazadoPor: nuevo?.verificationCode ?? null, reemplazadoPorNumero: nuevo ? numeroCertificado(nuevo) : null };
        })()
      : {}),
    // El PDF original solo se descarga cuando el certificado está vigente.
    pdfDisponible: c.estado === "valido" && !!c.verificationCode,
  });
});

// ── GET /consultorio/ordenes/verificar/:codigo ────────────────────────────
// Endpoint PÚBLICO (sin login): verificación de autenticidad de una orden de
// estudio escaneando el QR impreso en la orden de baja complejidad. Devuelve
// solo lo necesario para validar la orden; nunca la historia clínica.
// Acepta el token hexadecimal del QR/link o el número OE-... impreso.
router.get("/consultorio/ordenes/verificar/:codigo", async (req: Request, res: Response) => {
  if (!permitirVerificacionPublica(req)) { res.status(429).json({ error: "Demasiadas consultas; esperá un minuto" }); return; }
  const codigo = String(req.params.codigo ?? "").trim();
  if (!codigo || codigo.length > 80) { res.status(404).json({ valido: false, estado: "inexistente" }); return; }

  let orden: typeof studyOrdersTable.$inferSelect | null = null;
  const hex = codigo.toLowerCase();
  if (/^[a-f0-9]{16,64}$/.test(hex)) {
    const [o] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.verificationCode, hex)).limit(1);
    orden = o ?? null;
  } else {
    // Número OE ingresado a mano: debe coincidir COMPLETO (fecha incluida)
    // para no permitir barrer ids secuenciales.
    const m = /^OE-?(\d{8})-?(\d{1,10})$/i.exec(codigo);
    const id = m ? parseInt(m[2], 10) : null;
    if (m && id != null && Number.isSafeInteger(id) && id > 0) {
      const [o] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, id)).limit(1);
      if (o && numeroOrdenEstudio(o) === `OE-${m[1]}-${m[2].padStart(8, "0")}`) orden = o;
    }
  }
  if (!orden) { res.status(404).json({ valido: false, estado: "inexistente" }); return; }

  const [pac] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, orden.patientId)).limit(1);
  const [prof] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, orden.professionalId)).limit(1);
  let especialidad: string | null = null;
  if (prof?.especialidadId != null) {
    const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, prof.especialidadId)).limit(1);
    especialidad = esp?.nombre ?? null;
  }

  const anulada = orden.status === "anulada";
  res.json({
    valido: !anulada,
    estado: anulada ? "anulada" : "vigente",
    numero: numeroOrdenEstudio(orden),
    fechaEmision: orden.createdAt,
    estudio: orden.studyName,
    prioridad: orden.priority === "urgente" ? "URGENTE" : "Normal",
    paciente: pac ? `${pac.apellido ?? ""}, ${pac.nombre ?? ""}`.replace(/^, /, "") : null,
    dni: dniParcial(pac?.dni),
    profesional: prof ? `${prof.apellido ? prof.apellido + ", " : ""}${prof.nombre ?? ""}` : null,
    matricula: prof?.matricula ?? null,
    especialidad,
  });
});

// ── GET /consultorio/recetas/verificar/:codigo ────────────────────────────
// Endpoint PÚBLICO (sin login): verificación de autenticidad de una receta
// (la usa la farmacia escaneando el QR impreso). Datos mínimos, nunca HCE.
router.get("/consultorio/recetas/verificar/:codigo", async (req: Request, res: Response) => {
  if (!permitirVerificacionPublica(req)) { res.status(429).json({ error: "Demasiadas consultas; esperá un minuto" }); return; }
  const codigo = String(req.params.codigo ?? "").trim();
  if (!codigo || codigo.length > 80) { res.status(404).json({ valido: false, estado: "inexistente" }); return; }

  let receta: typeof prescriptionsTable.$inferSelect | null = null;
  const hex = codigo.toLowerCase();
  if (/^[a-f0-9]{16,64}$/.test(hex)) {
    const [r] = await db.select().from(prescriptionsTable).where(eq(prescriptionsTable.verificationCode, hex)).limit(1);
    receta = r ?? null;
  } else {
    // Número RM ingresado a mano: coincidencia COMPLETA (fecha incluida)
    // para no permitir barrer ids secuenciales.
    const m = /^RM-?(\d{8})-?(\d{1,10})$/i.exec(codigo);
    const id = m ? parseInt(m[2], 10) : null;
    if (m && id != null && Number.isSafeInteger(id) && id > 0) {
      const [r] = await db.select().from(prescriptionsTable).where(eq(prescriptionsTable.id, id)).limit(1);
      if (r && numeroReceta(r) === `RM-${m[1]}-${m[2].padStart(8, "0")}`) receta = r;
    }
  }
  if (!receta || receta.patientId == null || receta.professionalId == null) {
    res.status(404).json({ valido: false, estado: "inexistente" });
    return;
  }

  const [pac] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, receta.patientId)).limit(1);
  const [prof] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, receta.professionalId)).limit(1);
  let especialidad: string | null = null;
  if (prof?.especialidadId != null) {
    const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, prof.especialidadId)).limit(1);
    especialidad = esp?.nombre ?? null;
  }

  const anulada = receta.status === "anulada";
  res.json({
    valido: !anulada,
    estado: anulada ? "anulada" : "vigente",
    numero: numeroReceta(receta),
    fechaEmision: receta.createdAt,
    medicamento: receta.medication,
    dosis: receta.dosage,
    paciente: pac ? `${pac.apellido ?? ""}, ${pac.nombre ?? ""}`.replace(/^, /, "") : null,
    dni: dniParcial(pac?.dni),
    profesional: prof ? `${prof.apellido ? prof.apellido + ", " : ""}${prof.nombre ?? ""}` : null,
    matricula: prof?.matricula ?? null,
    especialidad,
  });
});

// ── GET /consultorio/certificados/verificar/:codigo/pdf ───────────────────
// Descarga PÚBLICA del PDF original del certificado (solo vigentes). El
// certificado emitido es inmutable, por lo que el PDF regenerado desde sus
// datos es idéntico al original.
router.get("/consultorio/certificados/verificar/:codigo/pdf", async (req: Request, res: Response) => {
  if (!permitirVerificacionPublica(req)) { res.status(429).json({ error: "Demasiadas consultas; esperá un minuto" }); return; }
  const codigo = String(req.params.codigo ?? "").trim();
  if (!codigo || codigo.length > 80) { res.status(404).json({ error: "No encontrado" }); return; }

  // Acepta el token hex del QR/link o el número CT ingresado a mano.
  const { cert: c } = await buscarCertificadoPorCodigo(codigo);
  if (!c) { res.status(404).json({ error: "No encontrado" }); return; }
  if (c.estado !== "valido") { res.status(410).json({ error: "El certificado no está vigente" }); return; }

  registrarVerificacion(req, c.id, c.estado, "descarga_pdf");

  // Sirve SIEMPRE el PDF original guardado al emitir. Fallback (certificados
  // anteriores a este circuito): se regenera una vez y se guarda.
  let base64 = c.pdfOriginal;
  if (!base64) {
    await guardarPdfOriginalCertificado(c.id);
    const [rec] = await db.select().from(certificatesTable).where(eq(certificatesTable.id, c.id)).limit(1);
    base64 = rec?.pdfOriginal ?? null;
  }
  if (!base64) { res.status(404).json({ error: "No encontrado" }); return; }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="certificado_${numeroCertificado(c)}.pdf"`);
  res.send(Buffer.from(base64, "base64"));
});

// ── GET /consultorio/patients/:patientId/certificates ─────────────────────
router.get("/consultorio/patients/:patientId/certificates", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const patientId = parseInt(String(req.params.patientId));
  if (isNaN(patientId)) { res.status(400).json({ error: "patientId inválido" }); return; }
  // Los roles de gestión (mismo criterio que el historial de verificaciones)
  // también pueden listar certificados: los auditan ante disputas.
  const esGestion = ["admin", "gerente", "desarrollador"].includes(user.rol);
  if (!esGestion && !esStaffAdministrativo(user) && !(await puedeLeerPaciente(user, patientId))) { res.status(403).json({ error: "Sin permisos" }); return; }

  const certificados = await db
    .select()
    .from(certificatesTable)
    .where(eq(certificatesTable.patientId, patientId))
    .orderBy(desc(certificatesTable.createdAt));

  // Contador de verificaciones (solo roles de gestión, mismo criterio que el
  // historial): una sola consulta agregada por certificateId, no N requests.
  let resumen = new Map<number, { cantidad: number; ultima: Date | null }>();
  if (esGestion && certificados.length > 0) {
    const ids = certificados.map((c) => c.id);
    const filas = await db
      .select({
        certificateId: certificadoVerificacionesTable.certificateId,
        cantidad: sql<number>`count(*)::int`,
        ultima: sql<Date | null>`max(${certificadoVerificacionesTable.fecha})`,
      })
      .from(certificadoVerificacionesTable)
      .where(inArray(certificadoVerificacionesTable.certificateId, ids))
      .groupBy(certificadoVerificacionesTable.certificateId);
    resumen = new Map(filas.map((f) => [f.certificateId, { cantidad: f.cantidad, ultima: f.ultima }]));
  }

  res.json(certificados.map((c) => ({
    ...c,
    numero: numeroCertificado(c),
    ...(esGestion ? {
      verificacionesCount: resumen.get(c.id)?.cantidad ?? 0,
      ultimaVerificacion: resumen.get(c.id)?.ultima ?? null,
    } : {}),
  })));
});

// ── POST /consultorio/indicaciones ────────────────────────────────────────
// Emite las "Indicaciones para el paciente" (plan de atención): estudios a
// realizar, medicamentos y cómo tomarlos, y otras indicaciones. Se encola el
// push automático a la app del paciente igual que los certificados.
router.post("/consultorio/indicaciones", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos para emitir indicaciones" }); return; }

  const parsed = CreateIndicacionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const tieneContenido = [parsed.data.estudios, parsed.data.medicamentos, parsed.data.otrasIndicaciones]
    .some((s) => s && s.trim().length > 0);
  if (!tieneContenido) {
    res.status(400).json({ error: "Completá al menos una sección de las indicaciones" });
    return;
  }

  const profesionalId = resolverProfesionalEmisor(user, parsed.data.profesionalId);
  if (profesionalId == null) {
    res.status(400).json({ error: user.rol === "admin" ? "Indicá el profesionalId emisor" : "El usuario no tiene un profesional asociado" });
    return;
  }

  const val = await validarPacienteYProfesional(parsed.data.patientId, profesionalId);
  if (!val.ok) { res.status(val.status).json({ error: val.error }); return; }
  // Alcance del rol médico: solo puede emitir para pacientes de sus turneras
  if (!(await puedeLeerPaciente(user, parsed.data.patientId))) {
    res.status(403).json({ error: "Sin permisos sobre este paciente" });
    return;
  }
  if (!(await validarConsulta(parsed.data.consultationId))) {
    res.status(404).json({ error: "Consulta no encontrada" });
    return;
  }

  // Una indicación por paciente+profesional+día: si el médico ya tiene la de
  // hoy (armada sola con recetas/órdenes/interconsultas), esto la actualiza.
  // undefined = conservar lo que había; texto vacío = borrar esa sección
  const { fila: indicacion, creada } = await upsertIndicacionManualDelDia({
    patientId: parsed.data.patientId,
    professionalId: profesionalId,
    consultationId: parsed.data.consultationId ?? null,
    createdBy: user.id,
    estudios: parsed.data.estudios === undefined ? undefined : parsed.data.estudios.trim() || null,
    medicamentos: parsed.data.medicamentos === undefined ? undefined : parsed.data.medicamentos.trim() || null,
    otrasIndicaciones: parsed.data.otrasIndicaciones === undefined ? undefined : parsed.data.otrasIndicaciones.trim() || null,
  });

  await registrarAuditoria(user, creada ? "crear" : "actualizar", "indicacion", indicacion.id, indicacion.patientId, parsed.data);
  // Push automático a la app del paciente (cola con reintentos, nunca bloquea)
  void encolarEnvioIndicacionApp(indicacion.id, { reenviar: true });
  notificarDocumentoEnAppAsync({
    patientId: indicacion.patientId,
    profesionalId,
    documento: "indicaciones",
    usuarioOrigenId: user.id,
    log: req.log,
  });
  res.status(201).json(indicacion);
});

// ── POST /consultorio/indicaciones/preview-pdf ────────────────────────────
// Vista previa del PDF de las indicaciones ANTES de emitirlas: mismo body que
// la creación, genera el documento en memoria y no persiste nada.
router.post("/consultorio/indicaciones/preview-pdf", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos para emitir indicaciones" }); return; }

  const parsed = CreateIndicacionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const profesionalId = resolverProfesionalEmisor(user, parsed.data.profesionalId);
  if (profesionalId == null) {
    res.status(400).json({ error: user.rol === "admin" ? "Indicá el profesionalId emisor" : "El usuario no tiene un profesional asociado" });
    return;
  }

  const val = await validarPacienteYProfesional(parsed.data.patientId, profesionalId);
  if (!val.ok) { res.status(val.status).json({ error: val.error }); return; }
  // Alcance del rol médico: solo puede previsualizar para pacientes de sus turneras
  if (!(await puedeLeerPaciente(user, parsed.data.patientId))) {
    res.status(403).json({ error: "Sin permisos sobre este paciente" });
    return;
  }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, parsed.data.patientId)).limit(1);
  const [profesional] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, profesionalId)).limit(1);
  if (!paciente || !profesional) { res.status(404).json({ error: "Datos del documento incompletos" }); return; }

  let especialidad: string | null = null;
  if (profesional.especialidadId != null) {
    const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, profesional.especialidadId)).limit(1);
    especialidad = esp?.nombre ?? null;
  }

  const datos = armarDatosIndicaciones({
    fechaEmision: new Date(),
    estudios: parsed.data.estudios,
    medicamentos: parsed.data.medicamentos,
    otrasIndicaciones: parsed.data.otrasIndicaciones,
  });
  const doc = generarPdfDocumento({
    ...datos,
    titulo: `${datos.titulo} (VISTA PREVIA)`,
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
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="vista_previa_indicaciones_${paciente.apellido.toLowerCase()}.pdf"`);
  doc.pipe(res);
  doc.end();
});

// ── GET /consultorio/patients/:patientId/indicaciones ─────────────────────
router.get("/consultorio/patients/:patientId/indicaciones", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const patientId = parseInt(String(req.params.patientId));
  if (isNaN(patientId)) { res.status(400).json({ error: "patientId inválido" }); return; }
  if (!(await puedeLeerPaciente(user, patientId))) { res.status(403).json({ error: "Sin permisos" }); return; }

  const indicaciones = await db
    .select()
    .from(indicacionesPacientesTable)
    .where(eq(indicacionesPacientesTable.patientId, patientId))
    .orderBy(desc(indicacionesPacientesTable.createdAt));
  res.json(indicaciones);
});

// ── POST /consultorio/study-orders ────────────────────────────────────────
router.post("/consultorio/study-orders", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos para emitir órdenes" }); return; }

  const parsed = CreateStudyOrderBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const profesionalId = resolverProfesionalEmisor(user, parsed.data.profesionalId);
  if (profesionalId == null) {
    res.status(400).json({ error: user.rol === "admin" ? "Indicá el profesionalId emisor" : "El usuario no tiene un profesional asociado" });
    return;
  }

  const val = await validarPacienteYProfesional(parsed.data.patientId, profesionalId);
  if (!val.ok) { res.status(val.status).json({ error: val.error }); return; }
  if (!(await validarConsulta(parsed.data.consultationId))) {
    res.status(404).json({ error: "Consulta no encontrada" });
    return;
  }

  // Asistente de órdenes: si vino una práctica del catálogo, tomar snapshot de
  // los códigos de facturación (IOMA) para que la orden salga lista para el robot.
  let practica: typeof practicasCatalogoTable.$inferSelect | null = null;
  if (parsed.data.practicaId != null) {
    const [p] = await db
      .select()
      .from(practicasCatalogoTable)
      .where(eq(practicasCatalogoTable.id, parsed.data.practicaId))
      .limit(1);
    if (!p || !p.activo) { res.status(404).json({ error: "Práctica del catálogo no encontrada" }); return; }
    practica = p;
  }
  const contraste = parsed.data.contraste === true && (practica?.permiteContraste ?? true);
  const reglas = (practica?.reglasKlinicos ?? null) as { practiceCode?: string } | null;
  const billingCodes = reglas?.practiceCode?.trim() || null;

  // Firma automática al emitir (decisión del usuario, ago 2026): si el que
  // emite es el propio médico prescriptor AUTENTICADO REAL (getUser resuelve
  // el token real, sin "vista como"), la planilla nace firmada — emitirla ES
  // el acto de firma. Si emite un admin en nombre del médico, queda pendiente
  // y sigue el circuito de "Firmas pendientes" como antes.
  const autoFirma = practica != null && user.rol === "medico" && user.profesionalId === profesionalId;

  const orden = await db.transaction(async (tx) => {
    const [creada] = await tx
      .insert(studyOrdersTable)
      .values({
      patientId: parsed.data.patientId,
      professionalId: profesionalId,
      consultationId: parsed.data.consultationId ?? null,
      studyType: parsed.data.studyType,
      studyName: parsed.data.studyName,
      practicaId: practica?.id ?? null,
      contraste,
      billingCodes,
      clinicalJustification: parsed.data.clinicalJustification ?? null,
      resumenHc: parsed.data.resumenHc?.trim() || null,
      priority: parsed.data.priority ?? "normal",
      preparationRequired: parsed.data.preparationRequired ?? (practica?.preparacion || null),
      observations: parsed.data.observations ?? null,
      status: "solicitado",
      statusUpdatedAt: new Date(),
      createdBy: user.id,
    })
    .returning();
    if (!autoFirma) return creada;
    const hash = hashContenidoOrden(creada);
    const [firmada] = await tx
      .update(studyOrdersTable)
      .set({ firmaEstado: "firmada", firmadoEn: new Date(), firmadoPor: user.id, firmaHash: hash })
      .where(eq(studyOrdersTable.id, creada.id))
      .returning();
    await registrarEventoFirma(tx, { orden: firmada, accion: "firmada", estadoAnterior: "pendiente_firma", estadoNuevo: "firmada", hash, user, detalle: "Firma automática al emitir" });
    return firmada;
  });

  await registrarAuditoria(user, "crear", "orden_estudio", orden.id, orden.patientId, {
    ...parsed.data,
    billingCodes,
    estadoNuevo: "solicitado",
  });

  // Copia de la orden al PACS (solo imágenes; cola con reintentos, nunca bloquea)
  if (orden.studyType === "imagenes") {
    void enviarOrdenEstudioAlPacs(orden.id, req.log);
  }

  // Push al Robot Klinicos: DESACTIVADO por decisión del usuario (jul 2026).
  // La planilla no debe viajar con "PENDIENTE DE FIRMA"; cuando se habilite,
  // el envío se disparará desde el endpoint de firmar (firma_estado='firmada').

  // Las órdenes de estudio suman su línea a las indicaciones del día
  void agregarLineaIndicacionDelDia({
    patientId: orden.patientId,
    professionalId: profesionalId,
    consultationId: orden.consultationId,
    createdBy: user.id,
    seccion: "estudios",
    linea: lineaOrdenEstudio(orden),
  });

  res.status(201).json(orden);
});

// ── POST /consultorio/study-orders/preview-pdf ────────────────────────────
// Vista previa del PDF de una orden ANTES de emitirla: recibe el mismo body
// que la creación, arma el documento en memoria y lo devuelve sin persistir nada.
router.post("/consultorio/study-orders/preview-pdf", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos para emitir órdenes" }); return; }

  const parsed = CreateStudyOrderBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const profesionalId = resolverProfesionalEmisor(user, parsed.data.profesionalId);
  if (profesionalId == null) {
    res.status(400).json({ error: user.rol === "admin" ? "Indicá el profesionalId emisor" : "El usuario no tiene un profesional asociado" });
    return;
  }

  const val = await validarPacienteYProfesional(parsed.data.patientId, profesionalId);
  if (!val.ok) { res.status(val.status).json({ error: val.error }); return; }

  // Mismo snapshot de práctica/códigos que la emisión real
  let practica: typeof practicasCatalogoTable.$inferSelect | null = null;
  if (parsed.data.practicaId != null) {
    const [p] = await db
      .select()
      .from(practicasCatalogoTable)
      .where(eq(practicasCatalogoTable.id, parsed.data.practicaId))
      .limit(1);
    if (!p || !p.activo) { res.status(404).json({ error: "Práctica del catálogo no encontrada" }); return; }
    practica = p;
  }
  const contraste = parsed.data.contraste === true && (practica?.permiteContraste ?? true);
  const reglas = (practica?.reglasKlinicos ?? null) as { practiceCode?: string } | null;
  const billingCodes = reglas?.practiceCode?.trim() || null;

  const fuente = await armarFuenteOrdenEstudio({
    patientId: parsed.data.patientId,
    professionalId: profesionalId,
    consultationId: parsed.data.consultationId ?? null,
    createdAt: new Date(),
    studyType: parsed.data.studyType,
    studyName: parsed.data.studyName,
    practicaId: practica?.id ?? null,
    contraste,
    billingCodes,
    clinicalJustification: parsed.data.clinicalJustification ?? null,
    resumenHc: parsed.data.resumenHc?.trim() || null,
    priority: parsed.data.priority ?? "normal",
    preparationRequired: parsed.data.preparationRequired ?? (practica?.preparacion || null),
    observations: parsed.data.observations ?? null,
  });

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, fuente.patientId)).limit(1);
  const [profesional] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, fuente.professionalId)).limit(1);
  if (!paciente || !profesional) { res.status(404).json({ error: "Datos del documento incompletos" }); return; }

  let especialidad: string | null = null;
  if (profesional.especialidadId != null) {
    const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, profesional.especialidadId)).limit(1);
    especialidad = esp?.nombre ?? null;
  }

  const doc = generarPdfDocumento(await prepararDatosPdf({
    ...fuente.datos,
    titulo: `${fuente.datos.titulo} (VISTA PREVIA)`,
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
  res.setHeader("Content-Disposition", `inline; filename="vista_previa_orden_${paciente.apellido.toLowerCase()}.pdf"`);
  doc.pipe(res);
  doc.end();
});

// ── POST /consultorio/consultas/finalizar ─────────────────────────────────
// Crea evolución + signos vitales + recetas y cierra el turno en UNA transacción:
// o se registra todo o no se registra nada (sin escrituras parciales).
router.post("/consultorio/consultas/finalizar", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos para registrar consultas" }); return; }

  const parsed = FinalizarConsultaBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const data = parsed.data;

  const profesionalId = resolverProfesionalEmisor(user, data.professionalId);
  if (profesionalId == null) {
    res.status(400).json({ error: user.rol === "admin" ? "Indicá el profesionalId emisor" : "El usuario no tiene un profesional asociado" });
    return;
  }

  const val = await validarPacienteYProfesional(data.patientId, profesionalId);
  if (!val.ok) { res.status(val.status).json({ error: val.error }); return; }

  // Bloqueo EN CONSULTA: si otro médico llamó al paciente, avisar ANTES de
  // registrar nada (si no, cada intento crearía una evolución duplicada sin
  // cerrar el turno).
  if (data.turnoId != null && user.rol !== "admin") {
    const [turnoActual] = await db
      .select({
        estado: turnosTable.estado,
        llamadoPor: turnosTable.llamadoPorProfesionalId,
      })
      .from(turnosTable)
      .where(eq(turnosTable.id, data.turnoId))
      .limit(1);
    if (
      turnoActual &&
      turnoActual.estado === "llamado" &&
      turnoActual.llamadoPor != null &&
      turnoActual.llamadoPor !== profesionalId
    ) {
      const [otro] = await db
        .select({ apellido: profesionalesTable.apellido, nombre: profesionalesTable.nombre })
        .from(profesionalesTable)
        .where(eq(profesionalesTable.id, turnoActual.llamadoPor))
        .limit(1);
      const quien = otro ? `${otro.apellido}, ${otro.nombre}` : "otro médico";
      res.status(409).json({
        codigo: "paciente_en_consulta",
        error: `El paciente está en consulta con ${quien}. Solo ese médico puede finalizar la consulta (o recepción puede destrabarlo desde la sala de espera).`,
      });
      return;
    }
  }

  try {
    const resultado = await db.transaction(async (tx) => {
      // Legajo clínico (crear si no existe)
      let [record] = await tx
        .select()
        .from(clinicalRecordsTable)
        .where(eq(clinicalRecordsTable.patientId, data.patientId))
        .limit(1);
      if (!record) {
        [record] = await tx.insert(clinicalRecordsTable).values({ patientId: data.patientId }).returning();
      }

      const [encounter] = await tx
        .insert(encountersTable)
        .values({
          clinicalRecordId: record.id,
          professionalId: profesionalId,
          specialty: data.specialty ?? null,
          encounterType: data.encounterType ?? "presencial",
          chiefComplaint: data.chiefComplaint ?? null,
          anamnesis: data.anamnesis ?? null,
          physicalExam: data.physicalExam ?? null,
          assessment: data.assessment ?? null,
          plan: data.plan ?? null,
          diagnosis: data.diagnosis ?? null,
          cie10: data.cie10 ?? null,
          status: "cerrada",
        })
        .returning();

      // Signos vitales (si vino al menos un dato)
      let vitals: typeof vitalSignsTable.$inferSelect | null = null;
      const v = data.vitales;
      if (v && Object.values(v).some((x) => x != null)) {
        let bmi: number | null = null;
        if (v.weight != null && v.height != null && v.height > 0) {
          const alturaMetros = v.height > 3 ? v.height / 100 : v.height;
          bmi = Math.round((v.weight / (alturaMetros * alturaMetros)) * 10) / 10;
        }
        [vitals] = await tx
          .insert(vitalSignsTable)
          .values({ encounterId: encounter.id, ...v, bmi })
          .returning();
      }

      // Recetas de la consulta
      const prescriptions: (typeof prescriptionsTable.$inferSelect)[] = [];
      for (const r of data.recetas ?? []) {
        const [rx] = await tx
          .insert(prescriptionsTable)
          .values({
            encounterId: encounter.id,
            patientId: data.patientId,
            professionalId: profesionalId,
            medication: r.medication,
            dosage: r.dosage ?? null,
            frequency: r.frequency ?? null,
            duration: r.duration ?? null,
            instructions: r.instructions ?? null,
            createdBy: user.id,
          })
          .returning();
        prescriptions.push(rx);
      }

      // Cierre del turno, atómico dentro de la transacción. Si la turnera
      // lleva informe (circuito DiagnostiPACS) el turno queda esperando
      // informe (en_atencion → pendiente_informe); si no, se cierra (visto).
      let turnoActualizado = false;
      let turnoEsperaInforme = false;
      if (data.turnoId != null) {
        const [conTurnera] = await tx
          .select({ llevaInforme: turnerasTable.llevaInforme })
          .from(turnosTable)
          .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
          .where(eq(turnosTable.id, data.turnoId))
          .limit(1);
        turnoEsperaInforme = Boolean(conTurnera?.llevaInforme);
        const [turno] = await tx
          .update(turnosTable)
          .set({ estado: turnoEsperaInforme ? "pendiente_informe" : "visto", finalizadoEn: new Date() })
          .where(and(
            eq(turnosTable.id, data.turnoId),
            eq(turnosTable.pacienteId, data.patientId),
            // El médico puede finalizar la consulta aunque el turno no haya
            // pasado formalmente por "en_atencion": cualquier estado de
            // espera también se cierra.
            inArray(turnosTable.estado, ["en_atencion", "llamado", "arribo", "en_sala"]),
            // Bloqueo EN CONSULTA: si otro médico lo llamó, solo ese médico
            // (o un admin) puede finalizar y liberar al paciente.
            ...(user.rol === "admin"
              ? []
              : [
                  sql`(${turnosTable.estado} <> 'llamado' OR ${turnosTable.llamadoPorProfesionalId} IS NULL OR ${turnosTable.llamadoPorProfesionalId} = ${profesionalId})`,
                ]),
          ))
          .returning();
        turnoActualizado = Boolean(turno);
      }

      // Auditoría dentro de la misma transacción
      await tx.insert(auditLogTable).values({
        usuarioId: user.id,
        usuarioEmail: user.email,
        rol: user.rol,
        accion: "crear",
        entidad: "encounter",
        entidadId: encounter.id,
        pacienteId: data.patientId,
        detalle: {
          origen: "consultorio_unificado",
          turnoId: data.turnoId ?? null,
          turnoActualizado,
          recetas: prescriptions.length,
          conVitales: Boolean(vitals),
        },
      });

      return { encounter, vitals, prescriptions, turnoActualizado, turnoEsperaInforme };
    });

    // Circuito DiagnostiPACS: si el turno quedó esperando informe, se envía
    // al PACS fuera de la transacción (fire-and-forget con log de errores).
    if (resultado.turnoActualizado && resultado.turnoEsperaInforme && data.turnoId != null) {
      void enviarTurnoAlPacs(data.turnoId, req.log);
    }

    // Guardia virtual: si el turno cerrado era una videollamada, avisar al
    // portal que la consulta terminó (fire-and-forget).
    if (resultado.turnoActualizado && data.turnoId != null) {
      void notificarEventoVideollamadaPorTurno(data.turnoId, "finalizada");
      // Guardia: la fila avanzó, avisar posiciones nuevas a los que esperan.
      void avanzarFilaGuardia(data.turnoId);
    }

    // Las recetas cargadas al finalizar la consulta también suman sus líneas
    // a las indicaciones del día (fuera de la transacción; nunca bloquea).
    // Secuencial para no crear dos indicaciones del día por carrera.
    void (async () => {
      for (const rx of resultado.prescriptions) {
        await agregarLineaIndicacionDelDia({
          patientId: data.patientId,
          professionalId: profesionalId,
          consultationId: data.turnoId ?? null,
          createdBy: user.id,
          seccion: "medicamentos",
          linea: lineaReceta(rx),
        });
      }
    })();

    req.log.info(
      { encounterId: resultado.encounter.id, pacienteId: data.patientId, turnoActualizado: resultado.turnoActualizado },
      "consulta finalizada desde consultorio unificado",
    );
    res.status(201).json({
      encounter: resultado.encounter,
      vitals: resultado.vitals ?? undefined,
      prescriptions: resultado.prescriptions,
      turnoActualizado: resultado.turnoActualizado,
    });
  } catch (err) {
    req.log.error({ err }, "error al finalizar consulta (transacción revertida)");
    res.status(500).json({ error: "No se pudo registrar la consulta. No se guardó ningún dato." });
  }
});

// ── PATCH /consultorio/consultas/:encounterId ─────────────────────────────
// El médico que atendió puede corregir la evolución aunque la consulta ya
// esté finalizada. Solo el autor (o admin) edita; queda updated_at y
// auditoría con los campos cambiados.
router.patch("/consultorio/consultas/:encounterId", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos para editar consultas" }); return; }

  const encounterId = Number(req.params["encounterId"]);
  if (!Number.isInteger(encounterId) || encounterId <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const parsed = EditarConsultaBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const data = parsed.data;

  const [encounter] = await db.select().from(encountersTable).where(eq(encountersTable.id, encounterId)).limit(1);
  if (!encounter) { res.status(404).json({ error: "Evolución no encontrada" }); return; }

  // Solo el médico autor de la evolución puede corregirla (admin también).
  // Un médico sin profesional vinculado no es autor de nada.
  if (user.rol !== "admin" && (user.profesionalId == null || encounter.professionalId !== user.profesionalId)) {
    res.status(403).json({ error: "Solo el médico que registró la evolución puede corregirla" });
    return;
  }

  // Campos omitidos no cambian; string vacío borra el campo.
  const CAMPOS = ["specialty", "chiefComplaint", "anamnesis", "physicalExam", "assessment", "plan", "diagnosis", "cie10"] as const;
  const cambios: Partial<Record<(typeof CAMPOS)[number], string | null>> = {};
  for (const k of CAMPOS) {
    const v = data[k];
    if (v === undefined) continue;
    const limpio = v.trim();
    if (limpio !== ((encounter[k] ?? "") as string).trim()) cambios[k] = limpio === "" ? null : limpio;
  }
  if (Object.keys(cambios).length === 0) {
    res.json(encounter);
    return;
  }

  const [actualizado] = await db
    .update(encountersTable)
    .set({ ...cambios, updatedAt: new Date() })
    .where(eq(encountersTable.id, encounterId))
    .returning();

  const [record] = await db.select().from(clinicalRecordsTable).where(eq(clinicalRecordsTable.id, encounter.clinicalRecordId)).limit(1);
  await registrarAuditoria(user, "editar", "evolucion", encounterId, record?.patientId ?? null, {
    camposCambiados: Object.keys(cambios),
  });
  req.log.info({ encounterId, campos: Object.keys(cambios) }, "evolución corregida por su autor");
  res.json(actualizado);
});

// ── Circuito de gestión de estudios ───────────────────────────────────────
// solicitado → pendiente_programacion → programado → en_realizacion →
// realizado → informado → entregado. Anulable hasta que entra en realización.
const TRANSICIONES_ORDEN: Record<string, string[]> = {
  solicitado: ["pendiente_programacion", "programado", "anulada"],
  pendiente_programacion: ["programado", "anulada"],
  programado: ["en_realizacion", "pendiente_programacion", "anulada"],
  en_realizacion: ["realizado"],
  realizado: ["informado"],
  informado: ["entregado"],
  entregado: [],
  anulada: [],
};

// Estados que puede setear recepción (logística de turnos y entrega)
const ESTADOS_LOGISTICOS_ORDEN = ["pendiente_programacion", "programado", "entregado", "anulada"];

// ── PATCH /consultorio/study-orders/:id/estado ────────────────────────────
router.patch("/consultorio/study-orders/:id/estado", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!["admin", "recepcionista", "medico"].includes(user.rol)) {
    res.status(403).json({ error: "Sin permisos para gestionar órdenes de estudio" });
    return;
  }

  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const parsed = UpdateStudyOrderStatusBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const nuevoEstado = parsed.data.estado;

  const [orden] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, id)).limit(1);
  if (!orden) { res.status(404).json({ error: "Orden no encontrada" }); return; }

  // El médico solo gestiona órdenes emitidas por él mismo
  if (user.rol === "medico" && orden.professionalId !== user.profesionalId) {
    res.status(403).json({ error: "Solo puede gestionar sus propias órdenes" });
    return;
  }

  // Recepción solo opera estados logísticos (programación, entrega, anulación);
  // los estados clínicos (en_realizacion/realizado/informado) quedan para admin/medico
  if (user.rol === "recepcionista" && !ESTADOS_LOGISTICOS_ORDEN.includes(nuevoEstado)) {
    res.status(403).json({ error: "Recepción solo puede programar, entregar o anular órdenes" });
    return;
  }

  const estadoActual = orden.status;
  const permitidas = TRANSICIONES_ORDEN[estadoActual] ?? [];
  if (!permitidas.includes(nuevoEstado)) {
    res.status(422).json({
      error: `Transición no permitida: ${estadoActual} → ${nuevoEstado}`,
      transicionesValidas: permitidas,
    });
    return;
  }

  // Transición atómica: condición de estado dentro del UPDATE
  const [updated] = await db
    .update(studyOrdersTable)
    .set({ status: nuevoEstado, statusUpdatedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(studyOrdersTable.id, id), eq(studyOrdersTable.status, estadoActual)))
    .returning();

  if (!updated) {
    res.status(422).json({ error: "La orden cambió de estado mientras se procesaba la solicitud" });
    return;
  }

  await registrarAuditoria(user, "cambiar_estado", "orden_estudio", id, orden.patientId, {
    estadoAnterior: estadoActual,
    estadoNuevo: nuevoEstado,
    observaciones: parsed.data.observaciones ?? null,
  });

  req.log.info({ ordenId: id, estadoAnterior: estadoActual, estadoNuevo: nuevoEstado }, "orden de estudio: cambio de estado");
  res.json(updated);
});

// ── Aprobación y firma de planillas IOMA (alta complejidad) ───────────────
// Regla de oro: SOLO el médico prescriptor AUTENTICADO REAL puede firmar.
// getUser() resuelve el usuario a partir del token real (sin "vista como"),
// así que ni un admin impersonando a un médico ni otro médico pueden aprobar.

// Hash del contenido clínico de la orden al momento de firmar: cualquier
// alteración posterior queda en evidencia comparando contra este valor.
function hashContenidoOrden(o: typeof studyOrdersTable.$inferSelect): string {
  const contenido = JSON.stringify({
    id: o.id,
    version: o.firmaVersion,
    patientId: o.patientId,
    professionalId: o.professionalId,
    studyType: o.studyType,
    studyName: o.studyName,
    practicaId: o.practicaId,
    contraste: o.contraste,
    billingCodes: o.billingCodes,
    clinicalJustification: o.clinicalJustification,
    resumenHc: o.resumenHc,
    priority: o.priority,
    preparationRequired: o.preparationRequired,
    observations: o.observations,
  });
  return createHash("sha256").update(contenido).digest("hex");
}

// Validaciones comunes de firmar/rechazar: existe, es planilla, es SU orden.
async function ordenParaFirma(user: DocsUser, id: number): Promise<
  { ok: true; orden: typeof studyOrdersTable.$inferSelect } | { ok: false; status: number; error: string }
> {
  if (user.rol !== "medico" || user.profesionalId == null) {
    return { ok: false, status: 403, error: "Solo el médico prescriptor puede firmar o devolver la planilla" };
  }
  const [orden] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, id)).limit(1);
  if (!orden) return { ok: false, status: 404, error: "Orden no encontrada" };
  if (orden.practicaId == null) {
    return { ok: false, status: 422, error: "La orden no tiene planilla IOMA: no requiere circuito de firma" };
  }
  if (orden.professionalId !== user.profesionalId) {
    return { ok: false, status: 403, error: "Solo el profesional solicitante de la orden puede firmarla" };
  }
  return { ok: true, orden };
}

// El evento se inserta dentro de la MISMA transacción que el cambio de estado:
// si el log falla, el cambio se revierte (nunca hay firma sin evento).
type DbOTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
async function registrarEventoFirma(tx: DbOTx, params: {
  orden: typeof studyOrdersTable.$inferSelect;
  accion: string;
  estadoAnterior: string;
  estadoNuevo: string;
  hash: string | null;
  user: DocsUser;
  detalle?: string | null;
}): Promise<void> {
  await tx.insert(studyOrdersFirmaLogTable).values({
    orderId: params.orden.id,
    version: params.orden.firmaVersion,
    accion: params.accion,
    estadoAnterior: params.estadoAnterior,
    estadoNuevo: params.estadoNuevo,
    hash: params.hash,
    usuarioId: params.user.id,
    profesionalId: params.orden.professionalId,
    detalle: params.detalle ?? null,
  });
}

// ── GET /consultorio/study-orders/pendientes-firma ────────────────────────
router.get("/consultorio/study-orders/pendientes-firma", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (user.rol !== "medico" || user.profesionalId == null) {
    res.status(403).json({ error: "Solo médicos con profesional asociado" });
    return;
  }
  const filas = await db
    .select({ orden: studyOrdersTable, paciente: pacientesTable })
    .from(studyOrdersTable)
    .innerJoin(pacientesTable, eq(pacientesTable.id, studyOrdersTable.patientId))
    .where(and(
      eq(studyOrdersTable.professionalId, user.profesionalId),
      eq(studyOrdersTable.firmaEstado, "pendiente_firma"),
      isNotNull(studyOrdersTable.practicaId),
    ))
    .orderBy(desc(studyOrdersTable.createdAt));
  res.json(filas.map((f) => ({
    orden: f.orden,
    pacienteNombre: `${f.paciente.apellido}, ${f.paciente.nombre}`,
    pacienteDni: f.paciente.dni,
  })));
});

// ── POST /consultorio/study-orders/:id/firmar ─────────────────────────────
router.post("/consultorio/study-orders/:id/firmar", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const val = await ordenParaFirma(user, id);
  if (!val.ok) { res.status(val.status).json({ error: val.error }); return; }
  const { orden } = val;
  if (orden.firmaEstado !== "pendiente_firma") {
    res.status(409).json({ error: `La planilla no está pendiente de firma (estado actual: ${orden.firmaEstado})` });
    return;
  }
  if (orden.status === "anulada") {
    res.status(409).json({ error: "No se puede firmar una orden anulada" });
    return;
  }

  const hash = hashContenidoOrden(orden);
  // Transacción: el UPDATE condicionado y el evento inmutable van juntos.
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(studyOrdersTable)
      .set({ firmaEstado: "firmada", firmadoEn: new Date(), firmadoPor: user.id, firmaHash: hash, updatedAt: new Date() })
      .where(and(eq(studyOrdersTable.id, id), eq(studyOrdersTable.firmaEstado, "pendiente_firma")))
      .returning();
    if (!u) return null;
    await registrarEventoFirma(tx, { orden: u, accion: "firmada", estadoAnterior: "pendiente_firma", estadoNuevo: "firmada", hash, user });
    return u;
  });
  if (!updated) {
    res.status(409).json({ error: "La planilla cambió de estado mientras se procesaba la firma" });
    return;
  }

  await registrarAuditoria(user, "firmar", "orden_estudio", id, orden.patientId, { hash, version: updated.firmaVersion });
  req.log.info({ ordenId: id, usuarioId: user.id }, "planilla IOMA firmada por el prescriptor");
  res.json(updated);
});

// ── POST /consultorio/study-orders/:id/rechazar-firma ─────────────────────
router.post("/consultorio/study-orders/:id/rechazar-firma", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const parsed = RechazarFirmaStudyOrderBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const val = await ordenParaFirma(user, id);
  if (!val.ok) { res.status(val.status).json({ error: val.error }); return; }
  const { orden } = val;
  if (orden.firmaEstado !== "pendiente_firma") {
    res.status(409).json({ error: `La planilla no está pendiente de firma (estado actual: ${orden.firmaEstado})` });
    return;
  }

  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(studyOrdersTable)
      .set({ firmaEstado: "rechazada", firmaMotivoRechazo: parsed.data.motivo.trim(), updatedAt: new Date() })
      .where(and(eq(studyOrdersTable.id, id), eq(studyOrdersTable.firmaEstado, "pendiente_firma")))
      .returning();
    if (!u) return null;
    await registrarEventoFirma(tx, { orden: u, accion: "rechazada", estadoAnterior: "pendiente_firma", estadoNuevo: "rechazada", hash: null, user, detalle: parsed.data.motivo.trim() });
    return u;
  });
  if (!updated) {
    res.status(409).json({ error: "La planilla cambió de estado mientras se procesaba la devolución" });
    return;
  }

  await registrarAuditoria(user, "rechazar_firma", "orden_estudio", id, orden.patientId, { motivo: parsed.data.motivo.trim() });
  res.json(updated);
});

// ── POST /consultorio/study-orders/:id/nueva-version ──────────────────────
// Una planilla firmada es INMUTABLE: cualquier corrección genera una orden
// nueva (versión + 1) que arranca pendiente de firma; la anterior queda
// marcada como "reemplazada" y su PDF firmado deja de ser el vigente.
router.post("/consultorio/study-orders/:id/nueva-version", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos para corregir órdenes" }); return; }
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const parsed = CrearNuevaVersionStudyOrderBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [orden] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, id)).limit(1);
  if (!orden) { res.status(404).json({ error: "Orden no encontrada" }); return; }
  if (orden.practicaId == null) {
    res.status(422).json({ error: "La orden no tiene planilla IOMA: no usa versionado de firma" });
    return;
  }
  // El médico solo corrige sus propias órdenes; admin puede corregir cualquiera
  // (pero la NUEVA versión igual la firma únicamente el prescriptor).
  if (user.rol === "medico" && orden.professionalId !== user.profesionalId) {
    res.status(403).json({ error: "Solo puede corregir sus propias órdenes" });
    return;
  }
  if (orden.firmaEstado === "reemplazada") {
    res.status(409).json({ error: "Esta orden ya fue reemplazada por una versión más nueva" });
    return;
  }

  const estadoAnterior = orden.firmaEstado;
  // Transacción con concurrencia optimista: primero se "consume" la versión
  // anterior (UPDATE condicionado a su estado actual); si otra request llegó
  // antes, no afecta filas y se aborta sin crear una versión duplicada.
  const nueva = await db.transaction(async (tx) => {
    const [reemplazada] = await tx
      .update(studyOrdersTable)
      .set({ firmaEstado: "reemplazada", updatedAt: new Date() })
      .where(and(eq(studyOrdersTable.id, orden.id), eq(studyOrdersTable.firmaEstado, estadoAnterior)))
      .returning();
    if (!reemplazada) return null;
    const [n] = await tx.insert(studyOrdersTable).values({
    patientId: orden.patientId,
    professionalId: orden.professionalId,
    consultationId: orden.consultationId,
    studyType: orden.studyType,
    studyName: parsed.data.studyName ?? orden.studyName,
    practicaId: orden.practicaId,
    contraste: orden.contraste,
    billingCodes: orden.billingCodes,
    clinicalJustification: parsed.data.clinicalJustification ?? orden.clinicalJustification,
    resumenHc: parsed.data.resumenHc ?? orden.resumenHc,
    priority: parsed.data.priority ?? orden.priority,
    preparationRequired: parsed.data.preparationRequired ?? orden.preparationRequired,
    observations: parsed.data.observations ?? orden.observations,
    status: "solicitado",
    firmaEstado: "pendiente_firma",
    firmaVersion: orden.firmaVersion + 1,
    reemplazaOrdenId: orden.id,
    createdBy: user.id,
    }).returning();
    if (!n) return null;
    await registrarEventoFirma(tx, { orden: n, accion: "nueva_version", estadoAnterior, estadoNuevo: "pendiente_firma", hash: null, user, detalle: `Reemplaza a la orden #${orden.id}` });
    // Firma automática (ago 2026): si quien corrige es el propio prescriptor
    // real, la nueva versión también nace firmada. Un admin corrigiendo la
    // deja pendiente para que el médico la apruebe.
    if (user.rol === "medico" && user.profesionalId === orden.professionalId) {
      const hash = hashContenidoOrden(n);
      const [firmada] = await tx
        .update(studyOrdersTable)
        .set({ firmaEstado: "firmada", firmadoEn: new Date(), firmadoPor: user.id, firmaHash: hash })
        .where(eq(studyOrdersTable.id, n.id))
        .returning();
      await registrarEventoFirma(tx, { orden: firmada, accion: "firmada", estadoAnterior: "pendiente_firma", estadoNuevo: "firmada", hash, user, detalle: "Firma automática al emitir" });
      return firmada;
    }
    return n;
  });
  if (!nueva) {
    res.status(409).json({ error: "La orden cambió de estado mientras se creaba la nueva versión" });
    return;
  }

  await registrarAuditoria(user, "nueva_version", "orden_estudio", nueva.id, orden.patientId, { reemplazaOrdenId: orden.id, version: nueva.firmaVersion });
  res.status(201).json(nueva);
});

// ── GET /consultorio/study-orders/:id/historial ───────────────────────────
router.get("/consultorio/study-orders/:id/historial", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }

  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [orden] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, id)).limit(1);
  if (!orden) { res.status(404).json({ error: "Orden no encontrada" }); return; }
  if (!(await puedeLeerPaciente(user, orden.patientId))) { res.status(403).json({ error: "Sin permisos" }); return; }

  const eventos = await db
    .select()
    .from(auditLogTable)
    .where(and(eq(auditLogTable.entidad, "orden_estudio"), eq(auditLogTable.entidadId, id)))
    .orderBy(desc(auditLogTable.createdAt));

  res.json(
    eventos.map((e) => {
      const detalle = (e.detalle ?? {}) as Record<string, unknown>;
      return {
        fecha: e.createdAt.toISOString(),
        accion: e.accion,
        usuarioEmail: e.usuarioEmail ?? null,
        rol: e.rol ?? null,
        estadoAnterior: (detalle.estadoAnterior as string | undefined) ?? null,
        estadoNuevo: (detalle.estadoNuevo as string | undefined) ?? null,
        observaciones: (detalle.observaciones as string | undefined) ?? null,
      };
    }),
  );
});

// ── GET /consultorio/patients/:patientId/workspace ────────────────────────
// Vista unificada del consultorio: todo lo que el médico necesita en una pantalla.
router.get("/consultorio/patients/:patientId/workspace", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!esProfesional(user)) { res.status(403).json({ error: "Solo para profesionales" }); return; }

  const patientId = parseInt(String(req.params.patientId));
  if (isNaN(patientId)) { res.status(400).json({ error: "patientId inválido" }); return; }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, patientId)).limit(1);
  if (!paciente) { res.status(404).json({ error: "Paciente no encontrado" }); return; }

  const [record] = await db
    .select()
    .from(clinicalRecordsTable)
    .where(eq(clinicalRecordsTable.patientId, patientId))
    .limit(1);

  const hoy = new Date().toISOString().split("T")[0];

  const [encuentros, recetas, ordenes, derivaciones, certificados, turnosHoy] = await Promise.all([
    record
      ? db
          .select()
          .from(encountersTable)
          .where(eq(encountersTable.clinicalRecordId, record.id))
          .orderBy(desc(encountersTable.encounterDate))
          .limit(20)
      : Promise.resolve([]),
    db.select().from(prescriptionsTable).where(eq(prescriptionsTable.patientId, patientId)).orderBy(desc(prescriptionsTable.createdAt)).limit(30),
    db.select().from(studyOrdersTable).where(eq(studyOrdersTable.patientId, patientId)).orderBy(desc(studyOrdersTable.createdAt)).limit(30),
    db.select().from(referralsTable).where(eq(referralsTable.patientId, patientId)).orderBy(desc(referralsTable.createdAt)).limit(20),
    db.select().from(certificatesTable).where(eq(certificatesTable.patientId, patientId)).orderBy(desc(certificatesTable.createdAt)).limit(20),
    db
      .select({
        id: turnosTable.id,
        hora: turnosTable.horaInicio,
        estado: turnosTable.estado,
        turneraNombre: turnerasTable.nombre,
        profesionalId: turnosTable.profesionalId,
      })
      .from(turnosTable)
      .leftJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
      .where(and(eq(turnosTable.pacienteId, patientId), eq(turnosTable.fecha, hoy)))
      .orderBy(turnosTable.horaInicio),
  ]);

  const encIds = encuentros.map((e) => e.id);
  const [vitals, encPrescriptions, adjuntos, profesionales] = await Promise.all([
    encIds.length
      ? db.select().from(vitalSignsTable).where(inArray(vitalSignsTable.encounterId, encIds))
      : Promise.resolve([] as (typeof vitalSignsTable.$inferSelect)[]),
    encIds.length
      ? db.select().from(prescriptionsTable).where(inArray(prescriptionsTable.encounterId, encIds))
      : Promise.resolve([] as (typeof prescriptionsTable.$inferSelect)[]),
    encIds.length
      ? db.select().from(encounterAttachmentsTable).where(inArray(encounterAttachmentsTable.encounterId, encIds)).orderBy(desc(encounterAttachmentsTable.createdAt))
      : Promise.resolve([] as (typeof encounterAttachmentsTable.$inferSelect)[]),
    db.select().from(profesionalesTable),
  ]);

  const profMap = new Map(profesionales.map((p) => [p.id, p]));
  const encountersFull = encuentros.map((e) => ({
    ...e,
    professional: e.professionalId != null ? (profMap.get(e.professionalId) ?? undefined) : undefined,
    vitals: vitals.filter((v) => v.encounterId === e.id),
    prescriptions: encPrescriptions.filter((p) => p.encounterId === e.id),
    attachments: adjuntos.filter((a) => a.encounterId === e.id),
  }));

  res.json({
    paciente,
    record: record ?? undefined,
    encounters: encountersFull,
    recetas,
    ordenes,
    derivaciones,
    certificados,
    adjuntos,
    turnosHoy,
  });
});

// ── GET /consultorio/patients/:patientId/study-orders ─────────────────────
router.get("/consultorio/patients/:patientId/study-orders", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const patientId = parseInt(String(req.params.patientId));
  if (isNaN(patientId)) { res.status(400).json({ error: "patientId inválido" }); return; }
  if (!(await puedeLeerPaciente(user, patientId))) { res.status(403).json({ error: "Sin permisos" }); return; }

  const ordenes = await db
    .select()
    .from(studyOrdersTable)
    .where(eq(studyOrdersTable.patientId, patientId))
    .orderBy(desc(studyOrdersTable.createdAt));
  res.json(ordenes);
});

// ── GET /consultorio/patients/:patientId/timeline ─────────────────────────
router.get("/consultorio/patients/:patientId/timeline", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const patientId = parseInt(String(req.params.patientId));
  if (isNaN(patientId)) { res.status(400).json({ error: "patientId inválido" }); return; }
  if (!(await puedeLeerPaciente(user, patientId))) { res.status(403).json({ error: "Sin permisos" }); return; }

  const [record] = await db
    .select()
    .from(clinicalRecordsTable)
    .where(eq(clinicalRecordsTable.patientId, patientId))
    .limit(1);

  const encuentros = record
    ? await db.select().from(encountersTable).where(eq(encountersTable.clinicalRecordId, record.id))
    : [];
  const [practicas, recetas, derivaciones, certificados, ordenes, estudiosExternos] = await Promise.all([
    db.select().from(practicasTable).where(eq(practicasTable.pacienteId, patientId)),
    db.select().from(prescriptionsTable).where(eq(prescriptionsTable.patientId, patientId)),
    db.select().from(referralsTable).where(eq(referralsTable.patientId, patientId)),
    db.select().from(certificatesTable).where(eq(certificatesTable.patientId, patientId)),
    db.select().from(studyOrdersTable).where(eq(studyOrdersTable.patientId, patientId)),
    db.select().from(estudiosExternosTable).where(eq(estudiosExternosTable.patientId, patientId)),
  ]);

  const profIds = [
    ...new Set(
      [
        ...encuentros.map((e) => e.professionalId),
        ...practicas.map((p) => p.profesionalId),
        ...recetas.map((r) => r.professionalId),
        ...derivaciones.map((d) => d.professionalId),
        ...certificados.map((c) => c.professionalId),
        ...ordenes.map((o) => o.professionalId),
      ].filter((id): id is number => id != null),
    ),
  ];
  const profesionales = profIds.length
    ? await db.select().from(profesionalesTable).where(inArray(profesionalesTable.id, profIds))
    : [];
  const profMap = new Map(profesionales.map((p) => [p.id, `${p.apellido ? p.apellido + ", " : ""}${p.nombre}`]));
  const nombreProf = (id: number | null) => (id != null ? (profMap.get(id) ?? null) : null);

  const items = [
    ...encuentros.map((e) => ({
      tipo: "consulta" as const,
      fecha: e.encounterDate.toISOString(),
      titulo: e.chiefComplaint || e.encounterType || "Consulta",
      detalle: e.diagnosis ?? e.assessment ?? null,
      estado: null,
      refId: e.id,
      profesionalNombre: nombreProf(e.professionalId),
    })),
    ...practicas.map((p) => ({
      tipo: "practica" as const,
      fecha: new Date(`${p.fecha}T12:00:00`).toISOString(),
      titulo: p.nombre,
      detalle: p.notas ?? null,
      estado: p.estado,
      refId: p.id,
      profesionalNombre: nombreProf(p.profesionalId),
    })),
    ...recetas.map((r) => ({
      tipo: "receta" as const,
      fecha: r.createdAt.toISOString(),
      titulo: r.medication,
      detalle: [r.dosage, r.frequency, r.duration].filter(Boolean).join(" · ") || null,
      estado: r.status ?? null,
      refId: r.id,
      profesionalNombre: nombreProf(r.professionalId),
    })),
    ...derivaciones.map((d) => ({
      tipo: "derivacion" as const,
      fecha: d.createdAt.toISOString(),
      titulo: `Derivación a ${d.targetSpecialty}`,
      detalle: d.reason,
      estado: d.status,
      refId: d.id,
      profesionalNombre: nombreProf(d.professionalId),
    })),
    ...certificados.map((c) => ({
      tipo: "certificado" as const,
      fecha: c.createdAt.toISOString(),
      titulo: `Certificado (${c.certificateType})`,
      detalle: c.diagnosis ?? c.content.slice(0, 120),
      estado: null,
      refId: c.id,
      profesionalNombre: nombreProf(c.professionalId),
    })),
    ...ordenes.map((o) => ({
      tipo: "orden_estudio" as const,
      fecha: o.createdAt.toISOString(),
      titulo: o.studyName,
      detalle: o.clinicalJustification ?? null,
      estado: o.status,
      refId: o.id,
      profesionalNombre: nombreProf(o.professionalId),
    })),
    ...estudiosExternos.map((ee) => ({
      tipo: "estudio_externo" as const,
      fecha: (ee.informadoEn ?? ee.estadoCambiadoEn ?? ee.createdAt).toISOString(),
      titulo: ee.descripcion || `Estudio ${ee.origen} #${ee.externalId}`,
      detalle: ee.estado === "informado" ? "Informe disponible (fuente: Phir-it)" : `Estudio externo (fuente: ${ee.origen})`,
      estado: ee.estado,
      refId: ee.id,
      profesionalNombre: null,
    })),
  ].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

  res.json(items);
});

// ── GET /consultorio/doctor/dashboard ─────────────────────────────────────
router.get("/consultorio/doctor/dashboard", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!esProfesional(user)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const parsed = GetDoctorDashboardQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const profesionalId =
    user.rol === "admin" ? (parsed.data.profesionalId ?? user.profesionalId) : user.profesionalId;
  if (profesionalId == null) {
    res.status(user.rol === "admin" ? 400 : 403).json({
      error: user.rol === "admin" ? "Indicá el profesionalId" : "El usuario no tiene un profesional asociado",
    });
    return;
  }

  // "Hoy" en hora argentina: el servidor corre en UTC y de noche ya sería
  // mañana (los turnos del día desaparecerían del escritorio del médico).
  const fecha = hoyArgentina();
  const inicioHoy = new Date(`${fecha}T00:00:00-03:00`);

  const turnos = await db
    .select()
    .from(turnosTable)
    .where(and(eq(turnosTable.profesionalId, profesionalId), eq(turnosTable.fecha, fecha)))
    .orderBy(turnosTable.horaInicio);

  const encuentrosHoy = await db
    .select()
    .from(encountersTable)
    .where(and(eq(encountersTable.professionalId, profesionalId), gte(encountersTable.encounterDate, inicioHoy)));

  const [recetasHoy, derivacionesHoy, certificadosHoy, ordenesHoy, practicasPend] = await Promise.all([
    db.select().from(prescriptionsTable).where(and(eq(prescriptionsTable.professionalId, profesionalId), gte(prescriptionsTable.createdAt, inicioHoy))),
    db.select().from(referralsTable).where(and(eq(referralsTable.professionalId, profesionalId), gte(referralsTable.createdAt, inicioHoy))),
    db.select().from(certificatesTable).where(and(eq(certificatesTable.professionalId, profesionalId), gte(certificatesTable.createdAt, inicioHoy))),
    db.select().from(studyOrdersTable).where(and(eq(studyOrdersTable.professionalId, profesionalId), gte(studyOrdersTable.createdAt, inicioHoy))),
    db.select().from(practicasTable).where(and(eq(practicasTable.profesionalId, profesionalId), inArray(practicasTable.estado, ["indicada", "autorizada", "pendiente"]))),
  ]);

  const pacienteIds = [...new Set([...turnos.map((t) => t.pacienteId), ...practicasPend.map((p) => p.pacienteId)])];
  const pacientes = pacienteIds.length
    ? await db.select().from(pacientesTable).where(inArray(pacientesTable.id, pacienteIds))
    : [];
  const pacientesMap = new Map(pacientes.map((p) => [p.id, p]));
  const nombreDe = (id: number | null) => {
    if (id == null) return "—";
    const p = pacientesMap.get(id);
    return p ? `${p.apellido}, ${p.nombre}` : `Paciente #${id}`;
  };

  const ESTADOS_PENDIENTES = ["pendiente", "confirmado", "en_sala"];
  const pendientes = turnos.filter((t) => ESTADOS_PENDIENTES.includes(t.estado)).length;

  const [profRow] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, profesionalId)).limit(1);

  // Las atenciones se computan desde la recepción (turnos que terminaron
  // atendidos), NO desde la historia clínica: corregir o re-registrar una
  // evolución no debe sumar una atención de más.
  const ESTADOS_ATENDIDO = ["atendido", "visto", "pendiente_informe", "en_atencion"];
  const atendidosHoy = turnos.filter((t) => ESTADOS_ATENDIDO.includes(t.estado)).length;

  res.json({
    profesionalId,
    aceptaDemandaEspontanea: !!profRow?.aceptaDemandaEspontanea,
    fecha,
    turnosHoy: turnos.length,
    atendidosHoy,
    pendientes,
    documentosEmitidosHoy: recetasHoy.length + derivacionesHoy.length + certificadosHoy.length + ordenesHoy.length,
    proximosTurnos: turnos
      .filter((t) => ESTADOS_PENDIENTES.includes(t.estado))
      .slice(0, 8)
      .map((t) => ({
        turnoId: t.id,
        hora: t.horaInicio,
        estado: t.estado,
        nombrePaciente: nombreDe(t.pacienteId),
        pacienteId: t.pacienteId ?? null,
      })),
    tareasPendientes: practicasPend.slice(0, 10).map((p) => ({
      tipo: "practica",
      refId: p.id,
      descripcion: `${p.nombre} (${p.estado})`,
      fecha: p.fecha,
      pacienteId: p.pacienteId,
      nombrePaciente: nombreDe(p.pacienteId),
    })),
  });
});

// ── POST /consultorio/clinical-ai/suggestions ─────────────────────────────
const DISCLAIMER =
  "Sugerencias generadas por IA con fines orientativos. No constituyen indicación médica ni reemplazan el juicio clínico del profesional tratante.";

router.post("/consultorio/clinical-ai/suggestions", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!esProfesional(user)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const parsed = GetClinicalAiSuggestionsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, parsed.data.patientId)).limit(1);
  if (!paciente) { res.status(404).json({ error: "Paciente no encontrado" }); return; }

  const [record] = await db
    .select()
    .from(clinicalRecordsTable)
    .where(eq(clinicalRecordsTable.patientId, parsed.data.patientId))
    .limit(1);

  let contextoHce = "";
  if (record) {
    const encuentros = await db
      .select()
      .from(encountersTable)
      .where(eq(encountersTable.clinicalRecordId, record.id))
      .orderBy(desc(encountersTable.encounterDate))
      .limit(5);
    const encIds = encuentros.map((e) => e.id);
    const vitales = encIds.length
      ? await db.select().from(vitalSignsTable).where(inArray(vitalSignsTable.encounterId, encIds))
      : [];
    contextoHce = [
      record.allergies ? `Alergias: ${record.allergies}` : null,
      record.chronicDiseases ? `Enfermedades crónicas: ${record.chronicDiseases}` : null,
      record.currentMedications ? `Medicación actual: ${record.currentMedications}` : null,
      encuentros.length
        ? `Últimas consultas:\n${encuentros
            .map((e) => `- ${e.encounterDate.toISOString().split("T")[0]}: ${e.diagnosis ?? e.assessment ?? e.chiefComplaint ?? "sin detalle"}`)
            .join("\n")}`
        : null,
      vitales.length
        ? `Últimos signos vitales: ${vitales
            .slice(0, 2)
            .map((v) => [v.bloodPressure ? `TA ${v.bloodPressure}` : null, v.heartRate ? `FC ${v.heartRate}` : null, v.bmi ? `IMC ${v.bmi.toFixed(1)}` : null].filter(Boolean).join(", "))
            .join(" | ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "Sos un asistente clínico para médicos de una clínica argentina. Recibís el contexto de la historia clínica de un paciente y devolvés sugerencias breves, prudentes y NO vinculantes (posibles diagnósticos diferenciales a considerar, estudios que podrían ser útiles, alertas de interacciones o alergias). Respondé SOLO en JSON válido con esta forma: {\"resumen\": string, \"sugerencias\": string[]}. Máximo 5 sugerencias, cada una de una línea. No inventes datos que no estén en el contexto.",
        },
        {
          role: "user",
          content: `Paciente: ${paciente.apellido}, ${paciente.nombre}${paciente.fechaNacimiento ? ` (nac. ${paciente.fechaNacimiento})` : ""}\n${contextoHce || "Sin datos de HCE registrados."}\n${parsed.data.contexto ? `Contexto de la consulta actual: ${parsed.data.contexto}` : ""}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let sugerencias: string[] = [];
    let resumen: string | null = null;
    try {
      const parsedJson = JSON.parse(raw) as { resumen?: unknown; sugerencias?: unknown };
      if (typeof parsedJson.resumen === "string") resumen = parsedJson.resumen;
      if (Array.isArray(parsedJson.sugerencias)) {
        sugerencias = parsedJson.sugerencias.filter((s): s is string => typeof s === "string").slice(0, 5);
      }
    } catch {
      req.log.warn({ raw }, "Respuesta IA no parseable como JSON");
    }

    await registrarAuditoria(user, "consultar", "clinical_ai", null, parsed.data.patientId, {
      consultationId: parsed.data.consultationId ?? null,
    });

    res.json({ sugerencias, resumen, disclaimer: DISCLAIMER });
  } catch (err) {
    req.log.error({ err }, "Error consultando IA clínica");
    res.status(502).json({ error: "No se pudo obtener sugerencias de IA en este momento" });
  }
});

// ── POST /consultorio/patients/:patientId/hc-resumen ──────────────────────
// Asistente IA: redacta un resumen de historia clínica del paciente para la
// planilla de alta complejidad, a partir de lo escrito en la HCE.
router.post("/consultorio/patients/:patientId/hc-resumen", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const patientId = Number(req.params.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) { res.status(400).json({ error: "patientId inválido" }); return; }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, patientId)).limit(1);
  if (!paciente) { res.status(404).json({ error: "Paciente no encontrado" }); return; }

  const [record] = await db
    .select()
    .from(clinicalRecordsTable)
    .where(eq(clinicalRecordsTable.patientId, patientId))
    .limit(1);

  let contextoHce = "";
  if (record) {
    const encuentros = await db
      .select()
      .from(encountersTable)
      .where(eq(encountersTable.clinicalRecordId, record.id))
      .orderBy(desc(encountersTable.encounterDate))
      .limit(8);
    contextoHce = [
      record.allergies ? `Alergias: ${record.allergies}` : null,
      record.chronicDiseases ? `Enfermedades crónicas: ${record.chronicDiseases}` : null,
      record.currentMedications ? `Medicación actual: ${record.currentMedications}` : null,
      encuentros.length
        ? `Evoluciones (de la más reciente a la más antigua):\n${encuentros
            .map((e) => {
              const partes = [
                e.chiefComplaint ? `Motivo: ${e.chiefComplaint}` : null,
                e.anamnesis ? `Evolución: ${e.anamnesis}` : null,
                e.physicalExam ? `Examen físico: ${e.physicalExam}` : null,
                e.assessment ? `Evaluación: ${e.assessment}` : null,
                e.diagnosis ? `Diagnóstico: ${e.diagnosis}${e.cie10 ? ` (${e.cie10})` : ""}` : null,
                e.plan ? `Plan: ${e.plan}` : null,
              ].filter(Boolean);
              return `- ${e.encounterDate.toISOString().split("T")[0]}: ${partes.join(". ") || "sin detalle"}`;
            })
            .join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Contexto opcional del examen actual: estudio pedido, maniobras semiológicas
  // (positivas/negativas) y notas del médico. Si viene, la IA genera además la
  // justificación clínica de la orden.
  const body = (req.body ?? {}) as {
    estudio?: string;
    maniobras?: Array<{ nombre: string; resultado: "positiva" | "negativa" }>;
    notasMedico?: string;
    // Estudio bilateral (ej: AMBAS RODILLAS): las maniobras vienen prefijadas
    // por lado y el médico indica cuál es el lado más doloroso.
    bilateral?: { region?: string; ladoMasDoloroso?: "derecha" | "izquierda" };
  };
  const bilateral =
    body.bilateral && (body.bilateral.ladoMasDoloroso === "derecha" || body.bilateral.ladoMasDoloroso === "izquierda")
      ? { region: typeof body.bilateral.region === "string" ? body.bilateral.region.trim() : "", ladoMasDoloroso: body.bilateral.ladoMasDoloroso }
      : null;
  const maniobras = Array.isArray(body.maniobras)
    ? body.maniobras.filter((m) => m && typeof m.nombre === "string" && m.nombre.trim() && (m.resultado === "positiva" || m.resultado === "negativa"))
    : [];
  const contextoExamen = [
    typeof body.estudio === "string" && body.estudio.trim() ? `Estudio solicitado: ${body.estudio.trim()}` : null,
    maniobras.length
      ? `Maniobras semiológicas del examen físico:\n${maniobras.map((m) => `- ${m.nombre.trim()}: ${m.resultado.toUpperCase()}`).join("\n")}`
      : null,
    typeof body.notasMedico === "string" && body.notasMedico.trim() ? `Notas del médico: ${body.notasMedico.trim()}` : null,
    bilateral
      ? `Estudio BILATERAL${bilateral.region ? ` (ambas ${bilateral.region.toLowerCase()}s)` : ""}. Lado más doloroso según el médico: ${bilateral.ladoMasDoloroso.toUpperCase()}.`
      : null,
  ].filter(Boolean).join("\n");
  const conExamen = contextoExamen.length > 0;

  if (!contextoHce.trim() && !conExamen) {
    res.status(422).json({ error: "El paciente no tiene datos de historia clínica registrados para resumir" });
    return;
  }

  try {
    const sistema = conExamen
      ? "Sos un asistente clínico de una clínica argentina. Recibís datos de la historia clínica de un paciente, el estudio solicitado y el examen físico actual (hallazgos del examen descriptos como movimientos, positivos/negativos, y notas del médico). Interpretá el significado clínico de cada hallazgo y redactá DOS textos en español, prosa médica formal, sin inventar datos que no estén en el contexto y sin incluir el nombre del paciente.\nPROHIBIDO nombrar maniobras por su nombre técnico o epónimo (NUNCA escribas Lachman, McMurray, Jobe, Lasègue, Phalen, etc.): describí siempre el hallazgo como el movimiento observado (por ejemplo \"dolor al flexionar la pierna y presionar del lado externo\" en lugar del nombre de la maniobra).\nREDACCIÓN: encadená los hallazgos en una sola oración fluida usando conectores como \"en conjunto a\", \"asociado a\", \"sugerente de\", y cerrá vinculando con el estudio pedido. Ejemplo de estilo: \"dolor al flexionar la pierna y presionar del lado externo en conjunto a chasquido articular bilateral, sugerente de lesión osteocondral, lo que motiva la solicitud de resonancia magnética como método de diagnóstico para establecer o descartar dicho diagnóstico presuntivo\".\n1. \"justificacion\": justificación clínica breve de por qué se solicita el estudio (2 a 4 líneas), integrando los hallazgos con ese estilo encadenado y la sospecha diagnóstica.\n2. \"resumen\": resumen de historia clínica (un párrafo de 4 a 8 líneas) para la planilla de la obra social: antecedentes relevantes, cuadro actual, hallazgos del examen físico encadenados con conectores y su interpretación, y la sospecha que motiva el estudio.\nIMPORTANTE: estos textos van a la obra social para autorizar el estudio. NUNCA incluyas frases negativas o que resten fundamento a la solicitud (por ejemplo \"no se informan maniobras positivas\", \"sin hallazgos\", \"examen normal\"). Si un dato es negativo o falta, simplemente omitilo y redactá solo con los hallazgos positivos y los datos que apoyan el pedido.\nRespondé SOLO un JSON válido con las claves \"justificacion\" y \"resumen\", sin markdown." +
        (bilateral
          ? (() => {
              // Miembro superior → "proceso degenerativo articular"; miembro
              // inferior (articulaciones de carga) → "sobrecarga compensatoria".
              const esMiembroSuperior = ["hombro", "codo", "muñeca y mano"].includes(bilateral.region.toLowerCase());
              const frase = esMiembroSuperior
                ? "descartar o establecer proceso degenerativo articular o enfermedad bilateral"
                : "descartar o establecer sobrecarga compensatoria o enfermedad bilateral";
              return `\nESTUDIO BILATERAL: el estudio abarca ambos lados (${bilateral.region ? `ambas ${bilateral.region.toLowerCase()}s` : "ambas articulaciones"}). En la justificación y el resumen dejá EXPLÍCITO: 1) que el lado ${bilateral.ladoMasDoloroso === "derecha" ? "DERECHO" : "IZQUIERDO"} es el que presenta mayor dolor y concentra el cuadro principal, con sus hallazgos; 2) que el lado ${bilateral.ladoMasDoloroso === "derecha" ? "izquierdo" : "derecho"} presenta los hallazgos positivos que se describen para ese lado; y 3) que el estudio de ambos lados se solicita para ${frase}. Usá exactamente la idea "${frase}" en la redacción.`;
            })()
          : "")
      : "Sos un asistente clínico de una clínica argentina. Recibís datos de la historia clínica de un paciente y redactás un RESUMEN DE HISTORIA CLÍNICA breve (un párrafo de 4 a 8 líneas, prosa médica formal en español) para adjuntar a una planilla de solicitud de estudio de alta complejidad de la obra social. Incluí solo lo clínicamente relevante: antecedentes, alergias, medicación, evolución del cuadro actual y diagnósticos. NO inventes datos que no estén en el contexto. NO incluyas encabezados ni el nombre del paciente. IMPORTANTE: este texto va a la obra social para autorizar el estudio. NUNCA incluyas frases negativas o que resten fundamento a la solicitud (por ejemplo \"no se informan maniobras positivas\", \"sin hallazgos\", \"examen normal\"); si un dato es negativo o falta, omitilo y redactá solo con lo que apoya el pedido. Respondé SOLO el texto del resumen, sin comillas ni formato.";

    const contenidoUsuario = [contextoExamen, contextoHce.trim() ? `Historia clínica:\n${contextoHce}` : null]
      .filter(Boolean).join("\n\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 900,
      messages: [
        { role: "system", content: sistema },
        { role: "user", content: contenidoUsuario },
      ],
    });

    const salida = (completion.choices[0]?.message?.content ?? "").trim();
    if (!salida) {
      res.status(502).json({ error: "La IA no devolvió un resumen" });
      return;
    }

    let resumen = salida;
    let justificacion: string | null = null;
    if (conExamen) {
      try {
        const json = JSON.parse(salida.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim()) as { justificacion?: string; resumen?: string };
        resumen = (json.resumen ?? "").trim() || salida;
        justificacion = (json.justificacion ?? "").trim() || null;
      } catch {
        // Si la IA no devolvió JSON, usamos el texto completo como resumen.
      }
    }

    await registrarAuditoria(user, "consultar", "clinical_ai", null, patientId, { accion: "resumen_hc", conExamen });

    res.json({ resumen, justificacion, disclaimer: "Texto generado por IA a partir de la HCE y el examen actual. Revisalo y editalo antes de emitir la orden." });
  } catch (err) {
    req.log.error({ err }, "Error generando resumen de HC con IA");
    res.status(502).json({ error: "No se pudo generar el resumen en este momento" });
  }
});


// ── POST /consultorio/patients/:patientId/sugerir-estudios ────────────────
// Asistente IA: a partir de lo escrito en la evolución actual (motivo,
// anamnesis, examen físico, diagnóstico) sugiere qué estudios complementarios
// pedir, con el motivo clínico de cada uno.
router.post("/consultorio/patients/:patientId/sugerir-estudios", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const patientId = Number(req.params.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) { res.status(400).json({ error: "patientId inválido" }); return; }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, patientId)).limit(1);
  if (!paciente) { res.status(404).json({ error: "Paciente no encontrado" }); return; }

  const body = (req.body ?? {}) as { motivo?: string; anamnesis?: string; examenFisico?: string; diagnostico?: string; evaluacion?: string };
  const campo = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const contextoConsulta = [
    campo(body.motivo) ? `Motivo de consulta: ${campo(body.motivo)}` : null,
    campo(body.anamnesis) ? `Anamnesis: ${campo(body.anamnesis)}` : null,
    campo(body.examenFisico) ? `Examen físico: ${campo(body.examenFisico)}` : null,
    campo(body.diagnostico) ? `Diagnóstico presuntivo: ${campo(body.diagnostico)}` : null,
    campo(body.evaluacion) ? `Evaluación: ${campo(body.evaluacion)}` : null,
  ].filter(Boolean).join("\n");

  if (!contextoConsulta) {
    res.status(422).json({ error: "Escribí algo en la evolución (motivo, anamnesis o examen) para poder sugerir estudios" });
    return;
  }

  // Antecedentes de la HCE como contexto adicional
  const [record] = await db.select().from(clinicalRecordsTable).where(eq(clinicalRecordsTable.patientId, patientId)).limit(1);
  const antecedentes = record
    ? [
        record.allergies ? `Alergias: ${record.allergies}` : null,
        record.chronicDiseases ? `Enfermedades crónicas: ${record.chronicDiseases}` : null,
        record.currentMedications ? `Medicación actual: ${record.currentMedications}` : null,
      ].filter(Boolean).join("\n")
    : "";

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 900,
      messages: [
        {
          role: "system",
          content:
            "Sos un asistente clínico de una clínica argentina. Recibís la evolución que el médico está escribiendo (motivo, anamnesis, examen físico, diagnóstico presuntivo) y sugerís qué estudios complementarios conviene solicitar según la práctica habitual argentina. Por ejemplo: gonalgia derecha post-traumática → Rx de rodilla frente y perfil, y resonancia de rodilla si hay sospecha de lesión meniscal o ligamentaria.\nReglas:\n- Sugerí entre 1 y 5 estudios, ordenados del más al menos prioritario.\n- Usá nombres de estudios concretos y habituales (ej: \"Rx de rodilla frente y perfil\", \"Resonancia de rodilla derecha\", \"Laboratorio: hemograma, glucemia, perfil lipídico\", \"Ecografía de partes blandas\").\n- \"complejidad\": \"alta\" solo para resonancia, tomografía o ecodoppler; el resto (Rx, ecografía, laboratorio, ECG, etc.) es \"baja\".\n- \"motivo\": una línea con la razón clínica de ese estudio en este paciente.\n- NO inventes datos que no estén en el contexto. Si el cuadro no amerita estudios, devolvé una lista vacía.\nRespondé SOLO un JSON válido: {\"sugerencias\": [{\"estudio\": string, \"complejidad\": \"baja\"|\"alta\", \"motivo\": string}]} sin markdown.",
        },
        {
          role: "user",
          content: [contextoConsulta, antecedentes ? `Antecedentes del paciente:\n${antecedentes}` : null].filter(Boolean).join("\n\n"),
        },
      ],
    });

    const salida = (completion.choices[0]?.message?.content ?? "").trim();
    let sugerencias: Array<{ estudio: string; complejidad?: "baja" | "alta"; motivo: string }> = [];
    try {
      const json = JSON.parse(salida.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim()) as { sugerencias?: unknown };
      if (Array.isArray(json.sugerencias)) {
        sugerencias = json.sugerencias
          .filter((s): s is { estudio: string; complejidad?: string; motivo: string } =>
            !!s && typeof (s as { estudio?: unknown }).estudio === "string" && typeof (s as { motivo?: unknown }).motivo === "string")
          .slice(0, 5)
          .map((s) => ({
            estudio: s.estudio.trim(),
            complejidad: s.complejidad === "alta" ? "alta" as const : "baja" as const,
            motivo: s.motivo.trim(),
          }))
          .filter((s) => s.estudio.length > 0);
      }
    } catch {
      req.log.warn({ salida: salida.slice(0, 200) }, "La IA no devolvió JSON válido al sugerir estudios");
      res.status(502).json({ error: "La IA no devolvió sugerencias válidas, probá de nuevo" });
      return;
    }

    await registrarAuditoria(user, "consultar", "clinical_ai", null, patientId, { accion: "sugerir_estudios", cantidad: sugerencias.length });

    res.json({
      sugerencias,
      disclaimer: "Sugerencias generadas por IA a partir de la evolución. Decidí vos qué estudios corresponden.",
    });
  } catch (err) {
    req.log.error({ err }, "Error sugiriendo estudios con IA");
    res.status(502).json({ error: "No se pudieron generar sugerencias en este momento" });
  }
});

// ── POST /consultorio/pdf/generate ────────────────────────────────────────
router.post("/consultorio/pdf/generate", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  if (!puedeEscribir(user)) { res.status(403).json({ error: "Sin permisos" }); return; }

  const parsed = GeneratePdfBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const fuente = await cargarFuente(parsed.data.sourceType, parsed.data.sourceId);
  if (!fuente) { res.status(404).json({ error: "Documento origen no encontrado" }); return; }

  if (user.rol === "medico" && user.profesionalId !== fuente.professionalId) {
    res.status(403).json({ error: "No podés generar PDFs de documentos de otro profesional" });
    return;
  }

  // Idempotente: si ya existe un registro para este documento, se reutiliza
  const [existente] = await db
    .select()
    .from(pdfDocumentsTable)
    .where(and(eq(pdfDocumentsTable.sourceType, parsed.data.sourceType), eq(pdfDocumentsTable.sourceId, parsed.data.sourceId)))
    .limit(1);

  const registro =
    existente ??
    (
      await db
        .insert(pdfDocumentsTable)
        .values({
          patientId: fuente.patientId,
          professionalId: fuente.professionalId,
          consultationId: fuente.consultationId,
          sourceType: parsed.data.sourceType,
          sourceId: parsed.data.sourceId,
          pdfContentReference: `generated:${parsed.data.sourceType}:${parsed.data.sourceId}`,
          createdBy: user.id,
        })
        .returning()
    )[0];

  if (!existente) {
    await registrarAuditoria(user, "generar_pdf", parsed.data.sourceType, parsed.data.sourceId, fuente.patientId, parsed.data);
  }

  res.status(201).json({ ...registro, downloadUrl: `/api/consultorio/pdf/${registro.id}` });
});

// ── GET /consultorio/pdf/:pdfId ───────────────────────────────────────────
router.get("/consultorio/pdf/:pdfId", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const pdfId = parseInt(String(req.params.pdfId));
  if (isNaN(pdfId)) { res.status(400).json({ error: "pdfId inválido" }); return; }

  const [registro] = await db.select().from(pdfDocumentsTable).where(eq(pdfDocumentsTable.id, pdfId)).limit(1);
  if (!registro) { res.status(404).json({ error: "PDF no encontrado" }); return; }

  const fuente = await cargarFuente(registro.sourceType, registro.sourceId);
  if (!fuente) { res.status(404).json({ error: "Documento origen no encontrado" }); return; }

  // Autorización a nivel de objeto: admin/medico (precedente de lectura HCE),
  // paciente solo si el documento es de su propia historia
  if (!(await puedeLeerPaciente(user, fuente.patientId))) {
    res.status(403).json({ error: "Sin permisos para descargar este documento" });
    return;
  }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, fuente.patientId)).limit(1);
  const [profesional] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, fuente.professionalId)).limit(1);
  if (!paciente || !profesional) { res.status(404).json({ error: "Datos del documento incompletos" }); return; }

  let especialidad: string | null = null;
  if (profesional.especialidadId != null) {
    const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, profesional.especialidadId)).limit(1);
    especialidad = esp?.nombre ?? null;
  }

  await registrarAuditoria(user, "descargar_pdf", registro.sourceType, registro.sourceId, fuente.patientId, { pdfId });

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
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${registro.sourceType}_${registro.sourceId}_${paciente.apellido.toLowerCase()}.pdf"`,
  );
  doc.pipe(res);
  doc.end();
});

// ── GET /consultorio/certificates/:certificateId/pdf ──────────────────────
// Impresión desde la ficha del paciente (recepción/staff): sirve SIEMPRE el
// PDF original inmutable guardado al emitir, igual que la descarga pública.
router.get("/consultorio/certificates/:certificateId/pdf", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const certificateId = parseInt(String(req.params.certificateId));
  if (isNaN(certificateId)) { res.status(400).json({ error: "certificateId inválido" }); return; }

  const [c] = await db.select().from(certificatesTable).where(eq(certificatesTable.id, certificateId)).limit(1);
  if (!c) { res.status(404).json({ error: "Certificado no encontrado" }); return; }
  if (!esStaffAdministrativo(user) && !(await puedeLeerPaciente(user, c.patientId))) {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }

  // Fallback para certificados anteriores al circuito del PDF inmutable.
  let base64 = c.pdfOriginal;
  if (!base64) {
    await guardarPdfOriginalCertificado(c.id);
    const [rec] = await db.select().from(certificatesTable).where(eq(certificatesTable.id, c.id)).limit(1);
    base64 = rec?.pdfOriginal ?? null;
  }
  if (!base64) { res.status(404).json({ error: "PDF no disponible" }); return; }

  await registrarAuditoria(user, "descargar_pdf", "certificado", c.id, c.patientId, { origen: "ficha_paciente" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="certificado_${numeroCertificado(c)}.pdf"`);
  res.send(Buffer.from(base64, "base64"));
});

// ── GET /consultorio/prescriptions/:prescriptionId/pdf ────────────────────
// Impresión de recetas desde la ficha del paciente (recepción/staff). El PDF
// se regenera desde los datos de la receta (las recetas no guardan snapshot).
router.get("/consultorio/prescriptions/:prescriptionId/pdf", async (req: Request, res: Response) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: "No autenticado" }); return; }
  const prescriptionId = parseInt(String(req.params.prescriptionId));
  if (isNaN(prescriptionId)) { res.status(400).json({ error: "prescriptionId inválido" }); return; }

  const fuente = await cargarFuente("receta", prescriptionId);
  if (!fuente) { res.status(404).json({ error: "Receta no encontrada" }); return; }
  if (!esStaffAdministrativo(user) && !(await puedeLeerPaciente(user, fuente.patientId))) {
    res.status(403).json({ error: "Sin permisos" });
    return;
  }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, fuente.patientId)).limit(1);
  const [profesional] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, fuente.professionalId)).limit(1);
  if (!paciente || !profesional) { res.status(404).json({ error: "Datos del documento incompletos" }); return; }

  let especialidad: string | null = null;
  if (profesional.especialidadId != null) {
    const [esp] = await db.select().from(especialidadesTable).where(eq(especialidadesTable.id, profesional.especialidadId)).limit(1);
    especialidad = esp?.nombre ?? null;
  }

  await registrarAuditoria(user, "descargar_pdf", "receta", prescriptionId, fuente.patientId, { origen: "ficha_paciente" });

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
  res.setHeader("Content-Disposition", `inline; filename="receta_${prescriptionId}_${paciente.apellido.toLowerCase()}.pdf"`);
  doc.pipe(res);
  doc.end();
});

export default router;
