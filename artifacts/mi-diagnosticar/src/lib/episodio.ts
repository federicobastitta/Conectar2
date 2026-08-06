export type EstadoEpisodio =
  | "pendiente"
  | "reservado"
  | "arribo"
  | "en_atencion"
  | "visto"
  | "pendiente_informe"
  | "informando"
  | "informado"
  | "publicado"
  | "visto_usuario"
  | "cancelado"
  | "ausente";

export interface EstadoMeta {
  label: string;
  color: string;
  bg: string;
  border: string;
  dot: string;
}

export const ESTADO_META: Record<string, EstadoMeta> = {
  pendiente: {
    label: "Reservado",
    color: "text-slate-600 dark:text-white/85",
    bg: "bg-slate-100 dark:bg-[#525E6F] estado-crayon",
    border: "border-slate-200 dark:border-[#6C7C93]",
    dot: "bg-slate-400/70",
  },
  reservado: {
    label: "Reservado",
    color: "text-slate-600 dark:text-white/85",
    bg: "bg-slate-100 dark:bg-[#525E6F] estado-crayon",
    border: "border-slate-200 dark:border-[#6C7C93]",
    dot: "bg-slate-400/70",
  },
  arribo: {
    label: "Arribó",
    color: "text-amber-600 dark:text-white/85",
    bg: "bg-amber-50 dark:bg-[#796D49] estado-crayon",
    border: "border-amber-200 dark:border-[#9F8F60]",
    dot: "bg-amber-400/70",
  },
  en_atencion: {
    label: "En atención",
    color: "text-blue-600 dark:text-white/85",
    bg: "bg-blue-50 dark:bg-[#495979] estado-crayon",
    border: "border-blue-200 dark:border-[#60759F]",
    dot: "bg-blue-400/70",
  },
  visto: {
    label: "Atendido",
    color: "text-pink-700 dark:text-white/85",
    bg: "bg-pink-100 dark:bg-[#79496B] estado-crayon",
    border: "border-pink-200 dark:border-[#9F608C]",
    dot: "bg-pink-400/70",
  },
  pendiente_informe: {
    label: "Pendiente informe",
    color: "text-orange-600 dark:text-white/85",
    bg: "bg-orange-50 dark:bg-[#795D49] estado-crayon",
    border: "border-orange-200 dark:border-[#9F7A60]",
    dot: "bg-orange-400/70",
  },
  informando: {
    label: "Informando",
    color: "text-violet-600 dark:text-white/85",
    bg: "bg-violet-50 dark:bg-[#614979] estado-crayon",
    border: "border-violet-200 dark:border-[#7F609F]",
    dot: "bg-violet-400/70",
  },
  informado: {
    label: "Informado",
    color: "text-emerald-600 dark:text-white/85",
    bg: "bg-emerald-50 dark:bg-[#497961] estado-crayon",
    border: "border-emerald-200 dark:border-[#609F80]",
    dot: "bg-emerald-400/70",
  },
  publicado: {
    label: "Publicado al portal",
    color: "text-teal-600 dark:text-white/85",
    bg: "bg-teal-50 dark:bg-[#497975] estado-crayon",
    border: "border-teal-200 dark:border-[#609F9A]",
    dot: "bg-teal-400/70",
  },
  visto_usuario: {
    label: "Visto por paciente",
    color: "text-emerald-600 dark:text-white/85",
    bg: "bg-emerald-50 dark:bg-[#497961] estado-crayon",
    border: "border-emerald-200 dark:border-[#609F80]",
    dot: "bg-emerald-400/70",
  },
  cancelado: {
    label: "Cancelado",
    color: "text-red-600 dark:text-white/85",
    bg: "bg-red-50 dark:bg-[#794949] estado-crayon",
    border: "border-red-200 dark:border-[#9F6060]",
    dot: "bg-red-400/70",
  },
  ausente: {
    label: "Ausente",
    color: "text-rose-600 dark:text-white/85",
    bg: "bg-rose-50 dark:bg-[#794955] estado-crayon",
    border: "border-rose-200 dark:border-[#9F6070]",
    dot: "bg-rose-400/70",
  },
  // Estados legacy (backward compat con datos viejos)
  confirmado: {
    label: "Confirmado",
    color: "text-sky-600 dark:text-white/85",
    bg: "bg-sky-50 dark:bg-[#496979] estado-crayon",
    border: "border-sky-200 dark:border-[#608A9F]",
    dot: "bg-sky-400/70",
  },
  en_sala: {
    label: "En sala",
    color: "text-amber-600 dark:text-white/85",
    bg: "bg-amber-50 dark:bg-[#796D49] estado-crayon",
    border: "border-amber-200 dark:border-[#9F8F60]",
    dot: "bg-amber-400/70",
  },
  atendido: {
    label: "Atendido",
    color: "text-pink-700 dark:text-white/85",
    bg: "bg-pink-100 dark:bg-[#79496B] estado-crayon",
    border: "border-pink-200 dark:border-[#9F608C]",
    dot: "bg-pink-400/70",
  },
};

