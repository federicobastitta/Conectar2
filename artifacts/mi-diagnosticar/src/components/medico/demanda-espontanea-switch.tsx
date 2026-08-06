// Interruptor "Acepto demanda espontánea" (guardia) del médico.
// Reutilizable: se muestra en Consultorio, Mi agenda y Escritorio Médico.
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetDoctorDashboard,
  useSetDemandaEspontanea,
  getGetDoctorDashboardQueryKey,
} from "@workspace/api-client-react";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Zap } from "lucide-react";

export function DemandaEspontaneaSwitch({ compacto = false }: { compacto?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useGetDoctorDashboard();
  const demandaMutation = useSetDemandaEspontanea();

  if (!data) return null;
  const activo = !!data.aceptaDemandaEspontanea;

  const toggleDemanda = (aceptar: boolean) => {
    demandaMutation.mutate(
      { data: { aceptar } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetDoctorDashboardQueryKey() });
          toast({
            title: aceptar ? "Demanda espontánea activada" : "Demanda espontánea desactivada",
            description: aceptar
              ? "Recepción puede cargarte pacientes sin turno en la sala."
              : "Ya no recibís pacientes sin turno.",
          });
        },
        onError: () => toast({ title: "No se pudo cambiar el estado", variant: "destructive" }),
      },
    );
  };

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border ${compacto ? "p-2" : "p-2.5"} ${activo ? "border-amber-400/60" : ""}`}
      data-testid="card-demanda-espontanea"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <div className={`p-1.5 rounded-lg shrink-0 ${activo ? "bg-amber-100 dark:bg-amber-500/20" : "bg-muted"}`}>
          <Zap className={`w-4 h-4 ${activo ? "text-amber-500" : "text-muted-foreground"}`} />
        </div>
        <div className="min-w-0">
          <p className="font-medium text-sm">Acepto demanda espontánea</p>
          {!compacto && (
            <p className="text-xs text-muted-foreground truncate">
              Recepción puede cargarte pacientes sin turno mientras esté prendido.
            </p>
          )}
        </div>
      </div>
      <Switch
        checked={activo}
        onCheckedChange={toggleDemanda}
        disabled={demandaMutation.isPending}
        data-testid="switch-demanda-espontanea"
      />
    </div>
  );
}
