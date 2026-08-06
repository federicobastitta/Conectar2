import { Router, type IRouter, type Request } from "express";
import crypto from "crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  turnosTable,
  pacientesTable,
  pacsWorklistItemsTable,
  pacsInformesFirmadosTable,
  pacsEventosTable,
} from "@workspace/db";
import { getUserFromRequest, requireRol } from "./auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { pacsWorklistHabilitado, sincronizarWorklistTurno } from "../integraciones/pacs-worklist";

// ── Worklist PACS v3: webhook de eventos + consultas para el staff ─────────
// El PACS firma los informes y avisa por webhook (REPORT_SIGNED). Conectar
// descarga el PDF firmado, verifica su sha256, lo archiva como copia
// inmutable en el object storage privado y pasa el turno a "informado".

const router: IRouter = Router();
const ROLES_STAFF = ["admin", "recepcionista", "medico"];

function webhookSecret(): string | null {
  const s = process.env.PACS_WEBHOOK_SECRET?.trim();
  if (s) return s;
  // Solo para desarrollo local con el simulador; en producción es obligatorio.
  if (process.env.NODE_ENV !== "production") return "dev-pacs-webhook-secret";
  return null;
}

export function firmarWebhook(timestamp: string, rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

const TOLERANCIA_SEG = 300;

const EventoBody = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  order_id: z.string().min(1),
  accession_number: z.string().optional().nullable(),
  study_instance_uid: z.string().optional().nullable(),
  signed_by: z.string().optional().nullable(),
  signed_at: z.string().optional().nullable(),
  pdf_sha256: z.string().optional().nullable(),
  report_text: z.string().optional().nullable(),
});

function pacsBase(): string | null {
  const b = process.env.PACS_WORKLIST_URL?.trim();
  return b ? b.replace(/\/$/, "") : null;
}

function pacsToken(): string | null {
  return (process.env.PACS_WORKLIST_TOKEN ?? process.env.PACS_API_TOKEN)?.trim() || null;
}

