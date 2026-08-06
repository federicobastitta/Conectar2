// Cliente del flujo transaccional único de consultas del Robot KLINICOS.
// Contrato DEFINITIVO 19/07/2026: docs/robot-openapi/robot-openapi.yaml
// (única fuente del contrato).
//
// Endpoints (base {ROBOT_API_URL}/api):
// - POST /v1/klinicos/consultations/process
// - GET  /v1/klinicos/consultations/requests/{request_id}        (polling read-only)
// - POST /v1/klinicos/consultations/requests/{request_id}/retry  (reintento con token guardado)
// - GET  /v1/klinicos/consultations/health
//
// Reglas del contrato:
// - Conectar NO envía specialty ni performing_professional (el Robot deriva
//   todo desde practice.id y fija el profesional al request_id).
// - X-Api-Key vive EXCLUSIVAMENTE en el backend.
// - Mismo request_id durante todo el caso; un consultation_id admite UN solo
//   request_id (reuso → 409).
// - El token NUNCA se loguea, ni se guarda en texto plano.
// - TOKEN_ACCEPTED es el único estado que habilita la consulta;
//   TOKEN_DENIED el único rechazo real.
// - scheduled_at se envía con offset argentino (-03:00), nunca en Z.

import { robotApiUrl } from "./robot-cliente";

/** Feature flag independiente del de validación de token. Default: apagado. */
export function consultasProcessHabilitadas(): boolean {
  return (
    process.env.KLINICOS_CONSULTATIONS_PROCESS_ENABLED?.trim().toLowerCase() === "true"
  );
}

// ── Tipos según el OpenAPI del Robot ─────────────────────────────────────

export const ESTADOS_CONSULTA_PROCESO = [
  "PROCESSING",
  "TOKEN_ACCEPTED",
  "TOKEN_DENIED",
  "DATA_REQUIRED",
  "MAPPING_REQUIRED",
  "MANUAL_REVIEW",
  "TOKEN_REENTRY_REQUIRED",
  "TECHNICAL_ERROR",
] as const;
export type EstadoConsultaProceso = (typeof ESTADOS_CONSULTA_PROCESO)[number];

const ESTADOS_VALIDOS: ReadonlySet<string> = new Set(ESTADOS_CONSULTA_PROCESO);

/** Estados finales: detener el polling al recibirlos. PROCESSING es el único no final. */
export function esEstadoFinal(estado: EstadoConsultaProceso): boolean {
  return estado !== "PROCESSING";
}

export interface PacienteProceso {
  document_type: string; // por ahora solo DNI
  document_number: string; // 6 a 9 dígitos, sin puntos
  first_name: string;
  last_name: string;
  birth_date?: string | null; // AAAA-MM-DD
  // Puede ir vacío: el Robot completa el nro. de afiliado por padrón (DNI).
  affiliate_number?: string | null;
  affiliate_type?: string | null;
}

export interface PracticaProceso {
  id: string; // CLAVE DE RESOLUCIÓN (equivalencia aprobada en el Robot)
  code: string; // nomenclador, informativo/auditoría
  description?: string | null;
  catalog?: string | null;
  quantity?: number;
}

export interface ConsultaProcesoEntrada {
  request_id: string;
  consultation_id: string;
  patient: PacienteProceso;
  coverage: { insurer: string; plan?: string | null };
  practice: PracticaProceso;
  site?: { id?: string | null; name?: string | null } | null;
  scheduled_at: string; // ISO 8601 con -03:00, atención del día de HOY
  diagnosis: { code: string; description?: string | null };
  token: string; // 4 a 40 caracteres; NUNCA se loguea ni persiste en claro
}

export interface MapeoPendiente {
  kind: "practice" | "specialty";
  value: string;
  problem: string;
}

export interface EstadoColaRobot {
  pending_operations?: number;
  approx_position?: number | null;
  estimated_wait_seconds?: number | null;
  klinicos_session_available?: boolean;
}

export interface ConsultaProcesoRespuesta {
  request_id: string;
  consultation_id: string;
  status: EstadoConsultaProceso;
  attempt_number: number;
  requires_manual_action: boolean;
  retry_allowed: boolean;
  missing_fields: string[];
  mapping_required: MapeoPendiente[];
  reason_code: string | null;
  reason_message: string | null;
  authorization_number: string | null;
  klinicos_reference: string | null;
  prestation_created: boolean;
  queue: EstadoColaRobot | null;
  validated_at: string | null;
  latency_ms: number | null;
}

