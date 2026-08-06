import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pacientesTable, pacsEstudiosVinculadosTable } from "@workspace/db";
import {
  PacsWebhookEstudioInformadoBody,
  VincularDicomPacsEstudioBody,
  CrearDicomPacsSesionVisorBody,
} from "@workspace/api-zod";
import { getUserFromRequest } from "./auth";
import { procesarTurnosEsperandoInforme } from "../integraciones/pacs-flujo";
import { getEstudiosByDni, phiritApiConfigurado } from "../integraciones/phirit-api";
import {
  dicomPacsConfigurado,
  getEstudiosDicomTodos,
  importarDesdePhir,
  crearPortalPacienteLink,
  crearPortalListadoLink,
  crearWorklistPortalLink,
} from "../integraciones/diagnostipacs-api";
import {
  pacsV1Configurado,
  estadoDeEstudio,
  crearSesionVisor,
  type PacsStudySummary,
} from "../integraciones/pacs-workspace-v1";

const router: IRouter = Router();

// Autorización compartida: staff ve cualquier paciente; el paciente, solo el suyo.
async function autorizarPaciente(req: Parameters<typeof getUserFromRequest>[0], pacienteId: number) {
  const user = await getUserFromRequest(req);
  if (!user) return { status: 401 as const, error: "No autenticado" };
  const esStaff = ["admin", "medico", "recepcionista"].includes(user.rol);
  if (!esStaff) {
    if (user.rol !== "paciente") return { status: 403 as const, error: "Rol sin permisos" };
    const propio = user.pacienteId ? parseInt(user.pacienteId) : null;
    if (propio !== pacienteId) return { status: 403 as const, error: "No autorizado" };
  }
  return null;
}

// ── PACS (imágenes de Phir-it) ─────────────────────────────────────────────
// Consulta EN VIVO a la API de Phir-it los estudios de imágenes de un paciente
// (por DNI) y devuelve la metadata DICOM, los informes y los links a los
// visores de Phir-it (OHIF / Oviyam / portal) que el frontend embebe.
// Acceso: staff (admin/medico/recepcionista) a cualquier paciente; el paciente
// solo a su propia ficha.

router.get("/pacs/pacientes/:id/estudios", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });

  const pacienteId = Number(req.params.id);
  if (!Number.isInteger(pacienteId) || pacienteId <= 0) {
    return res.status(400).json({ error: "ID de paciente inválido" });
  }

  const esStaff = ["admin", "medico", "recepcionista"].includes(user.rol);
  if (!esStaff) {
    // Paciente: solo su propia ficha
    if (user.rol !== "paciente") return res.status(403).json({ error: "Rol sin permisos" });
    const propio = user.pacienteId ? parseInt(user.pacienteId) : null;
    if (propio !== pacienteId) return res.status(403).json({ error: "No autorizado" });
  }

  if (!phiritApiConfigurado()) {
    return res.status(503).json({ error: "Integración Phir-it no configurada (falta PHIRIT_API_COD_CLIENTE)" });
  }

  const [paciente] = await db
    .select({ id: pacientesTable.id, dni: pacientesTable.dni })
    .from(pacientesTable)
    .where(eq(pacientesTable.id, pacienteId))
    .limit(1);
  if (!paciente) return res.status(404).json({ error: "Paciente no encontrado" });
  if (!paciente.dni) {
    // Sin DNI no hay forma de consultar Phir-it → lista vacía, no error
    return res.json({ estudios: [] });
  }

  const resultado = await getEstudiosByDni(paciente.dni);
  if (!resultado.ok) {
    const status = resultado.code === "SIN_CONFIG" ? 503 : 502;
    req.log.warn({ code: resultado.code, msg: resultado.message }, "Phir-it API: consulta de estudios falló");
    return res.status(status).json({ error: resultado.message });
  }

  return res.json({ estudios: resultado.data });
});

// ── DiagnostiPACS (PACS propio con IA) ─────────────────────────────────────
// GET: todos los estudios del PACS (pestaña Informes). Solo staff.
router.get("/pacs/estudios", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (!["admin", "medico", "recepcionista"].includes(user.rol)) {
    return res.status(403).json({ error: "Solo el staff puede ver el listado de informes" });
  }

  if (!dicomPacsConfigurado()) {
    return res.json({ configurado: false, estudios: [] });
  }

  const resultado = await getEstudiosDicomTodos();
  if (!resultado.ok) {
    req.log.warn({ code: resultado.code, msg: resultado.message }, "DiagnostiPACS: listado global de estudios falló");
    return res.status(502).json({ error: resultado.message });
  }
  return res.json({ configurado: true, estudios: resultado.data });
});

