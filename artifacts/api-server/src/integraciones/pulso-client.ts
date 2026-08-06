import type { Logger } from "pino";

// ── Cliente de la API de Pulso ──────────────────────────────────────────────
// Pulso (https://pulso.diagnosticar.org/api/v1) es una de las entradas de
// pacientes de la clínica. Su API es REST con auth JWT (access ~30min + refresh).
// Este cliente maneja el ciclo de login/refresh y expone la lista paginada de
// pacientes. NO persiste nada: solo habla con Pulso.

const DEFAULT_BASE_URL = "https://pulso.diagnosticar.org/api/v1";

function baseUrl(): string {
  return (process.env["PULSO_BASE_URL"]?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

export function pulsoConfigurado(): boolean {
  return Boolean(process.env["PULSO_USERNAME"]?.trim() && process.env["PULSO_PASSWORD"]?.trim());
}

export type PulsoPaciente = {
  id: string;
  dni: string | null;
  nombre: string | null;
  apellido: string | null;
  fecha_nacimiento: string | null;
  sexo: string | null;
  telefono: string | null;
  whatsapp: string | null;
  email: string | null;
  obra_social: { nombre?: string | null } | null;
  numero_afiliado: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type PulsoPage = {
  count: number;
  next: string | null;
  previous: string | null;
  results: PulsoPaciente[];
};

// Token de acceso cacheado en memoria del proceso. El refresh de Pulso rota, así
// que ante 401 simplemente volvemos a loguear con usuario/contraseña.
let accessToken: string | null = null;
let accessExpiraEn = 0; // epoch ms

class PulsoError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PulsoError";
    this.status = status;
  }
}

async function login(log?: Logger): Promise<string> {
  const username = process.env["PULSO_USERNAME"]?.trim();
  const password = process.env["PULSO_PASSWORD"]?.trim();
  if (!username || !password) {
    throw new PulsoError("Faltan credenciales de Pulso (PULSO_USERNAME/PULSO_PASSWORD)", 500);
  }
  const res = await fetch(`${baseUrl()}/auth/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) {
    const body = await res.text().catch(() => "");
    throw new PulsoError(`Login de Pulso falló (${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  const data = (await res.json()) as { access?: string };
  if (!data.access) {
    throw new PulsoError("Login de Pulso no devolvió token de acceso", 502);
  }
  accessToken = data.access;
  // El access dura ~30min; refrescamos preventivamente a los 25min.
  accessExpiraEn = Date.now() + 25 * 60 * 1000;
  log?.info("Pulso: login OK");
  return accessToken;
}

async function getAccessToken(log?: Logger): Promise<string> {
  if (accessToken && Date.now() < accessExpiraEn) return accessToken;
  return login(log);
}

// GET autenticado con un reintento tras re-login si el token expiró (401).
async function pulsoGet<T>(path: string, log?: Logger): Promise<T> {
  const doFetch = async (token: string) =>
    fetch(`${baseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

  let token = await getAccessToken(log);
  let res = await doFetch(token);
  if (res.status === 401) {
    accessToken = null;
    token = await login(log);
    res = await doFetch(token);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PulsoError(`Pulso GET ${path} falló (${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  return (await res.json()) as T;
}

export async function fetchPacientesPage(
  page: number,
  pageSize: number,
  log?: Logger,
): Promise<PulsoPage> {
  const qs = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    ordering: "-created_at",
  });
  return pulsoGet<PulsoPage>(`/pacientes/?${qs.toString()}`, log);
}

// ── Estudios / Informes ─────────────────────────────────────────────────────

// Estudio tal como lo devuelve Pulso en GET /estudios/. Solo tipamos lo que
// consumimos; el resto viaja en `raw`.
export type PulsoEstudio = {
  id: string;
  id_legible: string | null;
  paciente: {
    id?: string;
    dni?: string | null;
    nombre?: string | null;
    apellido?: string | null;
  } | null;
  tipo_estudio: { id?: string; nombre?: string | null; modalidad?: string | null } | null;
  modalidad: string | null;
  sede: { id?: string; nombre?: string | null; direccion?: string | null } | null;
  medico_asignado: { first_name?: string | null; last_name?: string | null; matricula?: string | null } | null;
  medico_derivante: { nombre?: string | null; apellido?: string | null; matricula?: string | null } | null;
  estado: string | null;
  fecha_estudio: string | null;
  observaciones: string | null;
  tiene_informe: boolean | null;
  created_at: string | null;
  updated_at: string | null;
  // Presente en el historial del paciente; en /estudios/ puede no venir.
  informe?: { id?: string; firmado?: boolean; firmado_at?: string | null } | null;
};

type PulsoEstudiosPage = {
  count: number;
  next: string | null;
  previous: string | null;
  results: PulsoEstudio[];
};

// Detalle de informe (GET /informes/{id}/). hallazgos/conclusion son HTML
// sanitizado por Pulso.
export type PulsoInformeDetalle = {
  id: string;
  estudio: {
    id?: string;
    id_legible?: string | null;
    paciente?: { dni?: string | null; nombre?: string | null; apellido?: string | null } | null;
    tipo_estudio?: { nombre?: string | null } | null;
    sede?: { nombre?: string | null } | null;
    fecha_estudio?: string | null;
    estado?: string | null;
    medico_asignado?: { first_name?: string | null; last_name?: string | null; matricula?: string | null } | null;
  } | null;
  motivo: string | null;
  hallazgos: string | null;
  conclusion: string | null;
  observaciones: string | null;
  enlace_pacs: string | null;
  firmado: boolean;
  firmado_por: { first_name?: string | null; last_name?: string | null; matricula?: string | null } | null;
  firmado_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

// Una página de estudios de Pulso. Se puede filtrar por fecha_desde (ventana
// rodante para captar firmas/cambios de estado) o por paciente_dni.
export async function fetchEstudiosPage(
  params: { page: number; pageSize: number; fechaDesde?: string; pacienteDni?: string },
  log?: Logger,
): Promise<PulsoEstudiosPage> {
  const qs = new URLSearchParams({
    page: String(params.page),
    page_size: String(params.pageSize),
    ordering: "-created_at",
  });
  if (params.fechaDesde) qs.set("fecha_desde", params.fechaDesde);
  if (params.pacienteDni) qs.set("paciente_dni", params.pacienteDni);
  return pulsoGet<PulsoEstudiosPage>(`/estudios/?${qs.toString()}`, log);
}

export async function fetchInformeDetalle(id: string, log?: Logger): Promise<PulsoInformeDetalle> {
  return pulsoGet<PulsoInformeDetalle>(`/informes/${encodeURIComponent(id)}/`, log);
}

// Descarga el PDF firmado de un informe. Devuelve el binario y su content-type
// para que la ruta lo re-emita al frontend (proxy autenticado).
export async function fetchInformePdf(
  id: string,
  log?: Logger,
): Promise<{ buffer: Buffer; contentType: string }> {
  const doFetch = async (token: string) =>
    fetch(`${baseUrl()}/informes/${encodeURIComponent(id)}/pdf/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/pdf" },
    });

  let token = await getAccessToken(log);
  let res = await doFetch(token);
  if (res.status === 401) {
    accessToken = null;
    token = await login(log);
    res = await doFetch(token);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PulsoError(`Pulso PDF informe ${id} falló (${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: res.headers.get("content-type") ?? "application/pdf",
  };
}

export { PulsoError };
