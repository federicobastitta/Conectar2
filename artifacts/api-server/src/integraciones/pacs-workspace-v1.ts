import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger as _logger } from "../lib/logger";
import { pixelEnvioActivo } from "./pixel-guard";

// ── Integración DiagnosticPACS v1.0 (contrato CONGELADO) ────────────────────
// Todo este módulo es INERTE mientras PACS_WORKSPACE_ENABLED !== "true".
// Nunca se llama al PACS con el flag apagado; los endpoints de Conectar que
// dependen de este módulo responden 404 (ver routes/pacs_workspace.ts).
// Contrato: DiagnosticPACS v1.0 (congelado). Ver docs/pacs-aprobacion-v1.0.md.

export function pacsWorkspaceHabilitado(): boolean {
  return process.env.PACS_WORKSPACE_ENABLED === "true";
}

const BASE_URL = () =>
  (process.env.PACS_INTEGRATION_BASE_URL ??
    process.env.DIAGNOSTIPACS_BASE_URL ??
    "https://medical-vision-ai.replit.app").replace(/\/$/, "") + "/api/v1/integration";

function serviceToken(): string | null {
  return (
    process.env.CONECTAR_INTEGRATION_TOKEN?.trim() ||
    process.env.PACS_INTEGRATION_TOKEN?.trim() ||
    process.env.PACS_API_TOKEN?.trim() ||
    null
  );
}

export function pacsV1Configurado(): boolean {
  return Boolean(serviceToken());
}

export type PacsV1Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: "SIN_CONFIG" | "HTTP" | "RESPUESTA" | "CONFLICTO" | "INVALIDO"; message: string };

