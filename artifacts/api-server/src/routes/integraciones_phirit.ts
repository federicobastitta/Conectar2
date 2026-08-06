import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  pacientesTable,
  estudiosExternosTable,
  notificacionesSalientesTable,
  auditLogTable,
  type EstudioExterno,
} from "@workspace/db";
import { SyncPhiritEstudioBody, ListEstudiosExternosQueryParams } from "@workspace/api-zod";
import { getUserIdFromToken } from "./auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";

const router: IRouter = Router();

// ── Integración Phir-it ────────────────────────────────────────────────────
// Phir-it es la fuente de verdad de estudios e informes. Conectar NO actúa
// como PACS: solo consume el estado (pendiente | informado), lo vincula a la
// ficha del paciente y dispara la comunicación por WhatsApp al pasar a
// "informado" (una sola vez por estudio).

const PORTAL_URL = "https://diagnosticar-clinic-portal.replit.app/";
// Template de Whaticket a usar cuando se conecte el proveedor real
const WHATICKET_TEMPLATE = "informe_disponible";

// Envío de WhatsApp a pacientes: apagado por defecto. Para habilitarlo,
// setear NOTIFICACIONES_WHATSAPP_ENABLED=true. Mientras está apagado, el
// circuito de estados sigue funcionando (dedupe incluido) pero NO se envían
// mensajes al paciente.
function whatsappHabilitado(): boolean {
  return process.env.NOTIFICACIONES_WHATSAPP_ENABLED?.trim() === "true";
}

type AuthUser = {
  id: number;
  email: string;
  rol: string;
  pacienteId: number | null;
};

async function getUser(req: Request): Promise<AuthUser | null> {
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
    pacienteId: user.pacienteId ? parseInt(user.pacienteId) : null,
  };
}

async function registrarAuditoria(
  actor: { id: number | null; email: string; rol: string },
  accion: string,
  entidadId: number | null,
  pacienteId: number | null,
  detalle: unknown,
): Promise<void> {
  await db.insert(auditLogTable).values({
    usuarioId: actor.id,
    usuarioEmail: actor.email,
    rol: actor.rol,
    accion,
    entidad: "estudio_externo",
    entidadId,
    pacienteId,
    detalle,
  });
}

function mensajeInformeDisponible(nombrePaciente: string): string {
  return (
    `Hola ${nombrePaciente}, tu informe ya se encuentra disponible en Mi Diagnosticar.\n\n` +
    `Podés ingresar desde el siguiente enlace:\n\n${PORTAL_URL}\n\n` +
    `Si tenés alguna duda, comunicate con Diagnosticar.`
  );
}

// Registra el WhatsApp saliente. Sin proveedor configurado queda "simulada"
// (auditada y lista para conectar Whaticket con el template indicado).
// Exportada: también la usa el circuito de informes de DiagnostiPACS.
export async function enviarWhatsAppInforme(
  paciente: {
    id: number;
    nombre: string;
    telefono: string | null;
  },
  evento = "informe_disponible_phirit",
): Promise<{ notificacionId: number; estadoEntrega: string }> {
  const destinatario = paciente.telefono ?? null;
  const tieneProveedor = Boolean(process.env.WHATSAPP_API_TOKEN);
  let estadoEntrega = "simulada";
  let errorDetalle: string | null = null;
  if (tieneProveedor) {
    estadoEntrega = destinatario ? "enviada" : "fallida";
    if (!destinatario) errorDetalle = "El paciente no tiene teléfono registrado";
  } else if (!destinatario) {
    errorDetalle = "El paciente no tiene teléfono registrado";
  }
  const [notif] = await db
    .insert(notificacionesSalientesTable)
    .values({
      patientId: paciente.id,
      solicitudId: null,
      canal: "whatsapp",
      evento,
      destinatario,
      contenido: mensajeInformeDisponible(paciente.nombre),
      estadoEntrega,
      errorDetalle,
      template: WHATICKET_TEMPLATE,
      usuarioOrigenId: null,
    })
    .returning();
  return { notificacionId: notif.id, estadoEntrega };
}

