// ── Cliente de DiagnostiPACS (medical-vision-ai.replit.app) ────────────────
// PACS propio con análisis de imágenes por IA. Autenticación por token
// Bearer (Secret PACS_API_TOKEN). Endpoints usados:
//   GET  /api/studies          → todos los estudios (filtramos por DNI acá)
//   POST /api/phir/import      → le pide al PACS que importe desde Phir-it
//                                los estudios de un DNI.
import { pixelEnvioActivo } from "./pixel-guard";
import { logger as _diagLogger } from "../lib/logger";

const BASE_URL = (process.env.DIAGNOSTIPACS_BASE_URL ?? "https://medical-vision-ai.replit.app").replace(/\/$/, "");

export interface DicomPacsEstudio {
  id: string;
  patientDni: string | null;
  patientName: string | null;
  studyDate: string | null;
  modality: string | null;
  status: string | null;
  imageUrl: string | null;
  impression: string | null;
  viewerUrl: string | null;
  createdAt: string | null;
}

export interface DicomPacsImportResult {
  imported: number;
  skipped: number;
  failed: number;
}

export type DicomPacsResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "SIN_CONFIG" | "HTTP" | "RESPUESTA"; message: string };

// El token vigente lo entrega DiagnostiPACS como CONECTAR_INTEGRATION_TOKEN;
// PACS_API_TOKEN queda como fallback histórico.
function token(): string | null {
  return process.env.CONECTAR_INTEGRATION_TOKEN?.trim() || process.env.PACS_API_TOKEN?.trim() || null;
}

export function dicomPacsConfigurado(): boolean {
  return Boolean(token());
}

async function pacsFetch(path: string, init?: RequestInit): Promise<DicomPacsResult<unknown>> {
  const t = token();
  if (!t) return { ok: false, code: "SIN_CONFIG", message: "Falta PACS_API_TOKEN" };
  // Guard: solicitudes que mutan datos (no-GET) solo salen en producción.
  const method = ((init?.method as string | undefined) ?? "GET").toUpperCase();
  if (method !== "GET" && !pixelEnvioActivo()) {
    _diagLogger.info({ operacion: path, method }, "Pixel: envío omitido en entorno no-producción");
    return { ok: false, code: "SIN_CONFIG", message: `Pixel: envío omitido en entorno no-producción (${method} ${path})` };
  }
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, code: "HTTP", message: `No se pudo contactar DiagnostiPACS: ${String(err)}` };
  }
  if (!res.ok) {
    return { ok: false, code: "HTTP", message: `DiagnostiPACS devolvió HTTP ${res.status} en ${path}` };
  }
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, code: "RESPUESTA", message: `Respuesta no-JSON de DiagnostiPACS en ${path}` };
  }
}

interface StudyRaw {
  id?: string | number;
  patientDni?: string | null;
  patientName?: string | null;
  studyDate?: string | null;
  modality?: string | null;
  status?: string | null;
  imageUrl?: string | null;
  impression?: string | null;
  createdAt?: string | null;
}

function normalizarEstudio(s: StudyRaw): DicomPacsEstudio {
  const id = String(s.id ?? "");
  return {
    id,
    patientDni: s.patientDni ?? null,
    patientName: s.patientName ?? null,
    studyDate: s.studyDate ?? null,
    modality: s.modality ?? null,
    status: s.status ?? null,
    imageUrl: s.imageUrl ?? null,
    impression: s.impression ?? null,
    viewerUrl: id ? `${BASE_URL}/estudio/${encodeURIComponent(id)}` : null,
    createdAt: s.createdAt ?? null,
  };
}

// Solo dígitos: los DNI pueden venir con puntos ("12.345.678") de un lado u otro.
function dniNormalizado(dni: string): string {
  return dni.replace(/\D/g, "");
}

