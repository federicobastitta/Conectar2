// Ventana del médico para ver/elegir su número de consultorio.
// Lo que elija acá es lo que anuncia la pantalla de sala de espera al llamar.
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetProfesional,
  useListConsultorios,
  useListSalasLlamado,
  useUpdateProfesional,
  getGetProfesionalQueryKey,
} from "@workspace/api-client-react";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { DoorOpen, Tv } from "lucide-react";

export function ConsultorioSelector() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const profesionalId = user?.rol === "medico" ? user?.profesionalId ?? null : null;

  const { data: profesional } = useGetProfesional(profesionalId ?? 0, {
    query: { enabled: profesionalId != null },
  });
  const { data: consultorios } = useListConsultorios({
    query: { enabled: profesionalId != null },
  });
  const { data: salas } = useListSalasLlamado({
    query: { enabled: profesionalId != null },
  });
  const update = useUpdateProfesional();

  if (profesionalId == null || !profesional) return null;

  const valor = profesional.consultorioId != null ? String(profesional.consultorioId) : "none";
  const valorSala = profesional.salaLlamadoId != null ? String(profesional.salaLlamadoId) : "none";
  const salasActivas = (salas ?? []).filter(
    (s) => s.activa !== false || s.id === profesional.salaLlamadoId,
  );

  const cambiar = (v: string) => {
    const consultorioId = v === "none" ? null : Number(v);
    update.mutate(
      { id: profesionalId, data: { consultorioId } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetProfesionalQueryKey(profesionalId) });
          const nombre = (consultorios ?? []).find(c => c.id === consultorioId)?.nombre;
          toast({
            title: consultorioId ? `Consultorio asignado: ${nombre ?? ""}` : "Consultorio sin asignar",
            description: consultorioId
              ? "La pantalla de sala de espera va a anunciar este consultorio al llamar."
              : "Al llamar, la pantalla solo va a mostrar la agenda.",
          });
        },
        onError: () => toast({ title: "No se pudo cambiar el consultorio", variant: "destructive" }),
      },
    );
  };

  const cambiarSala = (v: string) => {
    const salaLlamadoId = v === "none" ? null : Number(v);
    update.mutate(
      { id: profesionalId, data: { salaLlamadoId } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetProfesionalQueryKey(profesionalId) });
          const nombre = (salas ?? []).find(s => s.id === salaLlamadoId)?.nombre;
          toast({
            title: salaLlamadoId ? `Sala de llamado: ${nombre ?? ""}` : "Sala sin asignar",
            description: salaLlamadoId
              ? "La TV de esa sala va a anunciar tus llamados."
              : "Tus llamados aparecen solo en las pantallas generales (por sede o todas).",
          });
        },
        onError: () => toast({ title: "No se pudo cambiar la sala", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-2" data-testid="card-consultorio-medico">
      <div className="flex items-center gap-2.5">
        <div className="p-1.5 rounded-lg bg-violet-100 dark:bg-violet-500/20 shrink-0">
          <DoorOpen className="w-4 h-4 text-violet-600 dark:text-violet-400" />
        </div>
        <span className="text-sm font-medium whitespace-nowrap">Mi consultorio</span>
        <div className="min-w-[170px]">
          <Combobox
            options={[
              { value: "none", label: "Sin asignar" },
              ...(consultorios ?? []).map(c => ({ value: String(c.id), label: c.nombre })),
            ]}
            value={valor}
            onChange={cambiar}
            placeholder="Consultorio"
            testId="selector-consultorio-medico"
          />
        </div>
      </div>
      <div className="flex items-center gap-2.5">
        <div className="p-1.5 rounded-lg bg-emerald-100 dark:bg-emerald-500/20 shrink-0">
          <Tv className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        </div>
        <span className="text-sm font-medium whitespace-nowrap">Sala de llamado (TV)</span>
        <div className="min-w-[170px]">
          <Combobox
            options={[
              { value: "none", label: "Sin asignar" },
              ...salasActivas.map(s => ({ value: String(s.id), label: s.nombre })),
            ]}
            value={valorSala}
            onChange={cambiarSala}
            placeholder="Sala"
            testId="selector-sala-llamado-medico"
          />
        </div>
      </div>
    </div>
  );
}