function serializarEstudio(
  e: EstudioExterno,
  extra?: { pacienteNombre?: string | null; notificacionEstado?: string | null },
) {
  return {
    id: e.id,
    origen: e.origen,
    externalId: e.externalId,
    patientId: e.patientId,
    pacienteNombre: extra?.pacienteNombre ?? null,
    descripcion: e.descripcion,
    estado: e.estado,
    informeUrl: e.informeUrl,
    estadoCambiadoEn: e.estadoCambiadoEn?.toISOString() ?? null,
    informadoEn: e.informadoEn?.toISOString() ?? null,
    notificadoEn: e.notificadoEn?.toISOString() ?? null,
    notificacionId: e.notificacionId,
    notificacionEstado: extra?.notificacionEstado ?? null,
    tieneInformePdf: Boolean(e.informePdfPath),
    informePdfEn: e.informePdfEn?.toISOString() ?? null,
    createdAt: e.createdAt,
  };
}

// ── Lógica central reutilizable ────────────────────────────────────────────
// Usada tanto por el webhook (Phir-it → nosotros) como por el robot de sondeo
// (nosotros consultamos el portal de Phir-it). Hace el upsert idempotente del
// estudio y, al pasar a "informado", dispara el WhatsApp UNA sola vez por
// estudio (dedupe atómico). Devuelve un resultado discriminado (sin lanzar
// excepciones para el control de flujo).

export type PhiritActor = { id: number | null; email: string; rol: string };

export interface ProcesarEstudioInput {
  externalId: string;
  estado: string;
  patientId?: number | null;
  pacienteDni?: string | null;
  descripcion?: string | null;
  informeUrl?: string | null;
  fechaCambio?: Date | string | null;
}

type ProcesarLogger = { info: (obj: unknown, msg?: string) => void };

export type ProcesarEstudioResult =
  | { ok: false; code: "SIN_IDENTIFICADOR" | "PACIENTE_NO_ENCONTRADO" | "FECHA_INVALIDA"; message: string }
  | {
      ok: true;
      estudio: EstudioExterno;
      paciente: { id: number; nombre: string; apellido: string; telefono: string | null };
      notificacionDisparada: boolean;
      notificacionEstado: string | null;
    };

