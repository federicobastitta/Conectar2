// ── API layer PACS Workspace — consumo real del backend ──────────────────────
// Reemplaza los mocks de pacs-workspace-mock.demo.ts / use-pacs-workspace-store.demo.ts.
// Usa fetch con Bearer token desde localStorage, igual que el resto del frontend.
// Con PACS_WORKSPACE_ENABLED=false el backend responde 404 → pacsIndisponible=true.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

// ── Tipos públicos ────────────────────────────────────────────────────────────

export type EstadoOperativo =
  | "AGENDADO"
  | "RECEPCIONADO"
  | "PENDIENTE_DE_INFORME"
  | "INFORMADO"
  | "AUSENTE";

export type EstadoInforme = "borrador" | "firmado" | "publicado";

export interface PacsPaciente {
  id: number;
  nombre: string;
  apellido: string;
  dni: string | null;
  cobertura: string | null;
  nroAfiliado: string | null;
  fechaNacimiento: string | null;
  sexo: string | null;
}

export interface PacsProfesional {
  id: number;
  nombre: string;
  apellido: string | null;
  matricula: string | null;
}

export interface PacsOrden {
  id: number;
  accessionNumber: string | null;
  modality: string | null;
  studyName: string;
  studyType: string;
  motivoEstudio: string | null;
  observacionesTecnico: string | null;
  scheduledAt: string | null;
  status: string;
  estadoOperativo: EstadoOperativo;
  informeEstado: EstadoInforme | null;
  informeId: number | null;
  createdAt: string;
  paciente: PacsPaciente | null;
  profesional: PacsProfesional | null;
}

export interface ImagenClave {
  keyImageId: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  titulo: string;
  comentarioMedico: string;
  orden: number;
}

export interface VersionInforme {
  id: number;
  version: number;
  texto: string;
  firmadoPor: number | null;
  firmadoPorNombre: string | null;
  firmadoEn: string | null;
  publicadoEn: string | null;
}

export interface PacsInforme {
  id: number;
  studyOrderId: number;
  estadoOperativo: EstadoOperativo;
  informeEstado: EstadoInforme;
  borradorActual: string;
  imagenesClaveBorrador: ImagenClave[];
  versiones: VersionInforme[];
}

// ── Error especial: módulo no habilitado (flag off) ───────────────────────────

export class PacsIndisponibleError extends Error {
  constructor() {
    super("PACS workspace no disponible (módulo desactivado)");
    this.name = "PacsIndisponibleError";
  }
}

// ── Fetch base autenticado ────────────────────────────────────────────────────

async function pacsGet<T>(path: string): Promise<T> {
  const token = localStorage.getItem("auth_token") ?? "";
  const res = await fetch(`/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) throw new PacsIndisponibleError();
  if (res.status === 401 || res.status === 403) {
    throw new Error("Sin permisos para acceder al workspace PACS");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function pacsPost<T>(path: string, body?: unknown): Promise<T> {
  const token = localStorage.getItem("auth_token") ?? "";
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) throw new PacsIndisponibleError();
  if (res.status === 401 || res.status === 403) {
    throw new Error("Sin permisos");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `Error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function pacsPut<T>(path: string, body?: unknown): Promise<T> {
  const token = localStorage.getItem("auth_token") ?? "";
  const res = await fetch(`/api${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) throw new PacsIndisponibleError();
  if (res.status === 401 || res.status === 403) throw new Error("Sin permisos");
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `Error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function pacsPatch<T>(path: string, body?: unknown): Promise<T> {
  const token = localStorage.getItem("auth_token") ?? "";
  const res = await fetch(`/api${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) throw new PacsIndisponibleError();
  if (res.status === 401 || res.status === 403) throw new Error("Sin permisos");
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `Error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const pacsKeys = {
  ordenes: () => ["pacs", "ordenes"] as const,
  orden: (id: number) => ["pacs", "ordenes", id] as const,
  informe: (ordenId: number) => ["pacs", "ordenes", ordenId, "informe"] as const,
};

// ── Hooks de consulta ─────────────────────────────────────────────────────────

export function usePacsOrdenes() {
  const q = useQuery({
    queryKey: pacsKeys.ordenes(),
    queryFn: () => pacsGet<{ ordenes: PacsOrden[] }>("/pacs-workspace/ordenes").then((r) => r.ordenes),
    retry: (failCount, err) => !(err instanceof PacsIndisponibleError) && failCount < 2,
    staleTime: 30_000,
  });
  const pacsIndisponible = q.error instanceof PacsIndisponibleError;
  return { ...q, pacsIndisponible };
}

export function usePacsOrden(id: number) {
  const q = useQuery({
    queryKey: pacsKeys.orden(id),
    queryFn: () => pacsGet<PacsOrden>(`/pacs-workspace/ordenes/${id}`),
    enabled: Number.isInteger(id) && id > 0,
    retry: (failCount, err) => !(err instanceof PacsIndisponibleError) && failCount < 2,
    staleTime: 30_000,
  });
  const pacsIndisponible = q.error instanceof PacsIndisponibleError;
  return { ...q, pacsIndisponible };
}

export function usePacsInforme(ordenId: number) {
  const q = useQuery({
    queryKey: pacsKeys.informe(ordenId),
    queryFn: () => pacsGet<PacsInforme>(`/pacs-workspace/ordenes/${ordenId}/informe`),
    enabled: Number.isInteger(ordenId) && ordenId > 0,
    retry: (failCount, err) => !(err instanceof PacsIndisponibleError) && failCount < 2,
    staleTime: 15_000,
  });
  const pacsIndisponible = q.error instanceof PacsIndisponibleError;
  return { ...q, pacsIndisponible };
}

// ── Hooks de mutación ─────────────────────────────────────────────────────────

export function useGuardarBorrador(ordenId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (texto: string) =>
      pacsPut<{ ok: boolean }>(`/pacs-workspace/ordenes/${ordenId}/informe/borrador`, { texto }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: pacsKeys.informe(ordenId) }),
  });
}

export function useFirmarInforme(ordenId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      pacsPost<{ ok: boolean; version: number }>(`/pacs-workspace/ordenes/${ordenId}/informe/firmar`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pacsKeys.informe(ordenId) });
      void qc.invalidateQueries({ queryKey: pacsKeys.orden(ordenId) });
      void qc.invalidateQueries({ queryKey: pacsKeys.ordenes() });
    },
  });
}