// ── Tratamiento visual "Atendido" ──────────────────────────────────────────
// Al finalizar la consulta el turno queda en visto/pendiente_informe (u otros
// estados post-consulta). En los listados del día todos se muestran como
// "Atendido" y la fila entera se pinta de rosa (legible en claro y oscuro).

export const ESTADOS_ATENDIDO = [
  "visto",
  "atendido",
  "pendiente_informe",
  "informando",
  "informado",
  "publicado",
  "visto_usuario",
] as const;

export function esAtendido(estado: string): boolean {
  return (ESTADOS_ATENDIDO as readonly string[]).includes(estado);
}

// Fondo de fila rosa para turnos atendidos (fila completa, ambos temas).
export const FILA_ATENDIDO_BG = "bg-pink-100 dark:bg-pink-950/40";
// Texto legible sobre el fondo rosa de la fila.
export const FILA_ATENDIDO_TEXT = "text-pink-900 dark:text-pink-100";
// Chip compacto (tablas de recepción) para el estado Atendido.
export const CHIP_ATENDIDO = "bg-pink-200 text-pink-900";

export const ATENDIDO_META: EstadoMeta = {
  label: "Atendido",
  color: "text-pink-700 dark:text-white/85",
  bg: "bg-pink-100 dark:bg-[#79496B] estado-crayon",
  border: "border-pink-200 dark:border-[#9F608C]",
  dot: "bg-pink-400/70",
};

// Pastilla "Check in": el paciente reservó su lugar desde la app (check in
// previo de guardia presencial) y todavía no llegó a la clínica. Reemplaza a
// la pastilla de reservado/agendado hasta que aprieta "Ya llegué".
export const CHECK_IN_META: EstadoMeta = {
  label: "Check in",
  color: "text-teal-700 dark:text-white/85",
  bg: "bg-teal-50 dark:bg-[#496F79] estado-crayon",
  border: "border-teal-200 dark:border-[#60959F]",
  dot: "bg-teal-400/70",
};

export function getEstadoMeta(estado: string): EstadoMeta {
  return (
    ESTADO_META[estado] ?? {
      label: estado,
      color: "text-muted-foreground",
      bg: "bg-muted",
      border: "border-border",
      dot: "bg-muted-foreground",
    }
  );
}

// ── Estados macro ("emparentados") para la agenda ──────────────────────────
// Los estados finos de la máquina de episodios se agrupan en 5 estados macro
// que resumen el recorrido del turno: Agendado → Recepcionado → Pendiente de
// informe → Informado → Entregado. Cancelado y Ausente quedan aparte.

export type EstadoMacro =
  | "agendado"
  | "recepcionado"
  | "pendiente_informe"
  | "informado"
  | "entregado"
  | "cancelado"
  | "ausente";

const MACRO_DE_ESTADO: Record<string, EstadoMacro> = {
  pendiente: "agendado",
  reservado: "agendado",
  confirmado: "agendado",
  arribo: "recepcionado",
  llamado: "recepcionado",
  en_sala: "recepcionado",
  en_atencion: "recepcionado",
  // visto/atendido son estados de cierre (consulta sin informe): el recorrido
  // terminó, por eso se emparientan con "Entregado" y no con "Recepcionado".
  visto: "entregado",
  atendido: "entregado",
  pendiente_informe: "pendiente_informe",
  informando: "pendiente_informe",
  informado: "informado",
  publicado: "informado",
  visto_usuario: "entregado",
  cancelado: "cancelado",
  ausente: "ausente",
};

export function getEstadoMacro(estado: string): EstadoMacro {
  return MACRO_DE_ESTADO[estado] ?? "agendado";
}