// Mapea un vínculo local (+ estado en vivo opcional) al shape DicomPacsEstudio.
function estudioVinculadoADto(
  v: { studyInstanceUid: string; modalidad: string | null; descripcion: string | null; estado: string | null; createdAt: Date },
  vivo?: PacsStudySummary,
) {
  return {
    id: v.studyInstanceUid,
    patientDni: null,
    patientName: null,
    studyDate: vivo?.received_at ?? null,
    modality: vivo?.modality ?? v.modalidad,
    status: vivo?.state ?? v.estado,
    imageUrl: null,
    impression: v.descripcion,
    viewerUrl: null,
    createdAt: v.createdAt.toISOString(),
  };
}

// GET: estudios DICOM del paciente. El PACS cerró el listado por DNI del API
// legado, así que ahora se listan los StudyInstanceUID vinculados localmente
// y se consulta el estado en vivo de cada uno vía la API v1 de integración.
router.get("/pacs/pacientes/:id/dicom", async (req, res) => {
  const pacienteId = Number(req.params.id);
  if (!Number.isInteger(pacienteId) || pacienteId <= 0) {
    return res.status(400).json({ error: "ID de paciente inválido" });
  }
  const denegado = await autorizarPaciente(req, pacienteId);
  if (denegado) return res.status(denegado.status).json({ error: denegado.error });

  if (!pacsV1Configurado()) {
    return res.json({ configurado: false, estudios: [] });
  }

  const [paciente] = await db
    .select({ id: pacientesTable.id })
    .from(pacientesTable)
    .where(eq(pacientesTable.id, pacienteId))
    .limit(1);
  if (!paciente) return res.status(404).json({ error: "Paciente no encontrado" });

  const vinculos = await db
    .select()
    .from(pacsEstudiosVinculadosTable)
    .where(eq(pacsEstudiosVinculadosTable.pacienteId, pacienteId));

  const estudios = await Promise.all(
    vinculos.map(async (v) => {
      const vivo = await estadoDeEstudio(v.studyInstanceUid);
      if (!vivo.ok) {
        req.log.warn(
          { studyUid: v.studyInstanceUid, code: vivo.code, msg: vivo.message },
          "DiagnostiPACS v1: estado de estudio no disponible",
        );
        return estudioVinculadoADto(v);
      }
      return estudioVinculadoADto(v, vivo.data);
    }),
  );
  return res.json({ configurado: true, estudios });
});

// POST: vincula un StudyInstanceUID del PACS al paciente (solo staff).
// Valida contra la API v1 que el estudio exista antes de guardar.
router.post("/pacs/pacientes/:id/dicom/vincular", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (!["admin", "medico", "recepcionista"].includes(user.rol)) {
    return res.status(403).json({ error: "Solo el staff puede vincular estudios" });
  }

  const pacienteId = Number(req.params.id);
  if (!Number.isInteger(pacienteId) || pacienteId <= 0) {
    return res.status(400).json({ error: "ID de paciente inválido" });
  }
  const parsed = VincularDicomPacsEstudioBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido: se requiere studyInstanceUid" });
  }
  const studyUid = parsed.data.studyInstanceUid.trim();

  if (!pacsV1Configurado()) {
    return res.status(503).json({ error: "Integración DiagnostiPACS no configurada" });
  }

  const [paciente] = await db
    .select({ id: pacientesTable.id })
    .from(pacientesTable)
    .where(eq(pacientesTable.id, pacienteId))
    .limit(1);
  if (!paciente) return res.status(404).json({ error: "Paciente no encontrado" });

  const vivo = await estadoDeEstudio(studyUid);
  if (!vivo.ok) {
    if (vivo.status === 404) {
      return res.status(404).json({ error: "El PACS no conoce ese StudyInstanceUID — revisá el código" });
    }
    req.log.warn({ studyUid, code: vivo.code, msg: vivo.message }, "DiagnostiPACS v1: validación de estudio falló");
    return res.status(502).json({ error: vivo.message });
  }

  let vinculo;
  try {
    [vinculo] = await db
      .insert(pacsEstudiosVinculadosTable)
      .values({
        pacienteId,
        studyInstanceUid: studyUid,
        modalidad: vivo.data.modality ?? null,
        estado: vivo.data.state,
        vinculadoPor: user.id,
      })
      .returning();
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      return res.status(409).json({ error: "Ese estudio ya está vinculado a un paciente" });
    }
    throw err;
  }

  req.log.info({ pacienteId, studyUid }, "DiagnostiPACS: estudio vinculado al paciente");
  return res.json(estudioVinculadoADto(vinculo, vivo.data));
});

