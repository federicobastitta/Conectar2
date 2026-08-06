const API = "/api";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Tipos ─────────────────────────────────────────────────────────────────────
export type EstadoOrden =
  | "creada" | "pendiente_validacion" | "validada" | "arribado"
  | "en_realizacion" | "pendiente_informe" | "informada" | "publicada"
  | "rechazada" | "cancelada";

export const ETIQUETAS_ESTADO: Record<EstadoOrden, string> = {
  creada: "Creada",
  pendiente_validacion: "Pend. validación",
  validada: "Validada",
  arribado: "Arribó",
  en_realizacion: "En realización",
  pendiente_informe: "Pend. informe",
  informada: "Informada",
  publicada: "Publicada",
  rechazada: "Rechazada",
  cancelada: "Cancelada",
};

export const COLORES_ESTADO: Record<EstadoOrden, string> = {
  creada: "bg-gray-100 text-gray-700",
  pendiente_validacion: "bg-yellow-100 text-yellow-800",
  validada: "bg-blue-100 text-blue-800",
  arribado: "bg-indigo-100 text-indigo-800",
  en_realizacion: "bg-purple-100 text-purple-800",
  pendiente_informe: "bg-orange-100 text-orange-800",
  informada: "bg-teal-100 text-teal-800",
  publicada: "bg-green-100 text-green-800",
  rechazada: "bg-red-100 text-red-800",
  cancelada: "bg-gray-200 text-gray-500",
};

export interface PracticaCatalogo {
  id: number;
  codigo: string;
  nombre: string;
  especialidad: string;
  categoria: string;
  /** Descripciones del nomenclador con el mismo código (ej. "ECOGRAFIA MAMARIA BILATERAL"). */
  sinonimos?: string[];
  /** Código numérico del nomenclador (ej. "180106"), si se pudo derivar del código del catálogo. */
  codigoNomenclador?: string | null;
  /** Todos los códigos que componen el estudio, sin repetidos (ej. Eco Abdomen = ["180112","180113"]). */
  codigosNomenclador?: string[];
  /** Listado completo con repeticiones para facturación (ej. mamografía bilateral = 340601 x2 + 340602 x2). */
  codigos?: string[] | null;
  permiteContraste: boolean;
  modalidadDicom: string | null;
  generaDicom: boolean;
  usaWorkspacePacs: boolean;
  requiereTokenKlinicos: boolean;
  requiereRegion: boolean;
  requiereLateralidad: boolean;
  preparacion: string | null;
  requisitosDocumentacion: string | null;
  reglasKlinicos: Record<string, string> | null;
  activo: boolean;
  sortOrder: number;
}