export async function procesarEstudioPhirit(
  actor: PhiritActor,
  input: ProcesarEstudioInput,
  log: ProcesarLogger,
): Promise<ProcesarEstudioResult> {
  // Resolver paciente: por patientId o por DNI
  let paciente: { id: number; nombre: string; apellido: string; telefono: string | null } | null = null;
  if (input.patientId) {
    const [p] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, input.patientId)).limit(1);
    paciente = p ?? null;
  } else if (input.pacienteDni) {
    const [p] = await db.select().from(pacientesTable).where(eq(pacientesTable.dni, input.pacienteDni)).limit(1);
    paciente = p ?? null;
  } else {
    return { ok: false, code: "SIN_IDENTIFICADOR", message: "Debe indicar patientId o pacienteDni" };
  }
  if (!paciente) {
    return { ok: false, code: "PACIENTE_NO_ENCONTRADO", message: "Paciente no encontrado en Conectar" };
  }

  const fechaCambio = input.fechaCambio ? new Date(input.fechaCambio) : new Date();
  if (isNaN(fechaCambio.getTime())) {
    return { ok: false, code: "FECHA_INVALIDA", message: "fechaCambio inválida" };
  }

  // Estado previo (solo informativo, para la auditoría)
  const [previo] = await db
    .select({ estado: estudiosExternosTable.estado })
    .from(estudiosExternosTable)
    .where(and(eq(estudiosExternosTable.origen, "phirit"), eq(estudiosExternosTable.externalId, input.externalId)))
    .limit(1);

  // Upsert atómico por (origen, externalId): seguro ante llamadas concurrentes
  const [estudio0] = await db
    .insert(estudiosExternosTable)
    .values({
      origen: "phirit",
      externalId: input.externalId,
      patientId: paciente.id,
      descripcion: input.descripcion ?? null,
      estado: input.estado,
      informeUrl: input.informeUrl ?? null,
      estadoCambiadoEn: fechaCambio,
      informadoEn: input.estado === "informado" ? fechaCambio : null,
    })
    .onConflictDoUpdate({
      target: [estudiosExternosTable.origen, estudiosExternosTable.externalId],
      set: {
        patientId: paciente.id,
        estado: input.estado,
        descripcion: sql`COALESCE(EXCLUDED.descripcion, ${estudiosExternosTable.descripcion})`,
        informeUrl: sql`COALESCE(EXCLUDED.informe_url, ${estudiosExternosTable.informeUrl})`,
        estadoCambiadoEn: fechaCambio,
        // Se conserva la primera fecha de informado; se setea solo al transicionar
        informadoEn: sql`CASE WHEN EXCLUDED.estado = 'informado' AND ${estudiosExternosTable.informadoEn} IS NULL THEN EXCLUDED.informado_en ELSE ${estudiosExternosTable.informadoEn} END`,
        updatedAt: new Date(),
      },
    })
    .returning();
  let estudio: EstudioExterno = estudio0;

  await registrarAuditoria(actor, "sync_phirit", estudio.id, paciente.id, {
    externalId: input.externalId,
    estadoAnterior: previo?.estado ?? null,
    estadoNuevo: input.estado,
    fechaCambio: fechaCambio.toISOString(),
  });

  // WhatsApp solo al pasar a "informado" y una sola vez por estudio.
  // Dedupe atómico: solo el request que "gana" el UPDATE condicional
  // (notificado_en IS NULL) registra y dispara la notificación.
  let notificacionDisparada = false;
  let notificacionEstado: string | null = null;
  if (input.estado === "informado") {
    const [claim] = await db
      .update(estudiosExternosTable)
      .set({ notificadoEn: new Date(), updatedAt: new Date() })
      .where(and(eq(estudiosExternosTable.id, estudio.id), isNull(estudiosExternosTable.notificadoEn)))
      .returning();
    if (claim && whatsappHabilitado()) {
      const notif = await enviarWhatsAppInforme({
        id: paciente.id,
        nombre: paciente.nombre,
        telefono: paciente.telefono,
      });
      const [conNotif] = await db
        .update(estudiosExternosTable)
        .set({ notificacionId: notif.notificacionId, updatedAt: new Date() })
        .where(eq(estudiosExternosTable.id, estudio.id))
        .returning();
      estudio = conNotif;
      notificacionDisparada = true;
      notificacionEstado = notif.estadoEntrega;
      await registrarAuditoria(actor, "notificacion_informe_phirit", estudio.id, paciente.id, {
        externalId: input.externalId,
        notificacionId: notif.notificacionId,
        estadoEntrega: notif.estadoEntrega,
        template: WHATICKET_TEMPLATE,
      });
      log.info(
        { estudioId: estudio.id, patientId: paciente.id, estadoEntrega: notif.estadoEntrega },
        "Phir-it: informe disponible, WhatsApp registrado",
      );
    } else if (claim) {
      // WhatsApp deshabilitado: marcamos el estudio como notificado (dedupe)
      // para que el poller no lo reprocese, pero NO enviamos mensaje al paciente.
      log.info(
        { estudioId: estudio.id, patientId: paciente.id },
        "Phir-it: informe disponible, WhatsApp DESHABILITADO (no se envía)",
      );
    } else {
      // Otra llamada ya notificó este estudio: refrescamos para responder consistente
      const [actual] = await db
        .select()
        .from(estudiosExternosTable)
        .where(eq(estudiosExternosTable.id, estudio.id))
        .limit(1);
      if (actual) estudio = actual;
    }
  }

  return { ok: true, estudio, paciente, notificacionDisparada, notificacionEstado };
}

// ── Webhook: Phir-it notifica el estado de un estudio ─────────────────────
// Auth: header X-Phirit-Token (env PHIRIT_WEBHOOK_TOKEN) para llamadas
// máquina-a-máquina, o Bearer de admin para pruebas/carga manual.
router.post("/integraciones/phirit/estudios", async (req, res) => {
  const tokenHeader = req.headers["x-phirit-token"];
  const tokenEsperado = process.env.PHIRIT_WEBHOOK_TOKEN;
  let actor: { id: number | null; email: string; rol: string } | null = null;
  if (tokenEsperado && typeof tokenHeader === "string" && tokenHeader === tokenEsperado) {
    actor = { id: null, email: "phirit-webhook", rol: "sistema" };
  } else {
    const user = await getUser(req);
    if (user && user.rol === "admin") {
      actor = { id: user.id, email: user.email, rol: user.rol };
    }
  }
  if (!actor) {
    return res.status(401).json({ error: "No autorizado: se requiere X-Phirit-Token válido o sesión de admin" });
  }

  const parsed = SyncPhiritEstudioBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Datos inválidos", detalles: parsed.error.issues });
  }
  const body = parsed.data;

  const resultado = await procesarEstudioPhirit(
    actor,
    {
      externalId: body.externalId,
      estado: body.estado,
      patientId: body.patientId ?? null,
      pacienteDni: body.pacienteDni ?? null,
      descripcion: body.descripcion ?? null,
      informeUrl: body.informeUrl ?? null,
      fechaCambio: body.fechaCambio ?? null,
    },
    req.log,
  );

  if (!resultado.ok) {
    const status =
      resultado.code === "PACIENTE_NO_ENCONTRADO" ? 404 : 400;
    return res.status(status).json({ error: resultado.message });
  }

  return res.json({
    estudio: serializarEstudio(resultado.estudio, {
      pacienteNombre: `${resultado.paciente.apellido}, ${resultado.paciente.nombre}`,
      notificacionEstado: resultado.notificacionEstado,
    }),
    notificacionDisparada: resultado.notificacionDisparada,
  });
});

