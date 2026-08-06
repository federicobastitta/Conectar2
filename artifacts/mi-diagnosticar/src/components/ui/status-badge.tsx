import { getEstadoMeta, getEstadoMacro, ESTADO_MACRO_META } from "@/lib/episodio";

export function StatusBadge({ estado }: { estado: string }) {
  const meta = getEstadoMeta(estado);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium border ${meta.bg} ${meta.color} ${meta.border}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

// Badge del estado macro ("emparentado"): Agendado / Recepcionado /
// Pendiente de informe / Informado / Entregado. Opcionalmente muestra el
// estado fino como detalle si difiere del label macro.
export function StatusMacroBadge({ estado, conDetalle = false }: { estado: string; conDetalle?: boolean }) {
  const macro = getEstadoMacro(estado);
  const meta = ESTADO_MACRO_META[macro];
  const fino = getEstadoMeta(estado);
  const mostrarDetalle = conDetalle && fino.label !== meta.label;
  return (
    <div className="inline-flex flex-col items-start gap-0.5">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium border ${meta.bg} ${meta.color} ${meta.border}`}
        data-testid={`badge-macro-${macro}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${meta.dot}`} />
        {meta.label}
      </span>
      {mostrarDetalle && (
        <span className="text-[11px] text-muted-foreground pl-1">{fino.label}</span>
      )}
    </div>
  );
}
