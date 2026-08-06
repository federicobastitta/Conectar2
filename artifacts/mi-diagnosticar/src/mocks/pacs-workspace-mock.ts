// ⚠️  ARCHIVO AISLADO — SOLO REFERENCIA HISTÓRICA ────────────────────────────
// Este archivo NO se usa en la aplicación. Las páginas de Estudios consumen
// las APIs reales via src/api/pacs-workspace.ts.
//
// La copia funcional con datos demo se conserva en:
//   pacs-workspace-mock.demo.ts
//
// NO importar este archivo en código de producción ni de desarrollo activo.
// ─────────────────────────────────────────────────────────────────────────────

export type EstadoOperativo =
  | "AGENDADO"
  | "RECEPCIONADO"
  | "PENDIENTE_DE_INFORME"
  | "INFORMADO"
  | "AUSENTE";

export type EstadoInforme = "borrador" | "firmado" | "publicado";

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

export const MODALIDADES = ["CR", "CT", "MR", "US", "MG"] as const;
