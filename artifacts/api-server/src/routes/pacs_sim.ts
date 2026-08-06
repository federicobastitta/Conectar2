import { Router, type IRouter } from "express";
import crypto from "crypto";
import PDFDocument from "pdfkit";
import { getUserFromRequest } from "./auth";
import { firmarWebhook } from "./pacs_worklist";

// ── Simulador de PACS (SOLO desarrollo) ─────────────────────────────────────
// Hace de PACS para probar la integración por worklist sin tocar el PACS
// real (en migración DICOM→S3). Guarda los ítems en memoria, permite
// "firmar" un informe (genera un PDF y dispara el webhook REPORT_SIGNED
// firmado con HMAC hacia el propio api-server) y sirve el PDF firmado.
// Este router NO se monta en producción (ver routes/index.ts).

const router: IRouter = Router();
const ROLES_STAFF = ["admin", "recepcionista", "medico"];

interface SimItem {
  orderId: string;
  accessionNumber: string;
  worklistStatus: string;
  modality: string | null;
  studyDescription: string | null;
  scheduledAt: string | null;
  patient: Record<string, unknown> | null;
  recibidoEn: string;
}

interface SimInforme {
  texto: string;
  firmadoPor: string;
  firmadoEn: string;
  pdf: Buffer;
  sha256: string;
}

const items = new Map<string, SimItem>();
const informes = new Map<string, SimInforme>();

function tokenEsperado(): string | null {
  return (process.env.PACS_WORKLIST_TOKEN ?? process.env.PACS_API_TOKEN)?.trim() || null;
}

function bearerOk(auth: string | undefined): boolean {
  const esperado = tokenEsperado();
  if (!esperado) return false;
  const recibido = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Lado "integración" (lo que Conectar le pega al PACS) ───────────────────

router.post("/pacs-sim/api/v1/integration/worklist", (req, res) => {
  if (!bearerOk(req.headers.authorization)) return res.status(401).json({ error: "Token inválido" });
  const b = req.body ?? {};
  if (!b.order_id || !b.accession_number) {
    return res.status(400).json({ error: "order_id y accession_number son obligatorios" });
  }
  const existente = items.get(String(b.order_id));
  if (existente && existente.accessionNumber !== b.accession_number) {
    return res.status(409).json({ error: "accession_number inmutable para un order_id existente" });
  }
  items.set(String(b.order_id), {
    orderId: String(b.order_id),
    accessionNumber: String(b.accession_number),
    worklistStatus: String(b.worklist_status ?? "scheduled"),
    modality: b.modality ?? null,
    studyDescription: b.study_description ?? null,
    scheduledAt: b.scheduled_at ?? null,
    patient: b.patient ?? null,
    recibidoEn: new Date().toISOString(),
  });
  req.log.info({ orderId: b.order_id, status: b.worklist_status }, "PACS-SIM: ítem de worklist recibido");
  return res.status(existente ? 200 : 201).json({ ok: true });
});

router.delete("/pacs-sim/api/v1/integration/worklist/:orderId", (req, res) => {
  if (!bearerOk(req.headers.authorization)) return res.status(401).json({ error: "Token inválido" });
  const existia = items.delete(req.params.orderId);
  req.log.info({ orderId: req.params.orderId, existia }, "PACS-SIM: ítem de worklist eliminado");
  return res.status(existia ? 200 : 404).json({ ok: existia });
});

router.get("/pacs-sim/api/v1/integration/orders/:orderId/report", (req, res) => {
  if (!bearerOk(req.headers.authorization)) return res.status(401).json({ error: "Token inválido" });
  const informe = informes.get(req.params.orderId);
  if (!informe) return res.status(404).json({ error: "Sin informe firmado para esa orden" });
  return res.json({
    order_id: req.params.orderId,
    report_text: informe.texto,
    signed_by: informe.firmadoPor,
    signed_at: informe.firmadoEn,
    pdf_sha256: informe.sha256,
  });
});

router.get("/pacs-sim/api/v1/integration/orders/:orderId/report/pdf", (req, res) => {
  if (!bearerOk(req.headers.authorization)) return res.status(401).json({ error: "Token inválido" });
  const informe = informes.get(req.params.orderId);
  if (!informe) return res.status(404).json({ error: "Sin informe firmado para esa orden" });
  res.setHeader("Content-Type", "application/pdf");
  return res.send(informe.pdf);
});

// ── Lado "operador del PACS" (UI de prueba para el staff de Conectar) ──────

router.get("/pacs-sim/worklist", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user || !ROLES_STAFF.includes(user.rol)) return res.status(403).json({ error: "Sin permisos" });
  return res.json({
    data: Array.from(items.values()).map((i) => ({ ...i, informeFirmado: informes.has(i.orderId) })),
  });
});

