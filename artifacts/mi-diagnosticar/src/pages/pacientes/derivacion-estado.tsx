import {
  useUpdateReferralEstado,
  type Derivacion,
  type DerivacionEstadoInputEstado,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { ChevronDown, Loader2 } from "lucide-react";

// Circuito de estados de la derivación interna (espejo del backend):
// pedido → agendado → realizado → informado. Anulable hasta que se realiza.
export const TRANSICIONES_DERIVACION: Record<string, string[]> = {
  pedido: ["agendado", "anulada"],
  agendado: ["realizado", "pedido", "anulada"],
  realizado: ["informado"],
  informado: [],
  anulada: [],
};

export const ESTADOS_DERIVACION: Record<string, { label: string; className: string }> = {
  pedido: { label: "Pedido", className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200" },
  agendado: { label: "Agendado", className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  realizado: { label: "Realizado", className: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200" },
  informado: { label: "Informado", className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  anulada: { label: "Anulada", className: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200" },
};

export function DerivacionEstadoBadge({ estado }: { estado?: string | null }) {
  if (!estado) return null;
  const meta = ESTADOS_DERIVACION[estado];
  return (
    <Badge
      variant="secondary"
      className={`${meta?.className ?? "bg-muted text-muted-foreground"} border-0 text-xs whitespace-nowrap`}
    >
      {meta?.label ?? estado}
    </Badge>
  );
}

export function DerivacionEstadoControl({ derivacion, onChanged }: {
  derivacion: Pick<Derivacion, "id" | "status">;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const rol = (user as { rol?: string } | undefined)?.rol;
  const puedeGestionar = rol === "admin" || rol === "recepcionista" || rol === "medico";

  const cambiar = useUpdateReferralEstado({
    mutation: {
      onSuccess: (updated) => {
        toast({
          title: "Estado actualizado",
          description: `La derivación pasó a "${ESTADOS_DERIVACION[updated.status ?? ""]?.label ?? updated.status}"`,
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

  const estado = derivacion.status ?? "pedido";
  const transiciones = (TRANSICIONES_DERIVACION[estado] ?? []) as DerivacionEstadoInputEstado[];

  if (!puedeGestionar || transiciones.length === 0) return <DerivacionEstadoBadge estado={estado} />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-auto p-0.5 gap-1 hover:bg-transparent" disabled={cambiar.isPending}>
          <DerivacionEstadoBadge estado={estado} />
          {cambiar.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs">Cambiar estado a</DropdownMenuLabel>
        {transiciones.map((t) => (
          <DropdownMenuItem
            key={t}
            onClick={() => cambiar.mutate({ id: derivacion.id, data: { estado: t } })}
            className={t === "anulada" ? "text-red-600 focus:text-red-600" : ""}
          >
            {ESTADOS_DERIVACION[t]?.label ?? t}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