export const ESTADO_MACRO_META: Record<EstadoMacro, EstadoMeta> = {
  agendado: {
    label: "Agendado",
    color: "text-sky-600 dark:text-white/85",
    bg: "bg-sky-50 dark:bg-[#496979] estado-crayon",
    border: "border-sky-200 dark:border-[#608A9F]",
    dot: "bg-sky-400/70",
  },
  recepcionado: {
    label: "Recepcionado",
    color: "text-amber-600 dark:text-white/85",
    bg: "bg-amber-50 dark:bg-[#796D49] estado-crayon",
    border: "border-amber-200 dark:border-[#9F8F60]",
    dot: "bg-amber-400/70",
  },
  pendiente_informe: {
    label: "Pendiente de informe",
    color: "text-orange-600 dark:text-white/85",
    bg: "bg-orange-50 dark:bg-[#795D49] estado-crayon",
    border: "border-orange-200 dark:border-[#9F7A60]",
    dot: "bg-orange-400/70",
  },
  informado: {
    label: "Informado",
    color: "text-emerald-600 dark:text-white/85",
    bg: "bg-emerald-50 dark:bg-[#497961] estado-crayon",
    border: "border-emerald-200 dark:border-[#609F80]",
    dot: "bg-emerald-400/70",
  },
  entregado: {
    label: "Entregado",
    color: "text-teal-600 dark:text-white/85",
    bg: "bg-teal-50 dark:bg-[#497975] estado-crayon",
    border: "border-teal-200 dark:border-[#609F9A]",
    dot: "bg-teal-400/70",
  },
  cancelado: {
    label: "Cancelado",
    color: "text-red-600 dark:text-white/85",
    bg: "bg-red-50 dark:bg-[#794949] estado-crayon",
    border: "border-red-200 dark:border-[#9F6060]",
    dot: "bg-red-400/70",
  },
  ausente: {
    label: "Ausente",
    color: "text-rose-600 dark:text-white/85",
    bg: "bg-rose-50 dark:bg-[#794955] estado-crayon",
    border: "border-rose-200 dark:border-[#9F6070]",
    dot: "bg-rose-400/70",
  },
};

// Orden de presentación de los estados macro en filtros/listados.
export const ESTADOS_MACRO_ORDEN: EstadoMacro[] = [
  "agendado",
  "recepcionado",
  "pendiente_informe",
  "informado",
  "entregado",
  "cancelado",
  "ausente",
];

export type AccionRapida = {
  label: string;
  nuevoEstado: EstadoEpisodio;
  icon: string;
  variant: "default" | "outline" | "destructive" | "secondary";
};

export const ACCIONES_POR_ESTADO: Record<string, AccionRapida[]> = {
  pendiente: [
    { label: "Registrar arribo", nuevoEstado: "arribo", icon: "LogIn", variant: "default" },
    { label: "Ausente", nuevoEstado: "ausente", icon: "UserX", variant: "outline" },
    { label: "Cancelar", nuevoEstado: "cancelado", icon: "X", variant: "destructive" },
  ],
  reservado: [
    { label: "Registrar arribo", nuevoEstado: "arribo", icon: "LogIn", variant: "default" },
    { label: "Ausente", nuevoEstado: "ausente", icon: "UserX", variant: "outline" },
    { label: "Cancelar", nuevoEstado: "cancelado", icon: "X", variant: "destructive" },
  ],
  arribo: [
    { label: "Iniciar atención", nuevoEstado: "en_atencion", icon: "Stethoscope", variant: "default" },
    { label: "Ausente", nuevoEstado: "ausente", icon: "UserX", variant: "outline" },
    { label: "Cancelar", nuevoEstado: "cancelado", icon: "X", variant: "destructive" },
  ],
  en_atencion: [
    { label: "Marcar visto", nuevoEstado: "visto", icon: "CheckCircle", variant: "default" },
    { label: "Pend. informe", nuevoEstado: "pendiente_informe", icon: "FileText", variant: "secondary" },
  ],
  ausente: [
    { label: "Registrar arribo", nuevoEstado: "arribo", icon: "LogIn", variant: "outline" },
  ],
};

export function needsInforme(estado: string): boolean {
  return ["pendiente_informe", "informando", "informado", "publicado", "visto_usuario"].includes(estado);
}

export function isTerminal(estado: string): boolean {
  return ["visto", "cancelado", "visto_usuario"].includes(estado);
}