export interface OrdenPractica {
  id: number;
  ordenUuid: string;
  numeroOrden: string;
  accessionNumber: string | null;
  patientId: number;
  professionalId: number;
  practicaId: number;
  sedeId: number | null;
  estado: EstadoOrden;
  prioridad: "normal" | "urgente" | "programada";
  motivoClinico: string;
  diagnosticoCie10: string | null;
  region: string | null;
  lateralidad: string | null;
  observaciones: string | null;
  fechaOrden: string;
  fechaRealizacionEstimada: string | null;
  coberturaObra: string | null;
  coberturaPlan: string | null;
  coberturaNumeroAfiliado: string | null;
  klinicosEstado: string | null;
  klinicosAuthorizationNumber: string | null;
  klinicosTokenMasked: string | null;
  pacsOrdenEnviada: boolean;
  informeEjecutivoUrl: string | null;
  informeAnexosUrl: string | null;
  informeVersion: number | null;
  informeChecksum: string | null;
  informeConclusion: string | null;
  informePaginasEjecutivo: number | null;
  informeFirmanteNombre: string | null;
  informeFirmanteMatricula: string | null;
  informeFirmanteEspecialidad: string | null;
  informeFirmadoAt: string | null;
  turnoId: number | null;
  canceladoMotivo: string | null;
  rechazadoMotivo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrdenListItem {
  orden: OrdenPractica;
  practica: { nombre: string; especialidad: string; modalidadDicom: string | null; generaDicom: boolean } | null;
  paciente: { nombre: string; apellido: string; dni: string | null } | null;
  turno?: { fecha: string; horaInicio: string; estado: string } | null;
}

// ── Asignación de turno directo desde la orden ───────────────────────────────
export interface OpcionTurnoSugerida {
  turneraId: number;
  turneraNombre: string;
  profesional: string | null;
  sede: string | null;
  fecha: string;
  horaInicio: string;
  horaFin: string;
}

export interface SugerenciasTurno {
  ordenId: number;
  turnoId: number | null;
  tipo: "opciones" | "demanda_espontanea" | "sin_agenda" | "sin_disponibilidad";
  /** Modalidad de atención de la práctica: solo turno, solo demanda espontánea o mixta. */
  modalidad: "turno" | "demanda" | "mixta";
  opciones: OpcionTurnoSugerida[];
  guardia?: { turneraId: number; nombre: string; sede: string | null };
  practica: { id: number; nombre: string; codigoNomenclador: string | null };
  paciente: {
    id: number;
    dni: string | null;
    nombre: string;
    apellido: string;
    telefono: string | null;
    cobertura: string | null;
    nroAfiliado: string | null;
  } | null;
}

export async function getSugerenciasTurno(ordenId: number) {
  return apiFetch<SugerenciasTurno>(`/ordenes-practicas/${ordenId}/sugerencias-turno`);
}

export async function asignarTurnoOrden(
  ordenId: number,
  body: { turneraId: number; fecha?: string; horaInicio?: string },
) {
  return apiFetch<{ ok: boolean; turno: { id: number; fecha: string; horaInicio: string; esGuardia: boolean } }>(
    `/ordenes-practicas/${ordenId}/asignar-turno`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export interface CrearOrdenBody {
  practicaId: number;
  patientId: number;
  professionalId: number;
  sedeId?: number;
  motivoClinico: string;
  diagnosticoCie10?: string;
  region?: string;
  lateralidad?: string;
  observaciones?: string;
  fechaOrden: string;
  fechaRealizacionEstimada?: string;
  coberturaObra?: string;
  coberturaPlan?: string;
  coberturaNumeroAfiliado?: string;
  prioridad?: "normal" | "urgente" | "programada";
  token?: string;
}

// ── API ───────────────────────────────────────────────────────────────────────
export async function getPracticasCatalogo(soloActivas = true) {
  return apiFetch<{ practicas: PracticaCatalogo[] }>(
    `/practicas-catalogo?activo=${soloActivas}`,
  );
}

export async function crearPracticaCatalogo(data: Partial<PracticaCatalogo>) {
  return apiFetch<{ practica: PracticaCatalogo }>("/practicas-catalogo", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function actualizarPracticaCatalogo(id: number, data: Partial<PracticaCatalogo>) {
  return apiFetch<{ practica: PracticaCatalogo }>(`/practicas-catalogo/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function desactivarPracticaCatalogo(id: number) {
  return apiFetch<{ ok: boolean }>(`/practicas-catalogo/${id}`, { method: "DELETE" });
}

export async function getOrdenesPracticas(params?: {
  estado?: EstadoOrden;
  patientId?: number;
  practicaId?: number;
  fecha?: string;
  dni?: string;
  limit?: number;
  offset?: number;
}) {
  const q = new URLSearchParams();
  if (params?.estado) q.set("estado", params.estado);
  if (params?.patientId) q.set("patientId", String(params.patientId));
  if (params?.practicaId) q.set("practicaId", String(params.practicaId));
  if (params?.fecha) q.set("fecha", params.fecha);
  if (params?.dni) q.set("dni", params.dni);
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.offset) q.set("offset", String(params.offset));
  return apiFetch<{ ordenes: OrdenListItem[]; fechaCorte: string }>(
    `/ordenes-practicas?${q}`,
  );
}

export async function getOrdenPractica(id: number) {
  return apiFetch<{
    orden: OrdenPractica;
    practica: PracticaCatalogo | null;
    paciente: Record<string, unknown> | null;
    profesional: Record<string, unknown> | null;
    log: Array<{ id: number; estadoAnterior: string | null; estadoNuevo: string; motivo: string | null; createdAt: string }>;
  }>(`/ordenes-practicas/${id}`);
}

export async function crearOrdenPractica(body: CrearOrdenBody) {
  return apiFetch<{ orden: OrdenPractica }>("/ordenes-practicas", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function cambiarEstadoOrden(id: number, estado: EstadoOrden, motivo?: string) {
  return apiFetch<{ orden: OrdenPractica }>(`/ordenes-practicas/${id}/estado`, {
    method: "PATCH",
    body: JSON.stringify({ estado, motivo }),
  });
}

// Borra de un clic las órdenes de prueba TEST (motivo "TEST - Orden de prueba…")
// junto con sus turnos y su historial. Solo admin.
export async function limpiarOrdenesTest() {
  return apiFetch<{ ordenesEliminadas: number; turnosEliminados: number; numeros: string[] }>(
    "/ordenes-practicas/limpiar-test",
    { method: "POST" },
  );
}

export async function abrirSesionVisor(id: number) {
  return apiFetch<{
    sessionId: string;
    redeemUrl: string | null;
    viewerUrl: string | null;
    expiresAt: string;
  }>(`/ordenes-practicas/${id}/sesion-visor`, { method: "POST" });
}

export async function getPulsoBacklog(params?: { patientId?: number; limit?: number; offset?: number }) {
  const q = new URLSearchParams();
  if (params?.patientId) q.set("patientId", String(params.patientId));
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.offset) q.set("offset", String(params.offset));
  return apiFetch<{
    estudios: unknown[];
    soloLectura: boolean;
    fechaCorte: string;
    mensaje: string;
  }>(`/ordenes-practicas/pulso-backlog?${q}`);
}
