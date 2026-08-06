import { useState } from "react";
import {
  useUpdateStudyOrderStatus,
  useGetStudyOrderHistory,
  type OrdenEstudio,
  type OrdenEstudioEstadoInputEstado,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { ChevronDown, History, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";

// Circuito de estados (espejo del backend)
export const TRANSICIONES_ORDEN: Record<string, string[]> = {
  solicitado: ["pendiente_programacion", "programado", "anulada"],
  pendiente_programacion: ["programado", "anulada"],
  programado: ["en_realizacion", "pendiente_programacion", "anulada"],
  en_realizacion: ["realizado"],
  realizado: ["informado"],
  informado: ["entregado"],
  entregado: [],
  anulada: [],
};

export const ESTADOS_ORDEN: Record<string, { label: string; className: string }> = {
  solicitado: { label: "Solicitado", className: "bg-slate-100 text-slate-700" },
  pendiente_programacion: { label: "Pendiente de programación", className: "bg-amber-100 text-amber-800" },
  programado: { label: "Programado", className: "bg-blue-100 text-blue-800" },
  en_realizacion: { label: "En realización", className: "bg-indigo-100 text-indigo-800" },
  realizado: { label: "Realizado", className: "bg-teal-100 text-teal-800" },
  informado: { label: "Informado", className: "bg-violet-100 text-violet-800" },
  entregado: { label: "Entregado", className: "bg-green-100 text-green-800" },
  anulada: { label: "Anulada", className: "bg-red-100 text-red-700" },
};

export function OrdenEstadoBadge({ estado }: { estado?: string | null }) {
  if (!estado) return null;
  const meta = ESTADOS_ORDEN[estado];
  return (
    <Badge
      variant="secondary"
      className={`${meta?.className ?? "bg-muted text-muted-foreground"} border-0 text-xs whitespace-nowrap`}
    >
      {meta?.label ?? estado}
    </Badge>
  );
}

function HistorialDialog({ ordenId, open, onOpenChange }: {
  ordenId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data, isLoading } = useGetStudyOrderHistory(ordenId, { query: { enabled: open } });
  const eventos = data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="w-4 h-4" /> Historial de la orden #{ordenId}
          </DialogTitle>
          <DialogDescription>Trazabilidad completa de los cambios de estado.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : eventos.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Sin eventos registrados.</p>
        ) : (
          <div className="relative pl-5 space-y-3 max-h-80 overflow-y-auto before:absolute before:left-1.5 before:top-1 before:bottom-1 before:w-px before:bg-border">
            {eventos.map((e, i) => (
              <div key={i} className="relative text-sm">
                <div className="absolute -left-5 top-1.5 w-3 h-3 rounded-full bg-primary/20 border-2 border-primary" />
                <div className="flex flex-wrap items-center gap-1.5">
                  {e.accion === "crear" ? (
                    <span className="font-medium">Orden creada</span>
                  ) : (
                    <span className="font-medium flex items-center gap-1.5 flex-wrap">
                      {e.estadoAnterior && <OrdenEstadoBadge estado={e.estadoAnterior} />}
                      <span className="text-muted-foreground">→</span>
                      <OrdenEstadoBadge estado={e.estadoNuevo} />
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {format(new Date(e.fecha), "d MMM yyyy HH:mm", { locale: es })}
                  {e.usuarioEmail ? ` · ${e.usuarioEmail}` : ""}
                  {e.rol ? ` (${e.rol})` : ""}
                </p>
                {e.observaciones && <p className="text-xs mt-0.5 italic">"{e.observaciones}"</p>}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function OrdenEstadoControl({ orden, onChanged }: {
  orden: OrdenEstudio;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const rol = (user as { rol?: string } | undefined)?.rol;
  const puedeGestionar = rol === "admin" || rol === "recepcionista" || rol === "medico";
  const [historialAbierto, setHistorialAbierto] = useState(false);

  const cambiar = useUpdateStudyOrderStatus({
    mutation: {
      onSuccess: (updated) => {
        toast({
          title: "Estado actualizado",
          description: `La orden pasó a "${ESTADOS_ORDEN[updated.status ?? ""]?.label ?? updated.status}"`,
        });
        onChanged?.();
      },
      onError: (e) => {
        const msg = e instanceof Error ? e.message : "Error desconocido";
        toast({ title: "No se pudo cambiar el estado", description: msg, variant: "destructive" });
        onChanged?.();
      },
    },
  });

  const estado = orden.status ?? "solicitado";
  const transiciones = (TRANSICIONES_ORDEN[estado] ?? []) as OrdenEstudioEstadoInputEstado[];

  return (
    <div className="flex items-center gap-1.5">
      {puedeGestionar && transiciones.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-auto p-0.5 gap-1 hover:bg-transparent" disabled={cambiar.isPending}>
              <OrdenEstadoBadge estado={estado} />
              {cambiar.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="text-xs">Cambiar estado a</DropdownMenuLabel>
            {transiciones.map((t) => (
              <DropdownMenuItem
                key={t}
                onClick={() => cambiar.mutate({ id: orden.id, data: { estado: t } })}
                className={t === "anulada" ? "text-red-600 focus:text-red-600" : ""}
              >
                {ESTADOS_ORDEN[t]?.label ?? t}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setHistorialAbierto(true)}>
              <History className="w-3.5 h-3.5 mr-2" /> Ver historial
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <>
          <OrdenEstadoBadge estado={estado} />
          <Button size="icon" variant="ghost" className="w-6 h-6" onClick={() => setHistorialAbierto(true)} title="Ver historial">
            <History className="w-3.5 h-3.5 text-muted-foreground" />
          </Button>
        </>
      )}
      <HistorialDialog ordenId={orden.id} open={historialAbierto} onOpenChange={setHistorialAbierto} />
    </div>
  );
}