export interface SaludConsultas {
  enabled: boolean;
  /** true = entorno de simulación; el Robot nunca opera KLINICOS real. */
  sandbox: boolean;
  queue: EstadoColaRobot | null;
  totalsByStatus: Record<string, number>;
  timestamp: string | null;
}

/** Resultado discriminado: respuesta interpretable del Robot o error de transporte/contrato. */
export type ResultadoProceso =
  | { tipo: "respuesta"; data: ConsultaProcesoRespuesta; latenciaMs: number }
  | {
      tipo: "error";
      /** Código HTTP del Robot (0 si no hubo respuesta: red/timeout). */
      httpStatus: number;
      /** conflicto=409, rate_limit=429, no_autorizado=401, deshabilitado=503, no_encontrado=404, invalido=400, red=0, otro. */
      clase:
        | "conflicto"
        | "rate_limit"
        | "no_autorizado"
        | "deshabilitado"
        | "no_encontrado"
        | "invalido"
        | "timeout"
        | "red"
        | "otro";
      mensaje: string;
      latenciaMs: number;
    };

// ── Helpers ──────────────────────────────────────────────────────────────

function timeoutMs(): number {
  const raw = Number(process.env.ROBOT_CONSULTAS_TIMEOUT_MS);
  // El POST puede tardar ~15s antes de pasar a PROCESSING (spec); margen 25s.
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000;
}

/** Headers del Robot. La X-Api-Key NUNCA sale del backend. */
function headersRobot(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = process.env.ROBOT_API_KEY?.trim();
  if (apiKey) headers["x-api-key"] = apiKey;
  return headers;
}

/**
 * scheduled_at con offset argentino fijo (-03:00), nunca Z: evita que una
 * atención de la mañana se interprete como el día anterior/siguiente.
 * fecha: YYYY-MM-DD (hora argentina), hora: HH:mm.
 */
export function armarScheduledAt(fecha: string, hora: string): string {
  const hhmm = /^\d{2}:\d{2}$/.test(hora) ? `${hora}:00` : hora;
  return `${fecha}T${hhmm}-03:00`;
}

/** Validaciones previas mínimas del contrato. Nunca incluye el token en el mensaje. */
export function validarEntradaProceso(e: ConsultaProcesoEntrada): string | null {
  if (!e.request_id?.trim()) return "request_id es obligatorio";
  if (!e.consultation_id?.trim()) return "consultation_id es obligatorio";
  if (!e.token || e.token.trim().length < 4 || e.token.trim().length > 40)
    return "El token debe tener entre 4 y 40 caracteres";
  if (!/^\d{6,9}$/.test(e.patient?.document_number ?? ""))
    return "El DNI debe tener 6 a 9 dígitos, sin puntos";
  if (!e.patient.first_name?.trim() || !e.patient.last_name?.trim())
    return "Nombre y apellido del paciente son obligatorios";
  if (!e.coverage?.insurer?.trim()) return "coverage.insurer es obligatorio";
  if (!e.practice?.id?.trim()) return "practice.id es obligatorio";
  if (!e.practice?.code?.trim()) return "practice.code es obligatorio";
  if (!e.scheduled_at?.trim()) return "scheduled_at es obligatorio";
  if (/Z$/i.test(e.scheduled_at.trim()))
    return "scheduled_at debe llevar offset -03:00, no Z (UTC)";
  if (!e.diagnosis?.code?.trim()) return "diagnosis.code (CIE-10) es obligatorio";
  return null;
}