function generarPdf(item: SimItem, texto: string, firmadoPor: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(16).text("PACS SIMULADO — Informe firmado", { align: "center" });
    doc.moveDown();
    doc.fontSize(10).text(`Orden: ${item.orderId}   Accession: ${item.accessionNumber}`);
    doc.text(`Estudio: ${item.studyDescription ?? "-"}   Modalidad: ${item.modality ?? "-"}`);
    const p = item.patient as { nombre?: string; apellido?: string; dni?: string } | null;
    doc.text(`Paciente: ${p?.apellido ?? ""} ${p?.nombre ?? ""} (DNI ${p?.dni ?? "-"})`);
    doc.moveDown();
    doc.fontSize(12).text(texto);
    doc.moveDown(2);
    doc.fontSize(10).text(`Firmado digitalmente por ${firmadoPor} — ${new Date().toISOString()}`);
    doc.end();
  });
}

// El staff simula que el médico del PACS redacta y firma el informe.
router.post("/pacs-sim/worklist/:orderId/firmar", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user || !ROLES_STAFF.includes(user.rol)) return res.status(403).json({ error: "Sin permisos" });

  const item = items.get(req.params.orderId);
  if (!item) return res.status(404).json({ error: "La orden no está en la worklist del simulador" });

  const texto: string =
    (req.body?.texto as string | undefined)?.trim() ||
    `Estudio ${item.studyDescription ?? ""} realizado sin particularidades. Sin hallazgos patológicos significativos. (Informe generado por el PACS simulado.)`;
  const firmadoPor = (req.body?.firmadoPor as string | undefined)?.trim() || "Dra. Simuladora PACS";

  const pdf = await generarPdf(item, texto, firmadoPor);
  const sha256 = crypto.createHash("sha256").update(pdf).digest("hex");
  const firmadoEn = new Date().toISOString();
  informes.set(item.orderId, { texto, firmadoPor, firmadoEn, pdf, sha256 });

  // Dispara el webhook REPORT_SIGNED contra el propio api-server, firmado HMAC.
  const secret = process.env.PACS_WEBHOOK_SECRET?.trim() || "dev-pacs-webhook-secret";
  const evento = {
    event_id: `sim-${item.orderId}-${Date.now()}`,
    event_type: "REPORT_SIGNED",
    order_id: item.orderId,
    accession_number: item.accessionNumber,
    study_instance_uid: `1.2.826.0.1.${item.orderId}.${Date.now()}`,
    signed_by: firmadoPor,
    signed_at: firmadoEn,
    pdf_sha256: sha256,
    report_text: texto,
  };
  const rawBody = JSON.stringify(evento);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const puerto = process.env.PORT ?? "8080";
  let webhook: { status: number; body: unknown };
  try {
    const r = await fetch(`http://127.0.0.1:${puerto}/api/pacs/worklist/webhook/eventos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pacs-Timestamp": timestamp,
        "X-Pacs-Signature": firmarWebhook(timestamp, rawBody, secret),
      },
      body: rawBody,
      signal: AbortSignal.timeout(60_000),
    });
    webhook = { status: r.status, body: await r.json().catch(() => null) };
  } catch (err) {
    webhook = { status: 0, body: { error: String(err) } };
  }

  req.log.info({ orderId: item.orderId, webhookStatus: webhook.status }, "PACS-SIM: informe firmado y webhook enviado");
  return res.json({ ok: true, pdfSha256: sha256, webhook });
});

export default router;