async function descargarPdfFirmado(orderId: string): Promise<Buffer> {
  const base = pacsBase();
  const t = pacsToken();
  if (!base || !t) throw new Error("PACS worklist no configurado (URL/token)");
  const res = await fetch(`${base}/api/v1/integration/orders/${encodeURIComponent(orderId)}/report/pdf`, {
    headers: { Authorization: `Bearer ${t}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`PACS devolvió HTTP ${res.status} al pedir el PDF firmado`);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/pdf")) throw new Error(`El PACS no devolvió un PDF (${ct || "sin content-type"})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    throw new Error("El contenido descargado no tiene firma de PDF válida");
  }
  return buf;
}

// ── POST /pacs/webhook/eventos ──────────────────────────────────────────────
router.post("/pacs/worklist/webhook/eventos", async (req, res) => {
  const secret = webhookSecret();
  if (!secret) return res.status(503).json({ error: "Webhook PACS no configurado (falta PACS_WEBHOOK_SECRET)" });
  if (!pacsWorklistHabilitado()) {
    return res.status(503).json({ error: "Integración worklist PACS deshabilitada" });
  }

  const rawBody = (req as Request & { rawBody?: string }).rawBody;
  const timestamp = String(req.headers["x-pacs-timestamp"] ?? "");
  const firma = String(req.headers["x-pacs-signature"] ?? "");
  if (!rawBody || !timestamp || !firma) {
    return res.status(401).json({ error: "Faltan cabeceras de firma del webhook" });
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCIA_SEG) {
    return res.status(401).json({ error: "Timestamp del webhook fuera de ventana (anti-replay)" });
  }
  const esperada = firmarWebhook(timestamp, rawBody, secret);
  const a = Buffer.from(firma, "utf8");
  const b = Buffer.from(esperada, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Firma del webhook inválida" });
  }

  const parsed = EventoBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Body del evento inválido" });
  const ev = parsed.data;

  // Idempotencia por event_id, robusta ante entregas concurrentes: se toma un
  // advisory lock transaccional atado al event_id, y recién con el lock tomado
  // se decide si el evento ya fue procesado. Dos entregas simultáneas del mismo
  // evento se serializan y la segunda ve procesado_en y responde "duplicado".
  const claim = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"pacs_evento:" + ev.event_id}))`);
    const [existente] = await tx
      .select()
      .from(pacsEventosTable)
      .where(eq(pacsEventosTable.eventId, ev.event_id))
      .limit(1);
    if (existente?.procesadoEn) return "duplicado" as const;
    if (!existente) {
      await tx
        .insert(pacsEventosTable)
        .values({
          eventId: ev.event_id,
          eventType: ev.event_type,
          orderId: ev.order_id,
          studyInstanceUid: ev.study_instance_uid ?? null,
          ocurridoEn: ev.signed_at ? new Date(ev.signed_at) : null,
          payload: ev,
        })
        .onConflictDoNothing({ target: pacsEventosTable.eventId });
    }
    return "propio" as const;
  });
  if (claim === "duplicado") {
    return res.json({ ok: true, duplicado: true });
  }

  if (ev.event_type !== "REPORT_SIGNED") {
    // Otros eventos: se registran y se dan por procesados (por ahora no hay acción).
    await db
      .update(pacsEventosTable)
      .set({ procesadoEn: new Date(), error: null })
      .where(eq(pacsEventosTable.eventId, ev.event_id));
    return res.json({ ok: true, accion: "registrado" });
  }

  try {
    const turnoId = Number(ev.order_id);
    if (!Number.isInteger(turnoId) || turnoId <= 0) throw new Error(`order_id inválido: ${ev.order_id}`);

    const [item] = await db
      .select()
      .from(pacsWorklistItemsTable)
      .where(eq(pacsWorklistItemsTable.turnoId, turnoId))
      .limit(1);
    if (!item) throw new Error(`No hay ítem de worklist para el turno ${turnoId}`);

    const pdf = await descargarPdfFirmado(ev.order_id);
    const sha = crypto.createHash("sha256").update(pdf).digest("hex");
    if (ev.pdf_sha256 && sha !== ev.pdf_sha256.toLowerCase()) {
      throw new Error("El sha256 del PDF descargado no coincide con el declarado por el PACS");
    }

    const storage = new ObjectStorageService();
    const pdfPath = await storage.uploadPrivateBuffer(pdf, "application/pdf");

    // Escrituras en una única transacción serializada por el mismo advisory
    // lock del claim: si dos entregas del mismo evento llegan a la vez, la
    // segunda espera acá, ve procesado_en y no duplica el archivado.
    const informe = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"pacs_evento:" + ev.event_id}))`);
      const [evento] = await tx
        .select()
        .from(pacsEventosTable)
        .where(eq(pacsEventosTable.eventId, ev.event_id))
        .limit(1);
      if (evento?.procesadoEn) return null;

      const [{ maxVersion }] = await tx
        .select({ maxVersion: sql<number>`COALESCE(MAX(${pacsInformesFirmadosTable.version}), 0)` })
        .from(pacsInformesFirmadosTable)
        .where(eq(pacsInformesFirmadosTable.turnoId, turnoId));

      const [creado] = await tx
        .insert(pacsInformesFirmadosTable)
        .values({
          turnoId,
          worklistItemId: item.id,
          orderId: ev.order_id,
          accessionNumber: ev.accession_number ?? item.accessionNumber,
          studyInstanceUid: ev.study_instance_uid ?? null,
          version: Number(maxVersion) + 1,
          texto: ev.report_text ?? null,
          firmadoPorNombre: ev.signed_by ?? null,
          firmadoEn: ev.signed_at ? new Date(ev.signed_at) : new Date(),
          pdfPath,
          pdfSha256: sha,
        })
        .returning();

      // El turno pasa a "informado" (transición que en v3 solo produce el PACS).
      await tx
        .update(turnosTable)
        .set({
          estado: "informado",
          pacsEstudioId: ev.study_instance_uid ?? item.accessionNumber,
          pacsInformadoEn: new Date(),
        })
        .where(
          and(
            eq(turnosTable.id, turnoId),
            inArray(turnosTable.estado, ["pendiente", "confirmado", "visto", "en_atencion", "pendiente_informe", "informando", "arribo", "en_sala", "llamado"]),
          ),
        );

      await tx
        .update(pacsEventosTable)
        .set({ procesadoEn: new Date(), error: null })
        .where(eq(pacsEventosTable.eventId, ev.event_id));

      return creado;
    });

    if (!informe) {
      return res.json({ ok: true, duplicado: true });
    }

    req.log.info(
      { turnoId, orderId: ev.order_id, informeId: informe.id, version: informe.version },
      "PACS worklist: informe firmado archivado, turno informado",
    );
    return res.json({ ok: true, informeId: informe.id, version: informe.version });
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    // Se registra el error y NO se marca procesado: el PACS puede reintentar
    // con el mismo event_id y el evento se vuelve a procesar.
    await db
      .update(pacsEventosTable)
      .set({ error: mensaje })
      .where(eq(pacsEventosTable.eventId, ev.event_id));
    req.log.error({ err, eventId: ev.event_id }, "PACS worklist: error procesando REPORT_SIGNED");
    return res.status(502).json({ error: mensaje });
  }
});