// POST: crea una sesión contextual de visor para un estudio vinculado.
// Staff sobre cualquier estudio; el paciente solo sobre los suyos.
router.post("/pacs/dicom/sesion-visor", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });

  const parsed = CrearDicomPacsSesionVisorBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido: se requiere studyInstanceUid" });
  }
  const studyUid = parsed.data.studyInstanceUid.trim();

  const [vinculo] = await db
    .select()
    .from(pacsEstudiosVinculadosTable)
    .where(eq(pacsEstudiosVinculadosTable.studyInstanceUid, studyUid))
    .limit(1);
  if (!vinculo) return res.status(404).json({ error: "Estudio no vinculado a ningún paciente" });

  const esStaff = ["admin", "medico", "recepcionista"].includes(user.rol);
  if (!esStaff) {
    if (user.rol !== "paciente") return res.status(403).json({ error: "Rol sin permisos" });
    const propio = user.pacienteId ? parseInt(user.pacienteId) : null;
    if (propio !== vinculo.pacienteId) return res.status(403).json({ error: "No autorizado" });
  }

  if (!pacsV1Configurado()) {
    return res.status(503).json({ error: "Integración DiagnostiPACS no configurada" });
  }

  const rolPacs = user.rol === "medico" ? "medico" : user.rol === "admin" ? "admin" : "recepcion";
  const resultado = await crearSesionVisor(
    {
      study_instance_uid: studyUid,
      user: { external_id: String(user.id), role: rolPacs, display_name: user.nombre },
      purpose: "visualizacion_clinica",
    },
    `visor-dicom-${vinculo.id}-${user.id}-${crypto.randomUUID()}`,
  );
  if (!resultado.ok) {
    req.log.warn({ studyUid, code: resultado.code, msg: resultado.message }, "DiagnostiPACS v1: fallo sesión de visor");
    return res.status(502).json({ error: resultado.message });
  }

  req.log.info({ studyUid, sessionId: resultado.data.session_id }, "DiagnostiPACS: sesión de visor creada");
  return res.json({
    sessionId: resultado.data.session_id,
    // OJO: redeem_url es el endpoint API de canje, NO una URL de visor para
    // el navegador. Solo exponemos viewer_url (hoy el PACS la manda null).
    viewerUrl: resultado.data.viewer_url ?? null,
    expiresAt: resultado.data.expires_at,
  });
});

// POST: pide a DiagnostiPACS que importe los estudios del paciente desde
// Phir-it (derivación). Solo staff.
router.post("/pacs/pacientes/:id/dicom/importar", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (!["admin", "medico", "recepcionista"].includes(user.rol)) {
    return res.status(403).json({ error: "Solo el staff puede importar estudios al PACS" });
  }

  const pacienteId = Number(req.params.id);
  if (!Number.isInteger(pacienteId) || pacienteId <= 0) {
    return res.status(400).json({ error: "ID de paciente inválido" });
  }
  if (!dicomPacsConfigurado()) {
    return res.status(503).json({ error: "Integración DiagnostiPACS no configurada (falta PACS_API_TOKEN)" });
  }

  const [paciente] = await db
    .select({ id: pacientesTable.id, dni: pacientesTable.dni })
    .from(pacientesTable)
    .where(eq(pacientesTable.id, pacienteId))
    .limit(1);
  if (!paciente) return res.status(404).json({ error: "Paciente no encontrado" });
  if (!paciente.dni) return res.status(400).json({ error: "El paciente no tiene DNI cargado" });

  const resultado = await importarDesdePhir(paciente.dni);
  if (!resultado.ok) {
    req.log.warn({ code: resultado.code, msg: resultado.message }, "DiagnostiPACS: importación falló");
    return res.status(502).json({ error: resultado.message });
  }
  req.log.info({ pacienteId, ...resultado.data }, "DiagnostiPACS: importación desde Phir-it");
  return res.json(resultado.data);
});