/** Body EXACTO del schema; omite opcionales vacíos. PROHIBIDO: specialty / performing_professional. */
function bodySegunSchema(e: ConsultaProcesoEntrada): Record<string, unknown> {
  const opc = (v: string | null | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);
  const patient: Record<string, unknown> = {
    document_type: e.patient.document_type,
    document_number: e.patient.document_number.trim(),
    first_name: e.patient.first_name.trim(),
    last_name: e.patient.last_name.trim(),
    // Vacío permitido: el Robot lo completa por padrón de IOMA (por DNI).
    affiliate_number: e.patient.affiliate_number?.trim() ?? "",
  };
  if (opc(e.patient.birth_date)) patient.birth_date = opc(e.patient.birth_date);
  if (opc(e.patient.affiliate_type)) patient.affiliate_type = opc(e.patient.affiliate_type);

  const coverage: Record<string, unknown> = { insurer: e.coverage.insurer.trim() };
  if (opc(e.coverage.plan)) coverage.plan = opc(e.coverage.plan);

  const practice: Record<string, unknown> = {
    id: e.practice.id.trim(),
    code: e.practice.code.trim(),
  };
  if (opc(e.practice.description)) practice.description = opc(e.practice.description);
  if (opc(e.practice.catalog)) practice.catalog = opc(e.practice.catalog);
  if (e.practice.quantity && e.practice.quantity > 0) practice.quantity = e.practice.quantity;

  const diagnosis: Record<string, unknown> = { code: e.diagnosis.code.trim().toUpperCase() };
  if (opc(e.diagnosis.description)) diagnosis.description = opc(e.diagnosis.description);

  const body: Record<string, unknown> = {
    request_id: e.request_id.trim(),
    consultation_id: e.consultation_id.trim(),
    patient,
    coverage,
    practice,
    scheduled_at: e.scheduled_at.trim(),
    diagnosis,
    token: e.token.trim(),
  };
  if (e.site && (opc(e.site.id) || opc(e.site.name))) {
    const site: Record<string, unknown> = {};
    if (opc(e.site.id)) site.id = opc(e.site.id);
    if (opc(e.site.name)) site.name = opc(e.site.name);
    body.site = site;
  }
  return body;
}

function interpretarRespuesta(
  json: unknown,
  latenciaMs: number,
): ConsultaProcesoRespuesta | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const estadoStr = typeof o.status === "string" ? o.status.toUpperCase() : "";
  if (!ESTADOS_VALIDOS.has(estadoStr)) return null;
  const cola = o.queue && typeof o.queue === "object" ? (o.queue as EstadoColaRobot) : null;
  return {
    request_id: typeof o.request_id === "string" ? o.request_id : "",
    consultation_id: typeof o.consultation_id === "string" ? o.consultation_id : "",
    status: estadoStr as EstadoConsultaProceso,
    attempt_number: typeof o.attempt_number === "number" ? o.attempt_number : 1,
    requires_manual_action: o.requires_manual_action === true,
    retry_allowed: o.retry_allowed === true,
    missing_fields: Array.isArray(o.missing_fields)
      ? o.missing_fields.filter((f): f is string => typeof f === "string")
      : [],
    mapping_required: Array.isArray(o.mapping_required)
      ? o.mapping_required.filter(
          (m): m is MapeoPendiente =>
            !!m && typeof m === "object" && typeof (m as MapeoPendiente).value === "string",
        )
      : [],
    reason_code: typeof o.reason_code === "string" ? o.reason_code : null,
    reason_message: typeof o.reason_message === "string" ? o.reason_message : null,
    authorization_number:
      typeof o.authorization_number === "string" ? o.authorization_number : null,
    klinicos_reference: typeof o.klinicos_reference === "string" ? o.klinicos_reference : null,
    prestation_created: o.prestation_created === true,
    queue: cola,
    validated_at: typeof o.validated_at === "string" ? o.validated_at : null,
    latency_ms: typeof o.latency_ms === "number" ? o.latency_ms : null,
  };
}