// ── POST /pacs/worklist/resync/:turnoId (admin): reenvío manual forzado ────
// Resetea el ítem de worklist a "pendiente" (forzarReenvio) y dispara el
// despachador de inmediato. Sirve para turnos históricos que quedaron sin
// orden o cuyo ítem quedó en estado de error con backoff activo.
router.post("/pacs/worklist/resync/:turnoId", requireRol("admin"), async (req, res) => {
  if (!pacsWorklistHabilitado()) {
    return res.status(503).json({ error: "Integración worklist PACS deshabilitada" });
  }

  const turnoId = Number(req.params.turnoId);
  if (!Number.isInteger(turnoId) || turnoId <= 0) {
    return res.status(400).json({ error: "turnoId inválido" });
  }

  await sincronizarWorklistTurno(turnoId, req.log, { forzarReenvio: true });

  // Confirmar estado resultante
  const [item] = await db
    .select()
    .from(pacsWorklistItemsTable)
    .where(eq(pacsWorklistItemsTable.turnoId, turnoId))
    .limit(1);

  if (!item) {
    // El turno no existe, no está configurado para PACS o está en estado final.
    return res.status(404).json({ error: "Turno no encontrado o no configurado para PACS worklist" });
  }

  req.log.info({ turnoId, estadoEnvio: item.estadoEnvio }, "PACS worklist: resync manual solicitado");

  return res.json({
    ok: true,
    turnoId,
    worklistItemId: item.id,
    worklistStatus: item.worklistStatus,
    estadoEnvio: item.estadoEnvio,
    intentos: item.intentos,
    proximoIntentoEn: item.proximoIntentoEn ?? null,
  });
});

// ── GET /pacs/worklist (staff): estado de la cola/worklist ─────────────────
router.get("/pacs/worklist", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (!ROLES_STAFF.includes(user.rol)) return res.status(403).json({ error: "Sin permisos" });

  const items = await db
    .select({
      item: pacsWorklistItemsTable,
      turno: turnosTable,
      paciente: pacientesTable,
    })
    .from(pacsWorklistItemsTable)
    .innerJoin(turnosTable, eq(pacsWorklistItemsTable.turnoId, turnosTable.id))
    .innerJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .orderBy(desc(pacsWorklistItemsTable.updatedAt))
    .limit(200);

  const turnoIds = items.map((i) => i.item.turnoId).filter((id): id is number => id != null);
  const informes = turnoIds.length
    ? await db
        .select()
        .from(pacsInformesFirmadosTable)
        .where(inArray(pacsInformesFirmadosTable.turnoId, turnoIds))
    : [];
  const informesPorTurno = new Map<number, typeof informes>();
  for (const inf of informes) {
    const arr = informesPorTurno.get(inf.turnoId) ?? [];
    arr.push(inf);
    informesPorTurno.set(inf.turnoId, arr);
  }

  return res.json({
    habilitado: pacsWorklistHabilitado(),
    data: items.map(({ item, turno, paciente }) => ({
      id: item.id,
      turnoId: item.turnoId,
      orderId: item.orderId,
      accessionNumber: item.accessionNumber,
      modalidad: item.modalidad,
      descripcionEstudio: item.descripcionEstudio,
      worklistStatus: item.worklistStatus,
      estadoEnvio: item.estadoEnvio,
      intentos: item.intentos,
      ultimoError: item.ultimoError,
      publicadoEn: item.publicadoEn,
      fecha: turno.fecha,
      horaInicio: turno.horaInicio,
      estadoTurno: turno.estado,
      paciente: { id: paciente.id, nombre: paciente.nombre, apellido: paciente.apellido, dni: paciente.dni },
      informes: (item.turnoId != null ? informesPorTurno.get(item.turnoId) ?? [] : [])
        .sort((a, b) => b.version - a.version)
        .map((inf) => ({
          id: inf.id,
          version: inf.version,
          firmadoPorNombre: inf.firmadoPorNombre,
          firmadoEn: inf.firmadoEn,
          pdfSha256: inf.pdfSha256,
        })),
    })),
  });
});

// ── GET /pacs/informes-firmados/:turnoId/pdf (staff): PDF archivado ────────
router.get("/pacs/informes-firmados/:turnoId/pdf", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (!ROLES_STAFF.includes(user.rol)) return res.status(403).json({ error: "Sin permisos" });

  const turnoId = Number(req.params.turnoId);
  if (!Number.isInteger(turnoId) || turnoId <= 0) return res.status(400).json({ error: "turnoId inválido" });

  const [informe] = await db
    .select()
    .from(pacsInformesFirmadosTable)
    .where(eq(pacsInformesFirmadosTable.turnoId, turnoId))
    .orderBy(desc(pacsInformesFirmadosTable.version))
    .limit(1);
  if (!informe) return res.status(404).json({ error: "No hay informe firmado archivado para ese turno" });

  try {
    const storage = new ObjectStorageService();
    const file = await storage.getObjectEntityFile(informe.pdfPath);
    const respuesta = await storage.downloadObject(file, 0);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="informe-turno-${turnoId}-v${informe.version}.pdf"`);
    const body = Buffer.from(await respuesta.arrayBuffer());
    return res.send(body);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return res.status(404).json({ error: "PDF no encontrado en el archivo" });
    throw err;
  }
});

export default router;
