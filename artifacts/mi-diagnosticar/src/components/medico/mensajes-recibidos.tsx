import { useQueryClient } from "@tanstack/react-query";
import {
  useListMensajesMedico,
  useMarcarMensajeLeido,
  getListMensajesMedicoQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { MessageSquare, Check, Loader2 } from "lucide-react";

// Banner del médico: mensajes dirigidos que le mandó recepción/administración.
// Se actualiza solo (polling) y cada mensaje se descarta al marcarlo leído.
export function MensajesMedicoBanner() {
  const queryClient = useQueryClient();
  const { data: mensajes } = useListMensajesMedico({
    query: { refetchInterval: 15000, refetchIntervalInBackground: true },
  });
  const marcar = useMarcarMensajeLeido();

  if (!mensajes?.length) return null;

  const leido = (id: number) =>
    marcar.mutate(
      { id },
      {
        onSettled: () =>
          queryClient.invalidateQueries({ queryKey: getListMensajesMedicoQueryKey() }),
      },
    );

  return (
    <div className="space-y-2 px-4 pt-3 md:px-6" data-testid="banner-mensajes-medico">
      {mensajes.map((m) => (
        <div
          key={m.id}
          className="flex items-start justify-between gap-3 rounded-lg border-2 border-sky-500/50 bg-sky-500/10 p-3"
        >
          <div className="flex items-start gap-3 min-w-0">
            <div className="p-2 rounded-full bg-sky-500/20 text-sky-600 dark:text-sky-300 shrink-0">
              <MessageSquare className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                Mensaje de {m.deNombre || "recepción"}
              </div>
              <div className="text-sm break-words">{m.mensaje}</div>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => leido(m.id)}
            disabled={marcar.isPending}
            className="shrink-0"
            data-testid={`boton-leido-${m.id}`}
          >
            {marcar.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <Check className="w-4 h-4 mr-1.5" />
                Leído
              </>
            )}
          </Button>
        </div>
      ))}
    </div>
  );
}
