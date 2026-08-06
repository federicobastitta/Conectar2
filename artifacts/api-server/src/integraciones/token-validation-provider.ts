// Adaptador de validación de token IOMA (spec de preparación).
//
// El Robot externo es el ÚNICO componente autorizado para operar KLINICOS.
// Conectar nunca: automatiza la web de KLINICOS, guarda credenciales,
// valida el token por su cuenta ni interpreta pantallas.
//
// La función queda DESHABILITADA (KLINICOS_TOKEN_VALIDATION_ENABLED=false)
// hasta que el Robot tenga el endpoint operativo, pruebas completas,
// autenticación, idempotencia y diferencie aceptación/denegación/error técnico.

import {
  validarTokenConRobot,
  estadoRobot,
  type PayloadValidacionToken,
  type ResultadoValidacionToken,
  type EstadoValidacionToken,
  type EstadoRobot,
} from "./robot-cliente";
import { db, klinicosTokenValidaciones } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import type { TokenEstado, RobotSyncEstado } from "@workspace/db";

/** Feature flag: la validación en vivo está apagada por defecto. */
export function validacionTokenHabilitada(): boolean {
  return process.env.KLINICOS_TOKEN_VALIDATION_ENABLED?.trim().toLowerCase() === "true";
}

/** Mapea el estado del Robot al enum del modelo de consulta. */
export function mapearEstadoToken(estado: EstadoValidacionToken): TokenEstado {
  switch (estado) {
    case "TOKEN_ACCEPTED":
      return "ACCEPTED";
    case "TOKEN_DENIED":
      return "DENIED";
    case "TOKEN_EXPIRED":
      return "EXPIRED";
    case "TOKEN_ALREADY_USED":
      return "ALREADY_USED";
    case "PATIENT_MISMATCH":
      return "PATIENT_MISMATCH";
    case "TIMEOUT":
      return "TIMEOUT";
    case "MANUAL_PRESTATION_REQUIRED":
      // La contingencia no es un estado del token: el token queda PENDING
      // y la contingencia vive en robot_sync_status (spec).
      return "PENDING";
    case "PROCESSING":
      // El Robot aceptó el trabajo y lo está procesando: el token sigue
      // en validación hasta que el polling traiga el estado final.
      return "VALIDATING";
    case "DATA_REQUIRED":
    case "MAPPING_REQUIRED":
      // No son denegaciones: falta corregir datos o configurar el mapeo.
      return "PENDING";
    case "MANUAL_REVIEW":
      return "MANUAL_REVIEW";
    default:
      return "TECHNICAL_ERROR";
  }
}

/** Mapea el estado del Robot al estado de sincronización (robot_sync_status). */
export function mapearRobotSyncStatus(estado: EstadoValidacionToken): RobotSyncEstado {
  switch (estado) {
    case "MANUAL_PRESTATION_REQUIRED":
      return "MANUAL_PRESTATION_REQUIRED";
    case "PROCESSING":
      return "PROCESSING";
    case "DATA_REQUIRED":
    case "MAPPING_REQUIRED":
      // Falta acción de nuestro lado (datos o configuración): reintentable.
      return "READY_TO_RETRY";
    case "TECHNICAL_ERROR":
    case "TIMEOUT":
      return "ERROR";
    default:
      return "COMPLETED";
  }
}

export interface TokenValidationProvider {
  validateToken(payload: PayloadValidacionToken): Promise<ResultadoValidacionToken>;
  getValidationStatus(consultationId: number): Promise<{
    estado: string | null;
    requestId: string | null;
    creadoEn: Date | null;
  }>;
  checkRobotHealth(): Promise<EstadoRobot>;
}

// ── Validación interna (decisión 01/08/2026: el Robot externo se retira) ──
// El automatizador interno de Conectar valida el token DIRECTO contra
// Klinicos (misma llamada XHR que usa la pantalla de nueva atención; solo
// lectura, no crea nada). Se usa cuando hay credenciales KLINICOS_USUARIO/
// PASSWORD; el Robot externo queda como respaldo si no las hay.
import {
  klinicosHabilitado,
  validarTokenConsultaKlinicos,
  loginKlinicos,
  seleccionarContextoKlinicos,
  CookieJar,
} from "./klinicos-robot";

/** true si el automatizador interno puede validar tokens (hay credenciales). */
export function validacionInternaDisponible(): boolean {
  return klinicosHabilitado();
}

// ── Prueba liviana real de las credenciales de Klinicos ────────────────────
// El semáforo no debe quedarse en verde solo porque KLINICOS_USUARIO/PASSWORD
// están cargadas: si la clínica cambia la clave, el login falla y hay que
// avisar. La prueba hace login + selección de contexto (solo lectura, no crea
// nada) y se cachea ~5 minutos para no golpear Klinicos en cada consulta.
const SALUD_CACHE_MS = 5 * 60 * 1000;

interface SaludKlinicos {
  ok: boolean;
  motivo: string | null;
  latenciaMs: number;
  verificadoEn: number;
}

let saludCache: SaludKlinicos | null = null;
let saludEnCurso: Promise<SaludKlinicos> | null = null;

/** Para tests: descarta la caché de salud. */
export function _resetSaludKlinicosCache(): void {
  saludCache = null;
  saludEnCurso = null;
}