export function usePublicarInforme(ordenId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      pacsPost<{ ok: boolean }>(`/pacs-workspace/ordenes/${ordenId}/informe/publicar`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pacsKeys.informe(ordenId) });
      void qc.invalidateQueries({ queryKey: pacsKeys.ordenes() });
    },
  });
}

export function useCorregirInforme(ordenId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      pacsPost<{ ok: boolean }>(`/pacs-workspace/ordenes/${ordenId}/informe/corregir`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: pacsKeys.informe(ordenId) }),
  });
}

export function useActualizarImagenesClave(ordenId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (imagenes: ImagenClave[]) =>
      pacsPut<{ ok: boolean; total: number }>(
        `/pacs-workspace/ordenes/${ordenId}/informe/imagenes-clave`,
        { imagenes },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: pacsKeys.informe(ordenId) }),
  });
}

export function useCambiarEstadoOperativo(ordenId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (estadoOperativo: EstadoOperativo) =>
      pacsPatch<{ ok: boolean; estadoOperativo: string }>(
        `/pacs-workspace/ordenes/${ordenId}/estado`,
        { estadoOperativo },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pacsKeys.ordenes() });
      void qc.invalidateQueries({ queryKey: pacsKeys.orden(ordenId) });
      void qc.invalidateQueries({ queryKey: pacsKeys.informe(ordenId) });
    },
  });
}

export function useSesionVisor(ordenId: number) {
  return useMutation({
    mutationFn: () =>
      pacsPost<{
        session_id: string;
        redeem_code: string;
        redeem_url?: string;
        viewer_url?: string | null;
        expires_at: string;
        permitted_actions: string[];
      }>(`/pacs-workspace/ordenes/${ordenId}/sesion-visor`),
  });
}

// ── Helpers de presentación ───────────────────────────────────────────────────

export const ETIQUETAS_ESTADO: Record<EstadoOperativo, string> = {
  AGENDADO: "Agendado",
  RECEPCIONADO: "Recepcionado",
  PENDIENTE_DE_INFORME: "Pendiente de informe",
  INFORMADO: "Informado",
  AUSENTE: "Ausente",
};

export const COLORES_ESTADO: Record<EstadoOperativo, string> = {
  AGENDADO: "bg-slate-100 text-slate-700 border-slate-200",
  RECEPCIONADO: "bg-blue-50 text-blue-700 border-blue-200",
  PENDIENTE_DE_INFORME: "bg-amber-50 text-amber-700 border-amber-200",
  INFORMADO: "bg-emerald-50 text-emerald-700 border-emerald-200",
  AUSENTE: "bg-red-50 text-red-600 border-red-200",
};

export const ESTADOS_OPERATIVOS: EstadoOperativo[] = [
  "AGENDADO",
  "RECEPCIONADO",
  "PENDIENTE_DE_INFORME",
  "INFORMADO",
  "AUSENTE",
];

export const MODALIDADES = ["CR", "CT", "MR", "US", "MG"] as const;

// ── Hook compuesto: toggle imagen clave (igual que el store mock) ─────────────
// Devuelve una función que agrega/quita una imagen del borrador y persiste.
export function useToggleImagenClave(
  ordenId: number,
  informe: PacsInforme | undefined,
) {
  const actualizarImagenes = useActualizarImagenesClave(ordenId);
  return useCallback(
    (img: ImagenClave) => {
      if (!informe) return;
      const ya = informe.imagenesClaveBorrador.some((k) => k.keyImageId === img.keyImageId);
      let nuevas: ImagenClave[];
      if (ya) {
        nuevas = informe.imagenesClaveBorrador
          .filter((k) => k.keyImageId !== img.keyImageId)
          .map((k, idx) => ({ ...k, orden: idx + 1 }));
      } else {
        nuevas = [
          ...informe.imagenesClaveBorrador,
          { ...img, orden: informe.imagenesClaveBorrador.length + 1 },
        ];
      }
      actualizarImagenes.mutate(nuevas);
    },
    [informe, actualizarImagenes],
  );
}

export function useComentarImagenClave(
  ordenId: number,
  informe: PacsInforme | undefined,
) {
  const actualizarImagenes = useActualizarImagenesClave(ordenId);
  return useCallback(
    (keyImageId: string, comentarioMedico: string) => {
      if (!informe) return;
      const nuevas = informe.imagenesClaveBorrador.map((k) =>
        k.keyImageId === keyImageId ? { ...k, comentarioMedico } : k,
      );
      actualizarImagenes.mutate(nuevas);
    },
    [informe, actualizarImagenes],
  );
}