export async function getEstudiosDicomTodos(): Promise<DicomPacsResult<DicomPacsEstudio[]>> {
  const r = await pacsFetch("/api/studies");
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) {
    return { ok: false, code: "RESPUESTA", message: "DiagnostiPACS /api/studies no devolvió una lista" };
  }
  return { ok: true, data: (r.data as StudyRaw[]).map(normalizarEstudio) };
}

export async function getEstudiosDicomByDni(dni: string): Promise<DicomPacsResult<DicomPacsEstudio[]>> {
  const r = await pacsFetch("/api/studies");
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) {
    return { ok: false, code: "RESPUESTA", message: "DiagnostiPACS /api/studies no devolvió una lista" };
  }
  const objetivo = dniNormalizado(dni);
  const estudios = (r.data as StudyRaw[])
    .filter((s) => s.patientDni && dniNormalizado(String(s.patientDni)) === objetivo)
    .map(normalizarEstudio);
  return { ok: true, data: estudios };
}

// Enlace de solo lectura al portal por paciente (médicos solicitantes).
// El PACS devuelve un link multiuso de 180 días; pedimos uno nuevo por vez
// (llamada liviana, recomendado por el instructivo de DiagnostiPACS).
export interface DicomPacsPortalLink {
  url: string;
  expiresAt: string | null;
}

export async function crearPortalPacienteLink(dni: string): Promise<DicomPacsResult<DicomPacsPortalLink>> {
  const r = await pacsFetch("/api/v1/integration/patient-portal-links", {
    method: "POST",
    body: JSON.stringify({ document_number: dniNormalizado(dni) }),
  });
  if (!r.ok) return r;
  const body = r.data as { url?: string; expires_at?: string };
  if (!body.url) {
    return { ok: false, code: "RESPUESTA", message: "DiagnostiPACS no devolvió la URL del portal del paciente" };
  }
  return { ok: true, data: { url: body.url, expiresAt: body.expires_at ?? null } };
}

// Enlace de solo lectura al listado general de estudios del portal.
// Multiuso, 180 días de vigencia; sin cuerpo en el POST.
export async function crearPortalListadoLink(): Promise<DicomPacsResult<DicomPacsPortalLink>> {
  const r = await pacsFetch("/api/v1/integration/portal-links", { method: "POST" });
  if (!r.ok) return r;
  const body = r.data as { url?: string; expires_at?: string };
  if (!body.url) {
    return { ok: false, code: "RESPUESTA", message: "DiagnostiPACS no devolvió la URL del listado del portal" };
  }
  return { ok: true, data: { url: body.url, expiresAt: body.expires_at ?? null } };
}

// Enlace firmado al portal de la worklist (sin login de Pixel). Multiuso,
// se pide uno nuevo en cada apertura del panel embebido.
export async function crearWorklistPortalLink(): Promise<DicomPacsResult<DicomPacsPortalLink>> {
  const r = await pacsFetch("/api/v1/integration/worklist-portal-link", { method: "POST" });
  if (!r.ok) return r;
  const body = r.data as { url?: string; expires_at?: string };
  if (!body.url) {
    return { ok: false, code: "RESPUESTA", message: "DiagnostiPACS no devolvió la URL del portal de la worklist" };
  }
  return { ok: true, data: { url: body.url, expiresAt: body.expires_at ?? null } };
}

// URL directa a la orden para médicos informantes (usuarios del PACS).
export function urlOrdenDiagnostipacs(ordenUuid: string): string {
  return `${BASE_URL}/orden/${encodeURIComponent(ordenUuid)}`;
}

export async function importarDesdePhir(dni: string): Promise<DicomPacsResult<DicomPacsImportResult>> {
  const r = await pacsFetch("/api/phir/import", {
    method: "POST",
    body: JSON.stringify({ dni: dniNormalizado(dni) }),
  });
  if (!r.ok) return r;
  const body = r.data as Partial<DicomPacsImportResult>;
  return {
    ok: true,
    data: {
      imported: body.imported ?? 0,
      skipped: body.skipped ?? 0,
      failed: body.failed ?? 0,
    },
  };
}