async function probarCredencialesKlinicos(): Promise<SaludKlinicos> {
  const inicio = Date.now();
  try {
    const jar = new CookieJar();
    const login = await loginKlinicos(jar);
    if (!login.ok) {
      // Distinguir clave rechazada de problemas técnicos del portal.
      const esCredencial = /incorrecta|credencial/i.test(login.detalle);
      return {
        ok: false,
        motivo: esCredencial
          ? "Klinicos rechazó el login: revisar usuario/clave de Klinicos"
          : `No se pudo iniciar sesión en Klinicos (${login.detalle})`,
        latenciaMs: Date.now() - inicio,
        verificadoEn: Date.now(),
      };
    }
    const contexto = await seleccionarContextoKlinicos(jar);
    if (!contexto.ok) {
      return {
        ok: false,
        motivo: `Login OK pero falló la selección de contexto (${contexto.detalle})`,
        latenciaMs: Date.now() - inicio,
        verificadoEn: Date.now(),
      };
    }
    return { ok: true, motivo: null, latenciaMs: Date.now() - inicio, verificadoEn: Date.now() };
  } catch (err) {
    return {
      ok: false,
      motivo: `Error técnico al probar Klinicos: ${err instanceof Error ? err.message : String(err)}`,
      latenciaMs: Date.now() - inicio,
      verificadoEn: Date.now(),
    };
  }
}

async function saludKlinicos(): Promise<SaludKlinicos> {
  if (saludCache && Date.now() - saludCache.verificadoEn < SALUD_CACHE_MS) {
    return saludCache;
  }
  // Coalescer consultas concurrentes: una sola prueba en vuelo.
  if (!saludEnCurso) {
    saludEnCurso = probarCredencialesKlinicos()
      .then((r) => {
        saludCache = r;
        return r;
      })
      .finally(() => {
        saludEnCurso = null;
      });
  }
  return saludEnCurso;
}

export const internoTokenValidationProvider: TokenValidationProvider = {
  async validateToken(payload) {
    const inicio = Date.now();
    const dni = payload.patient?.document_number ?? "";
    if (!dni) {
      return {
        estado: "TECHNICAL_ERROR",
        mensaje: "Falta el DNI del paciente para validar el token",
        referenciaKlinicos: null,
        latenciaMs: 0,
      };
    }
    const r = await validarTokenConsultaKlinicos(dni, payload.token);
    const latenciaMs = Date.now() - inicio;
    if (r.requiereCargaManual) {
      // Condición de datos persistente (paciente inexistente / sin obra
      // social en Klinicos): reintentar no sirve, va a resolución manual.
      return { estado: "MANUAL_REVIEW", mensaje: r.mensaje, referenciaKlinicos: null, latenciaMs };
    }
    if (!r.ok) {
      // Error técnico (login, sesión, respuesta rara): reintentable, NO es denegación.
      return { estado: "TECHNICAL_ERROR", mensaje: r.mensaje, referenciaKlinicos: null, latenciaMs };
    }
    if (!r.valido) {
      // Denegación real de IOMA/Klinicos (vencido, usado, inválido): el
      // mensaje textual de Klinicos viaja tal cual al cartel rojo.
      return { estado: "TOKEN_DENIED", mensaje: r.mensaje, referenciaKlinicos: null, latenciaMs };
    }
    return {
      estado: "TOKEN_ACCEPTED",
      mensaje: r.afiliado ? `${r.mensaje} — ${r.afiliado}` : r.mensaje,
      referenciaKlinicos: null,
      latenciaMs,
    };
  },

  async getValidationStatus(consultationId) {
    return robotTokenValidationProvider.getValidationStatus(consultationId);
  },

  async checkRobotHealth() {
    if (!klinicosHabilitado()) {
      return {
        disponible: false,
        sesionKlinicos: "inactiva",
        latenciaMs: null,
        motivo: "Faltan las credenciales de Klinicos (KLINICOS_USUARIO/PASSWORD)",
      };
    }
    // Prueba real (login + contexto) con caché de ~5 minutos: si la clínica
    // cambió la clave de Klinicos, el semáforo debe pasar a rojo con motivo.
    const salud = await saludKlinicos();
    return {
      disponible: salud.ok,
      sesionKlinicos: salud.ok ? "activa" : "inactiva",
      latenciaMs: salud.latenciaMs,
      motivo: salud.motivo,
    };
  },
};

/** Implementación que delega en el Robot externo (ROBOT_API_URL). */
export const robotTokenValidationProvider: TokenValidationProvider = {
  async validateToken(payload) {
    if (!validacionTokenHabilitada()) {
      return {
        estado: "TECHNICAL_ERROR",
        mensaje: "La validación de token no está habilitada (KLINICOS_TOKEN_VALIDATION_ENABLED)",
        referenciaKlinicos: null,
        latenciaMs: 0,
      };
    }
    return validarTokenConRobot(payload);
  },

  async getValidationStatus(consultationId) {
    const [ultima] = await db
      .select()
      .from(klinicosTokenValidaciones)
      .where(eq(klinicosTokenValidaciones.turnoId, consultationId))
      .orderBy(sql`${klinicosTokenValidaciones.creadoEn} DESC`)
      .limit(1);
    return {
      estado: ultima?.estado ?? null,
      requestId: ultima?.requestId ?? null,
      creadoEn: ultima?.creadoEn ?? null,
    };
  },

  async checkRobotHealth() {
    return estadoRobot();
  },
};
