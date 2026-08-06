// Cliente del Robot Klinicos externo (Centro de Control Klinicos).
// El Robot expone (según contrato) POST {ROBOT_API_URL}/api/v1/klinicos/token/validate
// y Conectar le delega la validación EN VIVO del token IOMA.
//
// Regla clave del contrato: TECHNICAL_ERROR y TIMEOUT NO son denegaciones.
// Nunca loguear el token completo (solo los últimos 4 dígitos).

export type EstadoValidacionToken =
  | "PROCESSING"
  | "TOKEN_ACCEPTED"
  | "TOKEN_DENIED"
  | "TOKEN_EXPIRED"
  | "TOKEN_ALREADY_USED"
  | "PATIENT_MISMATCH"
  | "MANUAL_PRESTATION_REQUIRED"
  | "DATA_REQUIRED"
  | "MAPPING_REQUIRED"
  | "TECHNICAL_ERROR"
  | "TIMEOUT"
  | "MANUAL_REVIEW";

const ESTADOS_VALIDOS: ReadonlySet<string> = new Set([
  "PROCESSING",
  "TOKEN_ACCEPTED",
  "TOKEN_DENIED",
  "TOKEN_EXPIRED",
  "TOKEN_ALREADY_USED",
  "PATIENT_MISMATCH",
  "MANUAL_PRESTATION_REQUIRED",
  "DATA_REQUIRED",
  "MAPPING_REQUIRED",
  "TECHNICAL_ERROR",
  "TIMEOUT",
  "MANUAL_REVIEW",
]);

// Contrato del body: matching-request.schema.json (spec de El Robot).
// No enviar propiedades adicionales; los campos opcionales sin valor se OMITEN.
export interface PacienteValidacionToken {
  document_type: string; // "DNI"
  document_number: string; // solo dígitos
  patient_id?: string;
  affiliate_number?: string;
  // Guía del Robot (jul 2026): nombre y apellido tal como figuran en IOMA.
  first_name?: string;
  last_name?: string;
}

export interface PayloadValidacionToken {
  request_id: string;
  consultation_id: string;
  token: string;
  practice_code?: string;
  professional_id?: string;
  professional_name?: string; // "Apellido, Nombre"
  specialty_code?: string;
  institution_id?: string;
  diagnosis_code?: string; // CIE-10 normalizado
  // Guía del Robot (jul 2026): fecha de atención DD/MM/AAAA (el día del token).
  attention_date?: string;
  patient: PacienteValidacionToken;
}

/** Normaliza un código CIE-10: mayúsculas, sin espacios internos. */
export function normalizarCie10(codigo: string | null | undefined): string | undefined {
  const limpio = codigo?.trim().toUpperCase().replace(/\s+/g, "");
  return limpio ? limpio : undefined;
}

/**
 * Validaciones previas del contrato. Devuelve el mensaje de error o null si es
 * válido. Nunca incluye el token en el mensaje.
 */
export function validarPayloadToken(payload: PayloadValidacionToken): string | null {
  if (!payload.request_id?.trim()) return "request_id es obligatorio";
  if (!payload.token?.trim()) return "El token es obligatorio";
  if (!payload.patient?.document_number?.trim())
    return "El documento del paciente es obligatorio";
  if (!/^\d+$/.test(payload.patient.document_number))
    return "El DNI debe contener solo dígitos";
  return null;
}

/** Arma el body EXACTO del schema, omitiendo opcionales vacíos y aplicando trim al token. */
function bodySegunSchema(p: PayloadValidacionToken): Record<string, unknown> {
  const opcional = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);
  const patient: Record<string, unknown> = {
    document_type: p.patient.document_type,
    document_number: p.patient.document_number.trim(),
  };
  if (opcional(p.patient.patient_id)) patient.patient_id = opcional(p.patient.patient_id);
  if (opcional(p.patient.affiliate_number))
    patient.affiliate_number = opcional(p.patient.affiliate_number);
  if (opcional(p.patient.first_name)) patient.first_name = opcional(p.patient.first_name);
  if (opcional(p.patient.last_name)) patient.last_name = opcional(p.patient.last_name);
  const body: Record<string, unknown> = {
    request_id: p.request_id.trim(),
    consultation_id: p.consultation_id,
    // Guía del Robot: el token va SIN espacios (ni internos ni en los bordes).
    token: p.token.replace(/\s+/g, ""),
    patient,
  };
  if (opcional(p.attention_date)) body.attention_date = opcional(p.attention_date);
  if (opcional(p.practice_code)) body.practice_code = opcional(p.practice_code);
  if (opcional(p.professional_id)) body.professional_id = opcional(p.professional_id);
  if (opcional(p.professional_name)) body.professional_name = opcional(p.professional_name);
  if (opcional(p.specialty_code)) body.specialty_code = opcional(p.specialty_code);
  if (opcional(p.institution_id)) body.institution_id = opcional(p.institution_id);
  const cie10 = normalizarCie10(p.diagnosis_code);
  if (cie10) body.diagnosis_code = cie10;
  return body;
}