// ── Listado: médicos/staff ven estudios por paciente; paciente solo los suyos ─
router.get("/integraciones/phirit/estudios", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });

  const parsed = ListEstudiosExternosQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Parámetros inválidos" });
  }
  let { patientId, estado } = parsed.data;

  if (user.rol === "paciente") {
    // Paciente sin ficha vinculada: lista vacía (no error ni datos ajenos),
    // consistente con /turnos/mis-turnos y /sala-espera/mi-posicion
    if (!user.pacienteId) return res.json([]);
    patientId = user.pacienteId;
  } else if (!["admin", "medico", "recepcionista"].includes(user.rol)) {
    return res.status(403).json({ error: "Rol sin permisos" });
  }

  const condiciones = [eq(estudiosExternosTable.origen, "phirit")];
  if (patientId) condiciones.push(eq(estudiosExternosTable.patientId, patientId));
  if (estado) condiciones.push(eq(estudiosExternosTable.estado, estado));

  const rows = await db
    .select({
      e: estudiosExternosTable,
      pacienteNombre: sql<string | null>`${pacientesTable.apellido} || ', ' || ${pacientesTable.nombre}`,
      notificacionEstado: notificacionesSalientesTable.estadoEntrega,
    })
    .from(estudiosExternosTable)
    .leftJoin(pacientesTable, eq(estudiosExternosTable.patientId, pacientesTable.id))
    .leftJoin(notificacionesSalientesTable, eq(estudiosExternosTable.notificacionId, notificacionesSalientesTable.id))
    .where(and(...condiciones))
    .orderBy(desc(estudiosExternosTable.updatedAt));

  return res.json(
    rows.map((r) =>
      serializarEstudio(r.e, { pacienteNombre: r.pacienteNombre, notificacionEstado: r.notificacionEstado }),
    ),
  );
});

// ── Descarga del PDF del informe guardado en la nube ──────────────────────
// Staff (admin/medico/recepcionista) puede bajar cualquiera; el paciente solo
// los de su propia ficha. El archivo sale con el apellido del paciente.
router.get("/integraciones/phirit/estudios/:id/informe-pdf", async (req: Request, res: Response): Promise<void | Response> => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });

  const id = parseInt(String(req.params.id));
  if (isNaN(id)) return res.status(400).json({ error: "id inválido" });

  const [estudio] = await db.select().from(estudiosExternosTable).where(eq(estudiosExternosTable.id, id)).limit(1);
  if (!estudio || estudio.origen !== "phirit") return res.status(404).json({ error: "Estudio no encontrado" });

  const esStaff = ["admin", "medico", "recepcionista"].includes(user.rol);
  const esDuenio = user.rol === "paciente" && user.pacienteId != null && user.pacienteId === estudio.patientId;
  if (!esStaff && !esDuenio) return res.status(403).json({ error: "Sin permisos para este informe" });

  if (!estudio.informePdfPath) {
    return res.status(404).json({ error: "El informe todavía no fue descargado a la nube" });
  }

  const [paciente] = await db
    .select({ apellido: pacientesTable.apellido })
    .from(pacientesTable)
    .where(eq(pacientesTable.id, estudio.patientId))
    .limit(1);
  const apellido = (paciente?.apellido ?? "informe")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .toUpperCase();

  try {
    const storage = new ObjectStorageService();
    const file = await storage.getObjectEntityFile(estudio.informePdfPath);
    const [meta] = await file.getMetadata();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${apellido}.pdf"`);
    if (meta.size) res.setHeader("Content-Length", String(meta.size));
    await registrarAuditoria(
      { id: user.id, email: user.email, rol: user.rol },
      "descargar_informe_pdf_phirit",
      estudio.id,
      estudio.patientId,
      { externalId: estudio.externalId },
    );
    file.createReadStream().on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "Error leyendo el archivo" });
      else res.end();
    }).pipe(res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return res.status(404).json({ error: "El archivo del informe no está disponible" });
    }
    req.log.error({ err, estudioId: estudio.id }, "Phir-it: error sirviendo el PDF del informe");
    return res.status(500).json({ error: "Error interno" });
  }
});

export default router;