async function pacsV1Fetch<T>(
  path: string,
  init?: RequestInit & { idempotencyKey?: string },
): Promise<PacsV1Result<T>> {
  const t = serviceToken();
  if (!t) return { ok: false, status: 0, code: "SIN_CONFIG", message: "Falta PACS_INTEGRATION_TOKEN/PACS_API_TOKEN" };
  // Guard: solicitudes que mutan datos (no-GET) solo salen en producción.
  // Los GETs de lectura siguen pasando en dev (útiles para debug, no contaminan).
  const method = ((init?.method as string | undefined) ?? "GET").toUpperCase();
  if (method !== "GET" && !pixelEnvioActivo()) {
    _logger.info({ operacion: path, method }, "Pixel: envío omitido en entorno no-producción");
    return { ok: false, status: 0, code: "SIN_CONFIG", message: `Pixel: envío omitido en entorno no-producción (${method} ${path})` };
  }
  let res: Response;
  try {
    res = await fetch(`${BASE_URL()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        ...(init?.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, status: 0, code: "HTTP", message: `No se pudo contactar DiagnosticPACS: ${String(err)}` };
  }
  if (!res.ok) {
    const code = res.status === 409 ? "CONFLICTO" : res.status === 422 ? "INVALIDO" : "HTTP";
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      detail = body.detail ?? body.error ?? "";
    } catch {
      /* sin body JSON */
    }
    return { ok: false, status: res.status, code, message: `DiagnosticPACS HTTP ${res.status} en ${path}${detail ? `: ${detail}` : ""}` };
  }
  if (res.status === 204) return { ok: true, status: 204, data: undefined as T };
  try {
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: res.status, code: "RESPUESTA", message: `Respuesta no-JSON de DiagnosticPACS en ${path}` };
  }
}

// ── CM-1: accession number por secuencia propia ─────────────────────────────
// Formato C{AA}-{12 dígitos} (16 caracteres exactos), único, inmutable, opaco.
export function formatearAccession(anioDosDigitos: string, seq: number): string {
  const num = String(seq).padStart(12, "0");
  if (num.length > 12) throw new Error(`Secuencia de accession desbordada: ${seq}`);
  return `C${anioDosDigitos}-${num}`;
}

export async function generarAccessionNumber(): Promise<string> {
  const resultado = await db.execute(sql`SELECT nextval('pacs_accession_seq') AS nextval`);
  const fila = (resultado.rows?.[0] ?? {}) as { nextval?: string | number };
  const seq = Number(fila.nextval);
  if (!Number.isFinite(seq)) throw new Error("No se pudo obtener la secuencia pacs_accession_seq");
  const anio = String(new Date().getFullYear() % 100).padStart(2, "0");
  return formatearAccession(anio, seq);
}

export const ACCESSION_REGEX = /^C[0-9]{2}-[0-9]{12}$/;

// ── Órdenes (CM-2: inmutables order_id/accession/patient) ───────────────────
export interface PacsOrderUpsert {
  order_id: string;
  accession_number: string;
  // ID único del paciente en Conectar (uno distinto por persona)
  conectar_patient_id: string;
  // DNI real del paciente, solo números sin puntos — el PACS lo usa para
  // vincular el estudio al paciente correcto (pedido del equipo PACS jul 2026)
  external_patient_id: string;
  // Teléfono del paciente (opcional, para avisos por WhatsApp del PACS)
  patient_phone?: string | null;
  // Nombre y apellido tal como deben verse en la lista de trabajo del equipo
  patient_first_name?: string | null;
  patient_last_name?: string | null;
  // Fecha de nacimiento (YYYY-MM-DD) y sexo (M/F/O) — recomendados por la
  // especificación jul 2026: los equipos los usan para protocolos por edad/sexo
  patient_birth_date?: string | null;
  patient_sex?: "M" | "F" | "O" | null;
  practice_id: string;
  practice_description?: string;
  modality: string;
  reason_for_study: string;
  diagnosis?: string | null;
  technician_notes?: string | null;
  scheduled_at?: string;
  // Región anatómica del estudio (API PACS v1.0: body_part dentro de
  // procedure). Texto libre: "Rodilla derecha", "Tórax", etc.
  procedure?: { body_part: string };
}

// Normaliza el sexo guardado en la ficha al contrato del PACS (M/F/O).
// Cualquier valor no reconocido se omite para no ensuciar la worklist.
export function sexoParaPacs(sexo: string | null | undefined): "M" | "F" | "O" | null {
  const s = (sexo ?? "").trim().toUpperCase();
  if (s === "M" || s === "MASCULINO") return "M";
  if (s === "F" || s === "FEMENINO") return "F";
  if (s === "O" || s === "OTRO" || s === "X") return "O";
  return null;
}

// Solo enviamos la fecha si tiene el formato YYYY-MM-DD que espera el PACS.
export function fechaNacimientoParaPacs(fecha: string | null | undefined): string | null {
  const f = (fecha ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : null;
}

export function upsertOrden(orden: PacsOrderUpsert, idempotencyKey: string) {
  return pacsV1Fetch<unknown>("/orders", { method: "POST", body: JSON.stringify(orden), idempotencyKey });
}

// Aviso de cancelación por el mismo canal de órdenes (acordado con el PACS
// jul 2026: los turnos cancelados se avisan por acá, no por worklist v3).
export function anularOrden(orderId: string, idempotencyKey: string) {
  return pacsV1Fetch<unknown>(`/orders/${encodeURIComponent(orderId)}`, { method: "DELETE", idempotencyKey });
}

// ── Aviso de recepción del paciente (pedido del equipo PACS jul 2026) ───────
// Cuando la recepción admite al paciente, la orden pasa a "recepcionado" en la
// lista de trabajo del PACS y sube al principio de la cola de los equipos.
export interface PacsReceptionResult {
  order_id: string;
  status: string;
  already_received: boolean;
}

export function notificarRecepcion(orderId: string, receivedAt: string | null, idempotencyKey: string) {
  return pacsV1Fetch<PacsReceptionResult>(`/orders/${encodeURIComponent(orderId)}/reception`, {
    method: "POST",
    body: JSON.stringify(receivedAt ? { received_at: receivedAt } : {}),
    idempotencyKey,
  });
}

// ── Sesiones (redeem_code de un solo uso; PKCE S256 opcional, CM-3) ─────────
export interface PacsUserIdentity {
  external_id: string;
  role: "recepcion" | "tecnico" | "medico" | "medico_firmante" | "admin";
  display_name?: string;
}

export interface PacsSessionCreated {
  session_id: string;
  redeem_code: string;
  redeem_url?: string;
  viewer_url?: string | null;
  expires_at: string;
  permitted_actions: string[];
  study_instance_uids?: string[];
  audit_id: string;
}

export function crearSesionVisor(
  params: { order_id?: string; study_instance_uid?: string; user: PacsUserIdentity; purpose?: string; code_challenge?: string },
  idempotencyKey: string,
) {
  const conOrder = Boolean(params.order_id);
  const conStudy = Boolean(params.study_instance_uid);
  if (conOrder === conStudy) {
    return Promise.resolve<PacsV1Result<PacsSessionCreated>>({
      ok: false,
      status: 422,
      code: "INVALIDO",
      message: "XOR violado: exactamente uno de order_id | study_instance_uid",
    });
  }
  return pacsV1Fetch<PacsSessionCreated>("/viewer-sessions", { method: "POST", body: JSON.stringify(params), idempotencyKey });
}

export function crearSesionLectura(
  params: { order_id: string; user: PacsUserIdentity; code_challenge?: string },
  idempotencyKey: string,
) {
  return pacsV1Fetch<PacsSessionCreated>("/read-sessions", { method: "POST", body: JSON.stringify(params), idempotencyKey });
}

export function crearSesionCarga(
  params: {
    order_id: string;
    modality?: string;
    expected_files?: number;
    incomplete_after_minutes?: number;
    user: PacsUserIdentity;
    code_challenge?: string;
  },
  idempotencyKey: string,
) {
  return pacsV1Fetch<PacsSessionCreated>("/upload-sessions", { method: "POST", body: JSON.stringify(params), idempotencyKey });
}

// ── Estudios y estados ───────────────────────────────────────────────────────
export interface PacsStudySummary {
  study_instance_uid: string;
  order_id?: string | null;
  accession_number?: string | null;
  state: "AGENDADO" | "RECEPCIONADO" | "PENDIENTE_DE_INFORME" | "INFORMADO" | "AUSENTE";
  technical_state?: "ESPERANDO_OBJETOS" | "RECIBIENDO" | "INCOMPLETO" | "VERIFICADO" | "ERROR";
  series_count?: number;
  instance_count?: number;
  modality?: string;
  received_at?: string | null;
  incomplete?: boolean;
  practice_id?: string;
  practice_description?: string;
}

export function estudiosDeOrden(orderId: string) {
  return pacsV1Fetch<PacsStudySummary[]>(`/orders/${encodeURIComponent(orderId)}/studies`);
}

export function estadoDeEstudio(studyUid: string) {
  return pacsV1Fetch<PacsStudySummary>(`/studies/${encodeURIComponent(studyUid)}/status`);
}

export function pacsV1Health() {
  return pacsV1Fetch<{ status: string }>("/health");
}

// ── Webhook entrante: firma HMAC con signature_ts anti-replay ────────────────
// X-Conectar-Signature = HMAC-SHA256(secreto, `${signature_ts}.${rawBody}`).
// Rotación con doble secreto: se acepta el nuevo y el anterior.
export const VENTANA_ANTI_REPLAY_SEG = 300;

export function verificarFirmaWebhook(
  rawBody: string,
  firmaHeader: string | undefined,
  signatureTs: number,
  ahoraUnixSeg: number = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; motivo: string } {
  const secretos = [process.env.PACS_WEBHOOK_SECRET, process.env.PACS_WEBHOOK_SECRET_ANTERIOR]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s));
  if (secretos.length === 0) return { ok: false, motivo: "PACS_WEBHOOK_SECRET no configurado" };
  if (!firmaHeader) return { ok: false, motivo: "Falta el header X-Conectar-Signature" };
  if (!Number.isInteger(signatureTs)) return { ok: false, motivo: "signature_ts inválido" };
  if (Math.abs(ahoraUnixSeg - signatureTs) > VENTANA_ANTI_REPLAY_SEG) {
    return { ok: false, motivo: "signature_ts fuera de la ventana anti-replay" };
  }
  const firmaBuf = Buffer.from(firmaHeader, "hex");
  for (const secreto of secretos) {
    const esperada = crypto.createHmac("sha256", secreto).update(`${signatureTs}.${rawBody}`).digest();
    if (firmaBuf.length === esperada.length && crypto.timingSafeEqual(firmaBuf, esperada)) {
      return { ok: true };
    }
  }
  return { ok: false, motivo: "Firma HMAC inválida" };
}