export interface ResultadoValidacionToken {
  estado: EstadoValidacionToken;
  mensaje: string;
  referenciaKlinicos: string | null;
  latenciaMs: number;
  /** reason_code del Robot (p.ej. PRESTATION_NOT_FOUND) o AUTH_ERROR en HTTP 401. */
  codigo?: string | null;
  /** missing_fields del Robot en contingencia de carga manual. */
  camposFaltantes?: string[];
  /** authorization_number cuando el token fue aceptado. */
  numeroAutorizacion?: string | null;
  /** true si el Robot devolvió 401 (clave inválida): problema de configuración, no del token. */
  noAutenticado?: boolean;
  /** Posición en la cola del Robot cuando el estado es PROCESSING. */
  posicionCola?: number | null;
  /** Tiempo estimado de espera (segundos) informado por el Robot. */
  esperaEstimadaSegundos?: number | null;
}

function timeoutMs(): number {
  const raw = Number(process.env.ROBOT_TOKEN_VALIDATION_TIMEOUT_MS);
  // Pedido del Robot (jul 2026): timeout HTTP de 30s o más — ellos responden
  // status TIMEOUT a los ~20s si la validación sigue en curso, así que con 45s
  // siempre recibimos su respuesta en vez de abortar la conexión.
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
}

export function robotApiUrl(): string | null {
  const url = process.env.ROBOT_API_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

function headersRobot(requestId?: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = process.env.ROBOT_API_KEY?.trim();
  if (apiKey) {
    // Spec (jul 2026): el Robot autentica con X-Api-Key. NO usar Authorization Bearer.
    headers["x-api-key"] = apiKey;
  }
  if (requestId) {
    headers["x-request-id"] = requestId;
    headers["idempotency-key"] = requestId;
  }
  return headers;
}

export function enmascararToken(token: string): string {
  return token.length <= 4 ? `···${token}` : `···${token.slice(-4)}`;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

/**
 * Interpreta la respuesta del Robot con tolerancia de nombres de campo
 * (status/estado/result, reason_message/mensaje/message, klinicos_reference/referencia).
 */
function interpretarRespuesta(json: unknown, latenciaMs: number): ResultadoValidacionToken {
  if (!json || typeof json !== "object") {
    return {
      estado: "TECHNICAL_ERROR",
      mensaje: "Respuesta del Robot con formato inesperado",
      referenciaKlinicos: null,
      latenciaMs,
    };
  }
  const o = json as Record<string, unknown>;
  const crudo = pick(o, "status", "estado", "result", "state");
  const estadoStr = typeof crudo === "string" ? crudo.toUpperCase() : "";
  const estado: EstadoValidacionToken = ESTADOS_VALIDOS.has(estadoStr)
    ? (estadoStr as EstadoValidacionToken)
    : "TECHNICAL_ERROR";
  const msj = pick(o, "reason_message", "reason", "mensaje", "message");
  const ref = pick(o, "klinicos_reference", "referencia_klinicos", "reference", "referencia");
  const codigo = pick(o, "reason_code", "codigo");
  const faltantes = pick(o, "missing_fields", "campos_faltantes");
  const autorizacion = pick(o, "authorization_number", "numero_autorizacion");
  const cola = pick(o, "queue_position", "posicion_cola", "queuePosition");
  const espera = pick(
    o,
    "estimated_wait_seconds",
    "estimated_wait",
    "espera_estimada_segundos",
    "estimatedWaitSeconds",
  );
  return {
    estado,
    mensaje:
      typeof msj === "string" && msj.trim() !== ""
        ? msj
        : estado === "TECHNICAL_ERROR" && !ESTADOS_VALIDOS.has(estadoStr)
          ? `Estado desconocido del Robot: ${estadoStr || "(vacío)"}`
          : estado,
    referenciaKlinicos: typeof ref === "string" ? ref : null,
    latenciaMs,
    codigo: typeof codigo === "string" ? codigo : null,
    camposFaltantes: Array.isArray(faltantes)
      ? faltantes.filter((f): f is string => typeof f === "string")
      : [],
    numeroAutorizacion: typeof autorizacion === "string" ? autorizacion : null,
    posicionCola: typeof cola === "number" && Number.isFinite(cola) ? cola : null,
    esperaEstimadaSegundos:
      typeof espera === "number" && Number.isFinite(espera) ? espera : null,
  };
}

export async function validarTokenConRobot(
  payload: PayloadValidacionToken,
): Promise<ResultadoValidacionToken> {
  const base = robotApiUrl();
  const inicio = Date.now();
  if (!base) {
    return {
      estado: "TECHNICAL_ERROR",
      mensaje: "ROBOT_API_URL no configurada",
      referenciaKlinicos: null,
      latenciaMs: 0,
    };
  }
  const errorValidacion = validarPayloadToken(payload);
  if (errorValidacion) {
    return {
      estado: "TECHNICAL_ERROR",
      mensaje: `Payload inválido: ${errorValidacion}`,
      referenciaKlinicos: null,
      latenciaMs: 0,
    };
  }
  try {
    const res = await fetch(`${base}/api/v1/klinicos/token/validate`, {
      method: "POST",
      headers: headersRobot(payload.request_id),
      body: JSON.stringify(bodySegunSchema(payload)),
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
    if (!res.ok) {
      // 401: clave inválida — problema de configuración de la integración,
      // nunca mostrarlo como token rechazado ni exponer detalles técnicos.
      if (res.status === 401) {
        return {
          estado: "TECHNICAL_ERROR",
          mensaje:
            "La integración con El Robot no está correctamente autenticada. Contactá al administrador.",
          referenciaKlinicos: null,
          latenciaMs,
          codigo: "AUTH_ERROR",
          noAutenticado: true,
        };
      }
      // 4xx/5xx del Robot: puede traer un estado interpretable en el body
      if (json) {
        const r = interpretarRespuesta(json, latenciaMs);
        if (r.estado !== "TECHNICAL_ERROR" || (json as Record<string, unknown>).status) return r;
      }
      return {
        estado: "TECHNICAL_ERROR",
        mensaje:
          res.status === 404
            ? "El Robot todavía no expone el endpoint de validación de token"
            : `Robot respondió HTTP ${res.status}`,
        referenciaKlinicos: null,
        latenciaMs,
      };
    }
    return interpretarRespuesta(json, latenciaMs);
  } catch (err) {
    const latenciaMs = Date.now() - inicio;
    const esTimeout = err instanceof Error && err.name === "TimeoutError";
    return {
      estado: esTimeout ? "TIMEOUT" : "TECHNICAL_ERROR",
      mensaje: esTimeout
        ? "El Robot no respondió a tiempo"
        : `No se pudo contactar al Robot: ${err instanceof Error ? err.message : String(err)}`,
      referenciaKlinicos: null,
      latenciaMs,
    };
  }
}

export interface EstadoRobot {
  disponible: boolean;
  sesionKlinicos: string; // activa | inactiva | desconocida
  latenciaMs: number | null;
  /** Motivo legible cuando no está disponible (ej: revisar usuario/clave). */
  motivo?: string | null;
}

/**
 * Consulta el estado de una solicitud de validación previa:
 * GET {ROBOT_API_URL}/api/v1/klinicos/token/requests/{request_id}
 */
export async function consultarSolicitudToken(
  requestId: string,
): Promise<ResultadoValidacionToken> {
  const base = robotApiUrl();
  const inicio = Date.now();
  if (!base) {
    return {
      estado: "TECHNICAL_ERROR",
      mensaje: "ROBOT_API_URL no configurada",
      referenciaKlinicos: null,
      latenciaMs: 0,
    };
  }
  try {
    const res = await fetch(
      `${base}/api/v1/klinicos/token/requests/${encodeURIComponent(requestId)}`,
      { headers: headersRobot(requestId), signal: AbortSignal.timeout(timeoutMs()) },
    );
    const latenciaMs = Date.now() - inicio;
    const texto = await res.text();
    let json: unknown = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      return {
        estado: "TECHNICAL_ERROR",
        mensaje:
          res.status === 404
            ? `El Robot no encontró la solicitud ${requestId}`
            : `Robot respondió HTTP ${res.status}`,
        referenciaKlinicos: null,
        latenciaMs,
      };
    }
    return interpretarRespuesta(json, latenciaMs);
  } catch (err) {
    const latenciaMs = Date.now() - inicio;
    const esTimeout = err instanceof Error && err.name === "TimeoutError";
    return {
      estado: esTimeout ? "TIMEOUT" : "TECHNICAL_ERROR",
      mensaje: esTimeout
        ? "El Robot no respondió a tiempo"
        : `No se pudo contactar al Robot: ${err instanceof Error ? err.message : String(err)}`,
      referenciaKlinicos: null,
      latenciaMs,
    };
  }
}

/** Ping de disponibilidad: GET {ROBOT_API_URL}/api/v1/klinicos/health. */
export async function estadoRobot(): Promise<EstadoRobot> {
  const base = robotApiUrl();
  if (!base) return { disponible: false, sesionKlinicos: "desconocida", latenciaMs: null };
  const inicio = Date.now();
  try {
    let res = await fetch(`${base}/api/v1/klinicos/health`, {
      headers: headersRobot(),
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) {
      // El Robot todavía no publica /health; fallback al ping legado.
      res = await fetch(`${base}/api`, {
        headers: headersRobot(),
        signal: AbortSignal.timeout(8_000),
      });
    }
    const latenciaMs = Date.now() - inicio;
    if (!res.ok) return { disponible: false, sesionKlinicos: "desconocida", latenciaMs };
    let sesion = "desconocida";
    try {
      const json = (await res.json()) as Record<string, unknown>;
      const s = pick(json, "klinicos_session", "sesion_klinicos", "session");
      if (typeof s === "string") sesion = s;
      else if (typeof s === "boolean") sesion = s ? "activa" : "inactiva";
    } catch {
      /* body no-JSON: solo disponibilidad */
    }
    return { disponible: true, sesionKlinicos: sesion, latenciaMs };
  } catch {
    return {
      disponible: false,
      sesionKlinicos: "desconocida",
      latenciaMs: Date.now() - inicio,
    };
  }
}