function mensajeErrorBody(json: unknown, fallback: string): string {
  if (json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string")
    return (json as { error: string }).error;
  return fallback;
}

function claseDeStatus(status: number): Extract<ResultadoProceso, { tipo: "error" }>["clase"] {
  switch (status) {
    case 400:
      return "invalido";
    case 401:
      return "no_autorizado";
    case 404:
      return "no_encontrado";
    case 409:
      return "conflicto";
    case 429:
      return "rate_limit";
    case 503:
      return "deshabilitado";
    default:
      return "otro";
  }
}

async function llamarRobot(
  metodo: "GET" | "POST",
  ruta: string,
  body?: Record<string, unknown>,
): Promise<ResultadoProceso> {
  const base = robotApiUrl();
  const inicio = Date.now();
  if (!base) {
    return {
      tipo: "error",
      httpStatus: 0,
      clase: "red",
      mensaje: "ROBOT_API_URL no configurada",
      latenciaMs: 0,
    };
  }
  try {
    const res = await fetch(`${base}${ruta}`, {
      method: metodo,
      headers: headersRobot(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs()),
    });
    const latenciaMs = Date.now() - inicio;
    const texto = await res.text();
    let json: unknown = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = null;
    }
    if (res.ok) {
      const data = interpretarRespuesta(json, latenciaMs);
      if (data) return { tipo: "respuesta", data, latenciaMs };
      return {
        tipo: "error",
        httpStatus: res.status,
        clase: "otro",
        mensaje: "Respuesta del Robot con formato inesperado",
        latenciaMs,
      };
    }
    return {
      tipo: "error",
      httpStatus: res.status,
      clase: claseDeStatus(res.status),
      mensaje: mensajeErrorBody(json, `Robot respondió HTTP ${res.status}`),
      latenciaMs,
    };
  } catch (err) {
    const latenciaMs = Date.now() - inicio;
    const esTimeout = err instanceof Error && err.name === "TimeoutError";
    return {
      tipo: "error",
      httpStatus: 0,
      clase: esTimeout ? "timeout" : "red",
      mensaje: esTimeout
        ? "El Robot no respondió a tiempo"
        : `No se pudo contactar al Robot: ${err instanceof Error ? err.message : String(err)}`,
      latenciaMs,
    };
  }
}

// ── Operaciones del contrato ─────────────────────────────────────────────

/** POST /v1/klinicos/consultations/process — flujo transaccional único. */
export async function procesarConsultaConRobot(
  entrada: ConsultaProcesoEntrada,
): Promise<ResultadoProceso> {
  const error = validarEntradaProceso(entrada);
  if (error) {
    return {
      tipo: "error",
      httpStatus: 0,
      clase: "invalido",
      mensaje: `Payload inválido: ${error}`,
      latenciaMs: 0,
    };
  }
  return llamarRobot("POST", "/api/v1/klinicos/consultations/process", bodySegunSchema(entrada));
}

/** GET /v1/klinicos/consultations/requests/{request_id} — polling read-only. */
export async function consultarProcesoConsulta(requestId: string): Promise<ResultadoProceso> {
  return llamarRobot(
    "GET",
    `/api/v1/klinicos/consultations/requests/${encodeURIComponent(requestId)}`,
  );
}

/** POST /v1/klinicos/consultations/requests/{request_id}/retry — reintento con el token cifrado guardado. */
export async function reintentarProcesoConsulta(requestId: string): Promise<ResultadoProceso> {
  return llamarRobot(
    "POST",
    `/api/v1/klinicos/consultations/requests/${encodeURIComponent(requestId)}/retry`,
  );
}

/** GET /v1/klinicos/consultations/health — salud operativa del flujo. */
export async function saludConsultasRobot(): Promise<
  { ok: true; data: SaludConsultas } | { ok: false; mensaje: string; httpStatus: number }
> {
  const base = robotApiUrl();
  if (!base) return { ok: false, mensaje: "ROBOT_API_URL no configurada", httpStatus: 0 };
  try {
    const res = await fetch(`${base}/api/v1/klinicos/consultations/health`, {
      headers: headersRobot(),
      signal: AbortSignal.timeout(8_000),
    });
    const texto = await res.text();
    let json: unknown = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = null;
    }
    if (!res.ok)
      return {
        ok: false,
        mensaje: mensajeErrorBody(json, `Robot respondió HTTP ${res.status}`),
        httpStatus: res.status,
      };
    const o = (json ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      data: {
        enabled: o.enabled === true,
        sandbox: o.sandbox === true,
        queue: o.queue && typeof o.queue === "object" ? (o.queue as EstadoColaRobot) : null,
        totalsByStatus:
          o.totals_by_status && typeof o.totals_by_status === "object"
            ? (o.totals_by_status as Record<string, number>)
            : {},
        timestamp: typeof o.timestamp === "string" ? o.timestamp : null,
      },
    };
  } catch (err) {
    const esTimeout = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      mensaje: esTimeout ? "El Robot no respondió a tiempo" : "No se pudo contactar al Robot",
      httpStatus: 0,
    };
  }
}