// ── GET: enlace de solo lectura al portal por paciente de DiagnostiPACS ────
// Para médicos solicitantes: enlace multiuso (180 días) con los estudios e
// informes de un único DNI, sin login. Se pide uno nuevo en cada apertura de
// la HCE (recomendación del instructivo de DiagnostiPACS). Solo staff.
router.get("/pacs/pacientes/:id/portal-link", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (!["admin", "medico", "recepcionista"].includes(user.rol)) {
    return res.status(403).json({ error: "Solo el staff puede generar el enlace al portal" });
  }

  const pacienteId = Number(req.params.id);
  if (!Number.isInteger(pacienteId) || pacienteId <= 0) {
    return res.status(400).json({ error: "ID de paciente inválido" });
  }
  if (!dicomPacsConfigurado()) {
    return res.status(503).json({ error: "Integración DiagnostiPACS no configurada (falta PACS_API_TOKEN)" });
  }

  const [paciente] = await db
    .select({ id: pacientesTable.id, dni: pacientesTable.dni })
    .from(pacientesTable)
    .where(eq(pacientesTable.id, pacienteId))
    .limit(1);
  if (!paciente) return res.status(404).json({ error: "Paciente no encontrado" });
  if (!paciente.dni) return res.status(400).json({ error: "El paciente no tiene DNI cargado" });

  const resultado = await crearPortalPacienteLink(paciente.dni);
  if (!resultado.ok) {
    req.log.warn({ pacienteId, code: resultado.code, msg: resultado.message }, "DiagnostiPACS: fallo enlace portal paciente");
    return res.status(502).json({ error: resultado.message });
  }
  req.log.info({ pacienteId, expiresAt: resultado.data.expiresAt }, "DiagnostiPACS: enlace portal paciente generado");
  return res.json(resultado.data);
});

// ── GET: enlace de solo lectura al listado general del portal del PACS ─────
// Multiuso (180 días). Se pide uno nuevo en cada apertura. Solo staff.
router.get("/pacs/portal-link", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (!["admin", "medico", "recepcionista"].includes(user.rol)) {
    return res.status(403).json({ error: "Solo el staff puede generar el enlace al portal" });
  }
  if (!dicomPacsConfigurado()) {
    return res.status(503).json({ error: "Integración DiagnostiPACS no configurada (falta PACS_API_TOKEN)" });
  }

  const resultado = await crearPortalListadoLink();
  if (!resultado.ok) {
    req.log.warn({ code: resultado.code, msg: resultado.message }, "DiagnostiPACS: fallo enlace listado portal");
    return res.status(502).json({ error: resultado.message });
  }
  req.log.info({ expiresAt: resultado.data.expiresAt }, "DiagnostiPACS: enlace listado portal generado");
  return res.json(resultado.data);
});

// ── GET: enlace firmado al portal de la worklist del PACS ──────────────────
// Entra directo, sin login de Pixel. Se pide uno nuevo en cada apertura. Solo staff.
router.get("/pacs/worklist-portal-link", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (!["admin", "medico", "recepcionista"].includes(user.rol)) {
    return res.status(403).json({ error: "Solo el staff puede generar el enlace a la worklist" });
  }
  if (!dicomPacsConfigurado()) {
    return res.status(503).json({ error: "Integración DiagnostiPACS no configurada (falta PACS_API_TOKEN)" });
  }

  const resultado = await crearWorklistPortalLink();
  if (!resultado.ok) {
    req.log.warn({ code: resultado.code, msg: resultado.message }, "DiagnostiPACS: fallo enlace worklist portal");
    return res.status(502).json({ error: resultado.message });
  }
  req.log.info({ expiresAt: resultado.data.expiresAt }, "DiagnostiPACS: enlace worklist portal generado");
  return res.json(resultado.data);
});

// ── Webhook: DiagnostiPACS avisa que un estudio quedó informado ────────────
// Autenticación machine-to-machine: Bearer con el mismo PACS_API_TOKEN que
// usamos para hablarle al PACS (comparación en tiempo constante). Procesa al
// instante los turnos de ese DNI que esperaban informe.
router.post("/pacs/webhook/estudio-informado", async (req, res) => {
  const esperado = process.env.PACS_API_TOKEN?.trim();
  if (!esperado) {
    return res.status(503).json({ error: "Integración DiagnostiPACS no configurada" });
  }
  const auth = req.headers.authorization ?? "";
  const recibido = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Token inválido" });
  }

  const parsed = PacsWebhookEstudioInformadoBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido: se requiere dni" });
  }

  const procesados = await procesarTurnosEsperandoInforme(
    req.log,
    parsed.data.dni,
    parsed.data.estudioId,
  );
  req.log.info({ procesados }, "PACS webhook: aviso de estudio informado procesado");
  return res.json({ procesados });
});

export default router;
