import { logger } from "../lib/logger";

// ── Cliente de la API oficial de Phir-it (PACS de imágenes) ────────────────
// A diferencia del scraper (phirit-scraper.ts), acá consumimos la API REST
// documentada por Phir-it. Seguridad por dos parámetros:
//   - codCli: código de cliente (32 chars) → Secret PHIRIT_API_COD_CLIENTE
//   - token:  string generado a partir del codCli, válido 1 hora
// La API devuelve, por DNI de paciente, los estudios con su metadata DICOM,
// los informes (texto) y los links a los visores propios de Phir-it
// (OHIF / Oviyam / portal), que embebemos en Conectar.

const BASE_URL = (process.env.PHIRIT_BASE_URL ?? "https://diagnosticar.phir-it.ar").replace(/\/$/, "");
// Margen de seguridad: el token dura 1h, lo renovamos a los 55 min.
const TOKEN_TTL_MS = 55 * 60 * 1000;

export interface PhiritInforme {
  medico: string | null;
  estudioRealizado: string | null;
  descripcionInforme: string | null;
}

export interface PhiritEstudio {
  id: number;
  studyIUID: string | null;
  fecha: string | null;
  numAcceso: string | null;
  descripcion: string | null;
  modalidad: string | null;
  numSeries: number | null;
  numInstancias: number | null;
  fechaCreado: string | null;
  informes: PhiritInforme[];
  linkVisualizador: string | null;
  linkVisualizadorComp: string | null;
  linkVisualizadorOhif: string | null;
  linkPortal: string | null;
}

export type PhiritResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "SIN_CONFIG" | "TOKEN" | "CLIENTE" | "HTTP" | "RESPUESTA"; message: string };

function codCli(): string | null {
  return process.env.PHIRIT_API_COD_CLIENTE?.trim() || null;
}

export function phiritApiConfigurado(): boolean {
  return Boolean(codCli());
}

// Cache de token en memoria (proceso único). No se persiste: si el server
// reinicia se regenera on-demand en la primera consulta.
let tokenCache: { token: string; expira: number } | null = null;

async function generarToken(cc: string): Promise<PhiritResult<string>> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/cliente/generar-token?codCli=${encodeURIComponent(cc)}`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, code: "HTTP", message: `No se pudo contactar Phir-it: ${String(err)}` };
  }
  if (!res.ok) {
    return { ok: false, code: "HTTP", message: `Phir-it generar-token devolvió HTTP ${res.status}` };
  }
  let body: { status?: number; mensaje?: string; token?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, code: "RESPUESTA", message: "Respuesta no-JSON de generar-token" };
  }
  if (body.mensaje === "cliente-invalido") {
    return { ok: false, code: "CLIENTE", message: "Código de cliente inválido (revisar PHIRIT_API_COD_CLIENTE)" };
  }
  if (!body.token) {
    return { ok: false, code: "TOKEN", message: `No se generó token: ${body.mensaje ?? "sin mensaje"}` };
  }
  return { ok: true, data: body.token };
}

// Devuelve un token válido, reusando el cacheado si no venció.
async function ensureToken(force = false): Promise<PhiritResult<string>> {
  const cc = codCli();
  if (!cc) {
    return { ok: false, code: "SIN_CONFIG", message: "Falta PHIRIT_API_COD_CLIENTE" };
  }
  if (!force && tokenCache && tokenCache.expira > Date.now()) {
    return { ok: true, data: tokenCache.token };
  }
  const r = await generarToken(cc);
  if (!r.ok) return r;
  tokenCache = { token: r.data, expira: Date.now() + TOKEN_TTL_MS };
  return { ok: true, data: r.data };
}

function normalizarEstudio(e: Record<string, unknown>): PhiritEstudio {
  const informesRaw = Array.isArray(e.informes) ? (e.informes as Record<string, unknown>[]) : [];
  return {
    id: Number(e.id),
    studyIUID: (e.studyIUID as string) ?? null,
    fecha: (e.fecha as string) ?? null,
    numAcceso: (e.numAcceso as string) ?? null,
    descripcion: ((e.descripcion as string) ?? "").trim() || null,
    modalidad: ((e.modalidad as string) ?? "").trim() || null,
    numSeries: e.numSeries != null ? Number(e.numSeries) : null,
    numInstancias: e.numInstancias != null ? Number(e.numInstancias) : null,
    fechaCreado: (e.fechaCreado as string) ?? null,
    informes: informesRaw.map((i) => ({
      medico: ((i.medico as string) ?? "").trim() || null,
      estudioRealizado: ((i.estudioRealizado as string) ?? "").trim() || null,
      descripcionInforme: ((i.descripcionInforme as string) ?? "").trim() || null,
    })),
    linkVisualizador: (e.linkVisualizador as string) ?? null,
    linkVisualizadorComp: (e.linkVisualizadorComp as string) ?? null,
    linkVisualizadorOhif: (e.linkVisualizadorOhif as string) ?? null,
    linkPortal: (e.linkPortal as string) ?? null,
  };
}

// Lista los estudios de imágenes de un paciente por DNI. Regenera el token
// una vez si Phir-it lo reporta vencido ("token-invalido").
export async function getEstudiosByDni(dni: string): Promise<PhiritResult<PhiritEstudio[]>> {
  const cc = codCli();
  if (!cc) return { ok: false, code: "SIN_CONFIG", message: "Falta PHIRIT_API_COD_CLIENTE" };

  // Un intento completo: fetch + validación HTTP + parseo + chequeo de mensaje.
  type Body = { status?: number; mensaje?: string; data?: unknown[] };
  const intentar = async (token: string): Promise<PhiritResult<Body>> => {
    const url = `${BASE_URL}/api/estudios?id=${encodeURIComponent(dni)}&codCli=${encodeURIComponent(
      cc,
    )}&token=${encodeURIComponent(token)}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      return { ok: false, code: "HTTP", message: `No se pudo contactar Phir-it: ${String(err)}` };
    }
    if (!res.ok) return { ok: false, code: "HTTP", message: `Phir-it estudios devolvió HTTP ${res.status}` };
    let body: Body;
    try {
      body = (await res.json()) as Body;
    } catch {
      return { ok: false, code: "RESPUESTA", message: "Respuesta no-JSON de estudios" };
    }
    if (body.mensaje === "cliente-invalido") {
      return { ok: false, code: "CLIENTE", message: "Código de cliente inválido" };
    }
    if (body.mensaje === "cliente-no-habilitado") {
      return { ok: false, code: "CLIENTE", message: "Cliente no habilitado en Phir-it" };
    }
    return { ok: true, data: body };
  };

  let tok = await ensureToken();
  if (!tok.ok) return tok;

  let intento = await intentar(tok.data);
  // Token vencido: renovamos y reintentamos una vez (validando el 2do intento igual que el 1ro).
  if (intento.ok && intento.data.mensaje === "token-invalido") {
    tok = await ensureToken(true);
    if (!tok.ok) return tok;
    intento = await intentar(tok.data);
  }
  if (!intento.ok) return intento;
  if (intento.data.mensaje === "token-invalido") {
    return { ok: false, code: "TOKEN", message: "Token inválido tras renovación" };
  }

  const data = Array.isArray(intento.data.data) ? intento.data.data : [];
  logger.info({ n: data.length }, "Phir-it API: estudios consultados");
  return { ok: true, data: data.map((e) => normalizarEstudio(e as Record<string, unknown>)) };
}
